// Repairs important URLs if the model truncates or alters them (deterministic).
//
// The canonical link list is supplied via the CANONICAL_LINKS environment variable
// (newline- or comma-separated), so live meeting links and group invites are never
// committed to source control. It is empty by default, which makes repairLinks a no-op.
const CANON = (process.env.CANONICAL_LINKS || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Distinctive (unique) prefix of each URL, used to re-anchor a truncated variant.
function prefixOf(u) { return u.replace(/([?&].*)$/, '').slice(0, 60) }

// Replaces any truncated/altered occurrence of a known link with its exact version.
function repairLinks(text) {
  if (!text) return text
  let out = text
  for (const url of CANON) {
    const pre = prefixOf(url)
    if (pre.length < 25) continue
    out = out.replace(new RegExp(esc(pre) + '[^\\s)]*', 'g'), url)
  }
  return out
}

module.exports = { repairLinks }
