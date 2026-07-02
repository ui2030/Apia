const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } = require('electron')
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

// Single-instance guard. Without it, pressing "Apia 시작" while the app is
// already running spawns a SECOND full instance that fights the first for the
// backend port — and in wallpaper mode neither has a visible window, so it
// looks like "nothing happened". Skip under E2E (tests run isolated instances
// in separate userData dirs and must be allowed to coexist).
if (!APIA_E2E_USER_DATA_DIR) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      // Already running. In wallpaper mode there's no main window to focus, so
      // open Settings as a visible "yes, it's already on" signal.
      try { windows.openSettings() } catch {}
    })
  }
}

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
const wallpaperMode = require('./services/wallpaperMode')

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

let runtimeLogWriteCount = 0
const MAX_LOG_BYTES = 5 * 1024 * 1024 // L단계 — main.log 1세대 롤오버 임계(5MB)
function appendRuntimeLog(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.map(serializeLogPart).join(' ')}`

  try {
    fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true })
    // L단계(안정성) — 로그 무한 증가 방지: 500줄마다 크기 점검, 5MB 초과 시
    // 1세대 롤오버(main.log→main.log.1). rotate 실패해도 append는 계속(Codex).
    if ((runtimeLogWriteCount++ % 500) === 0) {
      try {
        if (fs.statSync(MAIN_LOG_PATH).size > MAX_LOG_BYTES) {
          try { fs.unlinkSync(`${MAIN_LOG_PATH}.1`) } catch {}
          fs.renameSync(MAIN_LOG_PATH, `${MAIN_LOG_PATH}.1`)
        }
      } catch {}
    }
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

ipcMain.handle('send-message', async (e, { message, history, useWeb }) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()
    // Per-message `useWeb` (boolean) overrides settings.useWebDefault when
    // explicit. `undefined` from older callers falls back to the saved
    // default. Cast to boolean either way so the payload is JSON-safe.
    const resolvedUseWeb = typeof useWeb === 'boolean'
      ? useWeb
      : settings.useWebDefault === true
    // Local LLM (Qwen on the user's PC) can spend ~47s just loading the model on
    // the first call, before any generation — a flat 30s timed out the very first
    // chat ("Request timed out after 30000ms"). Give local a generous budget;
    // cloud/auto stays tight since a hung request there should fail fast.
    const chatTimeout = settings.aiMode === 'local' ? 180000 : 30000
    return await requestBackendJson('/chat', {
      method: 'POST',
      timeout: chatTimeout,
      body: {
      message,
      history,
      ai_mode: settings.aiMode,
      memory_turns: settings.memoryTurns,
      use_web: resolvedUseWeb
      }
    })
  } catch (e) {
    return { error: e.message }
  }
})

// J단계 — LLM 행동 디렉터. 채팅과 분리된 경량 호출. 짧은 타임아웃, 실패는 전부
// null로 흡수(렌더러 runner가 백오프). 백엔드 미가용이면 ensureAvailableForRequest가
// 던지고 catch → null → 규칙기반 유지.
ipcMain.handle('director:decide', async (e, context) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()
    const r = await requestBackendJson('/director', {
      method: 'POST',
      timeout: 9000,
      body: { context: context || {}, ai_mode: settings.aiMode }
    })
    return (r && typeof r.raw === 'string') ? r.raw : null
  } catch {
    return null
  }
})

ipcMain.handle('tts', async (e, { text, voice_id }) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()

    if (settings.ttsEnabled === false) {
      return { disabled: true }
    }

    // I단계 — 엔진에 따라 mp3(edge)/wav(pyttsx3)가 오므로 Content-Type을
    // 렌더러까지 흘린다. 렌더러는 이걸 Blob type으로 쓴다.
    const response = await requestBackend('/tts', {
      method: 'POST',
      timeout: 30000,
      body: { text, voice_id: voice_id ?? settings.voiceId ?? null }
    })
    const audio = Buffer.from(await response.arrayBuffer())
    return {
      audio: audio.toString('base64'),
      mime: response.headers.get('content-type') || 'audio/wav',
      // 음성 복제 — 요청한 음성(custom)이 아닌 대체 음성으로 합성된 경우.
      // 렌더러가 "기본 음성으로 말했어요"를 1회 안내한다.
      fallback: response.headers.get('x-apia-tts-fallback') === '1'
    }
  } catch (e) {
    return { error: e.message }
  }
})

// ── 음성 복제 (custom voice) IPC — 설정 UI가 쓴다 ───────────────────────
// 업로드는 렌더러가 decodeAudioData로 22.05kHz mono WAV로 정규화한 것을
// base64로 보낸다 (mp3/m4a 디코드는 브라우저 몫 — 백엔드 ffmpeg 의존 제로).
ipcMain.handle('voice-clone-upload', async (e, { name, wavBase64 }) => {
  try {
    await backend.ensureAvailableForRequest()
    const form = new FormData()
    form.append('name', String(name || '').trim().slice(0, 40) || '내 캐릭터 음성')
    form.append(
      'file',
      new Blob([Buffer.from(String(wavBase64 || ''), 'base64')], { type: 'audio/wav' }),
      'reference.wav'
    )
    const { controller, timer } = makeTimeoutController(60000)
    try {
      const response = await fetch(`${getBackendUrl()}/voices/upload`, {
        method: 'POST',
        body: form,
        signal: controller.signal
      })
      if (!response.ok) {
        const details = await readErrorResponse(response)
        return { error: details || response.statusText }
      }
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { error: error.message }
  }
})

ipcMain.handle('voice-clone-progress', async (e, jobId) => {
  try {
    return await requestBackendJson(`/voices/train/${encodeURIComponent(String(jobId))}`, { timeout: 5000 })
  } catch (error) {
    return { status: 'error', progress: 0, error: error.message }
  }
})

ipcMain.handle('voice-clone-preview', async (e, voiceId) => {
  try {
    const response = await requestBackend(`/voices/${encodeURIComponent(String(voiceId))}/preview`, { timeout: 15000 })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.startsWith('audio/')) return { error: '미리듣기가 없어요' }
    const buf = Buffer.from(await response.arrayBuffer())
    return { audio: buf.toString('base64'), mime: contentType }
  } catch (error) {
    return { error: error.message }
  }
})

ipcMain.handle('voice-clone-delete', async (e, voiceId) => {
  try {
    return await requestBackendJson(`/voices/${encodeURIComponent(String(voiceId))}`, { method: 'DELETE', timeout: 10000 })
  } catch (error) {
    return { error: error.message }
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

// ── /store/* surface (steps 2-4 long-term memory / file / web search) ─────
//
// Every handler returns `null` on failure so the renderer doesn't need to
// parse exception strings. Same convention as warmup:status. Per Codex
// MUST-FIX (frontend integration round 1): there are 12 store endpoints,
// not 9 — keep IPC + preload + the smoke probe in sync.

function makeStoreGet(path) {
  return async () => {
    try {
      await backend.ensureAvailableForRequest()
      return await requestBackendJson(path, { method: 'GET', timeout: 8000 })
    } catch (error) {
      logWarn('[STORE_IPC_FAIL]', path, error?.message || error)
      return null
    }
  }
}

function makeStorePost(path, { timeout = 30000 } = {}) {
  return async (_event, body) => {
    try {
      await backend.ensureAvailableForRequest()
      return await requestBackendJson(path, {
        method: 'POST',
        timeout,
        body: body || {}
      })
    } catch (error) {
      logWarn('[STORE_IPC_FAIL]', path, error?.message || error)
      return null
    }
  }
}

ipcMain.handle('store:embeddingStatus', makeStoreGet('/store/embedding/status'))
ipcMain.handle('store:embeddingWarmup', makeStorePost('/store/embedding/warmup', { timeout: 120000 }))

ipcMain.handle('store:memoryStats', makeStoreGet('/store/memory/stats'))
ipcMain.handle('store:memorySummarize', makeStorePost('/store/memory/summarize', { timeout: 60000 }))

ipcMain.handle('store:filesListFolders', makeStoreGet('/store/files/folders'))
ipcMain.handle('store:filesAddFolder', makeStorePost('/store/files/folders'))
ipcMain.handle('store:filesRemoveFolder', async (_event, body) => {
  // DELETE with a JSON body — requestBackendJson supports method override.
  try {
    await backend.ensureAvailableForRequest()
    return await requestBackendJson('/store/files/folders', {
      method: 'DELETE', timeout: 15000, body: body || {}
    })
  } catch (error) {
    logWarn('[STORE_IPC_FAIL]', '/store/files/folders DELETE', error?.message || error)
    return null
  }
})
// Reindex can take a while if the folder is large; cap is generous.
ipcMain.handle('store:filesReindex', makeStorePost('/store/files/reindex', { timeout: 300000 }))
ipcMain.handle('store:filesIngestText', makeStorePost('/store/files/ingest_text', { timeout: 60000 }))
ipcMain.handle('store:filesStats', makeStoreGet('/store/files/stats'))

ipcMain.handle('store:webStats', makeStoreGet('/store/web/stats'))
ipcMain.handle('store:webSearch', makeStorePost('/store/web/search', { timeout: 20000 }))

// Native folder picker for the settings UI's "폴더 추가" button. Always
// returns `{ canceled, path }` so the renderer doesn't need to distinguish a
// cancel from an error — both yield `path: null`. APIA_E2E_NO_SHELL_OPEN
// short-circuits the dialog so headless GUI tests don't hang on a modal.
ipcMain.handle('store:pickFolder', async () => {
  if (APIA_E2E_NO_SHELL_OPEN) {
    return { canceled: true, path: null, stubbed: true }
  }
  try {
    const mainWin = windows.getMain()
    const result = await dialog.showOpenDialog(mainWin || null, {
      title: '인덱싱할 폴더 선택',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  } catch (error) {
    logWarn('[STORE_PICK_FOLDER_FAIL]', error)
    return { canceled: true, path: null, error: error?.message || String(error) }
  }
})

// citation chip click → open the source URL in the system browser. The
// allowlist is paranoid by design: only http(s), nothing file: or javascript:
// or app: schemes that could side-effect the OS. Per Codex MUST-FIX
// (frontend integration round 1).
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string' || !url) {
    return { ok: false, error: 'invalid url' }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'malformed url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logWarn('[OPEN_EXTERNAL_BLOCKED_SCHEME]', parsed.protocol)
    return { ok: false, error: 'only http/https URLs are allowed' }
  }
  if (APIA_E2E_NO_SHELL_OPEN) {
    return { ok: true, stubbed: true, url: parsed.toString() }
  }
  try {
    await shell.openExternal(parsed.toString())
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
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
  // Phase F Codex MUST-FIX: WindowManager.applySettings still calls
  // setAlwaysOnTop. In wallpaper mode that would yank the BrowserWindow
  // out of the WorkerW layer and back to overlay, defeating the mode.
  // Guard the always-on-top side effect to overlay mode only.
  if (settings.useWallpaperMode === false) {
    windows.applySettings(settings)
  } else {
    windows.applySettings({ ...settings, alwaysOnTop: false })
  }
  // Re-sync the attach/detach in case the user just flipped the toggle.
  syncWallpaperMode()
  startWallpaperHealthCheck() // (re)start or stop the probe to match the toggle
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

// Opens backend.env directly in the OS-associated editor. When the file does
// not exist yet (no API key has ever been saved), fall back to opening the
// parent folder rather than auto-creating an empty env file — the repo only
// writes backend.env when applyUpdates is called, so an auto-create here
// would diverge from that lifecycle. shell.openPath returns '' on success
// and a non-empty error string on failure; on failure we try
// showItemInFolder as a fallback because some Windows installs report a
// success-but-no-editor case where openPath returns an error string.
ipcMain.handle('settings:openBackendEnvFile', async () => {
  const envPath = backendEnvRepo.getEnvPath()
  const folder = path.dirname(envPath)
  try {
    fs.mkdirSync(folder, { recursive: true })
    const exists = fs.existsSync(envPath)
    if (APIA_E2E_NO_SHELL_OPEN) {
      return { ok: true, path: envPath, missing: !exists, stubbed: true }
    }
    if (!exists) {
      const folderError = await shell.openPath(folder)
      if (folderError) {
        return { ok: false, error: folderError, path: envPath, missing: true }
      }
      return { ok: true, path: envPath, missing: true }
    }
    const errorMessage = await shell.openPath(envPath)
    if (errorMessage) {
      // openPath failed (no editor association, locked file, etc.) — fall
      // back to highlighting the file in the OS file manager so the user
      // can open it manually. showItemInFolder has no return value, so we
      // can't verify success; reporting ok:true with fallback:true is the
      // best we can do.
      try {
        shell.showItemInFolder(envPath)
        return { ok: true, path: envPath, fallback: true, openPathError: errorMessage }
      } catch (fallbackError) {
        return { ok: false, error: errorMessage, path: envPath, fallbackError: fallbackError?.message || String(fallbackError) }
      }
    }
    return { ok: true, path: envPath }
  } catch (error) {
    logWarn('[OPEN_BACKEND_ENV_FILE_WARN]', error)
    return { ok: false, error: error?.message || String(error), path: envPath }
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

// Restarts the locally-spawned backend so newly-saved API keys take effect.
// Only meaningful when the app itself started the backend — for an external
// or remote backend (APIA_BACKEND_URL set, or user launched Python manually),
// stopping it would be hostile, so we short-circuit with skipped:'not-managed'.
// All in-flight ensure dedup, cooldown reset, and force-respawn are handled
// inside BackendLifecycle.restart so the IPC stays a thin pass-through.
ipcMain.handle('settings:restartBackend', async () => {
  try {
    const result = await backend.restart()
    logInfo('[BACKEND_RESTART_IPC]', result)
    return result
  } catch (error) {
    logWarn('[BACKEND_RESTART_WARN]', error)
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

// Phase F1: when monitors are added/removed/rearranged, Windows may invalidate
// the WorkerW handle we attached to. Re-syncing the wallpaper mode forces a
// detach + re-attach against the current Progman state. Codex NICE-TO-HAVE.
// Explorer can restart (crash or manual) and recreate the shell windows,
// orphaning our Progman-child wallpaper — it silently vanishes with no Electron
// event. A periodic health probe re-attaches when that happens. Cheap: one
// ~100ms helper spawn per interval, and only while wallpaper mode is on.
let wallpaperHealthTimer = null
function startWallpaperHealthCheck() {
  stopWallpaperHealthCheck()
  if (loadSettings().useWallpaperMode === false) return
  wallpaperHealthTimer = setInterval(async () => {
    const main = windows.getMain()
    if (!main || main.isDestroyed()) return
    if (loadSettings().useWallpaperMode === false) return
    if (wallpaperMode.getMode() !== 'progman-child') return
    let healthy = true
    try { healthy = await wallpaperMode.isStillAttached(main) } catch { healthy = true }
    if (!healthy) {
      logWarn('[WALLPAPER_REATTACH]', 'lost Progman parent (shell recreated?) — re-syncing')
      wallpaperMode.markDetached() // clear stale state so enableWallpaper re-attaches
      syncWallpaperMode()
    }
  }, 20000)
  if (wallpaperHealthTimer.unref) wallpaperHealthTimer.unref()
}
function stopWallpaperHealthCheck() {
  if (wallpaperHealthTimer) { clearInterval(wallpaperHealthTimer); wallpaperHealthTimer = null }
}

let rewallpaperTimer = null
function rewallpaperOnDisplayChange() {
  // Debounce — a single monitor change can fire metrics-changed several times
  // in a burst, and each re-attach spawns the sync Win32 helper (Codex
  // NICE-TO-HAVE). Coalesce to one detach + re-attach.
  if (rewallpaperTimer) clearTimeout(rewallpaperTimer)
  rewallpaperTimer = setTimeout(() => {
    rewallpaperTimer = null
    const settings = loadSettings()
    if (settings.useWallpaperMode === false) return
    try {
      wallpaperMode.disableWallpaper(windows.getMain(), { info: logInfo, warn: logWarn })
    } catch {}
    syncWallpaperMode()
  }, 500)
}
app.whenReady().then(() => {
  screen.on('display-metrics-changed', rewallpaperOnDisplayChange)
  screen.on('display-added', rewallpaperOnDisplayChange)
  screen.on('display-removed', rewallpaperOnDisplayChange)
})

// A dead renderer (native crash / OOM / killed) leaves its window blank and
// the in-window chat toggle can't revive it — the app looks bricked until a
// manual restart. Reload the renderer to bring the window back. Guard against
// crash-reload storms (a page that crashes deterministically) with a per-
// webContents budget so we don't spin forever.
const RECOVERABLE_GONE = new Set(['crashed', 'killed', 'oom'])
const crashReloads = new Map() // contents.id → [reload timestamps within the window]
const CRASH_WINDOW_MS = 60000
const CRASH_MAX_RELOADS = 3

app.on('web-contents-created', (event, contents) => {
  // Drop the crash-budget entry when the window goes away, so the Map doesn't
  // accumulate dead ids over a long (8h) session.
  contents.once('destroyed', () => crashReloads.delete(contents.id))

  contents.on('render-process-gone', (goneEvent, details) => {
    logError('[WEB_CONTENTS_RENDER_GONE]', { id: contents.id, details })

    if (quittingApia) return // app is shutting down — let it die
    if (!RECOVERABLE_GONE.has(details?.reason)) return // clean-exit etc. — not a crash
    if (contents.isDestroyed()) return
    const win = BrowserWindow.fromWebContents(contents)
    if (!win || win.isDestroyed()) return

    const now = Date.now()
    const recent = (crashReloads.get(contents.id) || []).filter((t) => now - t < CRASH_WINDOW_MS)
    if (recent.length >= CRASH_MAX_RELOADS) {
      logError('[WEB_CONTENTS_RECOVER_GIVEUP]', {
        id: contents.id, reason: details?.reason, reloads: recent.length
      })
      return
    }
    recent.push(now)
    crashReloads.set(contents.id, recent)

    const wasVisible = win.isVisible()
    logWarn('[WEB_CONTENTS_RECOVER_RELOAD]', {
      id: contents.id, reason: details?.reason, attempt: recent.length
    })
    try {
      contents.reload()
      // Restore visibility only if the crash actually hid the window — avoids
      // needlessly re-show()ing the wallpaper-attached main window.
      if (wasVisible) {
        contents.once('did-finish-load', () => {
          if (!win.isDestroyed() && !win.isVisible()) win.show()
        })
      }
    } catch (error) {
      logError('[WEB_CONTENTS_RECOVER_FAIL]', error)
    }
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

  // F단계 — 전역 커서 시선 피드. 벽지 모드는 forwardMouseInput:false라
  // renderer가 mousemove를 영영 못 받는다. 메인 프로세스가 커서를 폴링해
  // 창 content 기준 정규화 좌표를 renderer에 푸시한다.
  // E2E는 피드를 끈다 — 러너 도는 동안 사용자가 마우스를 움직이면 시선이
  // 덮어써져 스크린샷/단언이 비결정적이 된다 (launchApia가 항상 세팅).
  if (process.env.APIA_E2E_NO_CURSOR_FEED !== '1') {
    startCursorFeed()
    // J단계 — 사용자 존재 피드도 같은 이유(E2E 결정론)로 함께 끈다.
    startPresenceFeed()
  }

  // Phase F1: drop the main overlay into the Windows wallpaper layer (behind
  // desktop icons). Codex MUST-FIX: lazy + graceful — if the native module
  // isn't available (non-Windows, build missing), fall back to the existing
  // overlay path silently. The first paint hides behind icons; we wait for
  // ready-to-show so attach() never runs against a partially constructed
  // HWND.
  syncWallpaperMode()
  startWallpaperHealthCheck()
  setupTrayAndShortcuts()
}).catch(async (error) => {
  await windows.showStartupError('Apia failed during app initialization.', error)
})

// ── F단계: 전역 커서 시선 피드 ───────────────────────────────────────────────
//
// screen.getCursorScreenPoint()와 getContentBounds()는 둘 다 DIP 좌표계라
// DPI 스케일이 달라도 정규화가 일관된다. 같은 값이면 안 보내서(IPC 디듀프)
// 커서가 멈춰 있는 동안 트래픽이 0이고, 복귀 타이머는 renderer
// (characterController)가 단일 관할한다 — Codex 사전 검토 반영.
const CURSOR_POLL_MS = 50
let cursorPollTimer = null

function startCursorFeed() {
  if (cursorPollTimer) return
  let lastX = null
  let lastY = null
  cursorPollTimer = setInterval(() => {
    const main = windows.getMain()
    if (!main || main.isDestroyed() || !main.isVisible()) return
    let pt
    try { pt = screen.getCursorScreenPoint() } catch { return }
    const b = main.getContentBounds()
    if (!b.width || !b.height) return
    const nx = ((pt.x - b.x) / b.width) * 2 - 1
    const ny = ((pt.y - b.y) / b.height) * 2 - 1
    if (nx === lastX && ny === lastY) return
    lastX = nx
    lastY = ny
    try { main.webContents.send('cursor:pos', { x: nx, y: ny }) } catch {}
  }, CURSOR_POLL_MS)
}

function stopCursorFeed() {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer)
    cursorPollTimer = null
  }
}

// ── J단계: 사용자 존재 피드 ─────────────────────────────────────────────────
//
// powerMonitor.getSystemIdleTime()(초·전역 입력 기준)을 5s로 폴링해 renderer에
// 밀어주고, 절전/잠금 이벤트를 그대로 전달한다. 활성/자리비움 분류와 전이 반응
// (복귀 인사 등)은 renderer의 presenceManager가 단일 관할 — 메인은 원시 신호만.
const PRESENCE_POLL_MS = 5000
let presencePollTimer = null

function startPresenceFeed() {
  if (presencePollTimer) return
  presencePollTimer = setInterval(() => {
    const main = windows.getMain()
    if (!main || main.isDestroyed()) return
    let idleSec
    try { idleSec = powerMonitor.getSystemIdleTime() } catch { return }
    try { main.webContents.send('presence:idle', { idleSec }) } catch {}
  }, PRESENCE_POLL_MS)
  for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    try {
      powerMonitor.on(name, () => {
        const main = windows.getMain()
        if (!main || main.isDestroyed()) return
        try { main.webContents.send('presence:event', { name }) } catch {}
      })
    } catch {}
  }
}

// ── 좌하단 핫코너 (벽지모드 전용) ────────────────────────────────────────────
//
// 벽지모드에선 메인 창이 바탕화면 뒤(HWND_BOTTOM)라 클릭을 못 받으므로 설정·채팅
// 버튼을 이 별도 always-on-top 창에 둔다. 평소엔 완전히 숨김(투명+클릭통과). 메인
// 프로세스가 50ms로 전역 커서를 폴링해 이 창의 화면 사각형에 마우스가 들어오면
// reveal + 클릭 가능(setIgnoreMouseEvents(false))으로 바꾸고, 벗어나면 200ms
// 디바운스 후 다시 숨김 + 클릭 통과. 클릭은 forward에 기대지 않고 반드시 ignore
// 해제 뒤에만 받는다(Codex 사전검토). 멀티모니터/DPI는 캐릭터가 있는 디스플레이의
// workArea 기준이라 작업표시줄을 피해 좌하단에 온다.
const CORNER_W = 200
const CORNER_H = 140
const CORNER_HIDE_DEBOUNCE_MS = 200
let cornerWindow = null
let cornerWatchTimer = null
let cornerHideTimer = null
let cornerRevealed = false
let cornerDisplayListenersBound = false

function cornerTargetBounds() {
  const main = windows.getMain()
  let display
  try {
    display = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay()
  } catch {
    display = screen.getPrimaryDisplay()
  }
  const wa = display.workArea
  return { x: wa.x, y: wa.y + wa.height - CORNER_H, width: CORNER_W, height: CORNER_H }
}

function setCornerRevealed(on) {
  if (on === cornerRevealed) return
  cornerRevealed = on
  if (!cornerWindow || cornerWindow.isDestroyed()) return
  try { cornerWindow.setIgnoreMouseEvents(!on, { forward: false }) } catch {}
  try { cornerWindow.webContents.send('corner:reveal', on) } catch {}
}

function startCornerWatch() {
  if (cornerWatchTimer) return
  cornerWatchTimer = setInterval(() => {
    if (!cornerWindow || cornerWindow.isDestroyed()) return
    let pt
    try { pt = screen.getCursorScreenPoint() } catch { return }
    const b = cornerWindow.getBounds()
    const inside = pt.x >= b.x && pt.x < b.x + b.width &&
                   pt.y >= b.y && pt.y < b.y + b.height
    if (inside) {
      if (cornerHideTimer) { clearTimeout(cornerHideTimer); cornerHideTimer = null }
      setCornerRevealed(true)
    } else if (cornerRevealed && !cornerHideTimer) {
      cornerHideTimer = setTimeout(() => {
        cornerHideTimer = null
        // 디바운스 만료 시 커서가 여전히 코너 밖일 때만 숨김(경계 깜박임 완화).
        try {
          const p = screen.getCursorScreenPoint()
          const r = cornerWindow && !cornerWindow.isDestroyed() ? cornerWindow.getBounds() : null
          if (r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height) return
        } catch {}
        setCornerRevealed(false)
      }, CORNER_HIDE_DEBOUNCE_MS)
    }
  }, CURSOR_POLL_MS)
}

function stopCornerWatch() {
  if (cornerWatchTimer) { clearInterval(cornerWatchTimer); cornerWatchTimer = null }
  if (cornerHideTimer) { clearTimeout(cornerHideTimer); cornerHideTimer = null }
}

function repositionCornerWindow() {
  if (!cornerWindow || cornerWindow.isDestroyed()) return
  try { cornerWindow.setBounds(cornerTargetBounds()) } catch {}
}

function ensureCornerWindow() {
  if (cornerWindow && !cornerWindow.isDestroyed()) return cornerWindow
  const b = cornerTargetBounds()
  cornerWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'cornerPreload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  // 평소엔 클릭 통과(좌하단 바탕화면 아이콘을 가리지 않음). reveal 때 main이 해제.
  cornerRevealed = false
  try { cornerWindow.setIgnoreMouseEvents(true, { forward: false }) } catch {}
  // destroyCornerWindow() 외 경로(외부 close 등)로 닫혀도 50ms 폴링이 안 남도록
  // idempotent 정리. stopCornerWatch/clearTimeout 모두 여러 번 호출 안전.
  cornerWindow.on('closed', () => {
    cornerWindow = null
    cornerRevealed = false
    stopCornerWatch()
  })

  const load = async () => {
    try {
      if (isDev) {
        await cornerWindow.loadURL('http://localhost:5173/corner.html')
      } else {
        await cornerWindow.loadFile(path.join(app.getAppPath(), 'dist', 'corner.html'))
      }
    } catch (error) {
      logWarn('[CORNER_WINDOW_LOAD_FAIL]', error?.message || error)
    }
  }
  load()

  if (!cornerDisplayListenersBound) {
    cornerDisplayListenersBound = true
    screen.on('display-metrics-changed', repositionCornerWindow)
    screen.on('display-added', repositionCornerWindow)
    screen.on('display-removed', repositionCornerWindow)
  }
  startCornerWatch()
  return cornerWindow
}

function destroyCornerWindow() {
  stopCornerWatch()
  cornerRevealed = false
  if (cornerDisplayListenersBound) {
    try {
      screen.removeListener('display-metrics-changed', repositionCornerWindow)
      screen.removeListener('display-added', repositionCornerWindow)
      screen.removeListener('display-removed', repositionCornerWindow)
    } catch {}
    cornerDisplayListenersBound = false
  }
  if (cornerWindow && !cornerWindow.isDestroyed()) {
    try { cornerWindow.destroy() } catch {}
  }
  cornerWindow = null
}

// ── Phase F1 wallpaper mode integration ─────────────────────────────────────

function syncWallpaperMode() {
  const main = windows.getMain()
  if (!main || main.isDestroyed()) return
  const want = loadSettings().useWallpaperMode !== false
  if (want) {
    // User-reported bug: desktop icons were not clickable when wallpaper
    // mode was on. Two BrowserWindow defaults were the cause:
    //   (1) `alwaysOnTop: s.alwaysOnTop !== false` from createMainWindow
    //       kept the window floating above the desktop even after
    //       SetParent → WorkerW. Icons were physically behind it.
    //   (2) `setIgnoreMouseEvents(false)` made the overlay swallow every
    //       click in its rect, so even when icons were under cursor the
    //       click never propagated down to SHELLDLL_DefView.
    // The wallpaper layer has to BOTH stop floating AND stop intercepting
    // input. The first is `setAlwaysOnTop(false)`; the second is
    // `setIgnoreMouseEvents(true, { forward: false })` — `forward:true`
    // keeps mousemove events for hover effects, but `false` is right here
    // because the user's intent is "this is just background".
    try { main.setAlwaysOnTop(false) } catch {}
    try { main.setIgnoreMouseEvents(true, { forward: false }) } catch {}
    // Cover the WHOLE target display (full bounds, not workArea) before the
    // wallpaper reparent so Electron's renderer is already sized to the monitor
    // — the helper then matches the window's physical rect to that monitor and
    // canvas + window stay in sync (otherwise a workArea-sized canvas gets
    // stretched to the full physical monitor → zoomed-in look on a HiDPI
    // secondary display).
    try {
      const disp = screen.getDisplayMatching(main.getBounds())
      if (disp?.bounds) main.setBounds(disp.bounds)
    } catch {}
    const ready = main.isVisible() ? Promise.resolve() : new Promise((resolve) => {
      main.once('ready-to-show', resolve)
    })
    Promise.resolve(ready).then(async () => {
      // Codex MUST-FIX (round 2): a stale ready-to-show promise from an
      // earlier sync can fire after the user has flipped the toggle off.
      // Re-read settings + window state inside the .then() so the actual
      // attach decision uses the current state, not the captured one.
      const live = windows.getMain()
      if (!live || live.isDestroyed()) return
      if (loadSettings().useWallpaperMode === false) return
      let mode = false
      try {
        mode = await wallpaperMode.enableWallpaper(live, { info: logInfo, warn: logWarn })
      } catch (error) {
        // Never let an attach exception skip the fallback below (Codex MUST-FIX).
        logWarn('[WALLPAPER_ENABLE_THROW]', error?.message || error)
        mode = false
      }
      if (loadSettings().useWallpaperMode === false) return
      if (mode) {
        // The Progman-child helper resizes the window via Win32 SetWindowPos
        // from outside Electron; Chromium doesn't always re-fit its viewport,
        // leaving the 3D camera framed for the old size (character off-centre).
        // Force a resize tick so sceneRuntime's applyViewport re-centres.
        try {
          live.webContents?.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {})
        } catch {}
        // Now that it's a real wallpaper, tell the renderer to render an opaque,
        // screen-filling scene (a transparent overlay is invisible against the
        // desktop).
        try { live.webContents?.send('wallpaper:opaque', true) } catch {}
        // 메인 창이 바탕화면 뒤라 자체 버튼이 숨겨지므로(index.html wallpaper-mode),
        // 클릭 가능한 좌하단 핫코너 창을 띄운다.
        ensureCornerWindow()
      }
      if (!mode) {
        // Both native and Progman-child attach failed. Don't leave the window
        // in limbo (not floating, click-through, not in the wallpaper layer →
        // hidden behind other windows). Fall back to a normal always-on-top
        // overlay so the character stays visible. (Codex MUST-FIX)
        // Restore workArea bounds first — the full-display bounds set above for
        // the wallpaper layer would otherwise cover the taskbar AND, once
        // setIgnoreMouseEvents(false) re-arms clicks, intercept them across the
        // whole screen. (Codex MUST-FIX)
        try {
          const d = screen.getDisplayMatching(live.getBounds())
          if (d?.workArea) live.setBounds(d.workArea)
        } catch {}
        try { live.setAlwaysOnTop(loadSettings().alwaysOnTop !== false) } catch {}
        try { live.setIgnoreMouseEvents(false) } catch {}
        try { live.webContents?.send('wallpaper:opaque', false) } catch {}
        // 오버레이 폴백이면 메인 창이 자체 버튼을 다시 보여주므로 코너는 불필요.
        destroyCornerWindow()
        logWarn('[WALLPAPER_FALLBACK_OVERLAY]', 'attach failed; using always-on-top overlay')
      }
    })
  } else {
    if (wallpaperMode.isAttached()) {
      wallpaperMode.disableWallpaper(main, { info: logInfo, warn: logWarn })
    }
    // Restore the normal overlay behavior (floating, accepts clicks) at workArea
    // bounds — a previous wallpaper session may have grown it to full display
    // bounds (Codex MUST-FIX: don't leave a taskbar-covering click sink).
    try {
      const d = screen.getDisplayMatching(main.getBounds())
      if (d?.workArea) main.setBounds(d.workArea)
    } catch {}
    try { main.setAlwaysOnTop(loadSettings().alwaysOnTop !== false) } catch {}
    try { main.setIgnoreMouseEvents(false) } catch {}
    try { main.webContents?.send('wallpaper:opaque', false) } catch {}
    // 오버레이 모드는 메인 창 자체 버튼을 쓰므로 코너 창 제거.
    destroyCornerWindow()
  }
}

// 16x16 purple square PNG, used as a tray-icon fallback so a fresh install
// without build/icon.ico still gets a visible system-tray entry. Codex
// MUST-FIX (round 2): both icon paths were missing, so the unguarded
// `new Tray(missingPath)` was the actual reason tray didn't show up.
const TRAY_FALLBACK_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR42mNkYGD4z0AEYBxVSF' +
  'WhFKEKqQqoCKgIqAhDFVAxUBFQEVARUBFQEVARUBFQEVDRwFcEAGoVAuJzfYUOAAAAAElFTkSuQmCC'

let tray = null
function setupTrayAndShortcuts() {
  if (tray) return
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
    const altPath = path.join(__dirname, '..', 'public', 'favicon.ico')
    let image = null
    if (fs.existsSync(iconPath)) {
      image = nativeImage.createFromPath(iconPath)
    } else if (fs.existsSync(altPath)) {
      image = nativeImage.createFromPath(altPath)
    } else {
      image = nativeImage.createFromBuffer(Buffer.from(TRAY_FALLBACK_ICON_BASE64, 'base64'))
    }
    // Codex MUST-FIX (round 3): if the path existed but the file is
    // corrupt/invalid, `image.isEmpty()` is true here but the user still
    // gets the visible purple fallback before the last-ditch 1x1 — earlier
    // code skipped straight to the transparent pixel and silently lost the
    // tray icon visibility.
    if (image.isEmpty()) {
      image = nativeImage.createFromBuffer(Buffer.from(TRAY_FALLBACK_ICON_BASE64, 'base64'))
    }
    if (image.isEmpty()) {
      image = nativeImage.createFromBuffer(
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORk5CYII=', 'base64')
      )
    }
    tray = new Tray(image)
  } catch (error) {
    logWarn('[TRAY_INIT_WARN]', error?.message || error)
    tray = null
  }
  if (tray) {
    tray.setToolTip(
      'Apia — 좌클릭 채팅 / 우클릭 메뉴 / Ctrl+Alt+A 채팅 / Ctrl+Alt+Q 종료'
    )
    const buildMenu = () => Menu.buildFromTemplate([
      { label: '채팅 열기/닫기', click: () => toggleChatWindow() },
      { label: '설정 열기', click: () => windows.openSettings() },
      { type: 'separator' },
      { label: 'Apia 종료', click: () => quitApia() }
    ])
    tray.setContextMenu(buildMenu())
    // Phase F2: left-click → chat toggle (Windows convention).
    tray.on('click', () => toggleChatWindow())
    tray.on('double-click', () => windows.openSettings())
  }

  // Ctrl+Alt+Q = quit. Quit shortcut comes first because a tray-less user
  // can otherwise get stuck (wallpaper mode + no taskbar entry).
  try {
    if (!globalShortcut.isRegistered('CommandOrControl+Alt+Q')) {
      const ok = globalShortcut.register('CommandOrControl+Alt+Q', () => quitApia())
      if (!ok) logWarn('[GLOBAL_SHORTCUT_REGISTER_BUSY]', 'Ctrl+Alt+Q already in use by another app')
    }
  } catch (error) {
    logWarn('[GLOBAL_SHORTCUT_REGISTER_WARN]', error?.message || error)
  }
  // Ctrl+Alt+A = chat toggle.
  try {
    if (!globalShortcut.isRegistered('CommandOrControl+Alt+A')) {
      const ok = globalShortcut.register('CommandOrControl+Alt+A', () => toggleChatWindow())
      if (!ok) logWarn('[GLOBAL_SHORTCUT_REGISTER_BUSY]', 'Ctrl+Alt+A already in use by another app')
    }
  } catch (error) {
    logWarn('[GLOBAL_SHORTCUT_REGISTER_WARN]', error?.message || error)
  }
}

// ── Phase F2 — chatWindow + IPC routing ─────────────────────────────────

let chatWindow = null
function ensureChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  // Codex NICE-TO-HAVE: use workArea (not workAreaSize) so a taskbar on the
  // left/top of a non-primary monitor or DPI offsets still place the window
  // correctly. 360x520 in the bottom-right with 24px gutter.
  const chatW = 360
  const chatH = 520
  const gutter = 24
  chatWindow = new BrowserWindow({
    width: chatW,
    height: chatH,
    x: x + width - chatW - gutter,
    y: y + height - chatH - gutter,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false
    }
  })

  // Closing the X button should hide, not destroy — keeps reopen instant.
  chatWindow.on('close', (event) => {
    if (!quittingApia && chatWindow && !chatWindow.isDestroyed()) {
      event.preventDefault()
      chatWindow.hide()
    }
  })

  const loadChat = async () => {
    try {
      if (isDev) {
        await chatWindow.loadURL('http://localhost:5173/chat.html')
      } else {
        await chatWindow.loadFile(path.join(app.getAppPath(), 'dist', 'chat.html'))
      }
    } catch (error) {
      logWarn('[CHAT_WINDOW_LOAD_FAIL]', error?.message || error)
    }
  }
  loadChat()

  return chatWindow
}

function toggleChatWindow() {
  // Codex MUST-FIX (F2 round 1): branch on wallpaper mode. When wallpaper is
  // OFF the main BrowserWindow's own chat panel is the right surface and a
  // floating chat window would just duplicate it.
  const wallpaperOn = loadSettings().useWallpaperMode !== false
  if (!wallpaperOn) {
    if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
      chatWindow.hide()
    }
    // Tell the main window to surface its own chat panel — best-effort.
    const main = windows.getMain()
    if (main && !main.isDestroyed()) {
      main.webContents.send('character:action', { action: 'show-main-chat' })
    }
    return
  }
  const win = ensureChatWindow()
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
    // 채팅 창을 여는 것 = "부름". 메인(캐릭터) 렌더러에 호출 신호 → 컴퓨터 앞으로.
    const main = windows.getMain()
    if (main && !main.isDestroyed()) {
      try { main.webContents.send('character:action', { action: 'call' }) } catch {}
    }
  }
}

// Action allowlist for character:notify forwarding. Adding a new action MUST
// land in this set and in the renderer-side routeCharacterAction. The guard
// keeps a compromised chat renderer from triggering arbitrary IPC channels
// against the main window.
const CHARACTER_ACTION_ALLOWLIST = new Set([
  'emotion', 'bubble', 'face-camera', 'lipsync-start', 'lipsync-stop',
  'show-main-chat', 'call'
])

ipcMain.handle('character:notify', (event, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false }
  if (!CHARACTER_ACTION_ALLOWLIST.has(payload.action)) {
    logWarn('[CHARACTER_NOTIFY_REJECTED]', payload.action)
    return { ok: false, reason: 'unknown action' }
  }
  // H단계 Codex MUST-FIX(사후): allowlist는 action 이름만 본다. lipsync-start
  // 의 frames가 비대하면 메인 창으로의 구조화 복제·IPC 전송 자체가 부담이라
  // 얕은 상한(배열 여부 + 길이 6000=렌더러 MAX_FRAMES)을 여기서 먼저 건다.
  // 프레임 내용의 정밀 검증은 렌더러 sanitizeTimeline 소관.
  if (payload.action === 'lipsync-start' && payload.value !== undefined) {
    const frames = payload.value?.timeline?.frames
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 6000) {
      logWarn('[CHARACTER_NOTIFY_REJECTED]', 'lipsync-start payload cap')
      return { ok: false, reason: 'invalid lipsync payload' }
    }
  }
  const main = windows.getMain()
  if (!main || main.isDestroyed()) return { ok: false, reason: 'no main window' }
  try {
    main.webContents.send('character:action', payload)
    return { ok: true }
  } catch (error) {
    logWarn('[CHARACTER_NOTIFY_SEND_FAIL]', error?.message || error)
    return { ok: false, reason: error?.message || String(error) }
  }
})

ipcMain.handle('chat:hide', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.hide()
  return { ok: true }
})

ipcMain.handle('chat:toggle', () => {
  toggleChatWindow()
  return { ok: true }
})

let quittingApia = false
function quitApia() {
  if (quittingApia) return
  quittingApia = true
  try {
    wallpaperMode.disableWallpaper(windows.getMain(), { info: logInfo, warn: logWarn })
  } catch (error) {
    logWarn('[QUIT_DETACH_WARN]', error?.message || error)
  }
  try { globalShortcut.unregisterAll() } catch {}
  try { tray?.destroy?.(); tray = null } catch {}
  // Phase F2: destroy chatWindow on real quit so it doesn't keep the process
  // alive after backend stop.
  try {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy()
    chatWindow = null
  } catch {}
  try { destroyCornerWindow() } catch {}
  if (backend.isStartedByApp()) backend.stop()
  app.quit()
}

app.on('window-all-closed', () => {
  logWarn('[WINDOW_ALL_CLOSED]', { processPlatform: process.platform, backendStartedByApp: backend.isStartedByApp() })
  // Phase F1 Codex MUST-FIX: a tray-only / wallpaper-only app must NOT
  // quit when every BrowserWindow is closed — the tray + global shortcut
  // are the user's only remaining way back in. The explicit "Apia 종료"
  // menu item or Ctrl+Alt+Q calls quitApia() which sets quittingApia.
  // We still let macOS keep its standard Cmd+Q behavior.
  const settings = loadSettings()
  if (settings.useWallpaperMode !== false && !quittingApia) {
    return
  }
  if (backend.isStartedByApp()) {
    backend.stop()
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  logInfo('[BEFORE_QUIT]', { backendStartedByApp: backend.isStartedByApp() })
  // H단계 — quit이 quitApia()가 아닌 경로(OS 종료, E2E의 app.close())로
  // 시작되면 chatWindow의 close 핸들러가 preventDefault로 종료를 영원히
  // 막는다. before-quit에서 플래그를 세워 "진짜 종료"임을 알린다.
  quittingApia = true
  stopCursorFeed()
  destroyCornerWindow()
  stopWallpaperHealthCheck()
  try {
    wallpaperMode.disableWallpaper(windows.getMain(), { info: logInfo, warn: logWarn })
  } catch (error) {
    logWarn('[BEFORE_QUIT_DETACH_WARN]', error?.message || error)
  }
  // Drain the debounced anchor save before the window is gone — otherwise
  // a quit during a drag loses the final position.
  windows.flushPendingAnchor()
  if (backend.isStartedByApp()) {
    backend.stop()
  }
})

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch {}
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
