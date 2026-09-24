// Client du micro-service EMBEDDINGS (multilingue). FAIL-SAFE : renvoie null si le service est indispo
// -> le cerveau retombe alors sur la recherche FTS seule, sans rien casser.
const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:7867'
const _cache = new Map()

async function embed(texts, type = 'passage') {
  try {
    const r = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, type }),
    })
    if (!r.ok) return null
    const j = await r.json()
    return j.vectors || null
  } catch { return null }
}

async function embedQuery(q) {
  const key = (q || '').slice(0, 200).toLowerCase()
  if (!key) return null
  if (_cache.has(key)) return _cache.get(key)
  const v = await embed([q], 'query')
  const vec = v && v[0] ? v[0] : null
  if (_cache.size > 500) _cache.clear()
  _cache.set(key, vec)
  return vec
}

module.exports = { embed, embedQuery }
