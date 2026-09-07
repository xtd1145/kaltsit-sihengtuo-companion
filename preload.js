const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companionAPI', {
  platform: process.platform,
  getCharacter: () => ipcRenderer.invoke('character:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  getActions: () => ipcRenderer.invoke('actions:get'),
  playAction: (id) => ipcRenderer.invoke('action:play-now', id),
  openActionManager: () => ipcRenderer.invoke('manager:open'),
  replaceActionMedia: (id) => ipcRenderer.invoke('action:replace-media', id),
  restoreActionMedia: (id) => ipcRenderer.invoke('action:restore-media', id),
  saveActionLines: (id, lines) => ipcRenderer.invoke('action:save-lines', { id, lines }),
  restoreActionLines: (id) => ipcRenderer.invoke('action:restore-lines', id),
  saveActionLabel: (id, label) => ipcRenderer.invoke('action:save-label', { id, label }),
  restoreActionLabel: (id) => ipcRenderer.invoke('action:restore-label', id),
  addActions: (mode) => ipcRenderer.invoke('action:add', mode),
  setActionMode: (id, mode, enabled) => ipcRenderer.invoke('action:set-mode', { id, mode, enabled }),
  deleteAction: (id) => ipcRenderer.invoke('action:delete', id),
  pinAction: (id) => ipcRenderer.invoke('action:pin', id),
  setBaseAction: (id) => ipcRenderer.invoke('action:set-base', id),
  setActionInteraction: (id, enabled) => ipcRenderer.invoke('action:set-interaction', { id, enabled }),
  setActionDragRole: (id, role, enabled) => ipcRenderer.invoke('action:set-drag-role', { id, role, enabled }),
  setActionMemberships: (group, ids) => ipcRenderer.invoke('action:set-memberships', { group, ids }),
  openSettings: (section) => ipcRenderer.invoke('settings:open', section),
  openChat: () => ipcRenderer.invoke('ai:open'),
  aiGetState: () => ipcRenderer.invoke('ai:get-state'),
  aiSend: (text) => ipcRenderer.invoke('ai:send', text),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiNewSession: () => ipcRenderer.invoke('ai:new-session'),
  aiTest: () => ipcRenderer.invoke('ai:test'),
  aiSavePersonas: (list) => ipcRenderer.invoke('ai:personas-save', list),
  aiActivatePersona: (id) => ipcRenderer.invoke('ai:persona-activate', id),
  kbGetState: () => ipcRenderer.invoke('kb:get-state'),
  kbGetDocs: () => ipcRenderer.invoke('kb:get-docs'),
  kbAddText: (name, text) => ipcRenderer.invoke('kb:add-text', { name, text }),
  kbImportFiles: () => ipcRenderer.invoke('kb:import-files'),
  kbRemove: (id) => ipcRenderer.invoke('kb:remove', id),
  kbClear: () => ipcRenderer.invoke('kb:clear'),
  kbOpenManager: () => ipcRenderer.invoke('kb:open-manager'),
  toggleMouseThrough: () => ipcRenderer.invoke('mouse-through:toggle'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  showContextMenu: () => ipcRenderer.invoke('menu:show-context'),
  hidePet: () => ipcRenderer.invoke('pet:hide'),
  resetPosition: () => ipcRenderer.invoke('pet:reset-position'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getLyricsStatus: () => ipcRenderer.invoke('lyrics:status-get'),
  requestLyricsPermission: () => ipcRenderer.invoke('lyrics:permission-request'),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  onConfigChanged: (callback) => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
  onPlayAction: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('action:play', listener);
    return () => ipcRenderer.removeListener('action:play', listener);
  },
  onActionsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('actions:changed', listener);
    return () => ipcRenderer.removeListener('actions:changed', listener);
  },
  onLyricsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('lyrics:changed', listener);
    return () => ipcRenderer.removeListener('lyrics:changed', listener);
  },
  onLyricsStatusChanged: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('lyrics:status-changed', listener);
    return () => ipcRenderer.removeListener('lyrics:status-changed', listener);
  },
  onSettingsNavigate: (callback) => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('settings:navigate', listener);
    return () => ipcRenderer.removeListener('settings:navigate', listener);
  },
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  onAiState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ai:state', listener);
    return () => ipcRenderer.removeListener('ai:state', listener);
  },
  onAiDelta: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:delta', listener);
    return () => ipcRenderer.removeListener('ai:delta', listener);
  },
  onAiDone: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:done', listener);
    return () => ipcRenderer.removeListener('ai:done', listener);
  },
  onAiError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:error', listener);
    return () => ipcRenderer.removeListener('ai:error', listener);
  },
  onKbState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('kb:state', listener);
    return () => ipcRenderer.removeListener('kb:state', listener);
  }
});
