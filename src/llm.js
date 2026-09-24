// Client API imole (compatible OpenAI). Clé + URL via variables d'env.
const BASE = process.env.LLM_BASE_URL || 'https://api.imole.app/v1'
const KEY = process.env.LLM_API_KEY || ''
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-5.6-luna'
// Modèles de secours sur le MÊME fournisseur principal (bascule si "service indisponible").
const FALLBACK_MODELS = (process.env.LLM_FALLBACK_MODELS || '')
  .split(',').map((s) => s.trim()).filter((m) => m && m !== CHAT_MODEL)
// Chaîne d'ENDPOINTS essayés dans l'ordre : fournisseur principal (modèle principal + secours), puis un
// FOURNISSEUR de secours OPTIONNEL (autre API, un ou plusieurs modèles) -> bascule invisible pour l'user.
const ENDPOINTS = [CHAT_MODEL, ...FALLBACK_MODELS].map((model) => ({ base: BASE, key: KEY, model }))
if (process.env.LLM_FALLBACK_KEY) {
  const fbBase = process.env.LLM_FALLBACK_BASE_URL || 'https://api.openai.com/v1'
  const fbKey = process.env.LLM_FALLBACK_KEY
  const fbModels = (process.env.LLM_FALLBACK_MODEL || 'gpt-4o-mini').split(',').map((s) => s.trim()).filter(Boolean)
  for (const m of fbModels) ENDPOINTS.push({ base: fbBase, key: fbKey, model: m })
}
// NB: transcription (speech-to-text) volontairement non branchée ici — process séparé plus tard.

if (!KEY) console.warn('⚠️  LLM_API_KEY manquante (définir dans .env)')

// --- Limiteur de concurrence : au plus N appels LLM en parallèle (rapide mais borné) ---
const MAX_CONCURRENT = Number(process.env.LLM_CONCURRENCY || 4)
let active = 0
const highWaiters = [] // groupes = prioritaires
const lowWaiters = []  // DM / tâches de fond
function acquire(priority = 'low') {
  return new Promise((res) => {
    if (active < MAX_CONCURRENT) { active++; res() }
    else (priority === 'high' ? highWaiters : lowWaiters).push(res)
  })
}
function release() {
  active--
  const w = highWaiters.shift() || lowWaiters.shift() // sert les groupes d'abord
  if (w) { active++; w() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// imole sert ses modèles gpt-6/claude via l'API "Responses" (/v1/responses), pas /chat/completions.
const USE_RESPONSES = /imole\.app/i
// Un seul appel HTTP sur UN endpoint (base+clé+modèle), gère les 2 formats d'API (responses / chat).
async function callOnce(messages, max_tokens, ep) {
  const responses = USE_RESPONSES.test(ep.base)
  const url = ep.base + (responses ? '/responses' : '/chat/completions')
  // imole gpt-6 = modèles à RAISONNEMENT : ils dépensent des tokens à "réfléchir" (reasoning_content)
  // AVANT de répondre. Sans marge, la réponse visible revient vide -> on ajoute une réserve de raisonnement.
  const budget = responses ? max_tokens + 1600 : max_tokens
  const body = responses
    ? { model: ep.model, input: messages, max_output_tokens: budget } // API Responses (imole, reasoning)
    : { model: ep.model, messages, max_tokens: budget }               // API Chat Completions
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ep.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (res.status === 429 || res.status >= 500) { const e = new Error(`LLM ${res.status}: ${raw.slice(0, 160)}`); e.retryable = true; e.unavailable = true; throw e }
  let j = {}; try { j = JSON.parse(raw) } catch {}
  // imole peut renvoyer {error:"model_capacity_limited"|"model_request_failed"} même en HTTP 200 -> indispo, on bascule.
  if (j && j.error) { const code = (typeof j.error === 'string' ? j.error : (j.error.code || j.error.message || '')).toString(); const e = new Error('LLM: ' + code.slice(0, 60)); e.unavailable = true; throw e }
  if (!res.ok) { const e = new Error(`LLM ${res.status}: ${raw.slice(0, 200)}`); e.unavailable = true; throw e }
  if (responses) {
    let txt = j.output_text
    if (!txt && Array.isArray(j.output)) txt = j.output.flatMap((o) => (Array.isArray(o.content) ? o.content : [])).map((c) => c.text || c.output_text || '').join('')
    return (txt || '').trim()
  }
  return j.choices?.[0]?.message?.content?.trim() || ''
}

const isNetErr = (e) => /fetch failed|network|ECONN|ETIMEDOUT|timeout/i.test(e?.message || '')

// Appel chat : borné en concurrence. Essaie chaque ENDPOINT dans l'ordre (imole principal -> RodiumAI ->…).
// BASCULE IMMÉDIATE dès qu'un endpoint est indisponible (pas de backoff lent) -> l'user ne sent pas la panne.
// Seul un vrai pépin réseau transitoire déclenche UN petit retry rapide (300 ms) sur le même endpoint.
async function chat(messages, { max_tokens = 1024, priority = 'low' } = {}) {
  await acquire(priority)
  try {
    let lastErr
    for (const ep of ENDPOINTS) {
      try { return await callOnce(messages, max_tokens, ep) }
      catch (e) {
        lastErr = e
        if (isNetErr(e)) { // coupure réseau ponctuelle -> 1 seul retry rapide avant de basculer
          await sleep(300)
          try { return await callOnce(messages, max_tokens, ep) } catch (e2) { lastErr = e2 }
        }
        continue // indisponible / erreur -> endpoint suivant tout de suite (bascule invisible)
      }
    }
    throw lastErr // tous les endpoints down
  } finally { release() }
}

module.exports = { chat, CHAT_MODEL, BASE, KEY }
