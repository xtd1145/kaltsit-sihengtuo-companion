const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  systemPreferences,
  Tray
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { LyricsService } = require('./lyrics');
const createUpdater = require('./updater');
const { createAiService, DEFAULT_PERSONAS } = require('./ai');
const createKnowledgeBase = require('./kb');

const CHARACTER_DIR = process.env.DESKTOP_PET_CHARACTER_DIR
  ? path.resolve(process.env.DESKTOP_PET_CHARACTER_DIR)
  : path.join(__dirname, 'character');
const CHARACTER = JSON.parse(fs.readFileSync(path.join(CHARACTER_DIR, 'character.json'), 'utf8'));
const DEFAULT_ACTION_ID = CHARACTER.defaultAction || 'idle';
const GREETING_ACTION_ID = CHARACTER.greetingAction || 'wave';
const ASSETS_DIR = path.join(CHARACTER_DIR, 'assets');
const GIFS_DIR = path.join(ASSETS_DIR, 'gifs');
const PREVIEWS_DIR = path.join(ASSETS_DIR, 'previews');
const ACTIONS = JSON.parse(fs.readFileSync(path.join(CHARACTER_DIR, 'actions.json'), 'utf8'));
const ICON_PATH = path.join(CHARACTER_DIR, CHARACTER.icon || 'assets/app-icon.png');
const TRAY_PATH = path.join(CHARACTER_DIR, CHARACTER.trayIcon || 'assets/tray.png');
const QQ_LYRICS_AVAILABLE = process.platform === 'darwin' && Boolean(CHARACTER.features?.qqLyrics);
const DEFAULT_ACTION = ACTIONS.find((action) => action.id === DEFAULT_ACTION_ID) || ACTIONS[0];
const CHARACTER_INFO = {
  id: CHARACTER.id,
  name: CHARACTER.name,
  productName: CHARACTER.productName,
  description: CHARACTER.description,
  version: CHARACTER.version,
  greeting: CHARACTER.greeting || `你好，我是${CHARACTER.name}。`,
  greetingAction: GREETING_ACTION_ID,
  defaultAction: DEFAULT_ACTION_ID,
  features: {
    qqLyrics: Boolean(CHARACTER.features?.qqLyrics)
  },
  idleMediaUrl: DEFAULT_ACTION
    ? pathToFileURL(path.join(GIFS_DIR, DEFAULT_ACTION.file)).href
    : null
};

app.setName(CHARACTER.productName);
if (process.platform === 'win32') app.disableHardwareAcceleration();

const ownsSingleInstance = process.platform !== 'win32' || app.requestSingleInstanceLock();
if (!ownsSingleInstance) app.quit();

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const CUSTOM_DIR = () => path.join(app.getPath('userData'), 'custom-actions');
const CUSTOM_MANIFEST_PATH = () => path.join(CUSTOM_DIR(), 'manifest.json');
const DIAGNOSTIC_LOG_PATH = () => path.join(app.getPath('userData'), 'diagnostics.log');
const MAX_DIAGNOSTIC_LOG_SIZE = 2 * 1024 * 1024;

const DEFAULT_CONFIG = {
  scale: 0.55,
  bubbleScale: 1,
  bubbleScalePresetVersion: 2,
  actionLibraryVersion: 3,
  sizePresetVersion: 1,
  alwaysOnTop: true,
  speechEnabled: true,
  qqLyricsEnabled: false,
  autoActionEnabled: true,
  activityMode: 'daily',
  previousActivityMode: 'daily',
  quietMode: false,
  actionFrequency: 'normal',
  openAtLogin: false,
  firstLaunch: true,
  pinnedAction: null,
  baseAction: DEFAULT_ACTION_ID,
  position: null,
  mouseThrough: false,
  autoUpdateEnabled: true,
  updateOwner: 'xtd1145',
  updateRepo: 'kaltsit-sihengtuo-companion',
  aiEnabled: false,
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiReplyMode: 'window',
  activePersonaId: 'kaltsit',
  personas: [],
  aiKnowledgeEnabled: false,
  kbIndexMode: 'keyword',
  kbEmbedBase: '',
  kbEmbedModel: '',
  kbEmbedKey: '',
  kbTopK: 4
};

const WINDOW_BASE = { width: 300, height: 360 };
const WINDOW_MIN_WIDTH = 184;
const TOOLBAR_AREA_HEIGHT = 52;
const LYRICS_AREA_HEIGHT = 86;
const LYRICS_MIN_WIDTH = 292;
let petWindow = null;
let settingsWindow = null;
let managerWindow = null;
let chatWindow = null;
let knowledgeWindow = null;
let tray = null;
let dragState = null;
let dragTimer = null;
let quitting = false;
let lyricsService = null;
let lyricsStatus = { state: 'disabled', message: '未开启', permission: false };
let petRendererRecoveries = [];
let updater = null;
let aiService = null;
let kbService = null;

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch (_jsonError) { return String(error); }
}

function writeDiagnosticLog(event, details = {}) {
  try {
    const logPath = DIAGNOSTIC_LOG_PATH();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_DIAGNOSTIC_LOG_SIZE) {
      fs.writeFileSync(logPath, '', 'utf8');
    }
    const payload = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, value instanceof Error ? errorText(value) : value])
    );
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`, 'utf8');
  } catch (_error) {}
}

function openDiagnosticLog() {
  writeDiagnosticLog('diagnostics-opened');
  shell.showItemInFolder(DIAGNOSTIC_LOG_PATH());
}

function recoverPetRenderer(details) {
  writeDiagnosticLog('pet-renderer-gone', details);
  if (quitting || ['clean-exit', 'killed'].includes(details.reason)) return;

  const now = Date.now();
  petRendererRecoveries = petRendererRecoveries.filter((time) => now - time < 60000);
  if (petRendererRecoveries.length >= 3) {
    writeDiagnosticLog('pet-renderer-recovery-stopped', { reason: 'too-many-restarts' });
    return;
  }
  petRendererRecoveries.push(now);
  setTimeout(() => {
    try {
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.reload();
    } catch (error) {
      writeDiagnosticLog('pet-renderer-reload-failed', { error });
    }
  }, 500);
}

process.on('uncaughtException', (error) => {
  writeDiagnosticLog('uncaught-exception', { error });
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeDiagnosticLog('unhandled-rejection', { reason: errorText(reason) });
});

function readConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    const config = { ...DEFAULT_CONFIG, ...stored };
    if (!ACTION_MODES.has(config.activityMode)) {
      config.activityMode = stored.quietMode ? 'quiet' : 'daily';
    }
    if (!['daily', 'office'].includes(config.previousActivityMode)) {
      config.previousActivityMode = config.activityMode === 'office' ? 'office' : 'daily';
    }
    config.quietMode = config.activityMode === 'quiet';
    if (!QQ_LYRICS_AVAILABLE) config.qqLyricsEnabled = false;
    if (stored.sizePresetVersion !== DEFAULT_CONFIG.sizePresetVersion) {
      config.scale = DEFAULT_CONFIG.scale;
      config.sizePresetVersion = DEFAULT_CONFIG.sizePresetVersion;
      writeConfig(config);
    }
    if (stored.bubbleScalePresetVersion !== DEFAULT_CONFIG.bubbleScalePresetVersion) {
      config.bubbleScale = safeBubbleScale((Number(stored.bubbleScale) || 1) / 1.35);
      config.bubbleScalePresetVersion = DEFAULT_CONFIG.bubbleScalePresetVersion;
      writeConfig(config);
    }
    const previousLibraryVersion = Number(stored.actionLibraryVersion) || 0;
    if (previousLibraryVersion !== DEFAULT_CONFIG.actionLibraryVersion) {
      config.actionLibraryVersion = DEFAULT_CONFIG.actionLibraryVersion;
      try {
        const manifest = JSON.parse(fs.readFileSync(CUSTOM_MANIFEST_PATH(), 'utf8'));
        if (previousLibraryVersion < 2) {
          if (manifest.banana && !manifest.record) manifest.record = { ...manifest.banana };
          delete manifest.banana;
        }
        if (previousLibraryVersion < 3) delete manifest.daydream;
        const builtInIds = new Set(ACTIONS.map((action) => action.id));
        for (const [id, entry] of Object.entries(manifest)) {
          if (entry?.customAdded) continue;
          if (!builtInIds.has(id)) {
            delete manifest[id];
            continue;
          }
          if (previousLibraryVersion < 2) {
            delete entry.mode;
            delete entry.modes;
          }
          removeEmptyManifestEntry(manifest, id);
        }
        writeCustomManifest(manifest);
      } catch (_error) {}
      writeConfig(config);
    }
    if (!Array.isArray(config.personas) || !config.personas.length) {
      config.personas = DEFAULT_PERSONAS.map((persona) => ({ ...persona }));
    }
    if (!config.personas.some((persona) => persona.id === config.activePersonaId)) {
      config.activePersonaId = config.personas[0].id;
    }
    return config;
  } catch (_error) {
    const fallback = { ...DEFAULT_CONFIG, personas: DEFAULT_PERSONAS.map((persona) => ({ ...persona })) };
    return fallback;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf8');
}

function readCustomManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(CUSTOM_MANIFEST_PATH(), 'utf8'));
    let changed = false;
    for (const action of ACTIONS) {
      const entry = manifest[action.id];
      if (!entry) continue;
      if (entry.mode && !Array.isArray(entry.modes)) {
        entry.modes = [safeMode(entry.mode)];
        delete entry.mode;
        changed = true;
      }
      if (Array.isArray(entry.modes) && sameModes(entry.modes, defaultModes(action))) {
        delete entry.modes;
        removeEmptyManifestEntry(manifest, action.id);
        changed = true;
      }
    }
    if (changed) writeCustomManifest(manifest);
    return manifest;
  } catch (_error) {
    return {};
  }
}

function writeCustomManifest(manifest) {
  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  fs.writeFileSync(CUSTOM_MANIFEST_PATH(), JSON.stringify(manifest, null, 2), 'utf8');
}

const ACTION_MODES = new Set(['quiet', 'daily', 'office']);

function defaultModes(action) {
  return [...new Set((Array.isArray(action.modes) ? action.modes : []).filter((mode) => ACTION_MODES.has(mode)))];
}

function safeMode(mode) {
  return ACTION_MODES.has(mode) ? mode : 'daily';
}

function safeModes(modes, fallback = []) {
  return [...new Set((Array.isArray(modes) ? modes : fallback).map(safeMode))];
}

function sameModes(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function removeEmptyManifestEntry(manifest, id) {
  const entry = manifest[id];
  if (!entry) return;
  const hasData = entry.customAdded || entry.fileName || entry.label ||
    Array.isArray(entry.lines) || Array.isArray(entry.modes) || entry.mode ||
    typeof entry.interaction === 'boolean' || typeof entry.dragging === 'boolean' ||
    typeof entry.dropReaction === 'boolean';
  if (!hasData) delete manifest[id];
}

function createPreview(sourcePath, previewPath) {
  try {
    const preview = nativeImage.createFromPath(sourcePath).resize({ width: 220, height: 220, quality: 'best' });
    if (!preview.isEmpty()) {
      fs.writeFileSync(previewPath, preview.toPNG());
      return true;
    }
  } catch (_error) {}
  return false;
}

function actionById(id) {
  return resolvedActions().find((action) => action.id === id);
}

function resolvedActions() {
  const config = readConfig();
  const manifest = readCustomManifest();
  const builtInActions = ACTIONS.map((action) => {
    const custom = manifest[action.id];
    const mediaPath = custom?.fileName ? path.join(CUSTOM_DIR(), custom.fileName) : null;
    const previewPath = custom?.previewName ? path.join(CUSTOM_DIR(), custom.previewName) : null;
    const hasCustom = Boolean(mediaPath && fs.existsSync(mediaPath));
    const hasCustomPreview = Boolean(previewPath && fs.existsSync(previewPath));
    return {
      ...action,
      label: custom?.label || action.label,
      modes: safeModes(custom?.modes, custom?.mode ? [custom.mode] : defaultModes(action)),
      mediaUrl: hasCustom ? pathToFileURL(mediaPath).href : pathToFileURL(path.join(GIFS_DIR, action.file)).href,
      previewUrl: hasCustomPreview
        ? pathToFileURL(previewPath).href
        : (hasCustom ? pathToFileURL(mediaPath).href : pathToFileURL(path.join(PREVIEWS_DIR, `${action.id}.png`)).href),
      custom: hasCustom,
      lines: Array.isArray(custom?.lines) ? custom.lines : action.lines,
      customLines: Array.isArray(custom?.lines),
      customLabel: Boolean(custom?.label),
      interaction: typeof custom?.interaction === 'boolean'
        ? custom.interaction
        : Boolean(action.interaction),
      dragging: typeof custom?.dragging === 'boolean'
        ? custom.dragging
        : Boolean(action.dragging),
      dropReaction: typeof custom?.dropReaction === 'boolean'
        ? custom.dropReaction
        : Boolean(action.dropReaction),
      originalName: hasCustom ? custom.originalName : null,
      pinned: config.pinnedAction === action.id,
      base: (config.baseAction || DEFAULT_ACTION_ID) === action.id,
      builtIn: true
    };
  });

  const addedActions = Object.entries(manifest)
    .filter(([, entry]) => entry?.customAdded && entry.fileName)
    .map(([id, entry]) => {
      const mediaPath = path.join(CUSTOM_DIR(), entry.fileName);
      const previewPath = entry.previewName ? path.join(CUSTOM_DIR(), entry.previewName) : null;
      if (!fs.existsSync(mediaPath)) return null;
      const hasPreview = Boolean(previewPath && fs.existsSync(previewPath));
      const defaultLabel = entry.defaultLabel || path.parse(entry.originalName || id).name;
      return {
        id,
        file: entry.fileName,
        label: entry.label || defaultLabel,
        group: 'custom',
        auto: true,
        modes: safeModes(entry.modes, entry.mode ? [entry.mode] : []),
        playMs: Number(entry.playMs) || 3000,
        lines: Array.isArray(entry.lines) ? entry.lines : [],
        mediaUrl: pathToFileURL(mediaPath).href,
        previewUrl: hasPreview ? pathToFileURL(previewPath).href : pathToFileURL(mediaPath).href,
        custom: true,
        customLines: Array.isArray(entry.lines) && entry.lines.length > 0,
        customLabel: Boolean(entry.label && entry.label !== defaultLabel),
        interaction: Boolean(entry.interaction),
        dragging: Boolean(entry.dragging),
        dropReaction: Boolean(entry.dropReaction),
        originalName: entry.originalName || entry.fileName,
        pinned: config.pinnedAction === id,
        base: (config.baseAction || DEFAULT_ACTION_ID) === id,
        builtIn: false,
        added: true
      };
    })
    .filter(Boolean);

  return [...builtInActions, ...addedActions];
}

function sendActions() {
  for (const window of [petWindow, managerWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('actions:changed');
  }
}

function safeScale(value) {
  const number = Number(value) || 1;
  return Math.min(1.4, Math.max(0.45, number));
}

function safeBubbleScale(value) {
  const number = Number(value) || 1;
  return Math.min(1.25, Math.max(0.65, number));
}

function windowSize(scale, qqLyricsEnabled = false) {
  const factor = safeScale(scale);
  return {
    width: Math.max(
      qqLyricsEnabled ? LYRICS_MIN_WIDTH : WINDOW_MIN_WIDTH,
      Math.round(WINDOW_BASE.width * factor)
    ),
    height: Math.round(WINDOW_BASE.height * factor) + TOOLBAR_AREA_HEIGHT +
      (qqLyricsEnabled ? LYRICS_AREA_HEIGHT : 0)
  };
}

function defaultPosition(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - size.width - 28),
    y: Math.round(area.y + area.height - size.height - 24)
  };
}

function visiblePosition(position, size) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return defaultPosition(size);
  }
  const displays = screen.getAllDisplays();
  const display = displays.find(({ workArea }) => (
    position.x + size.width > workArea.x &&
    position.x < workArea.x + workArea.width &&
    position.y + size.height > workArea.y &&
    position.y < workArea.y + workArea.height
  ));
  if (!display) return defaultPosition(size);
  const { workArea } = display;
  return {
    x: Math.min(Math.max(position.x, workArea.x), workArea.x + workArea.width - size.width),
    y: Math.min(Math.max(position.y, workArea.y), workArea.y + workArea.height - size.height)
  };
}

function sendConfig(config) {
  for (const window of [petWindow, settingsWindow, managerWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('config:changed', config);
  }
  refreshMenus();
}

function sendLyrics(payload) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('lyrics:changed', payload);
}

function sendLyricsStatus(status) {
  lyricsStatus = status;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('lyrics:status-changed', status);
  }
}

function sendAiEvent(type, payload) {
  for (const window of [chatWindow, petWindow]) {
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('ai:' + type, payload); } catch (_error) {}
    }
  }
}

function refreshAiState() {
  if (!aiService) return;
  const state = aiService.getState();
  for (const window of [chatWindow, petWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('ai:state', state); } catch (_error) {}
    }
  }
}

function configureLyrics(config, promptForPermission = false) {
  if (!lyricsService) {
    const message = process.platform === 'darwin' ? '此角色未启用' : 'Windows 版暂不提供';
    sendLyricsStatus({ state: 'disabled', message, permission: false });
    return;
  }
  if (config.qqLyricsEnabled) lyricsService.start({ promptForPermission });
  else {
    lyricsService.stop();
    sendLyricsStatus({ state: 'disabled', message: '未开启', permission: lyricsService.permission(false) });
  }
}

function applyWindowConfig(config) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = windowSize(config.scale, config.qqLyricsEnabled);
  const current = petWindow.getBounds();
  const next = visiblePosition({
    x: current.x + current.width - size.width,
    y: current.y + current.height - size.height
  }, size);
  petWindow.setBounds({
    ...next,
    ...size
  });
  petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), 'floating');
  applyClickThroughConfig(config);
}

function applyClickThroughConfig(config) {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    petWindow.setIgnoreMouseEvents(Boolean(config.mouseThrough));
  } catch (_error) {}
}

function toggleMouseThrough() {
  const config = readConfig();
  config.mouseThrough = !config.mouseThrough;
  writeConfig(config);
  applyWindowConfig(config);
  sendConfig(config);
  if (config.mouseThrough) notifyMouseThroughEnabled();
}

function notifyMouseThroughEnabled() {
  try {
    const notification = new Notification({
      title: '鼠标穿透已开启',
      body: '桌宠将不再拦截鼠标点击。如需关闭，请从托盘菜单「鼠标穿透」或设置页中取消。'
    });
    notification.on('click', toggleMouseThrough);
    notification.show();
  } catch (_error) {}
}

function playAction(id, line) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const action = resolvedActions().find((item) => item.id === id);
  petWindow.webContents.send('action:play', { id, line, action });
  if (!petWindow.isVisible()) petWindow.showInactive();
}

function savePosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const config = readConfig();
  const [x, y] = petWindow.getPosition();
  config.position = { x, y };
  writeConfig(config);
}

function updateDragPosition() {
  if (!dragState?.moving || !petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  if (cursor.x === dragState.lastCursorX && cursor.y === dragState.lastCursorY) return;

  const size = petWindow.getContentBounds();
  const position = visiblePosition({
    x: Math.round(dragState.windowX + cursor.x - dragState.cursorX),
    y: Math.round(dragState.windowY + cursor.y - dragState.cursorY)
  }, size);
  dragState.lastCursorX = cursor.x;
  dragState.lastCursorY = cursor.y;

  if (position.x !== dragState.lastWindowX || position.y !== dragState.lastWindowY) {
    dragState.lastWindowX = position.x;
    dragState.lastWindowY = position.y;
    petWindow.setPosition(position.x, position.y);
  }
}

function stopDragTracking(save = true) {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  const moved = Boolean(dragState?.moving);
  dragState = null;
  if (save && moved) savePosition();
}

function createPetWindow() {
  const config = readConfig();
  const size = windowSize(config.scale, config.qqLyricsEnabled);
  const position = visiblePosition(config.position, size);

  petWindow = new BrowserWindow({
    ...size,
    ...position,
    title: CHARACTER.productName,
    icon: ICON_PATH,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: config.alwaysOnTop,
    hasShadow: false,
    useContentSize: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), 'floating');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyClickThroughConfig(config);
  petWindow.loadFile('pet.html');
  petWindow.once('ready-to-show', () => petWindow.showInactive());
  petWindow.webContents.on('render-process-gone', (_event, details) => recoverPetRenderer(details));
  petWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      petWindow.hide();
    }
  });
  petWindow.on('closed', () => {
    stopDragTracking(false);
    petWindow = null;
  });
}

function createSettingsWindow(section = null) {
  const targetSection = typeof section === 'string' ? section : null;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (targetSection) settingsWindow.webContents.send('settings:navigate', targetSection);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 660,
    minHeight: 700,
    title: `${CHARACTER.productName}设置`,
    icon: ICON_PATH,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadFile('settings.html');
  if (targetSection) {
    settingsWindow.webContents.once('did-finish-load', () => {
      settingsWindow?.webContents.send('settings:navigate', targetSection);
    });
  }
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }

  managerWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 760,
    minHeight: 580,
    title: `${CHARACTER.name}动作管理`,
    icon: ICON_PATH,
    backgroundColor: '#f3f5f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  managerWindow.loadFile('manager.html');
  managerWindow.on('closed', () => { managerWindow = null; });
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 340,
    minHeight: 420,
    title: `${CHARACTER.productName} AI 聊天`,
    icon: ICON_PATH,
    backgroundColor: '#f6f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatWindow.loadFile('chat.html');
  chatWindow.on('closed', () => { chatWindow = null; });
}

function createKnowledgeWindow() {
  if (knowledgeWindow && !knowledgeWindow.isDestroyed()) {
    knowledgeWindow.show();
    knowledgeWindow.focus();
    return;
  }

  knowledgeWindow = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 560,
    minHeight: 440,
    title: `${CHARACTER.productName} 知识库`,
    icon: ICON_PATH,
    backgroundColor: '#f6f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  knowledgeWindow.loadFile('knowledge.html');
  knowledgeWindow.on('closed', () => { knowledgeWindow = null; });
}

function sendKbState(state) {
  for (const window of [settingsWindow, knowledgeWindow]) {
    if (window && !window.isDestroyed()) {
      try { window.webContents.send('kb:state', state); } catch (_error) {}
    }
  }
}

function refreshKbState() {
  if (!kbService) return;
  const state = kbService.getState();
  sendKbState(state);
}

function toggleQuietMode() {
  const config = readConfig();
  if (config.activityMode === 'quiet') {
    config.activityMode = config.previousActivityMode || 'daily';
  } else {
    config.previousActivityMode = config.activityMode;
    config.activityMode = 'quiet';
  }
  config.quietMode = config.activityMode === 'quiet';
  writeConfig(config);
  sendConfig(config);
}

function showPet() {
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  petWindow.showInactive();
}

function menuTemplate() {
  const config = readConfig();
  const quickActions = Array.isArray(CHARACTER.quickActions) ? CHARACTER.quickActions : [];
  return [
    { label: `${CHARACTER.productName} ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: `显示${CHARACTER.name}`, click: showPet },
    ...quickActions.map((item) => ({
      label: item.label,
      click: () => playAction(item.actionId)
    })),
    { type: 'separator' },
    { label: '动作管理…', click: createManagerWindow },
    { label: 'AI 聊天…', click: createChatWindow },
    { label: '安静模式', type: 'checkbox', checked: config.activityMode === 'quiet', click: toggleQuietMode },
    { label: '鼠标穿透', type: 'checkbox', checked: config.mouseThrough, click: toggleMouseThrough },
    { label: '设置…', click: createSettingsWindow },
    { label: '诊断日志…', click: openDiagnosticLog },
    { label: '隐藏', click: () => petWindow?.hide() },
    { type: 'separator' },
    { label: `退出${CHARACTER.productName}`, click: () => { quitting = true; app.quit(); } }
  ];
}

function refreshMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_PATH);
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON_PATH);
  image = image.resize({ width: 20, height: 20, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip(CHARACTER.productName);
  refreshMenus();
  tray.on('click', showPet);
}

function showContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: '摸摸', click: () => playAction('pat') },
    { label: '打招呼', click: () => playAction('wave') },
    { label: '随机动作', click: () => playAction('random') },
    { type: 'separator' },
    { label: '动作管理…', click: createManagerWindow },
    { label: 'AI 聊天…', click: createChatWindow },
    { label: '安静模式', type: 'checkbox', checked: readConfig().activityMode === 'quiet', click: toggleQuietMode },
    { label: '鼠标穿透', type: 'checkbox', checked: readConfig().mouseThrough, click: toggleMouseThrough },
    { label: '设置…', click: createSettingsWindow },
    { label: '诊断日志…', click: openDiagnosticLog },
    { label: '隐藏', click: () => petWindow.hide() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]).popup({ window: petWindow });
}

app.whenReady().then(() => {
  if (!ownsSingleInstance) return;
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId(CHARACTER.appId);
  if (app.dock) app.dock.hide();
  if (QQ_LYRICS_AVAILABLE) {
    lyricsService = new LyricsService({
      app,
      systemPreferences,
      productName: CHARACTER.productName,
      clientHeader: `${CHARACTER.packageName}/${CHARACTER.version} (desktop companion)`,
      onUpdate: sendLyrics,
      onStatus: sendLyricsStatus
    });
  }
  createTray();
  createPetWindow();
  configureLyrics(readConfig());
  updater = createUpdater({
    getConfig: readConfig,
    onStateChange: (state) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('update:state', state);
      }
    },
    onOpenSettings: () => createSettingsWindow('update'),
    log: (event, details) => writeDiagnosticLog(event, details)
  });
  updater.applyConfig(readConfig());
  kbService = createKnowledgeBase({
    getConfig: readConfig,
    getIndexPath: () => path.join(app.getPath('userData'), 'knowledge-index.json'),
    emit: sendKbState,
    log: (event, details) => writeDiagnosticLog(event, details)
  });
  kbService.loadAsync();
  aiService = createAiService({
    getConfig: readConfig,
    emit: sendAiEvent,
    log: (event, details) => writeDiagnosticLog(event, details),
    retrieveKnowledge: async (query) => {
      const config = readConfig();
      if (!config.aiKnowledgeEnabled || !kbService) return [];
      const kbState = kbService.getState();
      if (!kbState.docCount) return [];
      return kbService.search(query, config.kbTopK);
    }
  });
  writeDiagnosticLog('startup', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    hardwareAcceleration: process.platform !== 'win32'
  });
  app.on('activate', showPet);
}).catch((error) => {
  writeDiagnosticLog('startup-failed', { error });
  app.exit(1);
});

if (process.platform === 'win32' && ownsSingleInstance) {
  app.on('second-instance', () => {
    writeDiagnosticLog('second-instance');
    if (app.isReady()) showPet();
  });
  app.on('child-process-gone', (_event, details) => {
    writeDiagnosticLog('child-process-gone', details);
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (updater) updater.stop();
  writeDiagnosticLog('shutdown');
  savePosition();
});

app.on('window-all-closed', () => {});

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('character:get', () => CHARACTER_INFO);
ipcMain.handle('actions:get', () => resolvedActions());
ipcMain.handle('config:save', (_event, partial) => {
  const previous = readConfig();
  const config = { ...previous, ...partial };
  if (typeof partial?.quietMode === 'boolean' && !partial?.activityMode) {
    config.activityMode = partial.quietMode
      ? 'quiet'
      : (previous.previousActivityMode || 'daily');
  }
  config.activityMode = safeMode(config.activityMode);
  if (config.activityMode !== 'quiet') config.previousActivityMode = config.activityMode;
  config.quietMode = config.activityMode === 'quiet';
  config.scale = safeScale(config.scale);
  config.bubbleScale = safeBubbleScale(config.bubbleScale);
  config.qqLyricsEnabled = QQ_LYRICS_AVAILABLE && Boolean(config.qqLyricsEnabled);
  config.mouseThrough = Boolean(config.mouseThrough);
  config.autoUpdateEnabled = Boolean(config.autoUpdateEnabled);
  config.updateOwner = typeof config.updateOwner === 'string' ? config.updateOwner.trim().slice(0, 100) : '';
  config.updateRepo = typeof config.updateRepo === 'string' ? config.updateRepo.trim().slice(0, 100) : '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(`${config.updateOwner}/${config.updateRepo}`)) {
    config.updateOwner = '';
    config.updateRepo = '';
  }
  config.aiEnabled = Boolean(config.aiEnabled);
  config.aiReplyMode = ['window', 'bubble', 'both'].includes(config.aiReplyMode)
    ? config.aiReplyMode
    : 'window';
  config.aiBaseUrl = typeof config.aiBaseUrl === 'string' ? config.aiBaseUrl.trim().slice(0, 300) : '';
  config.aiApiKey = typeof config.aiApiKey === 'string' ? config.aiApiKey.trim().slice(0, 200) : '';
  config.aiModel = typeof config.aiModel === 'string' ? config.aiModel.trim().slice(0, 100) : '';
  config.aiKnowledgeEnabled = Boolean(config.aiKnowledgeEnabled);
  config.kbIndexMode = ['keyword', 'builtin', 'embedding'].includes(config.kbIndexMode) ? config.kbIndexMode : 'keyword';
  config.kbEmbedBase = typeof config.kbEmbedBase === 'string' ? config.kbEmbedBase.trim().slice(0, 300) : '';
  config.kbEmbedModel = typeof config.kbEmbedModel === 'string' ? config.kbEmbedModel.trim().slice(0, 100) : '';
  config.kbEmbedKey = typeof config.kbEmbedKey === 'string' ? config.kbEmbedKey.trim().slice(0, 200) : '';
  config.kbTopK = Math.max(1, Math.min(8, Number(config.kbTopK) || 4));
  writeConfig(config);
  applyWindowConfig(config);
  app.setLoginItemSettings({
    openAtLogin: Boolean(config.openAtLogin),
    ...(process.platform === 'win32' ? { path: process.execPath } : {})
  });
  sendConfig(config);
  if (updater) updater.applyConfig(config);
  if (aiService) refreshAiState();
  if (kbService) refreshKbState();
  if (previous.qqLyricsEnabled !== config.qqLyricsEnabled) {
    configureLyrics(config, config.qqLyricsEnabled);
  }
  return config;
});
ipcMain.handle('lyrics:status-get', () => lyricsStatus);
ipcMain.handle('lyrics:permission-request', () => {
  const permission = lyricsService?.permission(true) || false;
  if (readConfig().qqLyricsEnabled) configureLyrics(readConfig());
  return { ...lyricsStatus, permission };
});
ipcMain.handle('settings:open', (_event, section) => { createSettingsWindow(section); return true; });
ipcMain.handle('manager:open', () => { createManagerWindow(); return true; });
ipcMain.handle('action:play-now', (_event, id) => {
  if (!actionById(id)) return false;
  playAction(id);
  return true;
});
ipcMain.handle('action:pin', (_event, id) => {
  const config = readConfig();
  config.pinnedAction = id && actionById(id) ? id : null;
  writeConfig(config);
  sendConfig(config);
  sendActions();
  return config;
});
ipcMain.handle('action:set-base', (_event, id) => {
  const config = readConfig();
  config.baseAction = id && actionById(id) ? id : DEFAULT_ACTION_ID;
  writeConfig(config);
  sendConfig(config);
  sendActions();
  return config;
});
ipcMain.handle('action:add', async (_event, requestedMode) => {
  const initialModes = ACTION_MODES.has(requestedMode) ? [requestedMode] : [];
  const parent = managerWindow && !managerWindow.isDestroyed() ? managerWindow : undefined;
  const result = await dialog.showOpenDialog(parent, {
    title: '添加 GIF 动作',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GIF 动画', extensions: ['gif'] }]
  });
  if (result.canceled || !result.filePaths.length) return { changed: false, ids: [] };

  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  const manifest = readCustomManifest();
  const stamp = Date.now();
  const ids = [];
  result.filePaths.forEach((sourcePath, index) => {
    const id = `user-${stamp}-${index}`;
    const fileName = `${id}.gif`;
    const previewName = `${id}-preview.png`;
    const originalName = path.basename(sourcePath);
    fs.copyFileSync(sourcePath, path.join(CUSTOM_DIR(), fileName));
    const hasPreview = createPreview(sourcePath, path.join(CUSTOM_DIR(), previewName));
    manifest[id] = {
      customAdded: true,
      fileName,
      previewName: hasPreview ? previewName : null,
      originalName,
      defaultLabel: path.parse(originalName).name.slice(0, 24) || '新动作',
      modes: initialModes,
      lines: [],
      playMs: 3000,
      updatedAt: stamp
    };
    ids.push(id);
  });
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, ids };
});
ipcMain.handle('action:set-mode', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action) return { changed: false };
  const mode = safeMode(payload?.mode);
  const modes = new Set(action.modes || []);
  if (payload?.enabled) modes.add(mode);
  else modes.delete(mode);
  const manifest = readCustomManifest();
  manifest[action.id] = {
    ...(manifest[action.id] || {}),
    modes: [...modes]
  };
  delete manifest[action.id].mode;
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && sameModes(manifest[action.id].modes, defaultModes(builtIn))) {
    delete manifest[action.id].modes;
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, modes: manifest[action.id].modes };
});
ipcMain.handle('action:set-interaction', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action) return { changed: false };
  const enabled = Boolean(payload?.enabled);
  const manifest = readCustomManifest();
  manifest[action.id] = {
    ...(manifest[action.id] || {}),
    interaction: enabled
  };
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && enabled === Boolean(builtIn.interaction)) {
    delete manifest[action.id].interaction;
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, interaction: enabled };
});
ipcMain.handle('action:set-drag-role', (_event, payload) => {
  const action = actionById(payload?.id);
  const field = payload?.role === 'dragging'
    ? 'dragging'
    : (payload?.role === 'drop' ? 'dropReaction' : null);
  if (!action || !field) return { changed: false };
  const enabled = Boolean(payload?.enabled);
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), [field]: enabled };
  const builtIn = ACTIONS.find((item) => item.id === action.id);
  if (builtIn && enabled === Boolean(builtIn[field])) {
    delete manifest[action.id][field];
    removeEmptyManifestEntry(manifest, action.id);
  }
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, [field]: enabled };
});
ipcMain.handle('action:set-memberships', (_event, payload) => {
  const group = payload?.group;
  const membershipFields = {
    interaction: 'interaction',
    dragging: 'dragging',
    drop: 'dropReaction'
  };
  if (![...ACTION_MODES, ...Object.keys(membershipFields)].includes(group)) return { changed: false };
  const selected = new Set(Array.isArray(payload?.ids) ? payload.ids : []);
  const allActions = resolvedActions();
  const manifest = readCustomManifest();
  let changed = false;

  for (const action of allActions) {
    const enabled = selected.has(action.id);
    const membershipField = membershipFields[group];
    if (membershipField) {
      if (Boolean(action[membershipField]) === enabled) continue;
      manifest[action.id] = { ...(manifest[action.id] || {}), [membershipField]: enabled };
      const builtIn = ACTIONS.find((item) => item.id === action.id);
      if (builtIn && enabled === Boolean(builtIn[membershipField])) {
        delete manifest[action.id][membershipField];
        removeEmptyManifestEntry(manifest, action.id);
      }
      changed = true;
      continue;
    }

    const modes = new Set(action.modes || []);
    if (modes.has(group) === enabled) continue;
    if (enabled) modes.add(group);
    else modes.delete(group);
    manifest[action.id] = { ...(manifest[action.id] || {}), modes: [...modes] };
    delete manifest[action.id].mode;
    const builtIn = ACTIONS.find((item) => item.id === action.id);
    if (builtIn && sameModes(manifest[action.id].modes, defaultModes(builtIn))) {
      delete manifest[action.id].modes;
      removeEmptyManifestEntry(manifest, action.id);
    }
    changed = true;
  }

  if (changed) {
    writeCustomManifest(manifest);
    sendActions();
  }
  return { changed };
});
ipcMain.handle('action:delete', (_event, id) => {
  const action = actionById(id);
  const manifest = readCustomManifest();
  const entry = manifest[id];
  if (!action || action.builtIn || !entry?.customAdded) return { changed: false };
  for (const name of [entry.fileName, entry.previewName]) {
    if (!name) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  delete manifest[id];
  writeCustomManifest(manifest);
  const config = readConfig();
  if (config.pinnedAction === id) {
    config.pinnedAction = null;
  }
  if (config.baseAction === id) config.baseAction = DEFAULT_ACTION_ID;
  writeConfig(config);
  sendConfig(config);
  sendActions();
  return { changed: true };
});
ipcMain.handle('action:replace-media', async (_event, id) => {
  const action = actionById(id);
  if (!action) return { changed: false };
  const parent = managerWindow && !managerWindow.isDestroyed() ? managerWindow : undefined;
  const result = await dialog.showOpenDialog(parent, {
    title: `替换“${action.label}”素材`,
    properties: ['openFile'],
    filters: [
      { name: '动画与图片', extensions: ['gif', 'png', 'webp'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return { changed: false };

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();
  const stamp = Date.now();
  const fileName = `${id}-${stamp}${extension}`;
  const previewName = `${id}-${stamp}-preview.png`;
  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  fs.copyFileSync(sourcePath, path.join(CUSTOM_DIR(), fileName));

  createPreview(sourcePath, path.join(CUSTOM_DIR(), previewName));

  const manifest = readCustomManifest();
  const previous = manifest[id];
  manifest[id] = {
    ...(previous || {}),
    fileName,
    previewName: fs.existsSync(path.join(CUSTOM_DIR(), previewName)) ? previewName : null,
    originalName: path.basename(sourcePath),
    updatedAt: stamp
  };
  writeCustomManifest(manifest);

  for (const name of [previous?.fileName, previous?.previewName]) {
    if (!name || name === fileName || name === previewName) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  sendActions();
  playAction(id);
  return { changed: true };
});
ipcMain.handle('action:restore-media', (_event, id) => {
  const action = actionById(id);
  if (!action || !action.builtIn) return { changed: false };
  const manifest = readCustomManifest();
  const previous = manifest[id];
  if (!previous) return { changed: false };
  const next = { ...previous };
  delete next.fileName;
  delete next.previewName;
  delete next.originalName;
  delete next.updatedAt;
  manifest[id] = next;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  for (const name of [previous.fileName, previous.previewName]) {
    if (!name) continue;
    try { fs.unlinkSync(path.join(CUSTOM_DIR(), name)); } catch (_error) {}
  }
  sendActions();
  playAction(id);
  return { changed: true };
});
ipcMain.handle('action:save-lines', (_event, payload) => {
  const action = actionById(payload?.id);
  if (!action || !Array.isArray(payload?.lines)) return { changed: false };
  const lines = payload.lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => line.slice(0, 80));
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), lines };
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, lines };
});
ipcMain.handle('action:restore-lines', (_event, id) => {
  if (!actionById(id)) return { changed: false };
  const manifest = readCustomManifest();
  if (!manifest[id] || !Array.isArray(manifest[id].lines)) return { changed: false };
  delete manifest[id].lines;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true };
});
ipcMain.handle('action:save-label', (_event, payload) => {
  const action = actionById(payload?.id);
  const label = String(payload?.label || '').trim().slice(0, 24);
  if (!action || !label) return { changed: false };
  const manifest = readCustomManifest();
  manifest[action.id] = { ...(manifest[action.id] || {}), label };
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true, label };
});
ipcMain.handle('action:restore-label', (_event, id) => {
  if (!actionById(id)) return { changed: false };
  const manifest = readCustomManifest();
  if (!manifest[id]?.label) return { changed: false };
  delete manifest[id].label;
  removeEmptyManifestEntry(manifest, id);
  writeCustomManifest(manifest);
  sendActions();
  return { changed: true };
});
ipcMain.handle('menu:show-context', () => { showContextMenu(); return true; });
ipcMain.handle('pet:hide', () => { petWindow?.hide(); return true; });
ipcMain.handle('pet:reset-position', () => {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const config = readConfig();
  const size = windowSize(config.scale, config.qqLyricsEnabled);
  const position = defaultPosition(size);
  petWindow.setPosition(position.x, position.y);
  savePosition();
  return true;
});
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('mouse-through:toggle', () => {
  toggleMouseThrough();
  return readConfig().mouseThrough;
});
ipcMain.handle('update:get-state', () => (updater ? updater.getState() : { phase: 'idle', currentVersion: app.getVersion() }));
ipcMain.handle('update:check', () => (updater ? updater.checkForUpdates({ manual: true }) : { phase: 'error', message: '更新模块未就绪' }));
ipcMain.handle('update:install', () => (updater ? updater.downloadAndInstall() : false));
ipcMain.handle('ai:get-state', () => (aiService ? aiService.getState() : { enabled: false, busy: false, replyMode: 'window', personas: [], persona: null }));
ipcMain.handle('ai:send', (_event, text) => (aiService ? aiService.send(text) : { ok: false }));
ipcMain.handle('ai:stop', () => { if (aiService) aiService.stop(); return true; });
ipcMain.handle('ai:new-session', () => { if (aiService) aiService.newSession(); return true; });
ipcMain.handle('ai:test', () => (aiService ? aiService.testConnection() : { ok: false, message: 'AI 模块未就绪' }));
ipcMain.handle('ai:open', () => { createChatWindow(); return true; });
ipcMain.handle('ai:personas-save', (_event, rawList) => {
  const config = readConfig();
  const list = (Array.isArray(rawList) ? rawList : [])
    .filter((persona) => persona && typeof persona.id === 'string' && persona.id)
    .slice(0, 30)
    .map((persona) => ({
      id: String(persona.id).slice(0, 40),
      name: (String(persona.name || '').trim().slice(0, 30)) || '新人格',
      prompt: String(persona.prompt || '').slice(0, 12000),
      builtIn: Boolean(persona.builtIn)
    }));
  if (!list.length) list.push({ ...DEFAULT_PERSONAS[0] });
  config.personas = list;
  if (!config.personas.some((persona) => persona.id === config.activePersonaId)) {
    config.activePersonaId = config.personas[0].id;
  }
  writeConfig(config);
  sendConfig(config);
  refreshAiState();
  return config.personas;
});
ipcMain.handle('ai:persona-activate', (_event, id) => {
  const config = readConfig();
  if (!config.personas.some((persona) => persona.id === id)) return false;
  if (aiService) { aiService.stop(); aiService.newSession(); }
  config.activePersonaId = id;
  writeConfig(config);
  sendConfig(config);
  refreshAiState();
  return true;
});
ipcMain.handle('kb:get-state', () => (kbService ? kbService.getState() : { docCount: 0, chunkCount: 0, mode: 'keyword', ready: false }));
ipcMain.handle('kb:get-docs', () => (kbService ? kbService.getDocs() : []));
ipcMain.handle('kb:add-text', async (_event, payload) => {
  if (!kbService) return { ok: false, error: '知识库未就绪' };
  const result = await kbService.addText(payload && payload.name, payload && payload.text);
  if (result.ok) refreshKbState();
  return result;
});
ipcMain.handle('kb:import-files', async (_event) => {
  if (!kbService) return { imported: [], errors: ['知识库未就绪'] };
  const parent = knowledgeWindow && !knowledgeWindow.isDestroyed() ? knowledgeWindow : undefined;
  const result = await dialog.showOpenDialog(parent, {
    title: '导入知识文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本与文档', extensions: ['txt', 'md', 'markdown', 'json', 'csv', 'srt'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { imported: [] };
  const imported = await kbService.importFiles(result.filePaths);
  refreshKbState();
  return { imported };
});
ipcMain.handle('kb:remove', (_event, id) => {
  if (!kbService) return false;
  kbService.removeDoc(id);
  refreshKbState();
  return true;
});
ipcMain.handle('kb:clear', () => {
  if (!kbService) return false;
  kbService.clearAll();
  refreshKbState();
  return true;
});
ipcMain.handle('kb:open-manager', () => { createKnowledgeWindow(); return true; });

ipcMain.on('drag:start', () => {
  if (!petWindow || petWindow.isDestroyed()) return;
  stopDragTracking(false);
  const [x, y] = petWindow.getPosition();
  const cursor = screen.getCursorScreenPoint();
  dragState = {
    cursorX: cursor.x,
    cursorY: cursor.y,
    windowX: x,
    windowY: y,
    lastCursorX: cursor.x,
    lastCursorY: cursor.y,
    lastWindowX: x,
    lastWindowY: y,
    moving: false
  };
});
ipcMain.on('drag:move', () => {
  if (!dragState || !petWindow || petWindow.isDestroyed()) return;
  dragState.moving = true;
  if (process.platform !== 'win32') {
    updateDragPosition();
    return;
  }
  if (dragTimer) return;
  updateDragPosition();
  dragTimer = setInterval(updateDragPosition, 16);
});
ipcMain.on('drag:end', () => {
  stopDragTracking(true);
});
