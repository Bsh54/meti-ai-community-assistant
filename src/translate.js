// Wrapper Node du traducteur de documents (Python + PyMuPDF, LLM = imole).
const path = require('path')
const { execFile } = require('child_process')

const PY = path.join(__dirname, '..', '.venv', 'bin', 'python')
const SCRIPT = path.join(__dirname, '..', 'translate_doc.py')

// Traduit src vers la langue tgt (code ISO) dans out (préserve le format). Renvoie out.
function translateDoc(src, tgt, out) {
  return new Promise((resolve, reject) => {
    execFile(PY, [SCRIPT, src, tgt, out], { env: process.env, timeout: 12 * 60000, maxBuffer: 1 << 26 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(((stderr || '') + (err.message || '')).slice(0, 300)))
        resolve(out)
      })
  })
}

module.exports = { translateDoc }
