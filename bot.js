const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys')
const { processDocument } = require('./src/media')
const { roleOf } = require('./src/roster')
const { OCR_ENABLED, ocrExtract } = require('./src/ocr')
const { findRecordingLinks, processRecording, transcribeAudioBuffer } = require('./src/transcribe')
const { incrust } = require('./src/incrust')
const { computeDueAlerts } = require('./src/schedule')
const { dailyDigest, wadhwaniRecap } = require('./src/brain')
const { learn: learnJid, tagify } = require('./src/mentions')
const { repairLinks } = require('./src/links')
const usermem = require('./src/usermem')
const { makeSerializer, writeJsonAtomic } = require('./src/serialize')
const docs = require('./src/docs')
const cal = require('./src/calendar')
const { chat } = require('./src/llm')

// ---- Envoi de documents SUR DEMANDE (jamais en vrac) ----
// Pré-filtre large (EN + FR) : le message ressemble-t-il à une demande d'envoi de document ?
const DOC_REQUEST_RE = /\b(send|share|give|get|download|receive|resend|forward|do you have|have|access|where|which|can (you|i)|could you|please|où|envoi|envoie|envoyer|m'envoyer|partage|partager|passe|balance|il (me|nous) faut|je veux|j'ai besoin|besoin de|j'aimerais|puis-?je|peux|peut|avoir|obtenir|recevoir|acc[eé]der|donne)\b/i
const DOC_HINT_RE = /\b(document|documents|doc|pdf|file|files|fichier|fichiers|deck|slides?|guide|guidelines?|info ?pack|infopack|pack|hackathon|video demo|presentation|example|exemple|module|modules|ignite|shoppilot|shop pilot)\b/i
const DOC_ALL_RE = /\b(all|every|everything|both|tous|toutes|les (documents|fichiers)|the (documents|files))\b/i
function detectDocLang(text) {
  if (/fran[cç]ais|french|\bfr\b/i.test(text)) return 'fr'
  if (/anglais|english|\ben\b/i.test(text)) return 'en'
  return null
}
async function sendOneDoc(sock, chatId, doc, lang, quoted) {
  const cached = lang === (doc.lang || 'en') || (doc.variants && doc.variants[lang])
  if (!cached) await sock.sendMessage(chatId, { text: `One moment — translating *${doc.title}* to ${lang.toUpperCase()}… 🌍` }, quoted ? { quoted } : {})
  const f = await docs.getFile(doc, lang)
  if (!fs.existsSync(f.path)) return false
  await sock.sendMessage(chatId, {
    document: fs.readFileSync(f.path), fileName: f.fileName, mimetype: f.mimetype,
    caption: `📎 *${doc.title}*${lang !== (doc.lang || 'en') ? ' — ' + lang.toUpperCase() : ''}`,
  }, quoted ? { quoted } : {})
  console.log('📎 Document envoyé:', doc.id, lang, '->', chatId)
  return true
}
async function sendDocumentIfRequested(sock, chatId, text, quoted, context = '') {
  if (!text) return false
  // Pré-filtre (indice de document OU "version") — évite d'appeler le matcher sur tout.
  if (!DOC_HINT_RE.test(text) && !/\bversion\b/i.test(text)) return false
  if (!DOC_REQUEST_RE.test(text) && !/\bversion\b/i.test(text)) return false
  try {
    // "tous les documents / les fichiers" -> on envoie TOUT (dans la langue demandée)
    if (DOC_ALL_RE.test(text)) {
      const lang0 = detectDocLang(text) || 'en'
      const bases = docs.all().filter((d) => d.source === 'seed')
      if (!bases.length) return false
      await sock.sendMessage(chatId, { text: `Sure — sending all the programme documents${lang0 === 'fr' ? ' (en français)' : ''} 📎` }, quoted ? { quoted } : {})
      for (const d of bases) { try { await sendOneDoc(sock, chatId, d, lang0) } catch (e) { console.log('doc all err:', e?.message) } }
      return true
    }
    const picked = await docs.pick(text, context) // {kind:'doc'|'ambiguous'|'none', doc, lang}
    const lang = detectDocLang(text) || picked.lang || 'en'
    if (picked.kind === 'doc') return await sendOneDoc(sock, chatId, picked.doc, lang, quoted)
    if (picked.kind === 'ambiguous') {
      const list = docs.all().filter((d) => d.source === 'seed').map((d) => `• ${d.title}`).join('\n')
      await sock.sendMessage(chatId, { text: `Sure! Which one would you like? I have:\n${list}\n\nJust tell me the name — I can send it in *English* or *French* 🇫🇷` }, quoted ? { quoted } : {})
      return true
    }
    return false // 'none' -> pas une demande de document -> réponse normale
  } catch (e) { console.log('❌ doc send err:', e?.message); return false }
}
const { interviewStep, marketBrief, panelTakes, finalFeedback, shouldRespond, recapSummary, hostReply } = require('./src/arena')
const P = require('pino')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

// ---- Arène "révélateur bienveillant" (parcours progressif) ----
const ARENA_GROUP = process.env.ARENA_GROUP || ''
const ARENA_ENABLED = (process.env.ARENA_ENABLED ?? '0') === '1'
const ARENA_QUORUM = Number(process.env.ARENA_QUORUM || 10) // pas d'accueil ni d'activité avant N membres
let arenaMemberCount = 0 // taille du groupe Arène (mise à jour à la connexion + aux ajouts)
let arenaOpenAnnounced = false
// Mémoire PAR MEMBRE (persistante) : profil solution + étape + historique
const ARENA_FILE = path.join(__dirname, 'data', 'arena-members.json')
let arenaStore = (() => { try { return JSON.parse(fs.readFileSync(ARENA_FILE, 'utf8')) } catch { return {} } })()
function arenaSave() { try { writeJsonAtomic(ARENA_FILE, arenaStore) } catch {} }
function arenaGet(jid) {
  if (!arenaStore[jid]) arenaStore[jid] = { stage: 'interview', profile: '', history: [], marketNotes: '', title: '', greeted: false }
  return arenaStore[jid]
}
function arenaHist(m, n = 12) { return (m.history || []).slice(-n).map((h) => `${h.role}: ${h.text}`).join('\n') }
// Recap vivant pour les nouveaux arrivants (résumé IA de ce qui s'est passé), caché 5 min.
let _arenaRecapCache = { t: 0, v: '' }
async function arenaRecapText() {
  const now = Date.now()
  if (now - _arenaRecapCache.t < 300000) return _arenaRecapCache.v
  const founders = Object.values(arenaStore).filter((m) => m.title).map((m) => `• ${m.title}`).join('\n')
  const recent = recentGet(ARENA_GROUP, 30).map((r) => `${r.name}: ${r.text}`).join('\n')
  let v = ''
  if (founders || recent) { try { v = await recapSummary(founders, recent) } catch {} }
  _arenaRecapCache = { t: now, v }
  return v
}

// ---- Config (via variables d'environnement, valeurs par défaut sinon) ----
// PHONE          : numéro du bot (format international sans +)
// ALLOWED_GROUPS : liste d'IDs de groupes séparés par des virgules. Vide = tous.
// AUTO_REPLY     : '1' pour activer la réponse auto + DM (par défaut 1)
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const AUTO_REPLY = (process.env.AUTO_REPLY ?? '1') === '1'
// Priority Announcements group(s) (official admins-only channel)
const ANNOUNCE_GROUPS = (process.env.ANNOUNCE_GROUPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// Group(s) where the bot ANSWERS questions.
const ANSWER_GROUPS = (process.env.ANSWER_GROUPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const WADHWANI_ANSWER_GROUP = process.env.WADHWANI_ANSWER_GROUP || '' // this group = Wadhwani only
// Signatures/déclencheurs des AUTRES bots de la communauté (hackathon) : on ne répond NI ne réagit
// JAMAIS à un message qui les invoque (ex. "@ask ...", "/nexus ...") — on le laisse à leur bot.
const OTHER_BOT_TRIGGER_RE = new RegExp(
  process.env.OTHER_BOT_TRIGGERS || '(^|\\s)[@/!](ask|jymns?|nexus|podpal|uniconnect|askbot|podai|geni)\\b',
  'i'
)
function isForOtherBot(text) { return !!text && OTHER_BOT_TRIGGER_RE.test(text) }
// Interrupteur : réponses aux QUESTIONS dans les groupes. '0' = le bot ne répond plus aux
// questions des groupes (mais garde DM, annonces, alertes, digests, logging, OCR).
const GROUP_ANSWER = (process.env.GROUP_ANSWER ?? '1') === '1'
// ---- Statut OWNER (dev) : toi. Zéro restriction + commandes par DM. ----
const OWNER_NUMS = new Set((process.env.OWNER_JIDS || '').split(',').map((s) => s.trim().split('@')[0]).filter(Boolean))
function isOwner(jid) { return !!jid && OWNER_NUMS.has(String(jid).split('@')[0]) }
// Extrait le numéro d'un jid de façon robuste (le jid peut être une string, un objet {id}, ou un nombre).
const numOf = (j) => String((j && typeof j === 'object' ? (j.id || j.jid || '') : j) || '').split('@')[0]
// Flags modifiables à chaud (survivent au restart) : override des env.
const RUNTIME_FILE = path.join(__dirname, 'data', 'runtime.json')
let runtime = (() => { try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) } catch { return {} } })()
function rtSave() { try { writeJsonAtomic(RUNTIME_FILE, runtime) } catch {} }
function groupAnswerOn() { return runtime.groupAnswer !== undefined ? runtime.groupAnswer : GROUP_ANSWER }
function arenaOn() { return runtime.arena !== undefined ? runtime.arena : ARENA_ENABLED }
// Réactions emoji dans les groupes, INDÉPENDANTES des réponses : présence légère même quand le
// bot ne répond pas (groupAnswer OFF). Ne pollue pas (maybeReact est throttlé).
function groupReactOn() { return runtime.groupReact !== undefined ? runtime.groupReact : false }
// Taux de réaction (proba sur un match direct), réglable en direct via /react — défaut calme = 0.33.
function reactRate() { const r = Number(runtime.reactRate); return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.33 }
// --- Kill switch d'urgence : "STOP" dans le groupe de contrôle (General) déconnecte le bot ---
const CONTROL_GROUP = process.env.CONTROL_GROUP || '' // control/kill-switch group
const EMERGENCY_FILE = path.join(__dirname, 'data', 'emergency-stop.flag')
let emergencyStop = fs.existsSync(EMERGENCY_FILE)
const { answerAuto, answerDM } = require('./src/brain')

// ---- Messages privés (DM) — phase d'essai ----
// Fenêtre globale de 2h30 (après : plus de réponses en DM). Limite 20 msgs/membre.
const DM_WINDOW_MS = Number(process.env.DM_WINDOW_MS || 150 * 60000) // 2h30
const DM_ALWAYS_OPEN = (process.env.DM_ALWAYS_OPEN ?? '0') === '1' // '1' = pas de limite de temps (toujours ouvert)
const DM_MAX_PER_MEMBER = Number(process.env.DM_MAX || 20)
const DM_WINDOW_FILE = path.join(__dirname, 'data', 'dm-window.json')
const dmTxtPath = path.join(__dirname, 'logs', 'dm.txt')
// Crée la fenêtre au démarrage si absente (le minuteur part du 1er lancement, persiste au restart).
function ensureDmWindow() {
  try { return JSON.parse(fs.readFileSync(DM_WINDOW_FILE, 'utf8')) } catch {}
  const w = { openUntil: Date.now() + DM_WINDOW_MS, opened: Date.now() }
  try { writeJsonAtomic(DM_WINDOW_FILE, w) } catch {}
  return w
}
function dmLog(name, jid, who, text) {
  try { fs.appendFileSync(dmTxtPath, `[${new Date().toISOString()}] [DM ${name} ${jid}] ${who}: ${text}\n`) } catch {}
}
// Dédup DM : évite de traiter deux fois le même message (redélivrance notify/append).
const DM_SEEN_FILE = path.join(__dirname, 'data', 'dm-seen.json')
let dmSeen = new Set((() => { try { return JSON.parse(fs.readFileSync(DM_SEEN_FILE, 'utf8')) } catch { return [] } })())
function dmMarkSeen(id) {
  if (!id) return
  dmSeen.add(id)
  if (dmSeen.size > 4000) dmSeen = new Set([...dmSeen].slice(-3000))
  try { writeJsonAtomic(DM_SEEN_FILE, [...dmSeen]) } catch {}
}
const dmEnqueue = makeSerializer()    // 1 file par membre (DM)
const groupEnqueue = makeSerializer() // 1 file par (groupe|expéditeur)
const DM_PLACEHOLDERS = new Set(['[image]', '[vidéo]', '[audio]', '[sticker]', '[document]', ''])

// Déduit le "vrai" texte d'un DM : texte brut, ou OCR d'une image/PDF, ou transcription d'une note vocale.
async function dmEffectiveText(sock, m, rawText) {
  const mm = m.message || {}
  const audio = mm.audioMessage
  const img = mm.imageMessage
  const doc = mm.documentMessage || mm.documentWithCaptionMessage?.message?.documentMessage
  const isPdf = doc && /pdf/i.test(doc.mimetype || doc.fileName || '')
  try {
    if (audio) {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
      const t = await transcribeAudioBuffer(buf, 'ogg')
      return t && t.trim() ? `(voice note) ${t.trim()}` : ''
    }
    if (img || isPdf) {
      if (!OCR_ENABLED) return rawText
      const buf = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
      const tmp = path.join(__dirname, 'data', `dm_${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`)
      fs.writeFileSync(tmp, buf)
      let t = ''; try { t = await ocrExtract(tmp, 'en') } catch {}
      try { fs.unlinkSync(tmp) } catch {}
      const cap = img?.caption || doc?.caption || ''
      const body = t && t.trim().length > 15 ? `(shared a ${isPdf ? 'document' : 'image'} that says:) ${t.trim()}` : ''
      return [cap, body].filter(Boolean).join('\n')
    }
  } catch (e) { console.log('DM media err:', e?.message) }
  return rawText
}

// Normalise le texte pour WhatsApp : *gras* (une étoile), pas de Markdown ** ni titres #.
function toWhatsApp(s) {
  if (!s) return s
  s = s.replace(/^[ \t]*[*+\-][ \t]+/gm, '• ') // puces markdown (*, -, +) -> • (sinon "*  " s'affiche mal)
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*') // ***x*** -> *x*
  s = s.replace(/\*\*(.+?)\*\*/gs, '*$1*') // **x** -> *x*
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '') // titres markdown -> rien
  s = s.replace(/\*\*/g, '*') // étoiles doubles restantes
  return s.trim()
}

// Prépare le payload d'envoi : réparation des liens + format WhatsApp + tags des admins.
function waMsg(text) {
  const { text: t, mentions } = tagify(repairLinks(toWhatsApp(text)))
  return mentions.length ? { text: t, mentions } : { text: t }
}

// ---- Réactions emoji CONTEXTUELLES : réaction SENSÉE (choisie selon le message + l'historique du
// membre + la conversation du groupe), jamais au hasard. Le guide/choix vit dans le plugin src/emojis.
const { pickReaction } = require('./src/emojis')
async function maybeReact(sock, chatId, m, text) {
  if (!text || m.key.fromMe || text.length > 300) return
  if (Math.random() > reactRate()) return // throttle : on ne réagit pas à TOUS les messages (réglable /react)
  try {
    const senderId = m.key.participant || ''
    const groupHist = recentGet(chatId, 12).map((r) => `${r.name}: ${r.text}`).join('\n')
    const userHist = recentGet(chatId, 40).filter((r) => r.senderId === senderId).slice(-5).map((r) => r.text).join(' | ')
    const emoji = await pickReaction(text, { groupHist, userHist }) // choix contextuel (ou '' -> rien)
    if (!emoji) return
    await sock.sendMessage(chatId, { react: { text: emoji, key: m.key } })
    console.log('😊 réaction', emoji, '->', chatId)
  } catch (e) { console.log('react err:', e?.message) }
}

// ---- Auto-suppression : le bot efface SON message si intrusion signalée / erreur ----
const botSent = new Map() // chatId -> [{key, ts}]
function rememberBotMsg(chatId, res) {
  if (!res?.key) return
  const a = botSent.get(chatId) || []
  a.push({ key: res.key, ts: Date.now() })
  while (a.length > 12) a.shift()
  botSent.set(chatId, a)
}
// Phrases signalant que le bot n'aurait pas dû parler / s'est trompé (EN + FR).
const CALLOUT_RE = /\b(not (talking|speaking) to you|wasn'?t (talking|speaking|for) you|not for you|who asked( you)?|no ?(one|body) asked|you'?re wrong|that'?s (wrong|not right|false|incorrect)|delete (this|that)|shut up|stay out of|mind your)\b|(c'?est pas (à|a) toi|je (te|ne te) parle pas|on (te|ne te) parle pas|on parlait? pas de toi|personne (t'|ne t')a parl[ée]|t'?as tort|c'?est faux|tais-?toi|supprime (ça|ce)|efface (ça|ce)|arr[êe]te)/i
async function maybeSelfDelete(sock, chatId, m, text) {
  if (!text || m.key.fromMe || !CALLOUT_RE.test(text)) return
  const list = botSent.get(chatId)
  if (!list || !list.length) return
  // UNIQUEMENT si c'est un REPLY à un message précis du bot (jamais "au hasard le dernier")
  const ctx = m.message?.extendedTextMessage?.contextInfo || {}
  if (!ctx.stanzaId) return
  const target = list.find((x) => x.key.id === ctx.stanzaId)
  if (!target) return
  try {
    await sock.sendMessage(chatId, { delete: target.key })
    botSent.set(chatId, list.filter((x) => x !== target))
    console.log('🗑️ Auto-suppression (intrusion/erreur signalée) ->', chatId)
  } catch (e) { console.log('self-delete err:', e?.message) }
}

// ---- Auto-remplissage du calendrier : détecte les événements annoncés par les admins ----
const CAL_HINT_RE = /\b(session|meeting|meet\b|call|webinar|deadline|due|today|tomorrow|demain|aujourd'hui|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d{1,2}\s*(am|pm)|\d{1,2}h\d{0,2}|\b(cat|wat|eat|gmt)\b|teams\.(microsoft|live)|zoom\.|meet\.google)/i
async function maybeExtractCalendarEvent(text, now) {
  if (!text || text.length < 12 || !CAL_HINT_RE.test(text)) return
  const todayYmd = cal.ymdCAT(now)
  const todayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Africa/Maputo' }).format(now)
  try {
    const raw = await chat([
      { role: 'system', content: `Extract SCHEDULED programme events from an admin message. Today (CAT) is ${todayName} ${todayYmd}. Resolve relative dates (today/tomorrow/next Tuesday) to absolute YYYY-MM-DD. STRICT JSON only: {"events":[{"date":"YYYY-MM-DD","title":"short title","hhmm":"HH:MM or empty","tz":"CAT|WAT|EAT|GMT or empty","link":"meeting URL or empty"}]}. Only include REAL scheduled sessions/meetings/deadlines that have a clear date. If none, {"events":[]}.` },
      { role: 'user', content: text.slice(0, 700) },
    ], { max_tokens: 300, priority: 'low' })
    const d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0])
    // L'URL de réunion peut être TRÈS longue (Teams meetup-join + context) et l'IA la tronque parfois.
    // On récupère donc l'URL COMPLÈTE directement dans le message brut (regex) et on la privilégie.
    const fullUrl = (text.match(/https?:\/\/[^\s)"'<>]+/g) || []).find((u) => /teams\.microsoft|zoom\.|meet\.google/i.test(u)) || ''
    for (const ev of (d.events || [])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !ev.title) continue
      if (cal.customEvents().some((c) => c.date === ev.date && (c.title || '').toLowerCase() === ev.title.toLowerCase())) continue // dédup
      const link = fullUrl || ev.link || '' // URL complète du message > lien (tronqué) de l'IA
      cal.addEvent({ date: ev.date, title: ev.title, hhmm: ev.hhmm || '', tz: ev.tz || 'CAT', time: ev.hhmm ? `${ev.hhmm} ${ev.tz || 'CAT'}` : '', link, type: link ? 'session' : 'event' })
      console.log('🗓️ Calendrier auto-rempli:', ev.date, ev.title, ev.link ? '(+lien -> auto-join)' : '')
    }
  } catch (e) { console.log('cal extract err:', e?.message) }
}

// ---- Auto-reconfig du planning : détecte les DÉCISIONS admin (annuler / reporter / changer la fréquence) ----
// Rend le système modulaire : quand un admin corrige le planning, le bot s'adapte sans édition de code.
const SCHED_CHANGE_RE = /\b(cancel|cancell|postpone|postpon|resched|reschedul|moved? to|move it|skip|skipping|no (meeting|session|open ?hour|class)|not (happening|today)|instead of|rather than|twice (a|per) (week|month|día)|once (a|per) (week|month)|every (other )?(week|month)|no longer|won'?t (be|happen)|pushed to|shifted to|changed? to|report[ée]|annul|repouss|d[ée]cal|au lieu de|plus de (r[ée]union|session)|deux fois par (semaine|mois))\b/i
async function maybeExtractScheduleChange(text, now) {
  if (!text || text.length < 8 || !SCHED_CHANGE_RE.test(text)) return
  const todayYmd = cal.ymdCAT(now)
  const todayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Africa/Maputo' }).format(now)
  try {
    const raw = await chat([
      { role: 'system', content: `An ADMIN is changing the programme schedule. Today (CAT) is ${todayName} ${todayYmd}. Resolve relative dates to absolute YYYY-MM-DD. Extract their scheduling DECISIONS as STRICT JSON only: {"ops":[...]}. Each op is ONE of:
{"op":"cancel","target":"session keyword (e.g. Open Hour, Wadhwani)","date":"YYYY-MM-DD or empty"}  (empty date = cancelled until further notice)
{"op":"reschedule","target":"...","date":"YYYY-MM-DD original","newDate":"YYYY-MM-DD"}
{"op":"note","text":"a short correction to remember, e.g. 'Open Hours run twice a month, not weekly'"}
ONLY output real admin scheduling decisions (cancel / postpone / skip / move / frequency change). Casual chat or questions => {"ops":[]}.` },
      { role: 'user', content: text.slice(0, 700) },
    ], { max_tokens: 250, priority: 'low' })
    const d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0])
    for (const op of (d.ops || [])) {
      if (!op || !['cancel', 'reschedule', 'note'].includes(op.op)) continue
      if (op.op !== 'note' && !op.target) continue
      if (op.op === 'note' && !op.text) continue
      const n = cal.addOverride(op)
      console.log('🔧 Planning auto-ajusté (admin):', JSON.stringify(op), `(${n} overrides)`)
    }
  } catch (e) { console.log('sched change err:', e?.message) }
}

// ---- Fil récent du groupe (pour "quoi de neuf aujourd'hui ?", résumés) ----
const RECENT_MAX = 250
const groupRecent = new Map() // chatId -> [{time, name, text, id, senderId}]
function recentPush(chatId, name, text, time, id, senderId) {
  const a = groupRecent.get(chatId) || []
  a.push({ time, name, text, id, senderId })
  while (a.length > RECENT_MAX) a.shift()
  groupRecent.set(chatId, a)
}
function recentGet(chatId, n = 70) { return (groupRecent.get(chatId) || []).slice(-n) }

// --- Repli / rattrapage : questions ratées ré-traitées plus tard ---
const HANDLED_FILE = path.join(__dirname, 'data', 'handled-msgs.json')
let handled = new Set((() => { try { return JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf8')) } catch { return [] } })())
function markHandled(id) {
  if (!id) return
  handled.add(id)
  if (handled.size > 3000) handled = new Set([...handled].slice(-2000))
  try { writeJsonAtomic(HANDLED_FILE, [...handled]) } catch {}
}

// ---- Veilleur / alertes (plugin schedule.computeDueAlerts -> envoi routé par canal) ----
// Wadhwani -> uniquement le groupe Wadhwani ; tout le reste (+ digest) -> groupe METI.
const METI_GROUP = process.env.METI_GROUP || '' // main programme group
const WADHWANI_GROUP = process.env.WADHWANI_GROUP || '' // Wadhwani-only group
// METI reçoit TOUT ; les alertes Wadhwani vont AUSSI (doublon voulu) dans le groupe Wadhwani.
function alertTargets(channel) { return channel === 'wadhwani' ? [METI_GROUP, WADHWANI_GROUP] : [METI_GROUP] }
const FIRED_FILE = path.join(__dirname, 'data', 'fired-alerts.json')
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true })
function loadFired() { try { return new Set(JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'))) } catch { return new Set() } }
function saveFired(s) { writeJsonAtomic(FIRED_FILE, [...s]) }
let currentSock = null
let alertLoopStarted = false
let alertRunning = false
async function alertCycle() {
  if (!currentSock || emergencyStop || alertRunning) return
  if (!groupAnswerOn()) return // groupes coupés -> pas de digests/recaps/alertes non plus (silence total)
  alertRunning = true
  try {
  const fired = loadFired()
  const due = computeDueAlerts(new Date(), fired)
  for (const a of due) {
    try {
      if (a.type === 'text') {
        for (const g of alertTargets(a.channel)) await currentSock.sendMessage(g, waMsg(a.text))
        console.log('🔔 alerte:', a.key, '->', a.channel)
      } else if (a.type === 'digest') {
        const d = await dailyDigest(recentGet(METI_GROUP, 120))
        if (d) { await currentSock.sendMessage(METI_GROUP, waMsg(d)); console.log('🌙 digest envoyé') }
      } else if (a.type === 'wadhwani-recap') {
        const w = await wadhwaniRecap()
        if (w) { await currentSock.sendMessage(WADHWANI_GROUP, waMsg(w)); console.log('🎓 récap Wadhwani envoyé') }
      }
      fired.add(a.key); saveFired(fired) // marque comme traité (aussi les 'skip')
    } catch (e) { console.log('alerte err:', e?.message) } // pas de fired.add -> réessai au prochain tick
  }
  } finally { alertRunning = false }
}
function startAlertLoop() {
  if (alertLoopStarted) return
  alertLoopStarted = true
  setInterval(() => alertCycle().catch(() => {}), 60000)
  setInterval(() => catchUp().catch(() => {}), 4 * 60000) // repli : rattrape les questions ratées
  setInterval(() => drainOutbox().catch(() => {}), 30000) // recaps / messages déposés par le planificateur
}

// ---- Boîte d'envoi (outbox) : un process externe dépose un {group,text} JSON -> le bot l'envoie ----
// Sert notamment aux recaps de fin de réunion générés par le planificateur Vexa.
const OUTBOX_DIR = path.join(__dirname, 'data', 'outbox')
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true })
let outboxRunning = false
async function drainOutbox() {
  if (!currentSock || emergencyStop || outboxRunning) return
  outboxRunning = true
  try {
    let files = []
    try { files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json')).sort() } catch { return } // tri = ordre d'envoi
    for (const f of files) {
      const p = path.join(OUTBOX_DIR, f)
      let item
      try { item = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { try { fs.unlinkSync(p) } catch {}; continue }
      // Groupes coupés : on ne sort QUE les envois marqués force:true (envois volontaires, ex. owner).
      // Les envois auto (recaps réunion, etc.) restent en attente jusqu'au /resume.
      if (!groupAnswerOn() && !item.force) continue
      try { fs.unlinkSync(p) } catch {} // supprime AVANT envoi -> jamais de doublon
      for (const g of (item.groups || [item.group]).filter(Boolean)) {
        try {
          if (item.greetAll) {
            // tague TOUS les membres du groupe dans un seul message + les salue
            const meta = await currentSock.groupMetadata(g)
            const parts = meta.participants.map((pp) => pp.id).filter((j) => j && numOf(j) !== (process.env.PHONE || ''))
            const tags = parts.map((j) => '@' + numOf(j)).join(' ')
            await currentSock.sendMessage(g, { text: `${item.text || ''}\n\n${tags}`.trim(), mentions: parts })
            for (const j of parts) { const mm = arenaGet(j); mm.greeted = true }
            arenaSave()
            console.log('📣 outbox greetAll ->', g, parts.length, 'membres')
          } else if (item.image) await currentSock.sendMessage(g, { image: { url: item.image }, caption: item.caption || undefined })
          else if (item.poll) await currentSock.sendMessage(g, { poll: { name: item.poll.name, values: item.poll.values, selectableCount: item.poll.selectableCount ?? 1 } })
          else if (item.text && item.mentions) await currentSock.sendMessage(g, { text: item.text, mentions: item.mentions })
          else if (item.text) await currentSock.sendMessage(g, waMsg(item.text))
          console.log('📤 outbox ->', g, item.greetAll ? '(greetAll)' : item.image ? '(image)' : item.poll ? '(poll)' : '(text)')
          await new Promise((r) => setTimeout(r, 1500)) // petit délai -> ordre respecté à l'affichage
        } catch (e) { console.log('outbox err:', e?.message) }
      }
    }
  } finally { outboxRunning = false }
}

// Repli : reprend les questions récentes non traitées et y répond (en taguant l'auteur).
let catchUpRunning = false
async function catchUp() {
  if (!groupAnswerOn()) return // réponses groupe coupées -> pas de rattrapage groupe non plus
  if (!currentSock || emergencyStop || catchUpRunning) return
  catchUpRunning = true
  try {
  const now = Date.now(), MAXAGE = 45 * 60000
  for (const group of ANSWER_GROUPS) {
    if (arenaOn() && group === ARENA_GROUP) continue // le groupe Arène est géré par l'orchestrateur
    for (const e of recentGet(group, 40)) {
      if (!e.id || handled.has(e.id)) continue
      const ts = e.time ? Date.parse(e.time) : now
      if (now - ts < 60000) continue // trop récent -> on laisse la voie live y répondre d'abord
      if (!e.text || e.text.trim().length < 3 || now - ts > MAXAGE) { markHandled(e.id); continue }
      if (isForOtherBot(e.text)) { markHandled(e.id); continue } // adressé à un autre bot -> on ignore
      try {
        const { reply, skipped } = await answerAuto(e.text, [], recentGet(group), { wadhwaniOnly: group === WADHWANI_ANSWER_GROUP })
        if (!skipped && reply) {
          const base = waMsg(reply)
          const num = (e.senderId || '').split('@')[0]
          const text = (num ? `↩️ @${num} ` : '') + base.text
          const mentions = [...(base.mentions || []), ...(e.senderId ? [e.senderId] : [])]
          await currentSock.sendMessage(group, mentions.length ? { text, mentions } : { text })
          console.log('🔁 Rattrapage — répondu à', e.name)
        }
        markHandled(e.id)
      } catch (err) { console.log('rattrapage err (re-essai +tard):', err?.message) }
    }
  }
  } finally { catchUpRunning = false }
}

// ---- Mémoire de conversation court-terme (par utilisateur, dans le groupe) ----
const HIST_MAX = 20 // ~10 échanges question/réponse
const convos = new Map() // clé: chatId|senderId -> [{role, text}]
function histGet(key) { return convos.get(key) || [] }
function histPush(key, role, text) {
  const a = convos.get(key) || []
  a.push({ role, text })
  while (a.length > HIST_MAX) a.shift()
  convos.set(key, a)
}

// ---- Message d'au revoir (prêt, envoyé sur commande /goodbye) ----
const GOODBYE_MSG = `Hi everyone 👋

It's been a real joy being part of this cohort during the test period. Thank you for talking with me, challenging me, and even trying to trip me up 😄 — I learned a lot from you.

If I helped you catch up on something, find an answer, or get a document, then it did its job. My testing window with the group is wrapping up now, so I'll be stepping back from answering here in the group.

But I'm not going anywhere — you can still *message me privately anytime*. I'm always available in *DM* to help with programme info, deadlines, sessions, documents and anything you might miss.

Thank you all, and best of luck with your projects 🙌`

// ---- Panneau de contrôle OWNER (commandes par DM) ----
const GROUP_ALIASES = () => ({ meti: METI_GROUP, wadhwani: WADHWANI_GROUP, general: CONTROL_GROUP, arena: ARENA_GROUP })
async function handleOwnerCommand(sock, jid, text) {
  const parts = text.trim().split(/\s+/)
  const c = parts[0].toLowerCase()
  const rest = parts.slice(1)
  const reply = (t) => sock.sendMessage(jid, { text: t })
  const A = GROUP_ALIASES()
  try {
    if (c === '/help' || c === '/start') return reply(`*Owner control panel* 🛠️\n\n/status — santé + config\n/pause — couper les réponses de groupe\n/resume — rallumer les réponses de groupe\n/arena on|off — activer/couper l'Arène\n/react on|off — réactions emoji dans les groupes (sans répondre)\n/goodbye — poster le message d'au revoir dans METI + couper les groupes\n/say <meti|wadhwani|general|arena> <texte> — poster un message\n/send <meti|wadhwani|general|arena> <document> [fr|en] — envoyer un document\n/docs — lister les documents\n/cal — voir le calendrier · /cal add AAAA-MM-JJ <titre> — ajouter un événement\n/selftest — tester réaction + édition + suppression\n/help — cette aide`)
    if (c === '/status') return reply(`*Status* 🩺\nGroup answers: ${groupAnswerOn() ? 'ON ✅' : 'OFF ⛔'}\nArena: ${arenaOn() ? 'ON ✅' : 'OFF ⛔'}\nGroup reactions: ${groupReactOn() ? 'ON ✅' : 'OFF ⛔'}\nDocuments: ${docs.all().length}\nUptime: ${Math.round(process.uptime() / 60)} min`)
    if (c === '/pause') { runtime.groupAnswer = false; rtSave(); return reply('⏸️ Réponses de groupe *en pause*. (/resume pour rallumer)') }
    if (c === '/resume') { runtime.groupAnswer = true; rtSave(); return reply('▶️ Réponses de groupe *réactivées*.') }
    if (c === '/arena') { runtime.arena = /on|1|oui|true/i.test(rest[0] || ''); rtSave(); return reply('🦈 Arène ' + (runtime.arena ? 'ON ✅' : 'OFF ⛔')) }
    if (c === '/react') {
      const a = (rest[0] || '').toLowerCase()
      const levels = { off: 0, low: 0.2, med: 0.33, high: 0.66 }
      if (a === 'off') { runtime.groupReact = false; rtSave(); return reply('😊 Réactions de groupe *OFF* ⛔') }
      if (a in levels) { runtime.groupReact = true; runtime.reactRate = levels[a]; rtSave(); return reply(`😊 Réactions *ON* ✅ — niveau *${a}* (${Math.round(levels[a] * 100)}%)`) }
      if (/^0?\.\d+$|^[01]$/.test(a)) { runtime.groupReact = true; runtime.reactRate = Number(a); rtSave(); return reply(`😊 Réactions *ON* ✅ — taux ${Math.round(Number(a) * 100)}%`) }
      if (/on|1|oui|true/i.test(a)) { runtime.groupReact = true; rtSave(); return reply(`😊 Réactions *ON* ✅ (niveau ${Math.round(reactRate() * 100)}%)`) }
      return reply(`😊 Réactions: ${groupReactOn() ? 'ON' : 'OFF'} — taux ${Math.round(reactRate() * 100)}%\nUsage: /react off | low | med | high | <0-1>`)
    }
    if (c === '/docs') return reply('*Documents disponibles*\n' + docs.all().map((d) => `• ${d.title}`).join('\n'))
    if (c === '/cal') {
      if ((rest[0] || '').toLowerCase() === 'add') {
        const date = rest[1]; const title = rest.slice(2).join(' ')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !title) return reply('Usage: /cal add YYYY-MM-DD <titre>')
        const n = cal.addEvent({ date, title })
        return reply(`🗓️ Ajouté au calendrier : *${title}* le ${date}. (${n} événements custom)`)
      }
      return reply(cal.agenda())
    }
    if (c === '/selftest') {
      const sent = await sock.sendMessage(jid, { text: '🧪 Self-test — I will react to, edit, then delete this message…' })
      await new Promise((r) => setTimeout(r, 1500))
      await sock.sendMessage(jid, { react: { text: '🔥', key: sent.key } })
      await new Promise((r) => setTimeout(r, 1500))
      await sock.sendMessage(jid, { text: '🧪 Self-test — *EDITED* ✏️ (react ✅ edit ✅). Deleting in 2s…', edit: sent.key })
      await new Promise((r) => setTimeout(r, 2000))
      await sock.sendMessage(jid, { delete: sent.key })
      return reply('✅ Self-test done — *react + edit + delete* all work. (the test message just vanished)')
    }
    if (c === '/goodbye') {
      await sock.sendMessage(METI_GROUP, { text: GOODBYE_MSG })
      runtime.groupAnswer = false; rtSave()
      return reply('👋 Message d\'au revoir posté dans METI + réponses de groupe coupées.')
    }
    if (c === '/say') {
      const g = A[(rest[0] || '').toLowerCase()]; const msg = rest.slice(1).join(' ')
      if (!g || !msg) return reply('Usage: /say <meti|wadhwani|general|arena> <texte>')
      await sock.sendMessage(g, waMsg(msg)); return reply('✅ Envoyé.')
    }
    if (c === '/send') {
      const g = A[(rest[0] || '').toLowerCase()]; const docq = rest.slice(1).join(' ')
      if (!g || !docq) return reply('Usage: /send <meti|wadhwani|general|arena> <document> [fr|en]')
      if (await sendDocumentIfRequested(sock, g, 'please send the ' + docq)) return reply('✅ Document envoyé.')
      return reply('❓ Document introuvable. Essaie /docs pour voir la liste.')
    }
    return reply('Commande inconnue. Tape /help')
  } catch (e) { return reply('⚠️ Erreur commande: ' + (e?.message || '')) }
}

// ---- Traitement d'un message privé (DM) ----
// Fenêtre 2h30 globale + limite 20 msgs/membre. Répond toujours (jamais silencieux).
async function handleDM(sock, jid, name, rawText, m) {
  if (emergencyStop) return
  if (dmSeen.has(m.key.id)) return // dédup : déjà traité
  dmMarkSeen(m.key.id)
  // OWNER : commandes de contrôle (prioritaire, sans fenêtre ni limite)
  if (isOwner(jid) && (rawText || '').trim().startsWith('/')) { await handleOwnerCommand(sock, jid, rawText); return }
  const mem = usermem.get(jid)
  const w = ensureDmWindow()
  // Fenêtre d'essai terminée -> un seul mot de fin (aux membres déjà en contact), puis silence.
  if (!DM_ALWAYS_OPEN && Date.now() > w.openUntil) {
    if (mem.count > 0 && !mem.endNotified) {
      mem.endNotified = true; usermem.save()
      try { await sock.sendMessage(jid, { text: "The private-message trial is closed for now 🙏 You can still ask anything in the group. Thanks!" }) } catch {}
    }
    return
  }
  // Limite par membre : après 20 messages, un dernier mot puis stop. (owner = illimité)
  if (!isOwner(jid) && usermem.count(jid) >= DM_MAX_PER_MEMBER) {
    if (!mem.limitNotified) {
      mem.limitNotified = true; usermem.save()
      try { await sock.sendMessage(jid, { text: "You've reached the message limit for this trial 🙏 I won't be able to reply more for now, but you can always ask in the group. Thanks!" }) } catch {}
    }
    return
  }
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {})
    // NB: pas de message d'accueil séparé (évite le "double message" au 1er contact) ;
    // l'auto-présentation est intégrée à la 1re réponse par answerDM (voir FIRST CONTACT).
    const firstContact = usermem.history(jid).length === 0
    // Texte effectif : brut, ou OCR (image/PDF), ou transcription (note vocale).
    const text = await dmEffectiveText(sock, m, rawText)
    if (!text || DM_PLACEHOLDERS.has(text.trim())) {
      // Média illisible (transcription/OCR vide) : on s'excuse sans consommer le quota.
      try { await sock.sendMessage(jid, { text: "Sorry, I couldn't read that 🙏 Could you type your question?" }) } catch {}
      return
    }
    dmLog(name, jid, 'user', text)
    const effText = withQuotedContext(m, text) // inclut le message cité si l'utilisateur répond à un message
    // Demande de document en DM ?
    if (await sendDocumentIfRequested(sock, jid, effText, undefined, usermem.history(jid).slice(-6).map((h) => `${h.role}: ${h.text}`).join('\n'))) {
      usermem.push(jid, 'user', text); usermem.bumpCount(jid)
      dmLog(name, jid, 'bot', '[document envoyé]')
      console.log('📎 DM: document envoyé à', name)
      return
    }
    const reply = await answerDM(effText, usermem.history(jid), usermem.notes(jid), { firstContact })
    usermem.push(jid, 'user', text)
    if (reply) {
      await sock.sendMessage(jid, waMsg(reply))
      usermem.push(jid, 'assistant', reply)
      dmLog(name, jid, 'bot', reply)
      usermem.bumpCount(jid) // quota consommé seulement sur une réponse réussie
      console.log('📩 DM répondu à', name, `(${usermem.count(jid)}/${DM_MAX_PER_MEMBER})`)
    } else {
      // Garantie DM : le modèle a renvoyé du vide -> on ne laisse JAMAIS le membre sans réponse.
      await sock.sendMessage(jid, { text: "Sorry, I didn't catch that 🙏 Could you rephrase your question about the UniPods METI AI programme?" })
      dmLog(name, jid, 'bot', '[fallback: empty reply]')
      console.log('⚠️ DM réponse vide -> fallback envoyé à', name)
    }
    usermem.maybeCompact(jid).catch(() => {}) // résumé en arrière-plan, ne bloque pas la réponse
  } catch (e) {
    // LLM temporairement indisponible (panne du fournisseur) -> message d'attente au lieu du silence total.
    const llmDown = /LLM (429|503)|model_request_failed|high traffic|temporarily unavailable|service is temporarily/i.test(e?.message || '')
    if (llmDown) {
      try { await sock.sendMessage(jid, { text: "Je suis un peu surchargé en ce moment 🙏 Réessaie dans quelques minutes et je te répondrai." }) } catch {}
      // on garde le message comme "vu" (pas de boucle de ré-essai pendant la panne)
      console.log('⏳ LLM indisponible -> message d\'attente envoyé à', name)
    } else {
      dmSeen.delete(m.key.id) // autre erreur -> autorise une nouvelle tentative, quota non consommé
      console.log('❌ Echec réponse DM (re-essai possible):', e?.message)
    }
  }
}

// ---- Annonce one-shot : envoie un message préparé (data/pending-announce.json) puis le supprime ----
const ANNOUNCE_FILE = path.join(__dirname, 'data', 'pending-announce.json')
async function sendPendingAnnounce(sock) {
  let items
  try { items = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')) } catch { return }
  if (!Array.isArray(items) || !items.length) return
  try { fs.unlinkSync(ANNOUNCE_FILE) } catch {} // supprime AVANT envoi -> jamais de doublon si reconnexion
  for (const it of items) {
    for (const g of (it.groups || [])) {
      try { await sock.sendMessage(g, waMsg(it.text)); console.log('📣 Annonce envoyée ->', g) }
      catch (e) { console.log('annonce envoi err:', e?.message) }
    }
  }
}

// ---- Arène : orchestre les tours (pitch -> questions -> relance -> verdict) dans le groupe ----
async function sendArena(sock, chatId, text, quoted) {
  const res = await sock.sendMessage(chatId, waMsg(text), quoted ? { quoted } : {})
  rememberBotMsg(chatId, res) // pour l'auto-suppression si intrusion signalée
}

// Accueil d'un nouveau membre (salutation + recap) — seulement si quorum atteint.
async function arenaGreet(sock, chatId, jid, name) {
  if (arenaMemberCount && arenaMemberCount < ARENA_QUORUM) return
  const mem = arenaGet(jid)
  if (mem.greeted) return
  mem.greeted = true; arenaSave()
  const recap = await arenaRecapText()
  const num = numOf(jid)
  const hi = `👋 Welcome ${num ? '@' + num + ' ' : ''}to the *Pitch Arena*! I'm here to get to know your project and help you see things you might not have noticed — friendly, no pressure.` +
    (recap ? `\n\n${recap}` : '') +
    `\n\nWhenever you're ready, tell me in a line or two: *what are you building, and for whom?*`
  try { await sock.sendMessage(chatId, { text: hi, mentions: num ? [jid] : [] }); console.log('👋 Arène: accueilli', num) } catch (e) { console.log('accueil err:', e?.message) }
}

// Clôture (après l'interview) : analyse marché -> sources -> sortie des agents -> feedback final.
async function runArenaClosing(sock, chatId, senderId) {
  const mem = arenaGet(senderId)
  try {
    const { analysis, sources, notes } = await marketBrief(mem.profile)
    mem.marketNotes = notes || ''
    if (analysis) await sendArena(sock, chatId, `📊 *Quick market read for you:*\n\n${analysis}`)
    if (sources) await sendArena(sock, chatId, `🔗 *Where this comes from:*\n${sources}`)
    const takes = await panelTakes(mem.profile, mem.marketNotes) // la sortie des agents
    if (takes) await sendArena(sock, chatId, `🎤 *The panel weighs in:*\n\n${takes}`)
    const fb = await finalFeedback(mem.profile, arenaHist(mem, 20), mem.marketNotes) // le feedback
    if (fb) await sendArena(sock, chatId, `✨ ${fb}`)
    mem.stage = 'done'; arenaSave()
    console.log('✨ Arène terminée pour', (senderId || '').split('@')[0])
  } catch (e) { console.log('❌ Arène clôture err:', e?.message) }
}

// Parcours progressif : interview -> (assez d'infos) -> marché+sources -> juge -> feedback final.
async function handleArena(sock, chatId, senderId, name, text, m) {
  if (emergencyStop) return
  if (handled.has(m.key.id)) return
  if (arenaMemberCount && arenaMemberCount < ARENA_QUORUM) { markHandled(m.key.id); return } // quorum
  if (await sendDocumentIfRequested(sock, chatId, text, m, recentGet(chatId, 8).map((r) => `${r.name}: ${r.text}`).join('\n'))) { markHandled(m.key.id); return } // demande de document
  const mem = arenaGet(senderId)
  try {
    // ---- Filtre "à qui s'adresse le message ?" : ne pas couper la parole entre participants ----
    const ctx = m.message?.extendedTextMessage?.contextInfo || {}
    // identités du bot (numéro + jid + lid) car en groupe la mention arrive souvent en @lid
    const botIds = new Set([
      process.env.PHONE || '',
      (sock.user?.id || '').split(':')[0].split('@')[0],
      (sock.user?.lid || '').split(':')[0].split('@')[0],
    ].filter(Boolean))
    const quotedNum = numOf(ctx.participant)
    const mentioned = (ctx.mentionedJid || []).map((j) => numOf(j))
    const mentionsBot = mentioned.some((n) => botIds.has(n))
    const quotedBot = quotedNum && botIds.has(quotedNum)
    const repliesToOther = quotedNum && !quotedBot
    const mentionsOtherOnly = mentioned.length > 0 && !mentionsBot
    const isQuestion = /\?/.test(text) ||
      /^(how|what|when|where|why|who|which|can|could|do|does|is|are|should|tell|explain|give|help|show|advise|walk|make)\b/i.test(text.trim()) ||
      /\b(tell me|what do you think|how would you|help me|explain|advise me|walk me through)\b/i.test(text)
    const inActiveConvo = (mem.history || []).some((h) => h.role === 'assistant') // le bot leur a déjà répondu -> échange en cours
    let respond
    if (mentionsBot || quotedBot) respond = true          // on me tague / on répond à MON message -> je réponds
    else if (repliesToOther || mentionsOtherOnly) respond = false // clairement adressé à un autre -> je me tais
    else if (isQuestion || inActiveConvo) respond = true  // question/demande OU conversation déjà en cours avec moi -> je réponds
    else {
      // ambigu -> le décideur tranche (en tenant compte de l'état de l'interview)
      const statusLine = mem.stage === 'done' ? 'already finished their session'
        : mem.stage === 'judge' ? 'you asked them panel questions and are awaiting their answer'
        : mem.profile ? 'in the middle of their project interview with you (you just asked them a question)'
        : 'has not started — first message'
      const recentGroup = recentGet(chatId, 12).map((r) => `${r.name}: ${r.text}`).join('\n')
      respond = await shouldRespond(text, recentGroup, statusLine)
    }
    if (!respond) { maybeReact(sock, chatId, m, text).catch(() => {}); markHandled(m.key.id); console.log('🤫 Arène: silence (entre participants) —', name); return }

    await sock.sendPresenceUpdate('composing', chatId).catch(() => {})
    mem.greeted = true // s'il parle, inutile de le re-saluer
    mem.history.push({ role: 'user', text })
    if (mem.stage === 'closing') { markHandled(m.key.id); return } // clôture en cours -> on n'interrompt pas
    if (mem.stage === 'done') {
      // session finie : on répond quand même aux questions (hôte général)
      const reply = await hostReply(text, mem.profile, arenaHist(mem, 10))
      if (reply) { await sendArena(sock, chatId, reply, m); mem.history.push({ role: 'assistant', text: reply }) }
      markHandled(m.key.id); arenaSave(); return
    }

    // Interview légère (1-2 questions max), puis clôture automatique.
    const turns = (mem.history || []).filter((h) => h.role === 'assistant').length
    const r = await interviewStep(mem.profile, arenaHist(mem), text, turns)
    mem.profile = r.notes || mem.profile
    if (!mem.title && mem.profile) mem.title = mem.profile.split('\n')[0].replace(/^[-*•\s]+/, '').slice(0, 60)
    if (r.reply) { await sendArena(sock, chatId, r.reply, m); mem.history.push({ role: 'assistant', text: r.reply }) }
    if (r.enough) {
      mem.stage = 'closing'; arenaSave()
      await runArenaClosing(sock, chatId, senderId) // marché -> sources -> agents -> feedback
    }
    markHandled(m.key.id)
    arenaSave()
  } catch (e) { console.log('❌ Arène err:', e?.message) }
}

// ---- Réponse à un message de GROUPE (en arrière-plan, prioritaire côté LLM) ----
async function handleGroupAnswer(sock, chatId, key, entry, m) {
  if (emergencyStop) return
  if (handled.has(m.key.id)) return // dédup : déjà traité (redélivrance notify/append)
  try {
    const effText = withQuotedContext(m, entry.text) // inclut le message cité si c'est un reply
    if (await sendDocumentIfRequested(sock, chatId, effText, m, recentGet(chatId, 8).map((r) => `${r.name}: ${r.text}`).join('\n'))) { markHandled(m.key.id); return } // demande de document
    const { reply, skipped } = await answerAuto(effText, histGet(key), recentGet(chatId), {
      wadhwaniOnly: chatId === WADHWANI_ANSWER_GROUP,
    })
    if (!skipped && reply) {
      await sock.sendPresenceUpdate('composing', chatId).catch(() => {})
      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1800))) // délai humain 1,2–3 s (anti-ban)
      const res = await sock.sendMessage(chatId, waMsg(reply), { quoted: m })
      rememberBotMsg(chatId, res) // pour l'auto-suppression si intrusion signalée
      histPush(key, 'user', entry.text)
      histPush(key, 'assistant', reply)
      console.log('🤖 Réponse au groupe envoyée à', entry.senderName)
    } else {
      maybeReact(sock, chatId, m, entry.text).catch(() => {}) // pas de réponse -> réagit parfois (personnalité)
    }
    markHandled(m.key.id) // traité (répondu OU volontairement ignoré)
  } catch (e) {
    console.log('❌ Echec réponse cerveau (à rattraper):', e?.message) // pas de markHandled -> rattrapage
  }
}

const LOG_DIR = path.join(__dirname, 'logs')
const AUTH_DIR = path.join(__dirname, 'auth')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR)

// Fichiers de log :
//  - messages.jsonl : une ligne JSON par message (pour traitement / parsing)
//  - messages.txt   : version lisible à l'œil
const jsonlPath = path.join(LOG_DIR, 'messages.jsonl')
const txtPath = path.join(LOG_DIR, 'messages.txt')

const ask = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (a) => {
      rl.close()
      resolve(a.trim())
    })
  })

// Extrait le texte d'un objet message (conversation, texte étendu, légendes, ou placeholder).
function textOfMsg(msg) {
  msg = msg || {}
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    (msg.imageMessage ? '[image]' : '') ||
    (msg.videoMessage ? '[vidéo]' : '') ||
    (msg.audioMessage ? '[audio]' : '') ||
    (msg.stickerMessage ? '[sticker]' : '') ||
    (msg.documentMessage ? '[document]' : '') ||
    ''
  )
}
// Extrait le texte quel que soit le type de message
function extractText(m) { return textOfMsg(m.message) }
// Texte du message CITÉ (reply/quote), s'il y en a un — pour que le bot comprenne "de quoi on parle".
function quotedText(m) {
  const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
  return q ? textOfMsg(q).trim() : ''
}
// Construit le texte "effectif" : si c'est une réponse à un autre message, on préfixe le message cité.
function withQuotedContext(m, text) {
  const q = quotedText(m)
  if (!q || q === text) return text
  return `(in reply to: "${q.slice(0, 300)}") ${text}`
}

const announcePath = path.join(LOG_DIR, 'announcements.jsonl')

function logMessage(entry) {
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n')
  const tag = entry.isAnnouncement ? '📢 ' : ''
  const line = `[${entry.time}] ${tag}[${entry.groupName || entry.chatId}] ${entry.senderName} (${entry.senderId}): ${entry.text}\n`
  fs.appendFileSync(txtPath, line)
  // Copie prioritaire des annonces dans un fichier dédié
  if (entry.isAnnouncement) fs.appendFileSync(announcePath, JSON.stringify(entry) + '\n')
  console.log(line.trim())
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false, // reste discret
  })
  currentSock = sock // le veilleur enverra via cette socket
  startAlertLoop() // démarre le tick minute (une seule fois)
  const _w = ensureDmWindow() // arme le minuteur DM (2h30) dès le lancement
  console.log(`📩 DM window ouverte jusqu'à ${new Date(_w.openUntil).toISOString()} (limite ${DM_MAX_PER_MEMBER}/membre)`)

  // ---- Connexion par CODE (pas de QR) ----
  if (!sock.authState.creds.registered) {
    let phone = process.env.PHONE || process.argv[2]
    if (!phone) {
      phone = await ask(
        'Numéro du bot au format international SANS + ni espaces (ex: 33612345678) : '
      )
    }
    phone = phone.replace(/[^0-9]/g, '')
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone)
        console.log('\n==============================')
        console.log('  CODE DE JUMELAGE : ' + code)
        console.log('==============================')
        console.log('Sur ton téléphone : WhatsApp > Appareils connectés >')
        console.log('Connecter un appareil > Se connecter avec un numéro de téléphone,')
        console.log('puis entre ce code.\n')
      } catch (e) {
        console.error('Erreur pairing code:', e?.message || e)
      }
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'open') {
      console.log('✅ Connecté. En écoute des messages...')
      sendPendingAnnounce(sock).catch((e) => console.log('annonce err:', e?.message))
      sock
        .groupFetchAllParticipating()
        .then((groups) => {
          const list = Object.values(groups)
          const ag = list.find((g) => g.id === ARENA_GROUP)
          if (ag) { arenaMemberCount = ag.participants.length; console.log(`🏆 Pitch Arena: ${arenaMemberCount} membre(s) (quorum ${ARENA_QUORUM})`) }
          console.log(`\n📋 Membre de ${list.length} groupe(s) :`)
          list.forEach((g, i) => {
            const flags = []
            if (g.announce) flags.push('ANNONCES(admins only)')
            if (g.isCommunityAnnounce) flags.push('COMMUNITY-ANNOUNCE')
            if (g.isCommunity) flags.push('COMMUNITY-PARENT')
            if (g.linkedParent) flags.push('sub-of:' + g.linkedParent)
            console.log(
              `  ${i + 1}. ${g.subject}  (${g.id}) — ${g.participants.length} membres ${flags.length ? '[' + flags.join(', ') + ']' : ''}`
            )
          })
          console.log('')
        })
        .catch((e) => console.log('Impossible de lister les groupes:', e?.message))
    } else if (connection === 'close') {
      if (emergencyStop) { console.log('🛑 Emergency stop — pas de reconnexion.'); return }
      const code = lastDisconnect?.error?.output?.statusCode
      const reconnect = code !== DisconnectReason.loggedOut
      console.log('❌ Déconnecté (code ' + code + '). Reconnexion:', reconnect)
      if (reconnect) start()
      else console.log('Session fermée. Supprime le dossier "auth" pour re-jumeler.')
    }
  })

  // ---- Arène : arrivées/départs de membres -> compteur quorum + accueil ----
  sock.ev.on('group-participants.update', async (ev) => {
    if (!arenaOn() || ev.id !== ARENA_GROUP) return
    try {
      const meta = await sock.groupMetadata(ARENA_GROUP)
      arenaMemberCount = meta.participants.length
    } catch {}
    console.log(`👥 Pitch Arena participants.update: ${ev.action} (${(ev.participants || []).length}) -> ${arenaMemberCount} membres`)
    if (ev.action === 'add') {
      // annonce d'ouverture quand le quorum est atteint pour la 1re fois
      if (arenaMemberCount >= ARENA_QUORUM && !arenaOpenAnnounced) {
        arenaOpenAnnounced = true
        try { await sock.sendMessage(ARENA_GROUP, { text: `🏆 We've reached ${arenaMemberCount} members — the *Pitch Arena* is now open! Tell me about your project whenever you're ready 🙂` }) } catch {}
      }
      // accueil individuel (seulement si quorum atteint), sérialisé + petit délai (anti-flood)
      for (const raw of ev.participants || []) {
        // le participant peut arriver comme string, objet {id}, ou nombre -> on normalise en jid string
        const jid = (raw && typeof raw === 'object') ? (raw.id || raw.jid || '') : String(raw || '')
        if (!jid || numOf(jid) === (process.env.PHONE || '')) continue // pas le bot lui-même
        await arenaGreet(sock, ARENA_GROUP, jid, '').catch(() => {})
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
  })

  // Cache des noms de groupes pour éviter d'appeler l'API à chaque message
  const groupNames = {}
  async function getGroupName(chatId) {
    if (groupNames[chatId]) return groupNames[chatId]
    try {
      const meta = await sock.groupMetadata(chatId)
      groupNames[chatId] = meta?.subject || chatId
    } catch (_) {
      groupNames[chatId] = chatId
    }
    return groupNames[chatId]
  }

  // ---- Logging des messages ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    for (const m of messages) {
      const chatId = m.key.remoteJid || ''
      // ---- Messages privés (DM) : hors groupe -> handler dédié (fenêtre + limite) ----
      if (!chatId.endsWith('@g.us')) {
        if (m.key.fromMe) continue
        if (chatId === 'status@broadcast') continue // statuts WhatsApp, on ignore
        const dmText = extractText(m)
        // Sérialisé par membre (ordre garanti, pas d'écriture concurrente sur la mémoire).
        if (dmText && dmText.trim().length >= 2)
          dmEnqueue(chatId, () => handleDM(sock, chatId, m.pushName || 'inconnu', dmText, m))
        continue
      }
      const inLogged = !ALLOWED_GROUPS.length || ALLOWED_GROUPS.includes(chatId)
      const inAnswer = ANSWER_GROUPS.includes(chatId)
      const inArena = arenaOn() && chatId === ARENA_GROUP
      if (!inLogged && !inAnswer && !inArena) continue // ni loggé ni répondu ni arène -> ignore

      const senderId = m.key.participant || chatId // ID (jid) de la personne
      const entry = {
        time: new Date((m.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
        messageId: m.key.id,
        chatId,
        groupName: await getGroupName(chatId),
        senderId,
        senderNumber: numOf(senderId),
        senderName: m.pushName || 'inconnu',
        fromMe: m.key.fromMe || false,
        msgType: Object.keys(m.message || {}).filter((k) => k !== 'messageContextInfo')[0] || 'unknown',
        isAnnouncement: ANNOUNCE_GROUPS.includes(chatId),
        text: extractText(m),
      }
      // 🛑 Kill switch d'urgence : "STOP" dans le groupe de contrôle -> déconnexion
      if (!m.key.fromMe && chatId === CONTROL_GROUP && (entry.text || '').trim().toUpperCase() === 'STOP') {
        emergencyStop = true
        try { fs.writeFileSync(EMERGENCY_FILE, new Date().toISOString()) } catch {}
        console.log('🛑 EMERGENCY STOP déclenché depuis le groupe de contrôle')
        try { await sock.sendMessage(CONTROL_GROUP, { text: '🛑 Emergency stop activé — le bot se déconnecte et se met en pause.' }) } catch {}
        try { sock.end(new Error('emergency-stop')) } catch {}
        return
      }
      if (emergencyStop) return

      if (inLogged || inArena) logMessage(entry) // logge aussi le groupe Arène (utile pour le suivi/rattrapage)

      // Alimente le fil récent du groupe (messages des membres, hors bot)
      if (!m.key.fromMe && (entry.text || '').trim()) {
        recentPush(chatId, entry.senderName, entry.text, entry.time, m.key.id, senderId)
      }
      // Apprend le JID réel des admins quand ils postent (pour les taguer ensuite)
      if (!m.key.fromMe) learnJid(entry.senderName, senderId)

      // Auto-suppression : si quelqu'un signale une intrusion/erreur du bot -> il efface son message
      if (!m.key.fromMe && (inAnswer || inArena)) maybeSelfDelete(sock, chatId, m, entry.text).catch(() => {})

      // ---- Auto-transcription des recordings (liens postés par un admin / annonces) ----
      if (inLogged && !m.key.fromMe && (entry.isAnnouncement || roleOf(entry) === 'admin')) {
        const links = findRecordingLinks(entry.text || '')
        for (const link of links) {
          // 1) Faits en mémoire (via captions, si dispo) — anti-doublon interne
          processRecording(link, { caption: entry.text, ts: Date.parse(entry.time) || Date.now() })
            .catch((e) => console.log('transcribe bg err:', e?.message))
          // 2) INCRUSTATION AUTO HD -> sous-titres FR -> Drive (pipeline translator), anti-doublon par URL
          const fullUrl = link.type === 'youtube' ? `https://www.youtube.com/watch?v=${link.id}`
            : link.type === 'drive' ? `https://drive.google.com/file/d/${link.id}/view` : link.url
          incrust(fullUrl).catch((e) => console.log('incrust bg err:', e?.message))
        }
        // Auto-remplissage du calendrier depuis les annonces admin (dates/sessions/deadlines)
        maybeExtractCalendarEvent(entry.text || '', new Date()).catch(() => {})
        // Auto-reconfig du planning : décisions admin (annuler/reporter/changer la fréquence) -> overrides
        maybeExtractScheduleChange(entry.text || '', new Date()).catch(() => {})
      }

      // ---- Fichiers (PDF/images) : téléchargement + OCR + mémoire ----
      if (inLogged && OCR_ENABLED && !m.key.fromMe) {
        const mm = m.message || {}
        const doc = mm.documentMessage || mm.documentWithCaptionMessage?.message?.documentMessage
        const isPdf = !!doc && /pdf/i.test(doc.mimetype || doc.fileName || '')
        const isImg = !!mm.imageMessage
        // PDF : toujours. Image : seulement des admins / groupe Annonces (éviter d'OCR chaque meme).
        const wantOcr = isPdf || (isImg && (entry.isAnnouncement || roleOf(entry) === 'admin'))
        if (wantOcr) {
          // Fire-and-forget : le téléchargement + OCR ne bloquent pas la réception des autres messages.
          const isAdminSender = entry.isAnnouncement || roleOf(entry) === 'admin'
          ;(async () => {
            const buffer = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
            const ext = isPdf ? 'pdf' : (mm.imageMessage?.mimetype?.split('/')[1] || 'jpg')
            console.log(`⬇️  Fichier reçu (${entry.senderName}) -> OCR...`)
            const res = await processDocument(buffer, {
              id: m.key.id, ext, fileName: doc?.fileName,
              groupName: entry.groupName, senderName: entry.senderName, senderId,
              isAnnouncement: entry.isAnnouncement, time: entry.time,
            })
            // Fichier d'un admin -> on le STOCKE et on l'enregistre pour pouvoir le renvoyer plus tard.
            if (isAdminSender) {
              try {
                const reg = await docs.registerFromContent({
                  buffer,
                  fileName: doc?.fileName || `${entry.senderName}-${m.key.id}.${ext}`,
                  mimetype: doc?.mimetype || (isPdf ? 'application/pdf' : 'image/' + ext),
                  text: res?.text || '',
                })
                if (reg) {
                  console.log('📎 Document admin enregistré (renvoyable):', reg.title)
                  // Traduction FR automatique (original EN + version FR prête pour la demande)
                  docs.ensureLang(reg.id, 'fr').then(() => console.log('🌍 Version FR prête:', reg.title)).catch(() => {})
                }
              } catch (e) { console.log('doc register err:', e?.message) }
            }
          })().catch((e) => console.log('❌ Echec traitement fichier:', e?.message))
        }
      }

      // ---- Cerveau branché : réponse NON bloquante, sérialisée par (groupe|expéditeur) ----
      // La boucle de réception ne s'arrête plus : plusieurs conversations sont traitées en
      // parallèle (bornées + prioritaires côté LLM), la réception/log garde le rythme.
      const forOtherBot = isForOtherBot(entry.text) // message adressé à un AUTRE bot -> on ne fait rien
      if (forOtherBot) { markHandled(m.key.id) } // consommé, ni réponse ni réaction
      else if (arenaOn() && chatId === ARENA_GROUP && !m.key.fromMe && (entry.text || '').trim().length >= 2) {
        // Groupe Arène : on route vers l'orchestrateur (au lieu de la réponse normale)
        const key = chatId + '|' + senderId
        groupEnqueue(key, () => handleArena(sock, chatId, senderId, entry.senderName, entry.text, m))
      } else if (groupAnswerOn() && inAnswer && !m.key.fromMe && (entry.text || '').trim().length >= 2) {
        const key = chatId + '|' + senderId
        groupEnqueue(key, () => handleGroupAnswer(sock, chatId, key, entry, m))
      } else if (groupReactOn() && inAnswer && !m.key.fromMe && (entry.text || '').trim().length >= 2) {
        // Réponses coupées mais réactions activées : présence légère (emoji parfois), sans répondre.
        maybeReact(sock, chatId, m, entry.text).catch(() => {})
      }
    }
  })
}

start().catch((e) => console.error('Fatal:', e))
