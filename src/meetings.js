// Plugin MEETINGS : état des réunions (démarrée / finie) = SIGNAL partagé bot <-> scheduler.
// Le scheduler écrit ici (markStarted au join, markEnded à la fin du conteneur = fin du meet) ;
// le cerveau lit meetingsBlock() pour SAVOIR en direct qu'un meet est en cours / vient de finir.
const fs = require('fs')
const path = require('path')
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const FILE = path.join(DATA_DIR, 'meetings.json')

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return [] } }
function save(l) { try { fs.writeFileSync(FILE, JSON.stringify(l, null, 2)) } catch {} }

// Le meet est rejoint -> "en cours". Idempotent (par label).
function markStarted(label, name, url) {
  const l = load()
  let m = l.find((x) => x.label === label)
  if (!m) { m = { label }; l.push(m) }
  m.name = name || m.name || label
  m.url = url || m.url || ''
  m.startedAt = Date.now()
  m.status = 'live'
  m.endedAt = null
  save(l)
  return m
}
// Le conteneur du bot est sorti = LE MEET EST FINI. C'est le signal.
function markEnded(label, info = {}) {
  const l = load()
  let m = l.find((x) => x.label === label)
  if (!m) { m = { label, name: label }; l.push(m) }
  m.status = 'ended'
  m.endedAt = Date.now()
  if (info.name) m.name = info.name
  if (info.facts != null) m.facts = info.facts // nb de faits injectés en mémoire
  save(l)
  return m
}
function live() { return load().filter((m) => m.status === 'live') }
function recentlyEnded(withinMs = 6 * 3600000) {
  const now = Date.now()
  return load().filter((m) => m.status === 'ended' && m.endedAt && now - m.endedAt <= withinMs)
}

// Bloc injecté dans le prompt : le cerveau SAIT en direct l'état des réunions.
function meetingsBlock() {
  const fmt = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Maputo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(ts))
  const lines = []
  for (const m of live()) lines.push(`- ${m.name} is CURRENTLY LIVE right now (started ${fmt(m.startedAt)} CAT).`)
  for (const m of recentlyEnded()) lines.push(`- ${m.name} has just FINISHED (ended ${fmt(m.endedAt)} CAT); its content is already captured and available.`)
  if (!lines.length) return ''
  return 'MEETING STATUS (live signal from the meeting system — trust it):\n' + lines.join('\n')
}

module.exports = { markStarted, markEnded, live, recentlyEnded, meetingsBlock, load }
