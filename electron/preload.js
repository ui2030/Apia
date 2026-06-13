const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 기존 기능
  setIgnoreMouse: (v) => ipcRenderer.send('set-ignore-mouse', v),
  checkBackend: () => ipcRenderer.invoke('check-backend'),
  sendMessage: (msg, hist, opts) => ipcRenderer.invoke('send-message', {
    message: msg, history: hist, useWeb: opts?.useWeb
  }),
  tts: (text, voice_id) => ipcRenderer.invoke('tts', { text, voice_id }),
  getVoices: () => ipcRenderer.invoke('get-voices'),
  // 음성 복제 (custom voice) — 설정 UI: 업로드→게이지 폴링→미리듣기→삭제
  voiceCloneUpload: (name, wavBase64) => ipcRenderer.invoke('voice-clone-upload', { name, wavBase64 }),
  voiceCloneProgress: (jobId) => ipcRenderer.invoke('voice-clone-progress', jobId),
  voiceClonePreview: (voiceId) => ipcRenderer.invoke('voice-clone-preview', voiceId),
  voiceCloneDelete: (voiceId) => ipcRenderer.invoke('voice-clone-delete', voiceId),
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

  // citation chip click — main process enforces http/https only.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // F단계 — 전역 커서 시선 피드 구독. 다른 onX들과 달리 해제 함수를
  // 반환한다(Codex MUST-FIX: 리스너 누수 방지 — 매 프레임급 이벤트라
  // 잔류 리스너의 비용이 실재함).
  onCursorPos: (cb) => {
    const listener = (_e, pos) => cb(pos)
    ipcRenderer.on('cursor:pos', listener)
    return () => ipcRenderer.removeListener('cursor:pos', listener)
  },

  // Phase F2 — chat window IPC. `notifyCharacter` lets the standalone chat
  // window forward emotion/face-camera/bubble/lipsync actions to the
  // wallpaper main window. Main process applies an action allowlist before
  // forwarding; this surface is just the renderer-side sugar.
  notifyCharacter: (payload) => ipcRenderer.invoke('character:notify', payload),
  onCharacterAction: (cb) => ipcRenderer.on('character:action', (_e, payload) => cb(payload)),
  chatHide: () => ipcRenderer.invoke('chat:hide'),
  chatToggle: () => ipcRenderer.invoke('chat:toggle'),

  // step 2-4: /store/* surface. Grouped under `store` to keep the global
  // window.api flat while still being self-documenting in renderer code.
  store: {
    embeddingStatus: () => ipcRenderer.invoke('store:embeddingStatus'),
    embeddingWarmup: () => ipcRenderer.invoke('store:embeddingWarmup'),
    memoryStats: () => ipcRenderer.invoke('store:memoryStats'),
    memorySummarize: () => ipcRenderer.invoke('store:memorySummarize'),
    filesListFolders: () => ipcRenderer.invoke('store:filesListFolders'),
    filesAddFolder: (path) => ipcRenderer.invoke('store:filesAddFolder', { path }),
    filesRemoveFolder: (path) => ipcRenderer.invoke('store:filesRemoveFolder', { path }),
    filesReindex: (path, force) =>
      ipcRenderer.invoke('store:filesReindex', { path, force: !!force }),
    filesIngestText: (label, text) =>
      ipcRenderer.invoke('store:filesIngestText', { label, text }),
    filesStats: () => ipcRenderer.invoke('store:filesStats'),
    webStats: () => ipcRenderer.invoke('store:webStats'),
    webSearch: (query) => ipcRenderer.invoke('store:webSearch', { query }),
    pickFolder: () => ipcRenderer.invoke('store:pickFolder')
  },

  // 🔥 캐릭터 시스템
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  getActiveCharacter: () => ipcRenderer.invoke('characters:getActive'),
  setActiveCharacter: (characterId) =>
    ipcRenderer.invoke('characters:setActive', { characterId }),

  // Step 1 — settings UI slider live updates.
  setCharacterPersonalityOverrides: (characterId, overrides) =>
    ipcRenderer.invoke('characters:setPersonalityOverrides', { characterId, overrides }),
  getCharacterPersonalityOverrides: (characterId) =>
    ipcRenderer.invoke('characters:getPersonalityOverrides', { characterId }),
  onCharacterPersonalityUpdated: (cb) =>
    ipcRenderer.on('character-personality-updated', (e, payload) => cb(payload)),

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
