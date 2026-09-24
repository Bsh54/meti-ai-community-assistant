// Mentions/tags plugin. Tags known admins whenever they are referenced by name.
// Learns each admin's real JID (often @lid) when they post, with a number fallback.
//
// The seed roster is provided via the ADMIN_JIDS environment variable as a JSON object
// mapping a display-name key to a JID, e.g. {"jane doe":"1234567890@s.whatsapp.net"}.
// It is empty by default so no personal data is hardcoded; when empty, tagify is a no-op
// until a real JID is learned at runtime.
const fs = require('fs')
const path = require('path')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const FILE = path.join(DATA_DIR, 'known-jids.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

let SEED = {}
try { SEED = JSON.parse(process.env.ADMIN_JIDS || '{}') } catch { SEED = {} }
const ADMIN_KEYS = Object.keys(SEED).map((k) => k.toLowerCase())

function loadLearned() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
function saveLearned(o) { fs.writeFileSync(FILE, JSON.stringify(o)) }
let learned = loadLearned()

// Learns an admin's real JID when they post (matched by display name).
function learn(senderName, senderId) {
  if (!senderName || !senderId) return
  const n = senderName.toLowerCase().trim()
  for (const key of ADMIN_KEYS) {
    if (n === key || n.includes(key)) {
      if (learned[key] !== senderId) { learned[key] = senderId; saveLearned(learned) }
    }
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Replaces admin names with @num tags and returns { text, mentions: [jid] }.
function tagify(text) {
  if (!text) return { text, mentions: [] }
  const mentions = new Set()
  let out = text
  const keys = [...new Set(ADMIN_KEYS)].sort((a, b) => b.length - a.length) // longest first
  for (const key of keys) {
    const jid = learned[key] || SEED[key]
    if (!jid) continue
    const num = jid.split('@')[0]
    const re = new RegExp('(?<![@\\w])' + esc(key) + '(?![\\w])', 'ig')
    if (re.test(out)) { out = out.replace(re, '@' + num); mentions.add(jid) }
  }
  return { text: out, mentions: [...mentions] }
}

module.exports = { learn, tagify }
