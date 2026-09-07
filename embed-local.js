const { utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');

const MODEL_ID = 'bge-small-zh-v1.5';
const MODEL_FILE = path.join('onnx', 'model_quantized.onnx');

function modelBaseCandidates() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'models'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'models'));
  }
  candidates.push(path.join(__dirname, '..', 'models'));
  return candidates;
}

function findModelBase() {
  for (const base of modelBaseCandidates()) {
    try { if (fs.existsSync(path.join(base, MODEL_ID, MODEL_FILE))) return base; } catch (_error) {}
  }
  return null;
}

function findWorkerPath() {
  const names = [];
  if (process.resourcesPath) {
    names.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'embed-worker.cjs'));
    names.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'embed-worker.cjs'));
  }
  names.push(path.join(__dirname, '..', '..', 'app.asar.unpacked', 'embed-worker.cjs'));
  names.push(path.join(__dirname, 'embed-worker.cjs'));
  for (const candidate of names) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_error) {}
  }
  return null;
}

function isAvailable() {
  const base = findModelBase();
  if (!base) return false;
  try { return fs.existsSync(path.join(base, MODEL_ID, MODEL_FILE)); } catch (_error) { return false; }
}

let worker = null;
let readyPromise = null;
let sequence = 0;
const pending = new Map();

let resolveReady = null;
let rejectReady = null;

function spawnWorker() {
  const workerPath = findWorkerPath();
  const modelDir = findModelBase();
  if (!workerPath) throw new Error('未找到内置模型 worker');
  if (!modelDir) throw new Error('未找到内置模型文件');
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'kaltsit-embed-worker',
    env: { ...process.env, EMBED_MODEL_DIR: modelDir }
  });
  worker = child;
  readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.on('message', (message) => {
    const msg = message || {};
    if (msg.type === 'embed-done' && msg.id != null) {
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry.resolve(msg.rows || []); }
      return;
    }
    if (msg.type === 'error') {
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        entry.reject(new Error(String(msg.message || '内置模型错误')));
        return;
      }
      if (rejectReady) { const reject = rejectReady; rejectReady = null; reject(new Error(String(msg.message || '内置模型初始化失败'))); }
    }
    if (msg.type === 'ready') {
      if (resolveReady) { const resolve = resolveReady; resolveReady = null; resolve(); }
    }
  });
  child.on('exit', (code) => {
    worker = null;
    resolveReady = null;
    rejectReady = null;
    readyPromise = null;
    for (const [, entry] of pending) entry.reject(new Error('内置模型进程退出 (' + code + ')'));
    pending.clear();
  });
  child.postMessage({ type: 'init' });
  return readyPromise;
}

async function ensureReady() {
  if (!worker) await spawnWorker();
  if (readyPromise) await readyPromise;
}

async function embedTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  await ensureReady();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ type: 'embed', id, texts: list });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

module.exports = { embedTexts, isAvailable, MODEL_ID };
