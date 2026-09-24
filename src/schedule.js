// OUTIL déterministe : planning & échéances.
// Le code calcule (dates, jours restants, sessions du jour) -> l'IA n'a qu'à formuler.
// CAT = UTC+2 (fuseau officiel du programme).

// Meeting links come from env so no live meeting URL/passcode is committed to source control.
const WADH_LINK = process.env.WADHWANI_MEETING_LINK || ''
const OPENHOUR_FRI = process.env.OPENHOUR_MEETING_LINK || ''

// Crée une Date à une heure "murale" CAT (UTC+2).
function cat(y, m, d, hh = 0, mm = 0) { return new Date(Date.UTC(y, m - 1, d, hh - 2, mm)) }

// Overrides admin (annulations/reports) — lus DIRECTEMENT du fichier pour éviter la dépendance
// circulaire avec calendar.js. Un rappel n'est PAS envoyé si sa session est annulée/déplacée ce jour-là.
const _fsO = require('fs'); const _pathO = require('path')
const _OVR_FILE = _pathO.join(process.env.DATA_DIR || _pathO.join(__dirname, '..', 'data'), 'schedule-overrides.json')
function _loadOverrides() { try { return JSON.parse(_fsO.readFileSync(_OVR_FILE, 'utf8')) } catch { return [] } }
function cancelledByOverride(name, ymd) {
  const inc = (t, n) => !!t && !!n && n.toLowerCase().includes(String(t).toLowerCase())
  return _loadOverrides().some((o) =>
    (o.op === 'cancel' && inc(o.target, name) && (!o.date || o.date === ymd)) ||
    (o.op === 'reschedule' && inc(o.target, name) && o.date === ymd))
}

// Événements datés (one-time) : deadlines & jalons.
const EVENTS = [
  { name: 'UN video demo submission deadline', at: cat(2026, 9, 18, 14, 0), note: 'submit your 5-min video by email to unipods.regional@undp.org' },
  { name: 'METI Open Hour “Ask Us Anything” (first one)', at: cat(2026, 9, 18, 15, 0), link: OPENHOUR_FRI },
  { name: 'Hackathon starts', at: cat(2026, 9, 18, 0, 0) },
  { name: 'Hackathon submission deadline (last day)', at: cat(2026, 9, 24, 23, 59) },
  { name: 'Expected MIT course completion', at: cat(2026, 10, 18, 0, 0) },
  { name: 'Workplan submission deadline', at: cat(2026, 10, 25, 0, 0) },
  { name: 'Addis Ababa AI Institute online programme starts', at: cat(2026, 10, 26, 0, 0) },
  { name: '50 teams selected for the bootcamp (week of)', at: cat(2026, 11, 23, 0, 0) },
  { name: 'Addis Ababa bootcamp opens', at: cat(2026, 12, 1, 0, 0) },
  { name: 'Wadhwani programme concludes', at: cat(2026, 12, 17, 0, 0) },
]

// Sessions hebdomadaires récurrentes (0=dim … 6=sam), heure murale CAT.
const RECURRING = [
  { name: 'Wadhwani Ignite class session', weekday: 2, time: '15:00 CAT (14:00 WAT / 16:00 EAT)', link: WADH_LINK },
  { name: 'Wadhwani Ignite Q&A / coaching session', weekday: 4, time: '15:00 CAT (14:00 WAT / 16:00 EAT)', link: WADH_LINK },
  // Open Hours DÉSACTIVÉS (rappels auto retirés) — Diane a corrigé le planning le 21/09 ("no meeting today,
  // next on Wed 30th"). On ne poste plus de rappel Open Hour tant que le vrai planning n'est pas reconfirmé.
  // { name: 'Open Hour with Gift', weekday: 1, time: '15:00 CAT (14:00 WAT)', from: cat(2026, 9, 21, 0, 0) },
  // { name: 'Open Hour with Diane', weekday: 3, time: '15:00 CAT (14:00 WAT)', from: cat(2026, 9, 23, 0, 0) },
]

function ymdCAT(d) {
  const o = {}
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Maputo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).forEach((p) => (o[p.type] = p.value))
  return `${o.year}-${o.month}-${o.day}`
}
const dayName = (ymd) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(ymd + 'T12:00:00Z'))
const weekdayOf = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay()

function sessionsOn(ymd, now) {
  const wd = weekdayOf(ymd)
  const out = []
  for (const r of RECURRING) {
    if (r.weekday === wd && (!r.from || ymd >= ymdCAT(r.from))) out.push(`${r.name} at ${r.time}${r.link ? ' — ' + r.link : ''}`)
  }
  for (const e of EVENTS) {
    if (ymdCAT(e.at) === ymd) out.push(`${e.name}${e.note ? ' (' + e.note + ')' : ''}${e.link ? ' — ' + e.link : ''}`)
  }
  return out
}

// Prochaine occurrence (à partir de DEMAIN) d'une session hebdo.
function nextOccurrence(weekday, from, todayYmd) {
  const start = new Date(todayYmd + 'T12:00:00Z').getTime()
  for (let i = 1; i <= 14; i++) {
    const ymd = new Date(start + i * 86400000).toISOString().slice(0, 10)
    if (weekdayOf(ymd) === weekday && (!from || ymd >= ymdCAT(from))) return ymd
  }
  return null
}

// Renvoie un bloc texte déterministe injecté dans le prompt.
function computeSchedule(now = new Date()) {
  const today = ymdCAT(now)
  const base = new Date(today + 'T12:00:00Z')
  const tomo = ymdCAT(new Date(base.getTime() + 86400000))
  const todayList = sessionsOn(today, now)
  const tomoList = sessionsOn(tomo, now)

  const nextLines = RECURRING.map((r) => {
    const ymd = nextOccurrence(r.weekday, r.from, today)
    if (!ymd) return null
    const days = Math.round((new Date(ymd + 'T12:00:00Z') - base) / 86400000)
    const when = days === 1 ? 'tomorrow' : `in ${days} days`
    return `${r.name}: ${dayName(ymd)} ${ymd} (${when}) at ${r.time}`
  }).filter(Boolean)

  const soon = EVENTS.filter((e) => e.at >= now && e.at - now <= 21 * 86400000)
    .sort((a, b) => a.at - b.at)
    .map((e) => {
      const diff = e.at - now
      const days = Math.floor(diff / 86400000)
      const hrs = Math.floor(diff / 3600000)
      const when = days >= 2 ? `in ${days} days` : hrs >= 1 ? `in ${hrs}h` : 'very soon'
      return `${e.name} — ${ymdCAT(e.at)} (${when})`
    })

  // Phase actuelle du programme (calculée)
  const phase = []
  const wadhStart = cat(2026, 9, 15, 0, 0)
  const wadhEnd = cat(2026, 12, 17, 23, 59)
  if (now >= wadhStart && now <= wadhEnd) {
    const wk = Math.floor((now - wadhStart) / (7 * 86400000)) + 1
    if (wk >= 1 && wk <= 14) phase.push(`Wadhwani Ignite: week ${wk} of 14`)
  }
  if (now >= cat(2026, 9, 14, 0, 0) && now < cat(2026, 10, 19, 0, 0))
    phase.push('MIT Universal AI course: OPEN (self-paced; expected completion 18 Oct 2026)')
  if (now >= cat(2026, 10, 26, 0, 0) && now < cat(2027, 1, 26, 0, 0))
    phase.push('Ethiopian AI Institute online programme: running')

  const lines = ['COMPUTED SCHEDULE (deterministic, from the system clock — trust these figures):']
  if (phase.length) lines.push(`- Current programme phase: ${phase.join(' | ')}`)
  lines.push(`- Today (${dayName(today)} ${today}): ${todayList.length ? todayList.join(' | ') : 'no scheduled programme session'}`)
  lines.push(`- Tomorrow (${dayName(tomo)} ${tomo}): ${tomoList.length ? tomoList.join(' | ') : 'no scheduled programme session'}`)
  if (nextLines.length) lines.push(`- Next recurring sessions: ${nextLines.join(' ; ')}`)
  if (soon.length) lines.push(`- Upcoming deadlines/milestones (next 21 days): ${soon.join(' ; ')}`)
  return lines.join('\n')
}

// 15:00 CAT (par défaut) sur une date ymd -> Date UTC
function catTimeOn(ymd, hh = 15, mm = 0) {
  return new Date(`${ymd}T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)
}
const TIMESTR = '15:00 CAT / 14:00 WAT / 16:00 EAT'

// Prochaine date-heure (Date) d'une session récurrente, >= now - 2 min
function nextSessionDT(rec, now) {
  const today = ymdCAT(now)
  for (let i = 0; i < 14; i++) {
    const ymd = new Date(new Date(today + 'T12:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10)
    if (weekdayOf(ymd) === rec.weekday && (!rec.from || ymd >= ymdCAT(rec.from))) {
      const dt = catTimeOn(ymd, 15, 0)
      if (dt.getTime() >= now.getTime() - 900000) return dt // garde la session "courante" jusqu'à 15 min après le début
    }
  }
  return null
}

// Calcule les alertes à envoyer maintenant. `fired` = Set des clés déjà traitées.
// Retourne [{key, type:'text'|'digest'|'skip', text?}].
function computeDueAlerts(now = new Date(), fired = new Set()) {
  const due = []
  const within = (target, graceMin) => now.getTime() >= target && now.getTime() < target + graceMin * 60000
  const emit = (key, target, graceMin, text, channel = 'general') => {
    if (fired.has(key)) return
    if (within(target, graceMin)) due.push({ key, type: 'text', text, channel })
    else if (now.getTime() >= target + graceMin * 60000) due.push({ key, type: 'skip', channel }) // trop tard -> marquer sans envoyer
  }

  // Sessions récurrentes : -60, -15, 0 min + nudge du matin (09:00 CAT)
  for (const rec of RECURRING) {
    const dt = nextSessionDT(rec, now)
    if (!dt) continue
    const T = dt.getTime(), ymd = ymdCAT(dt), L = rec.link || ''
    if (cancelledByOverride(rec.name, ymd)) continue // admin a annulé/déplacé cette session ce jour-là
    const ch = /wadhwani/i.test(rec.name) ? 'wadhwani' : 'general' // Wadhwani -> aussi dans le groupe Wadhwani
    emit(`sess:${rec.name}:${ymd}:60`, T - 3600000, 12, `⏰ *${rec.name}* starts in 1 hour — at ${TIMESTR}.${L ? ' Join: ' + L : ''}`, ch)
    emit(`sess:${rec.name}:${ymd}:15`, T - 900000, 12, `⏰ *${rec.name}* starts in 15 minutes.${L ? ' Join: ' + L : ''}`, ch)
    emit(`sess:${rec.name}:${ymd}:0`, T, 12, `🔴 *${rec.name}* is starting now!${L ? ' Join: ' + L : ''}`, ch)
    emit(`task:${rec.name}:${ymd}:am`, catTimeOn(ymd, 9, 0).getTime(), 150, `📌 Heads-up: *${rec.name}* is today at ${TIMESTR}. Make sure you've completed this week's module work before the session.`, ch)
  }

  // Événements ponctuels : avec lien = session ; sans lien = deadline/jalon
  for (const e of EVENTS) {
    const T = e.at.getTime()
    const ch = /wadhwani/i.test(e.name) ? 'wadhwani' : 'general'
    if (e.link) {
      emit(`evt:${e.name}:60`, T - 3600000, 12, `⏰ *${e.name}* starts in 1 hour.${' Join: ' + e.link}`, ch)
      emit(`evt:${e.name}:15`, T - 900000, 12, `⏰ *${e.name}* starts in 15 minutes. Join: ${e.link}`, ch)
      emit(`evt:${e.name}:0`, T, 12, `🔴 *${e.name}* is starting now! Join: ${e.link}`, ch)
    } else {
      emit(`dl:${e.name}:1440`, T - 86400000, 90, `🗓️ Reminder: *${e.name}* is due tomorrow (${ymdCAT(e.at)}).${e.note ? ' ' + e.note + '.' : ''}`, ch)
      emit(`dl:${e.name}:180`, T - 10800000, 90, `⚠️ *${e.name}* is due in about 3 hours.${e.note ? ' ' + e.note + '.' : ''}`, ch)
    }
  }

  // Digest quotidien à 20:30 CAT (canal général -> groupe METI)
  const dg = catTimeOn(ymdCAT(now), 20, 30).getTime()
  const dkey = `digest:${ymdCAT(now)}`
  if (!fired.has(dkey)) {
    if (within(dg, 60)) due.push({ key: dkey, type: 'digest', channel: 'general' })
    else if (now.getTime() >= dg + 60 * 60000) due.push({ key: dkey, type: 'skip', channel: 'general' })
  }
  // Récap Wadhwani à 20:00 CAT (jours de session) -> groupe Wadhwani uniquement
  const wkey = `wrecap:${ymdCAT(now)}`
  if (!fired.has(wkey)) {
    if (within(dg, 60)) due.push({ key: wkey, type: 'wadhwani-recap', channel: 'wadhwani-only' })
    else if (now.getTime() >= dg + 60 * 60000) due.push({ key: wkey, type: 'skip', channel: 'wadhwani-only' })
  }
  return due
}

module.exports = { computeSchedule, computeDueAlerts, EVENTS, RECURRING }
