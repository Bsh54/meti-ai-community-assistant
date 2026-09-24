// Plugin INCRUSTATION AUTO : quand un lien de recording est posté (par un admin), lance le pipeline
// translator -> téléchargement HD -> AssemblyAI -> sous-titres FR -> incrustation GitHub -> upload Drive
// (METI-Recordings-FR). Fire-and-forget, ANTI-DOUBLON (un même lien n'est incrusté qu'une seule fois).
const fs = require('fs')
const path = require('path')
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const SEEN = path.join(DATA_DIR, 'incrusted-links.json')
const API = process.env.TRANSLATOR_URL || 'http://127.0.0.1:7865'
const LANG = process.env.INCRUST_LANG || 'fr'

function load() { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')) } catch { return {} } }
function save(o) { try { fs.writeFileSync(SEEN, JSON.stringify(o, null, 2)) } catch {} }
function status() { return load() }

// Déclenche l'incrustation d'un recording. Idempotent par URL. Renvoie l'id de job (ou null).
async function incrust(url, opts = {}) {
  const key = (url || '').trim()
  if (!key) return null
  const seen = load()
  if (seen[key]) return seen[key].jobId || null // déjà traité / en cours -> pas de doublon
  seen[key] = { status: 'queued', at: Date.now() }
  save(seen)
  try {
    const body = new URLSearchParams({ youtube: key, target: opts.lang || LANG, backend: 'github' })
    const r = await fetch(`${API}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.id) throw new Error('translate ' + r.status + ' ' + JSON.stringify(j).slice(0, 120))
    seen[key] = { status: 'processing', jobId: j.id, at: Date.now() }
    save(seen)
    console.log('🎬 Incrustation auto lancée (recording -> FR HD -> Drive):', key, '-> job', j.id)
    return j.id
  } catch (e) {
    delete seen[key]; save(seen) // échec -> on autorise un nouvel essai plus tard
    console.log('incrust err:', e.message)
    return null
  }
}

module.exports = { incrust, status }
