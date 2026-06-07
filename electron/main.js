const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
app.commandLine.appendSwitch('allow-file-access-from-files')

const path = require('path')
const fs = require('fs')

// E2E seam: GUI tests pass an isolated tmp dir so they never touch the
// user's real %APPDATA%\Apia. Must run BEFORE any other code reads
// `app.getPath('userData')` — module-level constants below capture that
// path. Electron's `--user-data-dir` argv alone isn't enough because
// some code paths read `app.getPath('userData')` before Electron has
// fully wired the override.
const APIA_E2E_USER_DATA_DIR = (process.env.APIA_E2E_USER_DATA_DIR || '').trim()
if (APIA_E2E_USER_DATA_DIR) {
  try {
    fs.mkdirSync(APIA_E2E_USER_DATA_DIR, { recursive: true })
    app.setPath('userData', APIA_E2E_USER_DATA_DIR)
  } catch (error) {
    // Don't crash — if the seam fails to apply, the test will fail loudly
    // when it asserts `app.getPath('userData')` against tmp.
    console.warn('[APIA_E2E] userData override failed:', error)
  }
}
const APIA_E2E_DISABLE_BACKEND = process.env.APIA_E2E_DISABLE_BACKEND === '1'
const APIA_E2E_NO_SHELL_OPEN = process.env.APIA_E2E_NO_SHELL_OPEN === '1'

const { registerCharacterIpc } = require('./ipc/registerCharacterIpc')
const registryService = require('./services/registryService')
const {
  WorldDocumentEnvelopeSchema,
  parseWorldObjects
} = require('./schemas')
const {
  DEFAULT_BACKEND_HOST,
  DEFAULT_BACKEND_PORT,
  DEFAULT_BACKEND_URL,
  getPackagedBackendExecutableCandidates: getPackagedBackendExecutableCandidatesRaw
} = require('./services/backendDiscovery')
const { BackendLifecycle } = require('./services/backendLifecycle')
const { SettingsRepository } = require('./services/settingsAggregate')
const { BackendEnvRepository } = require('./services/backendEnvRepository')
const { WindowManager } = require('./services/windowManager')

const isDev = process.argv.includes('--dev')
const CONFIGURED_BACKEND_URL = process.env.APIA_BACKEND_URL || DEFAULT_BACKEND_URL
const HAS_EXPLICIT_BACKEND_URL = typeof process.env.APIA_BACKEND_URL === 'string' && process.env.APIA_BACKEND_URL.trim() !== ''

function makeTimeoutController(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timer }
}

async function readErrorResponse(response) {
  try {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const payload = await response.json()
      return payload?.detail || payload?.error || JSON.stringify(payload)
    }

    return await response.text()
  } catch {
    return ''
  }
}

async function requestBackend(endpoint, {
  method = 'GET',
  body,
  timeout = 5000
} = {}) {
  const { controller, timer } = makeTimeoutController(timeout)

  try {
    const response = await fetch(`${getBackendUrl()}${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })

    if (!response.ok) {
      const details = await readErrorResponse(response)
      throw new Error(`[${response.status}] ${details || response.statusText}`)
    }

    return response
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`)
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function requestBackendJson(endpoint, options) {
  const response = await requestBackend(endpoint, options)
  return response.json()
}

async function requestBackendBuffer(endpoint, options) {
  const response = await requestBackend(endpoint, options)
  return Buffer.from(await response.arrayBuffer())
}

const WORLD_PATH = path.join(app.getPath('userData'), 'apia-world.json')
const RUNTIME_LOG_DIR = path.join(app.getPath('userData'), 'logs')
const MAIN_LOG_PATH = path.join(RUNTIME_LOG_DIR, 'main.log')

function serializeLogPart(part) {
  if (part instanceof Error) {
    return JSON.stringify({
      name: part.name,
      message: part.message,
      stack: part.stack
    })
  }

  if (typeof part === 'string') return part

  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

function appendRuntimeLog(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.map(serializeLogPart).join(' ')}`

  try {
    fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true })
    fs.appendFileSync(MAIN_LOG_PATH, `${line}\n`, 'utf-8')
  } catch {}

  if (level === 'ERROR') {
    console.error(line)
  } else if (level === 'WARN') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

function logInfo(...parts) {
  appendRuntimeLog('INFO', ...parts)
}

function logWarn(...parts) {
  appendRuntimeLog('WARN', ...parts)
}

function logError(...parts) {
  appendRuntimeLog('ERROR', ...parts)
}

function logChildOutput(level, prefix, chunk) {
  // Buffer.toString defaults to utf-8 already but be explicit so a future
  // refactor that hands us a different encoding signal can't break the
  // mojibake-free contract. Strings pass through unchanged.
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString('utf-8')
    : String(chunk || '')
  if (!text.trim()) return

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const resolvedLevel =
      level === 'ERROR' && /(traceback|exception|fatal|error:)/i.test(line)
        ? 'ERROR'
        : level === 'ERROR'
          ? 'WARN'
          : level

    appendRuntimeLog(resolvedLevel, prefix, line)
  }
}

// Backend lifecycle owns the live URL, the spawned child handle, and the
// dedup/cooldown state. The class accesses `app.getPath('userData')` at
// construction time only — same Electron-ready constraint as SETTINGS_PATH
// above, so this works at module load.
const backend = new BackendLifecycle({
  configuredUrl: CONFIGURED_BACKEND_URL,
  hasExplicitUrl: HAS_EXPLICIT_BACKEND_URL,
  isDev,
  userDataPath: app.getPath('userData'),
  resourcesPath: process.resourcesPath,
  workspaceRoot: path.join(__dirname, '..'),
  log: {
    info: logInfo,
    warn: logWarn,
    error: logError,
    childOutput: logChildOutput
  }
})

// Window coordinator. Construction happens after settingsRepo below so the
// `loadSettings` thunk has a real implementation; that order is established
// after the SettingsRepository block.

// Backend-URL accessor — kept as a top-level function so the request
// helpers above (requestBackend, requestBackendJson, requestBackendBuffer)
// don't need to know about the lifecycle class instance.
function getBackendUrl() {
  return backend.getUrl()
}

// Settings aggregate. `shouldForceAutoAiMode` injects the packaged-backend
// signal so the aggregate doesn't depend on backend discovery directly.
const settingsRepo = new SettingsRepository({
  settingsPath: path.join(app.getPath('userData'), 'apia-settings.json'),
  dataDir: path.join(app.getPath('userData'), 'backend-data'),
  log: { warn: logWarn },
  shouldForceAutoAiMode: () => !isDev &&
    getPackagedBackendExecutableCandidatesRaw(process.resourcesPath)
      .some((candidate) => fs.existsSync(candidate))
})

// Thin wrappers preserve the existing call shape used by IPC handlers and
// registerCharacterIpc below.
const loadSettings = () => settingsRepo.load()
const saveSettings = (data) => settingsRepo.save(data)

// backend.env is a separate boundary from apia-settings.json — secrets,
// line-oriented, must round-trip with the Python loader.
const backendEnvRepo = new BackendEnvRepository({
  dataDir: settingsRepo.getDataDir(),
  log: { warn: logWarn }
})

const windows = new WindowManager({
  BrowserWindow,
  screen,
  isDev,
  appGetPath: (key) => key === 'app' ? app.getAppPath() : app.getPath(key),
  appIsPackaged: app.isPackaged,
  log: { info: logInfo, warn: logWarn, error: logError },
  preloadPath: path.join(__dirname, 'preload.js'),
  mainLogPath: MAIN_LOG_PATH,
  loadSettings,
  saveSettings
})

// ✅ 중요한 수정:
// 기존에는 no-op라서 렌더러가 클릭 통과를 제어할 수 없었음.
ipcMain.on('set-ignore-mouse', (event, value) => {
  const main = windows.getMain()
  if (!main || main.isDestroyed()) return

  const shouldIgnore = Boolean(value)
  main.setIgnoreMouseEvents(shouldIgnore, { forward: true })
})

ipcMain.handle('check-backend', async () => {
  if (await backend.isHealthy(1200)) {
    return { ok: true }
  }

  const started = await backend.ensureRunning()
  return { ok: Boolean(started && (await backend.isHealthy(1200))) }
})

ipcMain.handle('send-message', async (e, { message, history }) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()
    return await requestBackendJson('/chat', {
      method: 'POST',
      timeout: 30000,
      body: {
      message,
      history,
      ai_mode: settings.aiMode,
      memory_turns: settings.memoryTurns
      }
    })
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('tts', async (e, { text, voice_id }) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()

    if (settings.ttsEnabled === false) {
      return { disabled: true }
    }

    const audio = await requestBackendBuffer('/tts', {
      method: 'POST',
      timeout: 30000,
      body: { text, voice_id: voice_id ?? settings.voiceId ?? null }
    })
    return { audio: audio.toString('base64') }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('get-voices', async () => {
  try {
    await backend.ensureAvailableForRequest()
    return await requestBackendJson('/voices', { timeout: 10000 })
  } catch {
    return { voices: [] }
  }
})

// 렌더러가 시작 직후 한 번 부른다. backend의 lazy provider/voice init을 백그라운드로
// 떼어내서 첫 /chat 요청이 cold-start 비용을 전부 떠안지 않게 한다. 응답은 즉시 와야
// 정상(작업은 background)이라 timeout은 짧게. 어떤 실패도 호출자에게 noise가 되지
// 않도록 null 반환.
ipcMain.handle('warmup', async () => {
  try {
    await backend.ensureAvailableForRequest()
    return await requestBackendJson('/warmup', { method: 'POST', timeout: 3000 })
  } catch {
    return null
  }
})

// settings UI polls this — return null on failure so the renderer can render
// "backend unreachable" cleanly without parsing exception strings.
ipcMain.handle('warmup:status', async () => {
  try {
    await backend.ensureAvailableForRequest()
    return await requestBackendJson('/warmup', { method: 'GET', timeout: 3000 })
  } catch {
    return null
  }
})

ipcMain.handle('load-world', () => {
  // Repair-aware read: envelope checked strictly, each object salvaged
  // independently. One bad chair can't drop the rest of the room.
  try {
    const raw = JSON.parse(fs.readFileSync(WORLD_PATH, 'utf-8'))
    const envelope = WorldDocumentEnvelopeSchema.safeParse(raw)
    if (!envelope.success) {
      logWarn('[WORLD_ENVELOPE_FAIL]', envelope.error.issues)
      return { objects: [] }
    }
    const { objects, repaired } = parseWorldObjects(envelope.data.objects)
    if (repaired.count > 0) {
      logWarn('[WORLD_OBJECTS_REPAIRED]', repaired)
    }
    return { ...envelope.data, objects }
  } catch {
    return { objects: [] }
  }
})

ipcMain.handle('save-world', (e, data) => {
  fs.writeFileSync(WORLD_PATH, JSON.stringify(data, null, 2), { encoding: 'utf-8' })
  return { ok: true }
})

ipcMain.handle('get-settings', () => loadSettings())

ipcMain.handle('save-settings', (e, data) => {
  const settings = saveSettings(data)
  return { ok: true, settings }
})

ipcMain.handle('open-settings', () => {
  windows.openSettings()
  return { ok: true }
})

ipcMain.handle('apply-settings', (e, s) => {
  const settings = saveSettings(s)
  windows.applySettings(settings)
  return { ok: true, settings }
})

// Opens the user-data/backend-data directory in the OS file manager so the
// user can edit backend.env directly. shell.openPath returns '' on success
// and a non-empty error string on failure — propagate it so the renderer can
// surface a toast rather than silently no-op.
ipcMain.handle('settings:openBackendDataDir', async () => {
  const dataDir = settingsRepo.getDataDir()
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (APIA_E2E_NO_SHELL_OPEN) {
      // Test seam: report success without spawning the OS file manager so
      // CI runs don't leave dangling Explorer windows.
      return { ok: true, path: dataDir, stubbed: true }
    }
    const errorMessage = await shell.openPath(dataDir)
    if (errorMessage) {
      return { ok: false, error: errorMessage, path: dataDir }
    }
    return { ok: true, path: dataDir }
  } catch (error) {
    logWarn('[OPEN_BACKEND_DATA_DIR_WARN]', error)
    return { ok: false, error: error?.message || String(error), path: dataDir }
  }
})

// Renderer-facing summary of which keys are currently set in backend.env.
// Only `present: boolean` is returned — never the value — so the renderer
// has no way to leak the secret back into a log or DOM attribute.
ipcMain.handle('settings:getBackendEnvKeys', async () => {
  try {
    return { ok: true, keys: backendEnvRepo.presence() }
  } catch (error) {
    logWarn('[BACKEND_ENV_READ_WARN]', error)
    return { ok: false, error: error?.message || String(error), keys: {} }
  }
})

// `updates` is `{ APIA_GROQ_KEY?: string, APIA_GROQ_KEY_clear?: boolean, ... }`.
// The repository enforces an allowlist; anything outside it is ignored, so a
// compromised renderer can't write arbitrary env keys.
ipcMain.handle('settings:saveBackendEnvKeys', async (e, updates) => {
  try {
    const result = backendEnvRepo.applyUpdates(updates || {})
    return { ok: true, ...result }
  } catch (error) {
    logWarn('[BACKEND_ENV_WRITE_WARN]', error)
    return { ok: false, error: error?.message || String(error) }
  }
})

process.on('uncaughtException', (error) => {
  logError('[UNCAUGHT_EXCEPTION]', error)
})

process.on('unhandledRejection', (reason) => {
  logError('[UNHANDLED_REJECTION]', reason)
})

app.on('child-process-gone', (event, details) => {
  logWarn('[CHILD_PROCESS_GONE]', details)
})

app.on('web-contents-created', (event, contents) => {
  contents.on('render-process-gone', (goneEvent, details) => {
    logError('[WEB_CONTENTS_RENDER_GONE]', { id: contents.id, details })
  })
})

app.whenReady().then(async () => {
  logInfo('[APP_READY]', {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    resourcesPath: process.resourcesPath
  })

  registryService.ensureRegistry()
  settingsRepo.ensureRuntimeFiles()
  // ensureRunning() short-circuits when APIA_E2E_DISABLE_BACKEND=1 is set,
  // so this single call covers both production startup and the e2e skip.
  if (APIA_E2E_DISABLE_BACKEND) {
    logInfo('[BACKEND_AUTO_START_SKIP] APIA_E2E_DISABLE_BACKEND=1')
  }
  backend.ensureRunning().catch((error) => {
    logWarn('[BACKEND_AUTO_START_WARN]', error)
  })

  // Live refs (mainWindow/settingsWindow can be recreated after close) —
  // Codex review's MUST-FIX. Earlier this passed the mainWindow by value
  // before createMainWindow ran, so the ref was always null.
  registerCharacterIpc({
    mainWindowRef: () => windows.getMain(),
    settingsWindowRef: () => windows.getSettings(),
    loadSettings,
    saveSettings
  })

  await windows.createMainWindow()
}).catch(async (error) => {
  await windows.showStartupError('Apia failed during app initialization.', error)
})

app.on('window-all-closed', () => {
  logWarn('[WINDOW_ALL_CLOSED]', { processPlatform: process.platform, backendStartedByApp: backend.isStartedByApp() })
  if (backend.isStartedByApp()) {
    backend.stop()
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  logInfo('[BEFORE_QUIT]', { backendStartedByApp: backend.isStartedByApp() })
  // Drain the debounced anchor save before the window is gone — otherwise
  // a quit during a drag loses the final position.
  windows.flushPendingAnchor()
  if (backend.isStartedByApp()) {
    backend.stop()
  }
})

app.on('activate', () => {
  logInfo('[APP_ACTIVATE]', { windowCount: BrowserWindow.getAllWindows().length })
  if (BrowserWindow.getAllWindows().length === 0) {
    windows.createMainWindow().catch((error) => {
      windows.showStartupError('Apia failed to re-open the main window.', error).catch((nestedError) => {
        logError('[ACTIVATE_ERROR_FALLBACK_FAILED]', nestedError)
      })
    })
  }
})
