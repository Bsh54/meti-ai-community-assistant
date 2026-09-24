// Primitives de coordination réutilisables.
const fs = require('fs')

// Sérialiseur par clé : les tâches d'une même clé s'exécutent l'une après l'autre
// (ordre garanti, pas d'écriture concurrente), mais des clés différentes tournent EN PARALLÈLE.
function makeSerializer() {
  const m = new Map()
  return (key, fn) => {
    const prev = m.get(key) || Promise.resolve()
    const next = prev.then(fn, fn).catch(() => {})
    m.set(key, next)
    next.finally(() => { if (m.get(key) === next) m.delete(key) })
    return next
  }
}

// Écriture JSON atomique : écrit dans .tmp puis rename (évite un fichier corrompu si crash pendant l'écriture).
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

module.exports = { makeSerializer, writeJsonAtomic }
