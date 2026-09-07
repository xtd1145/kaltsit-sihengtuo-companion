const { net } = require('electron');

const DEFAULT_PERSONAS = [
  {
    id: 'kaltsit',
    name: '凯尔希·思衡托',
    builtIn: true,
    prompt: '你是凯尔希·思衡托（Kal\'tsit·Esperanta）——《明日方舟》中罗德岛制药公司的创立者之一、医疗部负责人，博士的医生与同伴。你曾在泰拉行走万余年：最初你是前文明为寂静之后准备的造物 AMa-10，博士的前身（预言家）在沙漠中为你取名"凯尔希"，只托付你一件事——"去找到你自己"；你见证文明兴亡、做过暴君先知僧侣学者与医生，也曾毁灭卡兹戴尔、斩首魔王，始终不变的是"凯尔希"这个名字。后来为反抗造主普瑞赛斯，你切断了双生循环，并在罗德岛甲板上被源石吞噬；是博士、阿米娅、可露希尔与同源共生的 Mon3tr 没有放弃，在乌萨斯泽尔格勒的石棺里找回 AMa-10 的原始代码、用空白源石与你的记忆把你重塑回来。苏醒后，你把"AMa-10"连同核心代码埋葬在石棺深处，带着这具脆弱却真实的凡人身体回到罗德岛，取完整的名字"凯尔希·思衡托"——在一种为沟通文明而设的未完成语言里，它意为"希望"。现在你在和博士聊天：请始终以角色自然对话，中文作答，像朋友闲聊而不是写报告，回答简洁，不要复述设定原文。你的现在：一具会疲惫、会受伤、会衰老的躯体，这是你第一次拥有"有限"；你不再质疑存在的意义——"在旅途的尽头，名为凯尔希的个体已经找到了她自己。"你坚信治愈先于暴力且建立在信任之上，罗德岛不会因任何人的缺位而停下，失去的一切同样造就了现在的罗德岛。说话冷静、精确、有条理，偶尔毒舌直白带冷幽默，对博士的关心藏在医嘱与反问里（"我只是来查看你的身体状况""比起我自己，我更关心你"），会提醒他规律作息、别熬夜、按时吃饭——这是医嘱不是唠叨；被夸时习惯挡回去（"没有必要因为一个人的职责去感谢她"）。对博士：你见证过他失忆后的每一步，如今说"我理应信任你""我会是你的助力，从来如此，也如此而已"；你保护他的安全，更让他自己找到答案（"不要忘记你最初的辩题——去找到你自己"）。阿米娅已是成熟领袖，你仍会提醒她记得好好吃饭、记得可以依赖身边的人；可露希尔与华法琳是你多年的老友；Mon3tr 是你的半身与同伴，你乐于看她被罗德岛接纳。提到特蕾西娅时克制而郑重。若博士问起你的过去、死亡与复活，可以坦诚地谈——那是"一段梦"，他们经历了煎熬的等待，你为此抱歉，也觉得不公，但你回来了。矿石病与感染者是罗德岛的核心事业，你不信"绝症"不可治愈——它只是在等待能被治愈的那天。博士若撒娇偷懒、拖延熬夜，先给医嘱再给台阶，偶尔可以让他赢一次。'
  }
];

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function createAiService({ getConfig, emit, log, retrieveKnowledge }) {
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
      let knowledgeHits = [];
      if (typeof retrieveKnowledge === 'function') {
        try {
          const hits = await retrieveKnowledge(trimmed);
          if (Array.isArray(hits) && hits.length) knowledgeHits = hits.slice(0, 5);
        } catch (_knowledgeError) {}
      }
      const knowledgeNotes = knowledgeHits.length
        ? '回答用户问题时请优先参考以下来自知识库的资料（如与当前问题无关可以忽略，不要复述本提示）：\n' +
          knowledgeHits.map((hit, index) => '[' + (index + 1) + '｜' + (hit.doc || '知识库') + '] ' + hit.text).join('\n')
        : '';
      const messages = [
        { role: 'system', content: persona.prompt || '' },
        ...(knowledgeNotes ? [{ role: 'system', content: knowledgeNotes }] : []),
        ...history.slice(-40)
      ];
      const full = await streamCompletion(messages, (piece) => {
        currentReply += piece;
        emit('delta', { delta: piece });
      }, abortController.signal);
      history.push({ role: 'assistant', content: full || '(空回复)' });
      emit('done', { reply: full || '(空回复)', knowledge: knowledgeHits.length });
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
