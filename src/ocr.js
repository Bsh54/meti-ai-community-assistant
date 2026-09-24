// Client de l'API OCR (extraction de texte depuis PDF/images).
// URL configurée via .env : OCR_URL (ex: https://xxxx.hf.space/extract)
const fs = require('fs')
const path = require('path')

const OCR_URL = process.env.OCR_URL || ''

async function ocrExtract(filePath, lang = 'en') {
  if (!OCR_URL) throw new Error('OCR_URL non configurée (.env)')
  const buf = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([buf]), path.basename(filePath))
  form.append('lang', lang) // 'fr' ou 'en'
  const res = await fetch(OCR_URL, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`OCR ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return j.text || ''
}

module.exports = { ocrExtract, OCR_ENABLED: !!OCR_URL }
