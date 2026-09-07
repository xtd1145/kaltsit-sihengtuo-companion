// 内置 Embedding 小模型 worker（在 app.asar.unpacked 下以真实文件运行，可正常 require 原生模块）
const path = require('path');
const fs = require('fs');

const MODEL_ID = 'bge-small-zh-v1.5';
const MODEL_FILE = path.join('onnx', 'model_quantized.onnx');

function findModelBase() {
  const candidates = [];
  if (process.env.EMBED_MODEL_DIR) candidates.push(process.env.EMBED_MODEL_DIR);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models'));
  for (const base of candidates) {
    try { if (fs.existsSync(path.join(base, MODEL_ID, MODEL_FILE))) return base; } catch (_e) {}
  }
  return null;
}

let extractorPromise = null;
let extractor = null;

async function getExtractor() {
  if (extractor) return extractor;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const base = findModelBase();
      if (!base) throw new Error('未找到内置模型文件');
      const { env, pipeline } = await import('@xenova/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = base;
      extractor = await pipeline('feature-extraction', MODEL_ID);
      return extractor;
    })();
  }
  return extractorPromise;
}

const port = process.parentPort;
if (port) {
  port.on('message', async (event) => {
    const message = event.data || event;
    if (message.type === 'init') {
      try { await getExtractor(); port.postMessage({ type: 'ready', modelDir: findModelBase() }); }
      catch (error) { port.postMessage({ type: 'error', message: 'init:' + (error && error.message || String(error)) }); }
      return;
    }
    if (message.type === 'embed') {
      try {
        const model = await getExtractor();
        const texts = (message.texts || []).map((t) => String(t || '').slice(0, 500));
        const output = await model(texts, { pooling: 'mean', normalize: true });
        const dim = output.dims[1];
        const count = output.dims[0];
        const rows = [];
        for (let r = 0; r < count; r += 1) rows.push(Array.from(output.data.slice(r * dim, (r + 1) * dim)));
        port.postMessage({ type: 'embed-done', id: message.id, rows });
      } catch (error) {
        port.postMessage({ type: 'error', id: message.id, message: error && error.message || String(error) });
      }
    }
  });
  port.postMessage({ type: 'hello', pid: process.pid });
}
