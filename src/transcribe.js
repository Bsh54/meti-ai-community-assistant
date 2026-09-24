// Auto-transcription des recordings (YouTube gratuit / Google Drive via AssemblyAI)
// -> extraction de faits par l'IA -> mémoire. Non bloquant, anti-doublon.
const fs = require('fs')
const path = require('path')
const util = require('util')
const execFile = util.promisify(require('child_process').execFile)
const { fetchTranscript, idFromUrl } = require('./youtube')
const { chat } = require('./llm')
const { addCurated } = require('./memory')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const REC_DIR = path.join(__dirname, '..', 'recordings')
const SEEN_FILE = path.join(DATA_DIR, 'processed-links.json')
const GDOWN = path.join(__dirname, '..', '.venv', 'bin', 'gdown')
const AAI_KEY = process.env.ASSEMBLYAI_KEY || ''
for (const d of [DATA_DIR, REC_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })

function loadSeen() { try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))) } catch { return new Set() } }
function saveSeen(set) { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set])) }

// Détecte les liens de recording dans un texte -> [{type, id, url}]
function findRecordingLinks(text) {
  const out = []
  const yt = text.matchAll(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/g)
  for (const m of yt) out.push({ type: 'youtube', id: m[1], url: m[0] })
  const gd = text.matchAll(/https?:\/\/drive\.google\.com\/file\/d\/([\w-]+)/g)
  for (const m of gd) out.push({ type: 'drive', id: m[1], url: m[0] })
  return out
}

// --- AssemblyAI (upload + transcript + poll) ---
async function assemblyai(audioPath) {
  if (!AAI_KEY) throw new Error('ASSEMBLYAI_KEY manquante')
  const B = 'https://api.assemblyai.com/v2'
  const bytes = fs.readFileSync(audioPath)
  let r = await fetch(`${B}/upload`, { method: 'POST', headers: { authorization: AAI_KEY }, body: bytes })
  if (!r.ok) throw new Error('aai upload ' + r.status)
  const { upload_url } = await r.json()
  r = await fetch(`${B}/transcript`, { method: 'POST', headers: { authorization: AAI_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ audio_url: upload_url, language_code: 'en' }) })
  if (!r.ok) throw new Error('aai transcript ' + r.status)
  const { id } = await r.json()
  for (;;) {
    await new Promise((s) => setTimeout(s, 10000))
    const t = await (await fetch(`${B}/transcript/${id}`, { headers: { authorization: AAI_KEY } })).json()
    if (t.status === 'completed') return t.text || ''
    if (t.status === 'error') throw new Error('aai: ' + t.error)
  }
}

async function transcribeDrive(id) {
  if (!fs.existsSync(GDOWN)) throw new Error('gdown (venv) absent')
  const mp4 = `/tmp/rec_${id}.mp4`, mp3 = `/tmp/rec_${id}.mp3`
  try {
    await execFile(GDOWN, [id, '-O', mp4], { maxBuffer: 1 << 26 })
    await execFile('ffmpeg', ['-y', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', mp3], { maxBuffer: 1 << 26 })
    return await assemblyai(mp3)
  } finally {
    for (const f of [mp4, mp3]) try { fs.unlinkSync(f) } catch {}
  }
}

// Transcrit un buffer audio (ex: note vocale WhatsApp ogg/opus) via AssemblyAI.
async function transcribeAudioBuffer(buffer, ext = 'ogg') {
  const tmp = path.join(REC_DIR, `dm_${Date.now()}.${ext}`)
  fs.writeFileSync(tmp, buffer)
  try { return await assemblyai(tmp) } finally { try { fs.unlinkSync(tmp) } catch {} }
}

// Extrait des faits utiles d'un transcript (par morceaux) et les mémorise.
// Extraction EXHAUSTIVE et DÉTAILLÉE : on veut TOUT le contenu substantiel de la session, pas quelques lignes.
async function extractFacts(text, name, meta) {
  const words = text.split(/\s+/)
  const CHUNK = Number(process.env.EXTRACT_CHUNK_WORDS || 2200) // morceaux plus fins -> plus de détail capté
  const chunks = []
  for (let i = 0; i < words.length; i += CHUNK) chunks.push(words.slice(i, i + CHUNK).join(' '))
  let n = 0
  for (let ci = 0; ci < chunks.length; ci++) {
    const prompt = `This is part ${ci + 1}/${chunks.length} of the transcript of a recorded session ("${name}") from the UniPods METI AI programme (auto-transcribed, may contain small errors).
Your job: extract a THOROUGH, DETAILED and COMPLETE set of facts so a member who missed the session can understand EVERYTHING that was said, not just a summary. Be exhaustive.
Capture ALL of the following whenever present:
- every teaching point, concept, definition and the EXPLANATION given (not just the term)
- every step of any process, framework or methodology, in order
- concrete EXAMPLES, analogies and case studies mentioned (with the specifics)
- exact numbers, metrics, criteria, thresholds, levels, names of tools/platforms/people
- exercises/assignments, deadlines, dates, decisions, recommendations and practical instructions
- Q&A: the question asked AND the full answer given
- any resource, link, template or next step mentioned
Write each fact as a clear, self-contained sentence (or two) that keeps the useful DETAIL (don't over-compress; a specific, informative fact is better than a vague one). Prefer MORE granular facts over fewer. Ignore only pure greetings, small talk, audio glitches and filler.
FORMAT — CRITICAL: return STRICT JSON where "facts" is an array of PLAIN STRINGS (full sentences), NOT objects. Example: {"facts":["The facilitator explained that ...","Participants were asked to ..."]}. Do NOT use keys like topic/detail. If truly nothing useful, {"facts":[]}.

TRANSCRIPT PART:
"""${chunks[ci]}"""`
    let reply
    try { reply = await chat([{ role: 'user', content: prompt }], { max_tokens: 3200 }) } catch (e) { console.log('  extract err:', e.message); continue }
    const m = reply && reply.match(/\{[\s\S]*\}/)
    let facts = []
    try { facts = JSON.parse(m[0]).facts || [] } catch {}
    for (const f of facts) {
      // Robuste : accepte une string OU un objet ({topic,detail} / {fact} / etc.) -> on aplatit en phrase.
      let s = ''
      if (typeof f === 'string') s = f
      else if (f && typeof f === 'object') {
        s = [f.topic, f.detail, f.fact, f.point, f.text].filter((v) => typeof v === 'string' && v).join(f.topic ? ': ' : ' ')
        if (!s) s = Object.values(f).filter((v) => typeof v === 'string' && v).join(' — ')
      }
      s = String(s).replace(/\s+/g, ' ').trim()
      if (s.length > 15) {
        addCurated({ text: `[${name}] ${s}`, source_role: 'admin', confidence: 0.85, group_name: 'Session recording', sender_name: name, ts: meta.ts || Date.now(), msg_id: 'rec:' + (meta.id || name) + ':' + n })
        n++
      }
    }
  }
  return n
}

// Point d'entrée : traite un lien de recording (non bloquant, anti-doublon).
async function processRecording(link, meta = {}) {
  const seen = loadSeen()
  const key = link.type + ':' + link.id
  if (seen.has(key)) return
  seen.add(key); saveSeen(seen) // marque tôt pour éviter double traitement
  try {
    console.log(`🎬 Recording détecté (${link.type} ${link.id}) -> transcription...`)
    let text = ''
    if (link.type === 'youtube') text = await fetchTranscript(link.id)
    else if (link.type === 'drive') text = await transcribeDrive(link.id)
    if (!text || text.length < 200) { console.log('  transcript vide/court, ignoré'); return }
    fs.writeFileSync(path.join(REC_DIR, `${link.type}-${link.id}.txt`), text.replace(/([.?!])\s+/g, '$1\n'))
    const name = (meta.caption && meta.caption.slice(0, 60)) || `${link.type} recording ${link.id}`
    const n = await extractFacts(text, name, { id: link.id, ts: meta.ts })
    console.log(`  ✅ Recording "${name}" -> ${n} fait(s) mémorisé(s)`)
  } catch (e) {
    console.log('  ❌ Echec transcription:', e.message)
    const s = loadSeen(); s.delete(key); saveSeen(s) // permet un nouvel essai plus tard
  }
}

// Ingère un transcript brut (ex: session live capturée) -> faits -> mémoire.
async function ingestTranscript(text, name, meta = {}) {
  if (!text || text.trim().length < 100) return 0
  return extractFacts(text, name || 'Live session', { id: meta.id || 'live:' + Date.now(), ts: meta.ts || Date.now() })
}

module.exports = { findRecordingLinks, processRecording, transcribeAudioBuffer, ingestTranscript }
