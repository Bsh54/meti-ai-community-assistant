// Processeur média : fichier (PDF/image) -> OCR -> nettoyage IA -> mémoire.
const fs = require('fs')
const path = require('path')
const { ocrExtract } = require('./ocr')
const { chat } = require('./llm')
const { addCurated } = require('./memory')
const { roleOf } = require('./roster')

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media')
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true })

function safeName(s) { return String(s || Date.now()).replace(/[^\w.\-]/g, '_').slice(0, 80) }

// meta: { id, ext, fileName, groupName, senderName, senderId, isAnnouncement, time }
async function processDocument(buffer, meta) {
  const fname = safeName(meta.fileName || meta.id) + (/\.[a-z0-9]+$/i.test(meta.fileName || '') ? '' : '.' + (meta.ext || 'bin'))
  const fp = path.join(MEDIA_DIR, fname)
  fs.writeFileSync(fp, buffer)

  let text = ''
  try { text = await ocrExtract(fp, 'en') } catch (e) { console.log('  OCR err:', e.message); return { saved: fp, facts: 0 } }
  if (!text || text.trim().length < 20) { console.log('  OCR: texte vide/court, ignoré'); return { saved: fp, facts: 0 } }

  const role = roleOf(meta)
  const prompt = `The following text was OCR'd from a file ("${meta.fileName || 'document'}") shared in the UniPods METI AI community by "${meta.senderName}" (role: ${role}) on ${meta.time}. OCR may contain mistakes.
1) Silently fix obvious OCR errors and reflow the text.
2) Extract the DURABLE, USEFUL facts for a community FAQ (dates, deadlines, links, sessions, procedures, decisions, requirements, contacts). Ignore letterhead, page numbers and boilerplate.
Each fact must be a clean, self-contained English sentence with its context (say what it is about).
Return STRICT JSON only: {"facts": ["fact 1", "fact 2", ...]}. If nothing useful, return {"facts": []}.

OCR TEXT:
"""${text.slice(0, 6000)}"""`

  let reply
  try { reply = await chat([{ role: 'user', content: prompt }], { max_tokens: 1200 }) }
  catch (e) { console.log('  LLM err:', e.message); return { saved: fp, facts: 0 } }
  const m = reply && reply.match(/\{[\s\S]*\}/)
  let facts = []
  try { facts = (JSON.parse(m[0]).facts) || [] } catch { facts = [] }

  let n = 0
  for (const f of facts) {
    if (f && String(f).trim().length > 15) {
      addCurated({
        text: `[From file: ${meta.fileName || 'document'}] ${f}`,
        source_role: role,
        confidence: role === 'admin' ? 0.95 : 0.7,
        group_name: meta.groupName || '',
        sender_name: meta.senderName || '',
        sender_id: meta.senderId || '',
        ts: meta.time ? Date.parse(meta.time) : Date.now(),
        msg_id: 'ocr:' + (meta.id || Date.now()) + ':' + n,
      })
      n++
    }
  }
  console.log(`  📄 OCR "${meta.fileName || meta.id}" (${role}) -> ${n} fait(s) mémorisé(s)`)
  return { saved: fp, facts: n, text, role }
}

module.exports = { processDocument, MEDIA_DIR }
