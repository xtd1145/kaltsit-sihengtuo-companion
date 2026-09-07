const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const embedLocal = require('./embed-local');

const MAX_DOCS = 200;
const MAX_TOTAL_CHUNKS = 6000;
const CHUNK_SIZE = 220;
const CHUNK_OVERLAP = 40;

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function chunkText(text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= CHUNK_SIZE) { chunks.push(paragraph); continue; }
    let start = 0;
    while (start < paragraph.length) {
      let end = Math.min(paragraph.length, start + CHUNK_SIZE);
      if (end < paragraph.length) {
        const dot = paragraph.lastIndexOf('。', end);
        if (dot > start + CHUNK_SIZE / 2) end = dot + 1;
        else {
          const comma = paragraph.lastIndexOf('，', end);
          if (comma > start + CHUNK_SIZE / 2) end = comma + 1;
        }
      }
      chunks.push(paragraph.slice(start, end));
      if (end >= paragraph.length) break;
      start = Math.max(end - CHUNK_OVERLAP, start + 1);
    }
  }
  return chunks.map((c) => c.trim()).filter((c) => c.length > 4);
}

function bigrams(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const seen = new Set();
  const out = [];
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
}

function lexicalScore(query, text) {
  const qg = bigrams(query);
  if (!qg.length) return 0;
  const tSet = new Set(bigrams(text));
  if (!tSet.size) return 0;
  let hits = 0;
  for (const g of qg) if (tSet.has(g)) hits += 1;
  const contains = String(text).includes(String(query).trim()) ? 0.6 : 0;
  return (hits / qg.length) * 0.4 + contains;
}

function cosine(a, b) {
  if (!a || !b || !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = function createKnowledgeBase({ getConfig, getIndexPath, emit, log }) {
  let loaded = false;
  let loading = null;
  let docs = [];

  function indexPath() {
    return getIndexPath ? getIndexPath() : null;
  }

  function loadSync() {
    if (loaded) return;
    const filePath = indexPath();
    try {
      if (filePath && fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        docs = Array.isArray(parsed.docs) ? parsed.docs.filter((d) => d && d.id && Array.isArray(d.chunks)) : [];
      } else docs = [];
    } catch (_error) { docs = []; }
    loaded = true;
  }

  function persist() {
    const filePath = indexPath();
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, updatedAt: Date.now(), docs }), 'utf8');
    } catch (error) {
      log('kb-persist-error', { error: error.message });
    }
  }

  async function embedRequest(texts) {
    const config = getConfig();
    const base = stripSlash(config.kbEmbedBase) || stripSlash(config.aiBaseUrl);
    if (!base) return null;
    const model = (config.kbEmbedModel || '').trim();
    if (!model) return null;
    const key = (config.kbEmbedKey || '').trim() || (config.aiApiKey || '').trim();
    const response = await net.fetch(base + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : {})
      },
      body: JSON.stringify({ model, input: texts })
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch (_error) {}
      throw new Error('Embedding HTTP ' + response.status + (detail ? ' ' + detail : ''));
    }
    const json = await response.json();
    if (!json || !Array.isArray(json.data)) throw new Error('Embedding 返回格式异常');
    return json.data
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((item) => item.embedding);
  }

  function state() {
    loadSync();
    const chunkCount = docs.reduce((sum, d) => sum + d.chunks.length, 0);
    const withVectors = docs.some((d) => d.chunks.some((c) => Array.isArray(c.vector)));
    const config = getConfig() || {};
    const hasEmbeddingEndpoint = Boolean(
      (stripSlash(config.kbEmbedBase) || stripSlash(config.aiBaseUrl)) &&
      (config.kbEmbedModel || '').trim()
    );
    return {
      ready: loaded,
      mode: config.kbIndexMode || 'keyword',
      docCount: docs.length,
      chunkCount,
      indexedWithVectors: withVectors,
      hasEmbeddingEndpoint,
      builtinAvailable: embedLocal.isAvailable(),
      builtinModel: embedLocal.MODEL_ID
    };
  }

  function loadAsync() {
    if (loaded) return Promise.resolve(true);
    if (loading) return loading;
    loading = Promise.resolve().then(() => { loadSync(); return true; }).finally(() => { loading = null; });
    return loading;
  }

  async function addDoc(name, text) {
    await loadAsync();
    const chunks = chunkText(text);
    if (!chunks.length) return { ok: false, error: '没有可用的文本内容' };
    if (docs.length >= MAX_DOCS) return { ok: false, error: '知识文档数量已达上限（' + MAX_DOCS + '）' };
    const total = docs.reduce((s, d) => s + d.chunks.length, 0);
    if (total + chunks.length > MAX_TOTAL_CHUNKS) {
      return { ok: false, error: '知识库分块数量已达上限（' + MAX_TOTAL_CHUNKS + '），请先删除部分文档' };
    }
    const entry = {
      id: 'doc-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4),
      name: String(name || '未命名').slice(0, 60),
      addedAt: Date.now(),
      chunks: chunks.map((text) => ({ text }))
    };
    docs.push(entry);

    const config = getConfig();
    const mode = config.kbIndexMode || 'keyword';
    if (mode === 'embedding' || mode === 'builtin') {
      try {
        const vectors = mode === 'builtin'
          ? (embedLocal.isAvailable() ? await embedLocal.embedTexts(chunks) : null)
          : await embedRequest(chunks);
        if (vectors && vectors.length === chunks.length) {
          entry.chunks.forEach((c, i) => { c.vector = vectors[i]; });
          entry.vectorReady = true;
        } else if (mode === 'builtin' && !embedLocal.isAvailable()) {
          entry.warning = '未找到内置模型，已使用关键词索引';
        } else {
          entry.warning = '向量化数量不匹配，已回退为关键词索引';
        }
      } catch (error) {
        entry.warning = '向量化失败（' + (error.message || String(error)).slice(0, 140) + '），已回退为关键词索引';
        log('kb-embed-error', { error: error.message, name: entry.name });
      }
    }
    persist();
    emit(state());
    return { ok: true, id: entry.id, chunks: chunks.length, warning: entry.warning || null };
  }

  async function importFiles(filePaths) {
    const results = [];
    for (const filePath of filePaths || []) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > 2 * 1024 * 1024) {
          results.push({ name: path.basename(filePath), ok: false, error: '文件超过 2MB' });
          continue;
        }
        const text = fs.readFileSync(filePath, 'utf8');
        const result = await addDoc(path.basename(filePath), text);
        results.push({ name: path.basename(filePath), ...result });
      } catch (error) {
        results.push({ name: path.basename(filePath), ok: false, error: error.message || String(error) });
      }
    }
    emit(state());
    return results;
  }

  function removeDoc(id) {
    loadSync();
    docs = docs.filter((d) => d.id !== id);
    persist();
    emit(state());
    return true;
  }

  function clearAll() {
    loadSync();
    docs = [];
    persist();
    emit(state());
    return true;
  }

  function getDocs() {
    loadSync();
    return docs.map((d) => ({
      id: d.id,
      name: d.name,
      addedAt: d.addedAt,
      chunkCount: d.chunks.length,
      warning: d.warning || null,
      vectorReady: Boolean(d.vectorReady)
    }));
  }

  async function search(query, topK) {
    loadSync();
    const q = String(query || '').trim();
    if (!docs.length || !q) return [];
    const config = getConfig() || {};
    const mode = config.kbIndexMode || 'keyword';
    const k = Math.max(1, Math.min(8, Number(topK) || 4));

    let queryVector = null;
    if (mode === 'embedding' || mode === 'builtin') {
      try {
        const vectors = mode === 'builtin'
          ? (embedLocal.isAvailable() ? await embedLocal.embedTexts([q]) : null)
          : await embedRequest([q]);
        if (vectors && vectors.length) queryVector = vectors[0];
      } catch (_error) {
        // embedding 查询失败时回退为纯关键词打分
      }
    }

    const scored = [];
    for (const doc of docs) {
      for (const chunk of doc.chunks) {
        const lexical = lexicalScore(q, chunk.text);
        let score = lexical;
        if (queryVector && Array.isArray(chunk.vector)) {
          score = lexical * 0.25 + cosine(chunk.vector, queryVector) * 0.75;
        } else if ((mode === 'embedding' || mode === 'builtin') && queryVector) {
          score = lexical;
        }
        if (score > 0.02) scored.push({ text: chunk.text, doc: doc.name, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  return {
    loadAsync,
    getState: state,
    getDocs,
    addText: addDoc,
    importFiles,
    removeDoc,
    clearAll,
    search
  };
};
