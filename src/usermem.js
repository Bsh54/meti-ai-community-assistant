// Mémoire par membre (DM) : historique persistant + notes distillées, borné.
// "Ultra efficace" = la mémoire reste petite : au-delà d'un seuil, les vieux tours
// sont résumés dans `notes` (compaction façon Mem0) et retirés de l'historique brut.
const fs = require('fs')
const path = require('path')
const { chat } = require('./llm')
const { writeJsonAtomic } = require('./serialize')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const FILE = path.join(DATA_DIR, 'dm-memory.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

let store
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { store = {} }
function save() { try { writeJsonAtomic(FILE, store) } catch {} }

function get(jid) {
  if (!store[jid]) store[jid] = { notes: '', history: [], count: 0, first: Date.now(), last: Date.now() }
  return store[jid]
}
function history(jid) { return get(jid).history }
function notes(jid) { return get(jid).notes }

// Incrémente le compteur de messages du membre (pour la limite). Renvoie le total.
function bumpCount(jid) { const m = get(jid); m.count = (m.count || 0) + 1; m.last = Date.now(); save(); return m.count }
function count(jid) { return get(jid).count || 0 }

function push(jid, role, text) {
  const m = get(jid)
  m.history.push({ role, text })
  if (m.history.length > 60) m.history = m.history.slice(-60) // garde-fou dur
  m.last = Date.now()
  save()
}

// Compaction : au-delà de HIST_CAP tours, résume les plus anciens dans `notes`.
const HIST_KEEP = 16, HIST_CAP = 30
async function maybeCompact(jid) {
  const m = get(jid)
  if (m.history.length <= HIST_CAP) return
  const old = m.history.slice(0, m.history.length - HIST_KEEP)
  const convo = old.map((h) => `${h.role}: ${h.text}`).join('\n')
  try {
    const s = await chat([{ role: 'user', content:
`Existing notes about this community member:
${m.notes || '(none yet)'}

Fold this earlier private conversation into the notes. Output ONLY an updated short factual profile: who they are, what they're working on, what they've asked or need, and any commitment made to them. Under 120 words, plain sentences, no fluff, no markdown.

Earlier conversation:
${convo}` }], { max_tokens: 300 })
    if (s && s.trim()) {
      m.notes = s.trim()
      m.history = m.history.slice(-HIST_KEEP)
      save()
    }
  } catch (e) { /* garde l'historique tel quel si le résumé échoue */ }
}

module.exports = { get, history, notes, count, bumpCount, push, maybeCompact, save }
