// Curateur automatique : transforme le flux brut des groupes en connaissance propre.
// Inspiré du pipeline Mem0 (Extract -> décision A.U.D.N. ADD/UPDATE/NOOP), adapté FTS.
// Tourne en boucle (toutes les ~15 min). Usage ponctuel : node --env-file=.env curator.js --once
const fs = require('fs')
const path = require('path')
const { chat } = require('./src/llm')
const { roleOf } = require('./src/roster')
const { addCurated, supersede, topSimilar, missingVecRows, setVec } = require('./src/memory')
const { embed } = require('./src/embed')

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'logs', 'messages.jsonl')
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const STATE_FILE = path.join(DATA_DIR, 'curator_state.json')
const REVIEW_QUEUE = path.join(DATA_DIR, 'review-queue.jsonl')
const INTERVAL_MS = Number(process.env.CURATOR_INTERVAL_MS || 15 * 60 * 1000)
const MAX_PER_RUN = Number(process.env.CURATOR_MAX || 40)
const AUTO_CONF = Number(process.env.CURATOR_AUTO_CONF || 0.8) // seuil auto-stockage pour non-admins

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// --- Pré-filtre gratuit (jeter le bruit avant d'appeler l'IA) ---
const NOISE = [
  /^(hi|hey|hello|hallo|yo|ok|okay|thanks?|thank you|merci|welcome|bienvenue|congrats?|congratulations|noted|done|great|nice|cool|lol|same here|me too|amen|👋|🙏|🎉|❤️)[\s!.😊🙏👋🥳🤝]*$/i,
  /^(good (morning|afternoon|evening|day))/i,
  /message was deleted|media omitted|joined using|joined from the community|was added|created (group|community)|pinned a message|changed this group|turned (on|off)|added ~|left$/i,
  /looking for (a )?team|join (my|our) team|need (a )?team|dm me|team full|who('?s| is) interested|add me|i'?m in\b/i,
]
function isNoise(t) {
  const s = (t || '').trim()
  if (s.length < 12) return true
  if (/^[\p{Emoji}\s\p{P}]+$/u.test(s)) return true
  return NOISE.some((re) => re.test(s))
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { offset: 0 } } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)) }
function queueForReview(item) { fs.appendFileSync(REVIEW_QUEUE, JSON.stringify(item) + '\n') }

function safeJson(txt) {
  if (!txt) return null
  const m = txt.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

const DECIDE_PROMPT = (cand, role, group, when, similar) => `You are the memory curator for the UniPods METI AI community knowledge base.
Decide what to do with ONE candidate message from the WhatsApp groups.

Only keep DURABLE, USEFUL facts for a community FAQ: deadlines, dates, event/session details, links, recordings, procedures, official clarifications, decisions, requirements.
Do NOT keep: greetings, chit-chat, personal team-search, opinions, jokes, questions without answers.

Author role: ${role} (admin = organizer/official; member = normal participant).
Group: ${group} | Date: ${when}
Candidate message: """${cand}"""

Existing similar knowledge (id | text):
${similar.length ? similar.map((s) => `- [${s.id}] ${s.text.slice(0, 240)}`).join('\n') : '(none found)'}

Choose ONE operation (priority NOOP > UPDATE > ADD):
- NOOP: already covered by an existing item, or not worth keeping.
- UPDATE: it refreshes/changes/corrects an existing item (give its id as target_id). Use for changed dates/links.
- ADD: genuinely new durable fact.

Reply with STRICT JSON only:
{"keep": true|false, "operation": "ADD"|"UPDATE"|"NOOP", "target_id": <number or null>, "fact": "<clean, self-contained fact in English, or empty>", "category": "<short>", "confidence": <0..1>}`

async function processCandidate(entry) {
  const role = roleOf(entry)
  const when = entry.time ? String(entry.time).slice(0, 16).replace('T', ' ') : ''
  const similar = topSimilar(entry.text, 5)
  let reply
  try {
    reply = await chat([{ role: 'user', content: DECIDE_PROMPT(entry.text, role, entry.groupName || '', when, similar) }], { max_tokens: 400 })
  } catch (e) { console.log('  LLM err:', e.message); return null }
  const d = safeJson(reply)
  if (!d || !d.keep || d.operation === 'NOOP' || !d.fact) return { op: 'NOOP' }

  const auto = role === 'admin' || (d.confidence || 0) >= AUTO_CONF
  // #3 Contextual retrieval : on préfixe la catégorie -> plus de contexte à l'indexation, meilleur recall.
  const factText = (d.category && !d.fact.toLowerCase().includes(String(d.category).toLowerCase())) ? `(${d.category}) ${d.fact}` : d.fact
  const fact = {
    text: factText,
    source_role: role,
    confidence: d.confidence || 0.7,
    group_name: entry.groupName || '',
    sender_name: entry.senderName || '',
    sender_id: entry.senderId || '',
    ts: entry.time ? Date.parse(entry.time) : Date.now(),
    msg_id: 'curated:' + (entry.messageId || Date.now() + ':' + Math.random()),
  }

  if (d.operation === 'UPDATE' && d.target_id) {
    if (auto) { supersede(d.target_id); addCurated(fact); return { op: 'UPDATE', role, fact: d.fact } }
    queueForReview({ ...fact, operation: 'UPDATE', target_id: d.target_id, category: d.category }); return { op: 'REVIEW' }
  }
  // ADD
  if (auto) { addCurated(fact); return { op: 'ADD', role, fact: d.fact } }
  queueForReview({ ...fact, operation: 'ADD', category: d.category }); return { op: 'REVIEW' }
}

async function runOnce() {
  if (!fs.existsSync(LOG_FILE)) { console.log('No log file yet:', LOG_FILE); return }
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
  const state = loadState()
  const fresh = lines.slice(state.offset)
  let processed = 0, added = 0, updated = 0, review = 0, noop = 0
  for (const l of fresh) {
    if (processed >= MAX_PER_RUN) break
    let e; try { e = JSON.parse(l) } catch { continue }
    if (!e.text || e.fromMe || isNoise(e.text)) continue
    processed++
    const r = await processCandidate(e)
    if (!r) continue
    if (r.op === 'ADD') { added++; console.log(`  + ADD (${r.role}): ${r.fact.slice(0, 90)}`) }
    else if (r.op === 'UPDATE') { updated++; console.log(`  ~ UPDATE (${r.role}): ${r.fact.slice(0, 90)}`) }
    else if (r.op === 'REVIEW') review++
    else noop++
  }
  state.offset = lines.length // avance même si certains ont été filtrés
  saveState(state)
  console.log(`[curator] ${new Date().toISOString()} — candidats:${processed} | +${added} ~${updated} revue:${review} noop:${noop} | total lignes:${lines.length}`)
}

// #4 Backfill des embeddings : embarque les fiches sans vecteur (par lots) pour la recherche hybride.
// Fail-safe : si le service d'embeddings est indispo, on ne fait rien (réessai au prochain passage).
async function backfillEmbeddings(max = 256) {
  let done = 0
  for (let i = 0; i < Math.ceil(max / 64); i++) {
    const rows = missingVecRows(64)
    if (!rows.length) break
    const vecs = await embed(rows.map((r) => r.text), 'passage')
    if (!vecs || vecs.length !== rows.length) break // service indispo -> on s'arrête
    rows.forEach((r, j) => { try { setVec(r.id, vecs[j]) } catch {} })
    done += rows.length
  }
  if (done) console.log(`[curator] embeddings: +${done} fiche(s) vectorisée(s)`)
}

async function loop() {
  await runOnce()
  await backfillEmbeddings().catch((e) => console.log('backfill err:', e.message))
  setTimeout(loop, INTERVAL_MS)
}

if (process.argv.includes('--once')) runOnce()
else loop()
