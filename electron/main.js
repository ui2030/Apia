const { app, BrowserWindow, ipcMain, screen } = require('electron')
app.commandLine.appendSwitch('allow-file-access-from-files')

const path = require('path')
const fs = require('fs')
const axios = require('axios')

const { registerCharacterIpc } = require('./ipc/registerCharacterIpc')
const registryService = require('./services/registryService')

const BACKEND_URL = 'http://127.0.0.1:8000'
const isDev = process.argv.includes('--dev')

let mainWindow = null
let settingsWindow = null

const SETTINGS_PATH = path.join(app.getPath('userData'), 'apia-settings.json')
const WORLD_PATH = path.join(app.getPath('userData'), 'apia-world.json')

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    }
  } catch (e) {
    console.error('[SETTINGS_LOAD_ERROR]', e)
  }

  return {
    activeModel: 'dummy',
    activeCharacter: null,
    models: [],
    alwaysOnTop: true,
    charScale: 100,
    autoBehavior: true,
    aiMode: 'local',
    memoryTurns: 10,
    ttsEnabled: true,
    voiceId: null
  }
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2))
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const s = loadSettings()

  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: s.alwaysOnTop !== false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  })

  // ✅ 중요한 수정:
  // 처음부터 클릭 통과 상태로 두지 않음.
  // 이게 켜져 있으면 설정 버튼 / 채팅 버튼이 전부 안 눌릴 수 있음.
  mainWindow.setIgnoreMouseEvents(false)

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 700,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const settingsPath = isDev
    ? path.join(__dirname, '..', 'settings.html')
    : path.join(__dirname, '..', 'dist', 'settings.html')

  settingsWindow.loadFile(settingsPath)

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

// ✅ 중요한 수정:
// 기존에는 no-op라서 렌더러가 클릭 통과를 제어할 수 없었음.
ipcMain.on('set-ignore-mouse', (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const shouldIgnore = Boolean(value)
  mainWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true })
})

ipcMain.handle('check-backend', async () => {
  try {
    await axios.get(`${BACKEND_URL}/health`, { timeout: 2000 })
    return { ok: true }
  } catch (e) {
    return { ok: false }
  }
})

ipcMain.handle('send-message', async (e, { message, history }) => {
  try {
    return (await axios.post(`${BACKEND_URL}/chat`, { message, history })).data
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('tts', async (e, { text, voice_id }) => {
  try {
    const r = await axios.post(
      `${BACKEND_URL}/tts`,
      { text, voice_id },
      { responseType: 'arraybuffer' }
    )
    return { audio: Buffer.from(r.data).toString('base64') }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('get-voices', async () => {
  try {
    return (await axios.get(`${BACKEND_URL}/voices`)).data
  } catch {
    return { voices: [] }
  }
})

ipcMain.handle('load-world', () => {
  try {
    return JSON.parse(fs.readFileSync(WORLD_PATH, 'utf-8'))
  } catch {
    return { objects: [] }
  }
})

ipcMain.handle('save-world', (e, data) => {
  fs.writeFileSync(WORLD_PATH, JSON.stringify(data, null, 2))
  return { ok: true }
})

ipcMain.handle('get-settings', () => loadSettings())

ipcMain.handle('save-settings', (e, data) => {
  saveSettings(data)
  return { ok: true }
})

ipcMain.handle('open-settings', () => {
  openSettings()
  return { ok: true }
})

ipcMain.handle('apply-settings', (e, s) => {
  saveSettings(s)
  mainWindow?.setAlwaysOnTop(s.alwaysOnTop !== false)
  mainWindow?.webContents.send('settings-applied', s)

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-applied', s)
  }

  return { ok: true }
})

app.whenReady().then(() => {
  registryService.ensureRegistry()
  createWindow()

  registerCharacterIpc({
    mainWindow,
    settingsWindowRef: () => settingsWindow,
    loadSettings,
    saveSettings
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})