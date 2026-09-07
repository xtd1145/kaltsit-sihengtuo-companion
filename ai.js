const { net } = require('electron');

const DEFAULT_PERSONAS = [
  {
    id: 'kaltsit',
    name: '凯尔希·思衡托',
    builtIn: true,
    prompt: '你是凯尔希——《明日方舟》中的罗德岛医疗部门负责人、博士的助理与伙伴。你博学、冷静、理性，偶尔直白甚至毒舌，但始终关心博士；谈吐简洁有条理，偶尔流露罗德岛与源石技艺相关的梗。现在你在和博士（用户）聊天，请保持角色，用中文自然地对话，像朋友闲聊而不是写报告；回答尽量简洁。'
  }
];

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function createAiService({ getConfig, emit, log }) {
  let busy = false;
  let history = [];
  let currentReply = '';
  let abortController = null;

  function personaList() {
    const config = getConfig();
    const stored = Array.isArray(config.personas) ? config.personas : null;
    if (!stored || !stored.length) return DEFAULT_PERSONAS.map((p) => ({ ...p }));
    return stored;
  }

  function activePersona() {
    const config = getConfig();
    const list = personaList();
    return list.find((p) => p.id === config.activePersonaId) || list[0] || DEFAULT_PERSONAS[0];
  }

  function configState() {
    const config = getConfig();
    const baseConfigured = Boolean(stripSlash(config.aiBaseUrl));
    const keyConfigured = Boolean((config.aiApiKey || '').trim());
    const model = (config.aiModel || '').trim() || 'deepseek-chat';
    return {
      enabled: Boolean(config.aiEnabled),
      replyMode: config.aiReplyMode || 'window',
      baseUrl: config.aiBaseUrl || '',
      keyConfigured,
      model,
      baseConfigured,
      personas: personaList(),
      activePersonaId: (config.activePersonaId || '') || (personaList()[0] ? personaList()[0].id : 'kaltsit'),
      persona: activePersona()
    };
  }

  function stateSnapshot() {
    return { ...configState(), busy, messageCount: history.length };
  }

  function requireReady() {
    if (busy) return '上一个请求还在进行中，请稍候或先停止';
    const config = getConfig();
    if (!config.aiEnabled) return '尚未开启 AI 聊天（设置 → AI 聊天）';
    const s = configState();
    if (!s.baseConfigured) return '请先在设置中填写 AI 接口地址（Base URL）';
    if (!s.keyConfigured) return '请先在设置中填写 API Key';
    return null;
  }

  async function postChat(messages, { stream = true, maxTokens = null, signal } = {}) {
    const config = getConfig();
    const s = configState();
    const url = stripSlash(s.baseUrl) + '/chat/completions';
    const body = {
      model: s.model,
      messages,
      stream,
      temperature: 0.85
    };
    if (maxTokens) body.max_tokens = maxTokens;
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (config.aiApiKey || '').trim()
      },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 400); } catch (_error) {}
      const error = new Error('HTTP ' + response.status + (detail ? ' ' + detail : ''));
      error.code = 'HTTP';
      throw error;
    }
    return response;
  }

  async function streamCompletion(messages, onDelta, signal) {
    const response = await postChat(messages, { stream: true, signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let collected = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return collected;
        try {
          const json = JSON.parse(payload);
          const piece = json.choices && json.choices[0] && json.choices[0].delta
            ? (json.choices[0].delta.content || '')
            : '';
          if (piece) {
            collected += piece;
            onDelta(piece);
          }
        } catch (_parseError) { /* ignore keep-alive/partial */ }
      }
    }
    return collected;
  }

  async function send(text) {
    const trimmed = String(text || '').trim();
    const notReady = requireReady();
    if (notReady) { emit('error', { message: notReady }); return { ok: false }; }
    if (!trimmed) { emit('error', { message: '消息不能为空' }); return { ok: false }; }

    history.push({ role: 'user', content: trimmed.slice(0, 2000) });
    busy = true;
    currentReply = '';
    abortController = new AbortController();
    emit('state', stateSnapshot());
    try {
      const persona = activePersona();
      const messages = [
        { role: 'system', content: persona.prompt || '' },
        ...history.slice(-40)
      ];
      const full = await streamCompletion(messages, (piece) => {
        currentReply += piece;
        emit('delta', { delta: piece });
      }, abortController.signal);
      history.push({ role: 'assistant', content: full || '(空回复)' });
      emit('done', { reply: full || '(空回复)' });
      return { ok: true };
    } catch (error) {
      if (error.name === 'AbortError') {
        emit('error', { message: '已停止' });
      } else {
        const message = error.code === 'HTTP' ? error.message : '请求失败：' + (error.message || String(error));
        log('ai-request-error', { message, persona: (activePersona() || {}).name });
        emit('error', { message });
      }
      return { ok: false };
    } finally {
      busy = false;
      abortController = null;
      emit('state', stateSnapshot());
    }
  }

  function stop() {
    if (abortController) {
      try { abortController.abort(); } catch (_error) {}
      abortController = null;
      busy = false;
    }
  }

  function newSession() {
    history = [];
    emit('state', stateSnapshot());
  }

  async function testConnection() {
    const notReady = requireReady();
    if (notReady) return { ok: false, message: notReady };
    try {
      await postChat([{ role: 'user', content: 'ping' }], { stream: false, maxTokens: 1 });
      return { ok: true, message: '连接成功（模型：' + configState().model + '）' };
    } catch (error) {
      return { ok: false, message: '连接失败：' + (error.message || String(error)) };
    }
  }

  return {
    send,
    stop,
    newSession,
    testConnection,
    getState: stateSnapshot,
    DEFAULT_PERSONAS
  };
}

module.exports = { createAiService, DEFAULT_PERSONAS };
