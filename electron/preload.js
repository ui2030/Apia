const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 기존 기능
  setIgnoreMouse: (v) => ipcRenderer.send('set-ignore-mouse', v),
  checkBackend: () => ipcRenderer.invoke('check-backend'),
  sendMessage: (msg, hist) => ipcRenderer.invoke('send-message', { message: msg, history: hist }),
  tts: (text, voice_id) => ipcRenderer.invoke('tts', { text, voice_id }),
  getVoices: () => ipcRenderer.invoke('get-voices'),
  warmup: () => ipcRenderer.invoke('warmup'),
  getWarmupStatus: () => ipcRenderer.invoke('warmup:status'),
  loadWorld: () => ipcRenderer.invoke('load-world'),
  saveWorld: (d) => ipcRenderer.invoke('save-world', d),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (d) => ipcRenderer.invoke('save-settings', d),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  applySettings: (d) => ipcRenderer.invoke('apply-settings', d),
  onSettingsApplied: (cb) => ipcRenderer.on('settings-applied', (e, s) => cb(s)),
  openBackendDataDir: () => ipcRenderer.invoke('settings:openBackendDataDir'),
  openBackendEnvFile: () => ipcRenderer.invoke('settings:openBackendEnvFile'),
  getBackendEnvKeys: () => ipcRenderer.invoke('settings:getBackendEnvKeys'),
  saveBackendEnvKeys: (updates) => ipcRenderer.invoke('settings:saveBackendEnvKeys', updates),
  restartBackend: () => ipcRenderer.invoke('settings:restartBackend'),

  // 🔥 캐릭터 시스템
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  getActiveCharacter: () => ipcRenderer.invoke('characters:getActive'),
  setActiveCharacter: (characterId) =>
    ipcRenderer.invoke('characters:setActive', { characterId }),

  importCharacterZip: (payload) =>
    ipcRenderer.invoke('characters:importZip', payload),

  pickCharacterSource: () =>
    ipcRenderer.invoke('characters:pickSource'),

  deleteCharacter: (characterId) =>
    ipcRenderer.invoke('characters:delete', { characterId }),

  // 이벤트
  onCharacterImported: (cb) =>
    ipcRenderer.on('character-imported', (e, payload) => cb(payload)),

  onCharacterChanged: (cb) =>
    ipcRenderer.on('character-changed', (e, payload) => cb(payload))
})
