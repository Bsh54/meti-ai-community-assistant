# Micro-service EMBEDDINGS (résident) : charge UNE fois un modèle multilingue (ONNX/CPU via fastembed)
# et renvoie des vecteurs L2-normalisés. Utilisé par le bot pour la recherche HYBRIDE (FTS + vecteur, RRF).
# Modèle multilingue -> renforce aussi le recall cross-langue (FR<->EN).
import os
from flask import Flask, request, jsonify
from fastembed import TextEmbedding
import numpy as np

MODEL = os.environ.get('EMBED_MODEL', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')  # 384d, multilingue, léger
app = Flask(__name__)
model = TextEmbedding(model_name=MODEL)

def _prep(texts, kind):
    return [(t or '') for t in texts]  # ce modèle n'a pas besoin de préfixe query/passage

@app.route('/embed', methods=['POST'])
def embed():
    d = request.get_json(force=True) or {}
    texts = d.get('texts') or []
    kind = d.get('type') or 'passage'
    if not texts:
        return jsonify({'vectors': [], 'dim': 0})
    out = []
    for v in model.embed(_prep(texts, kind)):
        a = np.asarray(v, dtype='float32')
        n = float(np.linalg.norm(a))
        if n > 0:
            a = a / n
        out.append(a.tolist())
    return jsonify({'vectors': out, 'dim': len(out[0]) if out else 0})

@app.route('/health')
def health():
    return jsonify({'ok': True, 'model': MODEL})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=7867)
