// Registre des documents envoyables + matcher flexible (mots-clés + LLM).
// Les fichiers vivent dans /documents ; le manifeste (titres/desc/keywords) dans data/docs.json.
const fs = require('fs')
const path = require('path')
const { chat } = require('./llm')
const { translateDoc } = require('./translate')

const DOC_DIR = process.env.DOC_DIR || path.join(__dirname, '..', 'documents')
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const MANIFEST = path.join(DATA_DIR, 'docs.json')
for (const d of [DOC_DIR, DATA_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })

// Les 4 documents de base (lus et compris).
const SEED = [
  { id: 'hackathon-guidelines', file: 'hackathon-guidelines.pdf', fileName: 'UniPods Hackathon Guidelines.pdf', mimetype: 'application/pdf',
    title: 'Hackathon Guidelines', source: 'seed', lang: 'en', variants: { fr: 'hackathon-guidelines.fr.pdf' },
    keywords: ['hackathon', 'guidelines', 'guideline', 'challenge', 'chatbot hackathon', '5000', '$5000', 'prize', 'submit', 'submission', 'team rules', 'rules'],
    description: 'The chatbot hackathon brief: the problem, the challenge, what to submit, team rules, timeline and the $5,000 prize.' },
  { id: 'video-demo-guide', file: 'video-demo-guide.pdf', fileName: 'UniPods Video Demo Guide.pdf', mimetype: 'application/pdf',
    title: 'Video Demo Guide', source: 'seed',
    keywords: ['video', 'demo', 'video demo', 'un', 'unga', 'recording', 'video guide', 'pitch video', '5 minute video', 'video submission', 'demo guide'],
    description: 'Guide for the UN video demo submission (UNGA showcase): what to include, technical requirements, and how to submit the 5-minute video.' },
  { id: 'info-pack', file: 'info-pack.pdf', fileName: 'UniPods METI AI Info Pack.pdf', mimetype: 'application/pdf',
    title: 'Programme Info Pack', source: 'seed',
    keywords: ['info pack', 'infopack', 'information', 'programme', 'program', 'overview', 'details', 'mit', 'wadhwani', 'ethiopian', 'timeline', 'schedule', 'info'],
    description: 'The main programme information pack: MIT course, Wadhwani Ignite, Ethiopian AI Institute, how it all connects, full timeline, welcome call and contacts.' },
  { id: 'cohort1-deck', file: 'cohort1-deck.pptx', fileName: 'UniPods METI AI Cohort 1 Deck.pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    title: 'Cohort 1 Deck', source: 'seed',
    keywords: ['deck', 'slides', 'slide', 'presentation', 'powerpoint', 'pptx', 'cohort deck'],
    description: 'The Cohort 1 presentation deck (slides overview of the programme).' },
]

let manifest = (() => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return [] } })()
for (const s of SEED) if (!manifest.find((d) => d.id === s.id)) manifest.push(s)
function save() { try { fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)) } catch {} }
save()

function all() { return manifest }
function pathOf(doc) { return path.isAbsolute(doc.file) ? doc.file : path.join(DOC_DIR, doc.file) }

// Enregistre / met à jour un document (ex: fichier reçu d'un admin).
function register(doc) {
  const id = doc.id || 'doc-' + Date.now()
  const existing = manifest.find((d) => d.id === id)
  if (existing) Object.assign(existing, doc, { id })
  else manifest.push({ id, source: 'admin', ts: Date.now(), ...doc })
  save()
  return id
}

// Score mots-clés (rapide, gratuit).
function scoreDoc(d, q) {
  const s = ' ' + q.toLowerCase() + ' '
  let score = 0
  for (const k of (d.keywords || [])) if (s.includes(k.toLowerCase())) score += 2
  for (const w of (d.title || '').toLowerCase().split(/\s+/)) if (w.length > 3 && s.includes(w)) score += 1
  return score
}
function findByKeyword(query) {
  const ranked = manifest.map((d) => ({ d, s: scoreDoc(d, query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
  return ranked.length ? ranked[0].d : null
}

// Matcher : renvoie {kind:'doc'|'ambiguous'|'none', doc, lang}.
// 'none' = pas une demande de document (même si le message mentionne un sujet).
// 'ambiguous' = veut clairement un document mais on ne sait pas lequel.
async function pick(query, context = '') {
  const kw = findByKeyword(query)
  const list = manifest.map((d) => `- ${d.id}: ${d.title} — ${d.description}`).join('\n')
  try {
    const raw = await chat([
      { role: 'system', content: `You classify a user message about programme documents. Reply STRICT JSON only: {"id":"<a document id | ambiguous | none>","lang":"<ISO code, default en>"}.
- Use "none" ONLY when the user asks a QUESTION for information (e.g. "what is the deadline", "what is the hackathon about") rather than asking to receive a file.
- If the user wants to GET / RECEIVE / be SENT a document, or mentions a document "in French/English", map it to the matching document id. Mentioning a language version almost always means they want the file.
- Use "ambiguous" when they clearly want a document sent but it is unclear which one.
- Use the recent conversation to resolve references ("this document", "the French version", "it").
- LANGUAGE: default "en". Only use another code if the user EXPLICITLY asks for that language ("in French", "la version française"). Do NOT infer the language from the message's own language.
Examples: "what is the deadline" -> none | "send me the info pack" -> info-pack | "can I get the guidelines in french" -> hackathon-guidelines | "send me the file" -> ambiguous | "the video guide please" -> video-demo-guide` },
      { role: 'user', content: `AVAILABLE DOCUMENTS:\n${list}\n\n${context ? 'RECENT CONVERSATION (oldest first):\n' + context + '\n\n' : ''}USER MESSAGE: "${query}"\n\nJSON only.` },
    ], { max_tokens: 40, priority: 'high' })
    let d = {}; try { d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]) } catch {}
    // Langue : le LLM ne doit pas déduire du message ; on force FR si demandé explicitement.
    const frWanted = /\b(fran[cç]ais|french)\b/i.test(query)
    const lang = frWanted ? 'fr' : (d.lang || 'en').toLowerCase()
    // Rattrapage : si le message demande CLAIREMENT un envoi ET qu'un doc matche par mot-clé,
    // on le renvoie même si le LLM a dit none/ambiguous (le LLM se trompe parfois, surtout en FR).
    const sendIntent = /\b(send|share|give|forward|resend|get|receive|download|envoi|envoie|envoyer|partage|partager|passe|donne|obtenir|recevoir|t[ée]l[ée]charger)\b/i.test(query)
    if (d.id === 'none' || d.id === 'ambiguous') return (sendIntent && kw) ? { kind: 'doc', doc: kw, lang } : { kind: d.id, lang }
    const doc = d.id ? manifest.find((x) => x.id === d.id) : null
    if (doc) return { kind: 'doc', doc, lang }
    return (sendIntent && kw) ? { kind: 'doc', doc: kw, lang } : { kind: 'none', lang }
  } catch {}
  return kw ? { kind: 'doc', doc: kw, lang: /\b(fran[cç]ais|french)\b/i.test(query) ? 'fr' : 'en' } : { kind: 'none', lang: 'en' } // repli mot-clé
}

function _renameLang(fileName, lang) {
  const ext = path.extname(fileName)
  return fileName.slice(0, -ext.length) + ` (${lang.toUpperCase()})` + ext
}

// Renvoie {path, fileName, mimetype} du doc dans la langue voulue (traduit à la demande si absent).
async function getFile(doc, lang) {
  lang = (lang || 'en').toLowerCase()
  const baseLang = (doc.lang || 'en').toLowerCase()
  if (lang === baseLang) return { path: pathOf(doc), fileName: doc.fileName, mimetype: doc.mimetype }
  doc.variants = doc.variants || {}
  const known = doc.variants[lang]
  if (known && fs.existsSync(path.join(DOC_DIR, known))) {
    return { path: path.join(DOC_DIR, known), fileName: _renameLang(doc.fileName, lang), mimetype: doc.mimetype }
  }
  const ext = path.extname(pathOf(doc))
  const outName = `${doc.id}.${lang}${ext}`
  const outPath = path.join(DOC_DIR, outName)
  if (!fs.existsSync(outPath)) await translateDoc(pathOf(doc), lang, outPath) // déjà traduit ? on réutilise
  doc.variants[lang] = outName; save()
  return { path: outPath, fileName: _renameLang(doc.fileName, lang), mimetype: doc.mimetype }
}

// Garantit qu'une variante de langue existe (ex: FR auto à l'upload admin).
async function ensureLang(docId, lang) {
  const doc = manifest.find((d) => d.id === docId)
  if (!doc) return
  try { await getFile(doc, lang) } catch {}
}

// Reçoit un fichier (buffer) : le stocke dans /documents et l'enregistre (titre/desc/keywords via LLM).
async function registerFromContent({ buffer, fileName, mimetype, text }) {
  const safe = (fileName || 'document').replace(/[^\w.\-]/g, '_').slice(0, 60)
  const stored = /\.[a-z0-9]+$/i.test(safe) ? safe : safe + '.bin'
  const dest = path.join(DOC_DIR, Date.now() + '-' + stored)
  try { fs.writeFileSync(dest, buffer) } catch (e) { return null }
  let meta = { title: fileName || 'Document', description: (text || '').slice(0, 160), keywords: [] }
  try {
    const raw = await chat([
      { role: 'system', content: 'Summarize a shared document for a retrieval index. STRICT JSON only: {"title":"short title","description":"one clear sentence","keywords":["k1","k2","k3"]}.' },
      { role: 'user', content: `File name: ${fileName || '(unknown)'}\nContent (OCR, may be partial):\n"""${(text || '').slice(0, 2500)}"""` },
    ], { max_tokens: 200 })
    const d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0])
    if (d.title) meta = { title: d.title, description: d.description || meta.description, keywords: Array.isArray(d.keywords) ? d.keywords : [] }
  } catch {}
  // Enrichit les mots-clés avec les mots du TITRE + NOM DE FICHIER -> retrouvable par une demande naturelle
  // (ex. "ignite module 1 and 2 slides", "shoppilot example"), pas seulement par des termes sémantiques.
  const stop = new Set(['the', 'and', 'for', 'with', 'pdf', 'pptx', 'docx', 'from', 'this', 'that', 'your'])
  const extra = ((meta.title || '') + ' ' + (fileName || '')).toLowerCase().match(/[a-z0-9]{3,}/g) || []
  meta.keywords = [...new Set([...(meta.keywords || []), ...extra.filter((w) => !stop.has(w))])]
  const id = 'doc-' + Date.now()
  register({ id, file: dest, fileName: fileName || (meta.title + '.pdf'), mimetype: mimetype || 'application/octet-stream', source: 'admin', ...meta })
  return { id, ...meta }
}

module.exports = { all, register, registerFromContent, findByKeyword, pick, getFile, ensureLang, pathOf, DOC_DIR }
