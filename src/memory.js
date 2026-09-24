// Mémoire = SQLite + FTS5 (recherche BM25). Un seul fichier, zéro serveur.
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'memory.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// Table principale (source structurée) + index FTS5 pour la recherche plein-texte BM25.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id        TEXT UNIQUE,
    ts            INTEGER,
    group_id      TEXT,
    group_name    TEXT,
    sender_id     TEXT,
    sender_name   TEXT,
    is_announcement INTEGER DEFAULT 0,
    msg_type      TEXT,
    text          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_group_ts ON messages(group_id, ts);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  -- triggers pour garder l'index FTS synchro avec la table
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`)

// --- Migration : colonnes autorité / confiance / périmé (pour le curateur auto) ---
const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name)
function addCol(name, def) { if (!cols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`) }
addCol('source_role', "TEXT DEFAULT 'member'") // 'admin' | 'member'
addCol('confidence', 'REAL DEFAULT 1')          // 0..1
addCol('kind', "TEXT DEFAULT 'knowledge'")      // 'raw' | 'knowledge' | 'curated'
addCol('superseded', 'INTEGER DEFAULT 0')       // 1 = remplacé par une info plus récente
addCol('updated_at', 'INTEGER')

// --- #4 Recherche HYBRIDE : table des vecteurs (embeddings) pour le canal sémantique/cross-langue ---
db.exec(`CREATE TABLE IF NOT EXISTS vec (id INTEGER PRIMARY KEY, v BLOB)`)
const _setVec = db.prepare('INSERT OR REPLACE INTO vec (id, v) VALUES (?, ?)')
function setVec(id, arr) { _setVec.run(id, Buffer.from(Float32Array.from(arr).buffer)) }
// Fiches actives sans embedding (pour le backfill par le curateur).
function missingVecRows(limit = 64) {
  return db.prepare(
    `SELECT id, text FROM messages
     WHERE (superseded IS NULL OR superseded = 0) AND kind IN ('knowledge','curated')
       AND id NOT IN (SELECT id FROM vec) LIMIT ?`
  ).all(limit)
}
let _vecCache = { t: 0, rows: null }
function _loadVecs() {
  const now = Date.now()
  if (_vecCache.rows && now - _vecCache.t < 30000) return _vecCache.rows
  const rows = db.prepare(
    `SELECT v.id AS id, v.v AS v FROM vec v JOIN messages m ON m.id = v.id
     WHERE (m.superseded IS NULL OR m.superseded = 0)`
  ).all().map((r) => ({ id: r.id, v: new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4) }))
  _vecCache = { t: now, rows }
  return rows
}
// Ids classés par similarité cosinus (vecteurs L2-normalisés -> cosinus = produit scalaire).
function vecRankIds(queryVec, pool = 40) {
  if (!queryVec || !queryVec.length) return []
  const q = Float32Array.from(queryVec)
  const scored = _loadVecs().map((r) => {
    let dot = 0; const v = r.v; const n = Math.min(v.length, q.length)
    for (let i = 0; i < n; i++) dot += v[i] * q[i]
    return { id: r.id, s: dot }
  })
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, pool).map((x) => x.id)
}
function _ftsIds(query, pool = 40) {
  const match = sanitizeQuery(query || '')
  if (!match) return []
  try {
    return db.prepare(
      `SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND (m.superseded IS NULL OR m.superseded = 0)
       ORDER BY (bm25(messages_fts) - (m.is_announcement * 3.0)) ASC LIMIT ?`
    ).all(match, pool).map((r) => r.id)
  } catch { return [] }
}
function _hydrate(ids) {
  const byId = db.prepare('SELECT * FROM messages WHERE id = ?')
  const neighborStmt = db.prepare(
    `SELECT sender_name, text, ts, is_announcement FROM messages
     WHERE group_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 12`
  )
  const W = 5 * 60 * 1000
  return ids.map((id) => {
    const r = byId.get(id)
    if (!r) return null
    return { group_name: r.group_name, sender_name: r.sender_name, ts: r.ts, is_announcement: !!r.is_announcement, text: r.text, context: neighborStmt.all(r.group_id, r.ts - W, r.ts + W) }
  }).filter(Boolean)
}
// Recherche HYBRIDE : FTS (multi-requêtes native+EN) + canal vecteur, fusion Reciprocal Rank Fusion.
function hybridSearch(queries, queryVec, { limit = 12, k = 60, pool = 40 } = {}) {
  const score = new Map()
  const add = (ids) => ids.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i)))
  for (const q of queries) add(_ftsIds(q, pool))
  if (queryVec) add(vecRankIds(queryVec, pool))
  const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
  return _hydrate(top)
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (msg_id, ts, group_id, group_name, sender_id, sender_name, is_announcement, msg_type, text)
  VALUES (@msg_id, @ts, @group_id, @group_name, @sender_id, @sender_name, @is_announcement, @msg_type, @text)
`)

// Ajoute une fiche de connaissance CURÉE (issue du curateur auto).
const insertCurated = db.prepare(`
  INSERT OR IGNORE INTO messages
    (msg_id, ts, group_id, group_name, sender_id, sender_name, is_announcement, msg_type, text,
     source_role, confidence, kind, superseded, updated_at)
  VALUES (@msg_id, @ts, @group_id, @group_name, @sender_id, @sender_name, @is_announcement, @msg_type, @text,
     @source_role, @confidence, 'curated', 0, @updated_at)
`)
function addCurated(f) {
  const info = insertCurated.run({
    msg_id: f.msg_id || `curated:${Date.now()}:${Math.random()}`,
    ts: f.ts || Date.now(),
    group_id: f.group_id || 'curated',
    group_name: f.group_name || 'Curated knowledge',
    sender_id: f.sender_id || '',
    sender_name: f.sender_name || 'inconnu',
    is_announcement: f.source_role === 'admin' ? 1 : 0,
    msg_type: 'curated',
    text: f.text,
    source_role: f.source_role || 'member',
    confidence: f.confidence == null ? 0.8 : f.confidence,
    updated_at: Date.now(),
  })
  return info.lastInsertRowid
}
// Marque une fiche comme périmée (soft-delete, garde l'historique).
const supersedeStmt = db.prepare(`UPDATE messages SET superseded=1, updated_at=? WHERE id=?`)
function supersede(id) { supersedeStmt.run(Date.now(), id) }

// Récupère les K fiches les plus proches (pour la décision A.U.D.N. du curateur).
function topSimilar(text, k = 5) {
  const match = sanitizeQuery(text)
  if (!match) return []
  return db.prepare(
    `SELECT m.id, m.text, m.source_role FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ? AND (m.superseded IS NULL OR m.superseded=0)
     ORDER BY bm25(messages_fts) ASC LIMIT ?`
  ).all(match, k)
}

// Ingère un tableau d'entrées jsonl (issues des logs du bot). Idempotent (msg_id UNIQUE).
function ingest(entries) {
  let added = 0
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e || !e.text) continue
      const info = insertStmt.run({
        msg_id: e.messageId || `${e.chatId}:${e.time}:${Math.random()}`,
        ts: e.time ? Date.parse(e.time) : Date.now(),
        group_id: e.chatId || '',
        group_name: e.groupName || e.chatId || '',
        sender_id: e.senderId || '',
        sender_name: e.senderName || 'inconnu',
        is_announcement: e.isAnnouncement ? 1 : 0,
        msg_type: e.msgType || 'unknown',
        text: e.text,
      })
      if (info.changes) added++
    }
  })
  tx(entries)
  return added
}

// Nettoie une requête pour FTS5 (évite les erreurs de syntaxe) et fait un OR entre les mots.
function sanitizeQuery(q) {
  const terms = (q.match(/[\p{L}\p{N}]+/gu) || [])
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`)
  return terms.join(' OR ')
}

// Recherche BM25. Les annonces sont boostées (bonus sur le score).
// Retourne des messages pertinents + une petite fenêtre de contexte autour de chacun.
function search(query, { limit = 8, windowSize = 2 } = {}) {
  const match = sanitizeQuery(query)
  if (!match) return []
  const rows = db
    .prepare(
      `SELECT m.*, bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND (m.superseded IS NULL OR m.superseded=0)
       ORDER BY (bm25(messages_fts) - (m.is_announcement * 3.0)) ASC
       LIMIT ?`
    )
    .all(match, limit)

  // Fenêtre de contexte : messages voisins dans le même groupe (avant/après par le temps)
  const neighborStmt = db.prepare(
    `SELECT sender_name, text, ts, is_announcement FROM messages
     WHERE group_id = ? AND ts BETWEEN ? AND ?
     ORDER BY ts ASC LIMIT 12`
  )
  const WINDOW_MS = 5 * 60 * 1000 // ±5 min autour du message trouvé
  return rows.map((r) => {
    const ctx = neighborStmt.all(r.group_id, r.ts - WINDOW_MS, r.ts + WINDOW_MS)
    return {
      group_name: r.group_name,
      sender_name: r.sender_name,
      ts: r.ts,
      is_announcement: !!r.is_announcement,
      text: r.text,
      context: ctx,
    }
  })
}

// Recherche FTS MULTI-REQUÊTES fusionnée par RRF (Reciprocal Rank Fusion, k=60).
// Sert le recall cross-langue : on passe [question_native_FR, question_traduite_EN] -> les 2 canaux
// de recall sont fusionnés par rang (robuste, pas de problème d'échelle de score). Annonces boostées.
function searchRRF(queries, { limit = 12, k = 60, pool = 40 } = {}) {
  const scores = new Map() // id -> score RRF
  const rowById = new Map()
  const stmt = db.prepare(
    `SELECT m.*, bm25(messages_fts) AS rank
     FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ? AND (m.superseded IS NULL OR m.superseded = 0)
     ORDER BY (bm25(messages_fts) - (m.is_announcement * 3.0)) ASC
     LIMIT ?`
  )
  for (const q of queries) {
    const match = sanitizeQuery(q || '')
    if (!match) continue
    let rows = []
    try { rows = stmt.all(match, pool) } catch { continue }
    rows.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i)) // RRF sur le rang
      if (!rowById.has(r.id)) rowById.set(r.id, r)
    })
  }
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => rowById.get(id))
  const neighborStmt = db.prepare(
    `SELECT sender_name, text, ts, is_announcement FROM messages
     WHERE group_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 12`
  )
  const WINDOW_MS = 5 * 60 * 1000
  return top.map((r) => ({
    group_name: r.group_name, sender_name: r.sender_name, ts: r.ts,
    is_announcement: !!r.is_announcement, text: r.text,
    context: neighborStmt.all(r.group_id, r.ts - WINDOW_MS, r.ts + WINDOW_MS),
  }))
}

// Renvoie TOUTE la connaissance (non périmée) pour une vision générale.
// Officielles d'abord. Coupe à maxChars (sécurité si la base devient énorme).
function allKnowledge({ maxChars = 60000, domain } = {}) {
  let where = "(superseded IS NULL OR superseded = 0) AND kind IN ('knowledge','curated')"
  if (domain === 'wadhwani') where += " AND (text LIKE '%Wadhwani%' OR text LIKE '%Ignite%' OR group_name LIKE '%Wadhwani%')"
  const rows = db.prepare(
    `SELECT text, is_announcement, group_name, ts FROM messages
     WHERE ${where}
     ORDER BY is_announcement DESC, ts ASC`
  ).all()
  const lines = []
  let total = 0
  let truncated = false
  for (const r of rows) {
    const tag = r.is_announcement ? '[OFFICIAL] ' : ''
    const line = `- ${tag}${r.text}`
    if (total + line.length > maxChars) { truncated = true; break }
    lines.push(line)
    total += line.length
  }
  return { text: lines.join('\n'), count: lines.length, totalRows: rows.length, truncated }
}

// Dernières annonces officielles (avec leur date) — pour "quoi de neuf / annonces récentes".
function recentAnnouncements({ limit = 12 } = {}) {
  return db.prepare(
    `SELECT text, ts FROM messages
     WHERE is_announcement = 1 AND (superseded IS NULL OR superseded = 0) AND kind IN ('knowledge','curated')
     ORDER BY ts DESC LIMIT ?`
  ).all(limit)
}

// SESSIONS RÉCENTES avec leur CONTENU, chacune groupée par (nom de session + JOUR).
// Permet au cerveau de répondre juste à "le meet d'aujourd'hui / d'hier / de mardi" SANS mélanger les jours :
// il reçoit le contenu de chaque session daté séparément. Renvoie [{name, ts, facts:[...]}] (ordre chrono).
function recentSessionsWithFacts({ days = 9, maxCharsPer = 3500, maxSessions = 3 } = {}) {
  const since = Date.now() - days * 86400000
  const rows = db.prepare(
    `SELECT text, ts FROM messages WHERE msg_id LIKE 'rec:%' AND ts >= ? AND (superseded IS NULL OR superseded = 0) ORDER BY id ASC`
  ).all(since)
  const groups = new Map() // "name|YYYY-MM-DD" -> {name, ts, facts[]}
  for (const r of rows) {
    const m = r.text.match(/^\[([^\]]+)\]\s*/)
    const name = m ? m[1] : 'session'
    const day = new Date(r.ts).toISOString().slice(0, 10)
    const key = name + '|' + day
    if (!groups.has(key)) groups.set(key, { name, ts: r.ts, facts: [] })
    groups.get(key).facts.push(m ? r.text.slice(m[0].length) : r.text)
  }
  let arr = [...groups.values()].sort((a, b) => b.ts - a.ts).slice(0, maxSessions) // les N plus récentes
  arr = arr.map((g) => { const out = []; let t = 0; for (const f of g.facts) { if (t + f.length > maxCharsPer) break; out.push(f); t += f.length } return { name: g.name, ts: g.ts, facts: out } })
  return arr.sort((a, b) => a.ts - b.ts) // ordre chronologique (plus ancien -> plus récent)
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM messages').get().c
  const ann = db.prepare('SELECT COUNT(*) c FROM messages WHERE is_announcement=1').get().c
  const groups = db.prepare('SELECT COUNT(DISTINCT group_id) c FROM messages').get().c
  return { total, announcements: ann, groups }
}

module.exports = { db, ingest, search, searchRRF, hybridSearch, setVec, missingVecRows, vecRankIds, recentSessionsWithFacts, stats, DB_PATH, addCurated, supersede, topSimilar, allKnowledge, recentAnnouncements }
