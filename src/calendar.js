// Plugin CALENDRIER : pré-remplit chaque jour du programme avec ses événements.
// Source unique de vérité = schedule.js (EVENTS + RECURRING), + événements ajoutés à la volée
// (data/calendar.json). Le bot compare les dates et lit ce qui est prévu, sans recalculer.
const fs = require('fs')
const path = require('path')
const { EVENTS, RECURRING } = require('./schedule')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const CAL_FILE = path.join(DATA_DIR, 'calendar.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

function ymdCAT(d) {
  const o = {}
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Maputo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).forEach((p) => (o[p.type] = p.value))
  return `${o.year}-${o.month}-${o.day}`
}
const weekdayOf = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay()
const dayName = (ymd) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(ymd + 'T12:00:00Z'))
const addDays = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)

// Événements ajoutés manuellement / à la volée (persistants).
function customEvents() { try { return JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')) } catch { return [] } }
function saveCustom(list) { try { fs.writeFileSync(CAL_FILE, JSON.stringify(list, null, 2)) } catch {} }
function addEvent(ev) {
  const list = customEvents()
  list.push({ date: ev.date, title: ev.title, time: ev.time || '', hhmm: ev.hhmm || '', tz: ev.tz || 'CAT', link: ev.link || '', type: ev.type || 'event', note: ev.note || '', ts: Date.now() })
  saveCustom(list)
  return list.length
}
// Événements custom avec lien de meeting (pour l'auto-join du planificateur Vexa).
function sessionsWithLinks() { return customEvents().filter((c) => c.link) }

// ---- Overrides pilotés par les admins (annuler / reporter / noter un changement) ----
// Rend le planning MODULAIRE : quand un admin décide qqch, on l'applique sans toucher au code.
// op:'cancel'     {target, date?}          -> annule une session (date précise, ou toutes si date vide)
// op:'reschedule' {target, date, newDate}  -> déplace une session d'une date à une autre
// op:'note'       {text, until?}           -> correction à retenir (ex: "Open Hours = 2x/mois")
const OVR_FILE = path.join(DATA_DIR, 'schedule-overrides.json')
function overrides() { try { return JSON.parse(fs.readFileSync(OVR_FILE, 'utf8')) } catch { return [] } }
function saveOverrides(list) { try { fs.writeFileSync(OVR_FILE, JSON.stringify(list, null, 2)) } catch {} }
function addOverride(o) {
  const list = overrides()
  const key = (x) => `${x.op}|${(x.target || '').toLowerCase()}|${x.date || ''}|${x.newDate || ''}|${(x.text || '').toLowerCase()}`
  if (list.some((x) => key(x) === key(o))) return list.length // dédup
  list.push({ ...o, ts: Date.now() })
  saveOverrides(list)
  return list.length
}
const _match = (target, name) => !!target && !!name && name.toLowerCase().includes(String(target).toLowerCase())
// Une session (par son nom) est-elle annulée à cette date ? (cancel sans date = annulée partout)
function isCancelled(name, ymd) {
  return overrides().some((o) =>
    (o.op === 'cancel' && _match(o.target, name) && (!o.date || o.date === ymd)) ||
    (o.op === 'reschedule' && _match(o.target, name) && o.date === ymd))
}
// Sessions reprogrammées VERS cette date (à afficher ce jour-là).
function incomingReschedules(ymd) {
  return overrides().filter((o) => o.op === 'reschedule' && o.newDate === ymd)
    .map((o) => ({ title: (o.target || 'session') + ' (rescheduled)', time: o.time || '', link: o.link || '', type: 'session' }))
}
// Notes de correction actives (non expirées) — injectées dans l'agenda pour que le bot réponde juste.
function activeNotes(now = new Date()) {
  const today = ymdCAT(now)
  return overrides().filter((o) => o.op === 'note' && o.text && (!o.until || o.until >= today)).map((o) => o.text)
}

// Tous les événements d'une date (récurrents dévéloppés + ponctuels + ajoutés), APRÈS overrides admin.
function eventsOn(ymd) {
  const wd = weekdayOf(ymd)
  let out = []
  for (const r of RECURRING) if (r.weekday === wd && (!r.from || ymd >= ymdCAT(r.from))) out.push({ title: r.name, time: r.time, link: r.link || '', type: 'session' })
  for (const e of EVENTS) if (ymdCAT(e.at) === ymd) out.push({ title: e.name, time: '', link: e.link || '', note: e.note || '', type: e.link ? 'session' : 'deadline' })
  for (const c of customEvents()) if (c.date === ymd) out.push(c)
  out = out.filter((e) => !isCancelled(e.title, ymd)) // retire ce que les admins ont annulé/déplacé
  out = out.concat(incomingReschedules(ymd))           // ajoute ce qui a été déplacé vers ce jour
  return out
}
const fmtEv = (e) => `${e.title}${e.time ? ' at ' + e.time : ''}${e.note ? ' (' + e.note + ')' : ''}${e.link ? ' — ' + e.link : ''}`

// Prochaines deadlines (EVENTS sans lien + custom type deadline) dans N jours.
function upcomingDeadlines(now = new Date(), days = 45) {
  const out = []
  for (const e of EVENTS) if (!e.link && e.at >= now && e.at - now <= days * 86400000) out.push({ date: ymdCAT(e.at), title: e.name, note: e.note || '', at: e.at })
  for (const c of customEvents()) if (c.type === 'deadline') { const at = new Date(c.date + 'T12:00:00Z'); if (at >= now && at - now <= days * 86400000) out.push({ date: c.date, title: c.title, note: c.note || '', at }) }
  return out.sort((a, b) => a.at - b.at)
}

// Bloc "agenda" injecté dans le prompt : aujourd'hui + jours à venir (avec événements) + deadlines.
function agenda(now = new Date(), lookahead = 14) {
  const today = ymdCAT(now)
  const lines = ['PROGRAMME CALENDAR (pre-filled day by day, from the system clock — trust these dates):']
  const todayEv = eventsOn(today)
  lines.push(`- TODAY (${dayName(today)} ${today}): ${todayEv.length ? todayEv.map(fmtEv).join(' | ') : 'no scheduled programme session'}`)
  const tomo = addDays(today, 1)
  const tomoEv = eventsOn(tomo)
  lines.push(`- TOMORROW (${dayName(tomo)} ${tomo}): ${tomoEv.length ? tomoEv.map(fmtEv).join(' | ') : 'no scheduled programme session'}`)
  const soon = []
  for (let i = 2; i <= lookahead; i++) {
    const ymd = addDays(today, i)
    const evs = eventsOn(ymd)
    if (evs.length) soon.push(`${dayName(ymd)} ${ymd}: ${evs.map(fmtEv).join(' | ')}`)
  }
  if (soon.length) lines.push('- Coming up: ' + soon.join(' ; '))
  const dl = upcomingDeadlines(now, 45)
  if (dl.length) lines.push('- Upcoming deadlines: ' + dl.map((d) => `${d.title} — ${d.date}${d.note ? ' (' + d.note + ')' : ''}`).join(' ; '))
  const notes = activeNotes(now)
  if (notes.length) lines.push('- ADMIN UPDATES (latest corrections from organisers — these OVERRIDE anything above): ' + notes.join(' ; '))
  return lines.join('\n')
}

module.exports = { eventsOn, agenda, addEvent, upcomingDeadlines, customEvents, sessionsWithLinks, ymdCAT, addOverride, overrides, isCancelled, activeNotes }
