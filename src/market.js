// Analyse de marché en direct via LangSearch (concurrents, levées, tendances).
// Sert au panel d'investisseurs de l'Arène pour ancrer ses questions sur des faits réels.
const LANG_KEY = process.env.LANGSEARCH_KEY || ''

async function marketScan(query) {
  if (!LANG_KEY) return { ok: false, notes: '', results: [] }
  try {
    const r = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + LANG_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count: 5 }),
    })
    if (!r.ok) return { ok: false, notes: '', results: [] }
    const j = await r.json()
    const v = (j.data && j.data.webPages && j.data.webPages.value) || []
    const results = v.slice(0, 5).map((x) => ({ title: x.name, url: x.url, summary: (x.summary || x.snippet || '').slice(0, 280) }))
    const notes = results.map((x) => `- ${x.title}: ${x.summary}`).join('\n')
    return { ok: results.length > 0, notes, results }
  } catch (e) { return { ok: false, notes: '', results: [] } }
}

module.exports = { marketScan }
