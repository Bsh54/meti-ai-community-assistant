// Outil : récupère la transcription (sous-titres auto) d'une vidéo YouTube. Gratuit.
const { YoutubeTranscript } = require('youtube-transcript')

function idFromUrl(u) {
  const m = String(u).match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/)
  return m ? m[1] : String(u).trim()
}

async function fetchTranscript(urlOrId, lang) {
  const id = idFromUrl(urlOrId)
  const opts = lang ? { lang } : undefined
  const parts = await YoutubeTranscript.fetchTranscript(id, opts)
  return parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim()
}

module.exports = { fetchTranscript, idFromUrl }
