const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } = require('electron')
app.commandLine.appendSwitch('allow-file-access-from-files')

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { execFile, spawn } = require('child_process')

// 야간 학습기(A-3)의 백엔드 표면은 부르는 것만으로 교사 예산과 GPU가 나간다.
// localhost에 붙을 수 있는 아무 프로세스나 그걸 시키지 못하게, 실행할 때마다
// 새 토큰을 만들어 백엔드와 학습 프로세스에 **env로만** 건넨다(명령줄은 프로세스
// 목록에 노출된다). process.env에 넣어 두면 두 자식의 spawn env에 그대로 실린다.
// 디스크·로그·상태 파일 어디에도 적지 않는다 — 프로세스가 죽으면 같이 사라진다.
process.env.APIA_TRAINING_TOKEN = crypto.randomBytes(32).toString('hex')

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
const { saveWorldDocument } = require('./services/worldStore')
const { BackendEnvRepository } = require('./services/backendEnvRepository')
const { WindowManager } = require('./services/windowManager')
const wallpaperMode = require('./services/wallpaperMode')
const {
  TOPIC_IDS: LEDGER_TOPIC_IDS,
  dayKeyOf,
  parseClassification,
  createTopicLedger,
  createExchangeTracker
} = require('./services/topicLedger')
const {
  createCoursewareStore,
  createCoursewareJob,
  attachReferenceCards
} = require('./services/courseware')
const {
  DEADLINE_SEC: TRAINING_DEADLINE_SEC,
  RETURN_IDLE_SEC: TRAINING_RETURN_IDLE_SEC,
  DEADLINE_GRACE_MS: TRAINER_GRACE_MS,
  awaitChildExit,
  evaluateTrigger,
  similarity: shadowSimilarity,
  lengthRatio: shadowLengthRatio,
  createNightSchoolStore,
  createNightSchoolJob
} = require('./services/nightSchool')
const {
  LOCAL_SERVE_TIMEOUT_MS,
  classifyUtterance,
  createServingGate
} = require('./services/promotion')

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
  headers: extraHeaders,
  timeout = 5000
} = {}) {
  const { controller, timer } = makeTimeoutController(timeout)

  try {
    const response = await fetch(`${getBackendUrl()}${endpoint}`, {
      method,
      headers: (body || extraHeaders)
        ? { ...(body ? { 'Content-Type': 'application/json' } : null), ...extraHeaders }
        : undefined,
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
// 사용자 조작 경로는 전부 patch(부분 갱신). 문서 통째 쓰기는 스냅샷을 되쓰면서
// 그 사이 다른 곳에서 바뀐 값을 되돌린다.
const patchSettings = (partial) => settingsRepo.patch(partial)

// ── 눈치 원장 계측기 ────────────────────────────────────────────────────────
//
// 계측 전용. 채팅 두 표면(오버레이·벽지 채팅창)이 모두 통과하는 main의 IPC
// 핸들러에 붙어 교환 단위 신호를 뽑는다. 수집도 분류도 대화를 막지 않는다 —
// 분류는 promise로 떼어 두고, 다음 발화가 올 때 그제서야 신호를 확정한다.
//
// 저장 위치는 apia-world.json / apia-settings.json과 같은 userData
// (Windows: %APPDATA%\Apia). OneDrive/Dropbox 같은 동기화 폴더가 아니다.
const LEDGER_PATH = path.join(app.getPath('userData'), 'apia-topic-ledger.json')
const ledger = createTopicLedger({ ledgerPath: LEDGER_PATH, log: { warn: logWarn } })

// 화제 분류 — 로컬 provider 전용(백엔드가 강제). 백엔드가 꺼져 있거나 로컬
// 모델이 없으면 그냥 null이고, 그 교환은 원장에 남지 않는다. 여기서
// ensureAvailableForRequest를 부르지 않는 게 중요하다: 계측이 백엔드를
// 깨우는 부수효과를 만들면 안 된다.
async function classifyTopic(text) {
  try {
    const res = await requestBackendJson('/classify', {
      method: 'POST',
      timeout: 60000,
      body: { text, topics: LEDGER_TOPIC_IDS }
    })
    return parseClassification(res?.raw, LEDGER_TOPIC_IDS)
  } catch {
    return null
  }
}

const ledgerTracker = createExchangeTracker({
  classify: classifyTopic,
  onSignal: (signal) => {
    try { ledger.recordSignal(signal) } catch (error) { logWarn('[LEDGER_SIGNAL_FAILED]', error?.message || error) }
  }
})

// 응답 뒤 사용자가 처음 키를 누른 순간. 지연의 끝점은 '전송'이 아니라 '입력 시작'
// 이라 두 채팅 표면의 keydown이 이걸 쏴 준다. send(fire-and-forget)라 렌더러는
// 아무것도 기다리지 않는다.
ipcMain.on('ledger:input-start', () => {
  try { ledgerTracker.noteInputStart() } catch {}
})

// 열람 UI(설정 창) 표면. 읽기·수동 라벨·삭제·초기화뿐 — 캐릭터 행동과 연결 없음.
ipcMain.handle('ledger:getState', () => {
  try { return ledger.getState() } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('ledger:aggregate', () => {
  try { ledger.aggregate(); return ledger.getState() } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('ledger:setGold', (e, { topicId, label } = {}) => {
  try { ledger.setGoldLabel(topicId, label); return ledger.getState() } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('ledger:removeTopic', (e, { topicId } = {}) => {
  try { ledger.removeTopic(topicId); return ledger.getState() } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('ledger:reset', () => {
  try { ledger.reset(); return ledger.getState() } catch (error) { return { error: error?.message || String(error) } }
})

// 일일 집계 잡 — 자정(날짜가 바뀌는 첫 정시 점검) 또는 앱 종료 시 1회.
let ledgerDayKey = null
let ledgerDailyTimer = null
const LEDGER_DAILY_POLL_MS = 3600000

function startLedgerDailyJob() {
  if (ledgerDailyTimer) return
  ledgerDayKey = dayKeyOf(Date.now())
  ledgerDailyTimer = setInterval(() => {
    const key = dayKeyOf(Date.now())
    if (key === ledgerDayKey) return
    ledgerDayKey = key
    try { ledger.aggregate() } catch (error) { logWarn('[LEDGER_AGGREGATE_FAILED]', error?.message || error) }
  }, LEDGER_DAILY_POLL_MS)
}

function stopLedgerDailyJob() {
  if (ledgerDailyTimer) {
    clearInterval(ledgerDailyTimer)
    ledgerDailyTimer = null
  }
}

// ── 교재 파이프라인 ─────────────────────────────────────────────────────────
//
// 눈치 원장과 **같은 IPC 초크포인트**(send-message / chat:streamStart)에 붙되
// 코드는 독립이다. 원장은 원문을 절대 남기지 않고, 이쪽은 원문을 하루 동안만
// 들고 있다가 교재로 바꾼 뒤 지운다 — 목적이 달라 수명도 다르다.
//
// 여기서 하는 일은 기록·변환·폐기, 그리고 A-2 검색 참조다. 교재 파일은
// electron이 소유하므로 검색도 여기서 돌고(백엔드는 디스크를 보지 않는다),
// 고른 카드만 채팅 요청 body에 실려 나간다. 이 교재를 실제로 모델에 새기는
// 야간 학습(A-3)은 아래 nightSchool 블록이 맡는다.
const COURSEWARE_DIR = path.join(app.getPath('userData'), 'courseware')
const courseware = createCoursewareStore({ dir: COURSEWARE_DIR, log: { warn: logWarn } })

// 변환은 사용자가 자리를 비운 동안만 — 교사 왕복이 수십 초라 쓰는 중에 끼면
// 백엔드 응답이 밀린다. presenceManager와 같은 5분 기준.
const COURSEWARE_IDLE_SEC = 300
const coursewareJob = createCoursewareJob({
  store: courseware,
  isIdle: () => {
    try { return powerMonitor.getSystemIdleTime() >= COURSEWARE_IDLE_SEC } catch { return false }
  },
  convert: (day, exchanges) => requestBackendJson('/courseware/convert', {
    method: 'POST',
    timeout: 240000,
    body: { day, exchanges: exchanges.map((e) => ({ u: e.u, a: e.a })) }
  })
})

// 교환 1건 기록. 실패해도 대화는 그대로 — 버퍼가 한 줄 비는 것뿐이다.
function recordCoursewareExchange(message, reply) {
  try { courseware.appendExchange({ u: message, a: reply }) } catch (error) {
    logWarn('[COURSEWARE_BUFFER_FAILED]', error?.message || error)
  }
}

ipcMain.handle('courseware:getState', () => {
  try { return courseware.getState() } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('courseware:convertNow', async () => {
  try {
    const result = await coursewareJob.runOnce({ force: true })
    return { ...courseware.getState(), result }
  } catch (error) { return { error: error?.message || String(error) } }
})

// 변환 잡 — 15분마다 점검. 지난 날짜 버퍼가 없으면 디렉터리 하나 읽고 끝난다.
let coursewareTimer = null
const COURSEWARE_POLL_MS = 900000

function startCoursewareJob() {
  if (coursewareTimer) return
  coursewareTimer = setInterval(() => {
    coursewareJob.runOnce().catch((error) => logWarn('[COURSEWARE_JOB_WARN]', error?.message || error))
  }, COURSEWARE_POLL_MS)
}

function stopCoursewareJob() {
  if (coursewareTimer) {
    clearInterval(coursewareTimer)
    coursewareTimer = null
  }
}

// ── 야간 학습기 + 그림자 모드 (A-3) ─────────────────────────────────────────
//
// 교재(A-1)를 실제로 로컬 학생 모델에 새기는 주 1회 재학습과, 그렇게 배운
// 학생을 사용자 몰래 채점하는 그림자 모드. **사용자 대면 응답은 여전히 불변**이다
// — 학생 답은 유사도 점수로만 남고 화면에 오르지 않는다(승격은 A-4 몫).
//
// 학습은 이 프로세스에서 하지 않는다. 별도 파이썬을 스폰한다 — 이유가 셋이다.
//   1. 학습 스택(unsloth/trl/peft)이 백엔드 venv에 없고, 넣으면 torch가 6.9GB
//      중복된다. 검증 실험을 돌린 night-loop-lab venv를 그대로 빌려 쓴다.
//   2. 학습이 죽어도(OOM·드라이버) 대화와 캐릭터는 프로세스가 달라 무사하다.
//   3. 사용자가 돌아오면 프로세스를 통째로 끊는 게 가장 확실한 즉시 중단이다.
const TRAINING_DIR = path.join(COURSEWARE_DIR, 'training')
const nightSchool = createNightSchoolStore({ dir: TRAINING_DIR, log: { warn: logWarn } })
const TRAINER_SCRIPT = path.join(__dirname, '..', 'backend', 'training', 'night_trainer.py')

function trainingPythonPath() {
  try { return String(loadSettings().trainingPythonPath || '') } catch { return '' }
}

/** nvidia-smi로 여유 VRAM(GB). 없거나 실패하면 0 — 학습은 시작되지 않는다. */
function probeVramFreeGb() {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi',
        ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
        { timeout: 8000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(0)
          const mb = Number(String(stdout).split('\n')[0]?.trim())
          resolve(Number.isFinite(mb) ? mb / 1024 : 0)
        })
    } catch { resolve(0) }
  })
}

async function probeTrainingSignals() {
  let idleSec = 0
  try { idleSec = powerMonitor.getSystemIdleTime() } catch {}
  const python = trainingPythonPath()
  let totalCards = 0
  try { totalCards = courseware.getState().totalCards || 0 } catch {}
  return {
    idleSec,
    vramFreeGb: await probeVramFreeGb(),
    totalCards,
    pythonOk: Boolean(python) && fs.existsSync(python),
    scriptOk: fs.existsSync(TRAINER_SCRIPT)
  }
}

/**
 * 학습 프로세스 한 번. 종료될 때까지 기다렸다가 결과 JSON을 읽어 돌려준다.
 *
 * 중단은 두 겹이다: 사용자가 돌아오면 STOP 파일을 써서 **스스로** 체크포인트를
 * 남기고 끝나게 하고, 그래도 안 끝나면 30초 뒤 kill한다. 어느 쪽이든 이전
 * 채택 델타와 대화 기능에는 영향이 없다.
 */
// 살아 있는 학습 자식 핸들. 종료 경로가 STOP 파일만 쓰고 끝나면 Electron이
// 먼저 죽은 뒤 학습이 유령으로 남아 GPU를 계속 문다.
let trainerChild = null

function runTrainer({ adoptedDelta, since }) {
  return new Promise((resolve) => {
    const { workDir, stopPath, resultPath, logPath } = nightSchool.paths
    try {
      fs.mkdirSync(workDir, { recursive: true })
      fs.rmSync(stopPath, { force: true })
      fs.rmSync(resultPath, { force: true })
    } catch (error) {
      return resolve({ status: 'failed', reason: `work dir: ${error?.message || error}` })
    }

    const args = [
      TRAINER_SCRIPT,
      '--cards', courseware.paths.cardsDir,
      '--work', workDir,
      '--result', resultPath,
      '--backend-url', getBackendUrl(),
      '--stop-file', stopPath,
      // 부모가 크래시하면 STOP 파일을 써 줄 주체가 없다. 학습기가 직접 감시한다.
      '--parent-pid', String(process.pid),
      '--deadline-sec', String(TRAINING_DEADLINE_SEC)
    ]
    if (adoptedDelta) args.push('--adopted-delta', adoptedDelta)
    if (since) args.push('--since', since)

    let child
    let logStream = null
    try {
      logStream = fs.createWriteStream(logPath, { flags: 'w' })
      child = spawn(trainingPythonPath(), args, {
        // cwd는 **작업 디렉터리**다. unsloth가 CWD에 컴파일 캐시(unsloth_compiled_cache)를
        // 만들기 때문에 repo 안에서 돌리면 소스 트리가 더러워진다. 학습기는 경로를
        // 전부 인자로 받으므로 어디서 돌든 상관없다.
        cwd: workDir,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      })
    } catch (error) {
      try { logStream?.end() } catch {}
      return resolve({ status: 'failed', reason: `spawn: ${error?.message || error}` })
    }

    trainerChild = child
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })

    // 사용자 복귀 감시. 유휴가 짧아지면 STOP을 써서 즉시 중단시킨다.
    let killTimer = null
    const watch = setInterval(() => {
      let idle = TRAINING_RETURN_IDLE_SEC + 1
      try { idle = powerMonitor.getSystemIdleTime() } catch {}
      if (idle > TRAINING_RETURN_IDLE_SEC) return
      try { fs.writeFileSync(stopPath, 'user returned', 'utf-8') } catch {}
      clearInterval(watch)
      killTimer = setTimeout(() => { try { child.kill() } catch {} }, TRAINER_GRACE_MS)
    }, 15000)

    const finish = (fallback) => {
      clearInterval(watch)
      if (killTimer) clearTimeout(killTimer)
      if (trainerChild === child) trainerChild = null
      try { logStream?.end() } catch {}
      let result = null
      try { result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) } catch {}
      resolve(result || fallback)
    }

    child.on('error', (error) => finish({ status: 'failed', reason: `spawn: ${error?.message}` }))
    child.on('close', (code) => finish({
      status: code === 0 ? 'failed' : 'interrupted',
      reason: `학습 프로세스가 결과를 남기지 못했다 (exit ${code})`
    }))
  })
}

const nightSchoolJob = createNightSchoolJob({
  store: nightSchool,
  probe: probeTrainingSignals,
  runTrainer,
  log: { warn: logWarn }
})

/**
 * 로컬 학생(베이스+채택 델타)에게 발화 하나를 시킨다. 그림자(A-3)와 승격
 * 서빙(A-4)이 **같은 표면**을 쓴다 — 하는 일이 글자 그대로 같기 때문이다
 * ("모델을 올리지 말고, 떠 있으면 델타를 붙여 한 번 생성"). 둘의 차이는
 * 기다리는 시간과 그 답을 어디에 쓰느냐뿐이라 엔드포인트를 나누지 않았다.
 */
function localStudentReply(message, timeout) {
  const delta = nightSchool.adoptedDelta()
  if (!delta) return Promise.resolve({ status: 'dormant', reason: '채택 델타 없음' })
  return requestBackendJson('/training/shadow', {
    method: 'POST',
    timeout,
    headers: { 'X-Apia-Training-Token': process.env.APIA_TRAINING_TOKEN || '' },
    body: { message, delta_dir: delta.dir }
  })
}

/**
 * 그림자 1건 — 채팅 교환이 **끝난 뒤** 비동기로. 대화 지연 0이 계약이라
 * 호출자는 이 promise를 기다리지 않는다.
 *
 * 로컬 모델을 올리지 않는다(백엔드가 떠 있는지만 보고 판단은 백엔드가 한다).
 * 델타가 없거나 그 유형이 이미 승격됐으면 아예 부르지 않는다.
 */
function recordShadow(message, reply, type) {
  const delta = nightSchool.adoptedDelta()
  if (!delta) return nightSchool.noteShadowDormant('채택 델타 없음')
  if (!message || !reply) return
  // 이미 승격된 유형은 그림자를 돌리지 않는다. 그림자의 용도는 "승격해도 되나"를
  // 재는 것인데 그 판단은 끝났고(이제는 서빙 통계가 그 자리를 대신한다), 승격
  // 유형에서 그림자를 계속 돌리면 다음 발화의 서빙이 그 생성에 막혀 API로
  // 새는 악순환이 생긴다 — 둘이 같은 로컬 경로 하나를 쓰기 때문이다.
  if (nightSchool.isPromoted(type)) return
  localStudentReply(message, 60000).then((res) => {
    if (res?.status !== 'ok' || !res.reply) {
      return nightSchool.noteShadowDormant(res?.reason || res?.status || 'no reply')
    }
    // 여기서 원문은 점수로 바뀌고 버려진다. 디스크로 내려가는 건 숫자뿐이다.
    nightSchool.noteShadow({
      similarity: shadowSimilarity(res.reply, reply),
      lengthRatio: shadowLengthRatio(res.reply, reply),
      type
    })
  }).catch((error) => nightSchool.noteShadowDormant(error?.message || String(error)))
}

// ── 승격 서빙 게이트 (A-4) ──────────────────────────────────────────────────
//
// 승격된 유형만 로컬이 먼저 답한다. 폴백은 사용자에게 **보이지 않는다** —
// 게이트가 'api'를 돌려주면 호출자는 평소의 /chat 경로를 그대로 탄다.
const servingGate = createServingGate({
  store: nightSchool,
  generate: (message, { timeoutMs }) => localStudentReply(message, timeoutMs),
  timeoutMs: LOCAL_SERVE_TIMEOUT_MS
})

/**
 * 교환 하나의 앞단. 참조 카드가 붙은 body와 유형, 그리고 로컬이 답했다면 그
 * 답을 돌려준다. 두 채팅 초크포인트(비스트리밍/스트리밍)가 같은 규칙을 쓰도록
 * 규칙은 여기 한 곳에만 둔다.
 */
async function prepareExchange(message, baseBody, settings) {
  const body = attachReferenceCards(baseBody, courseware, settings.coursewareReferenceEnabled !== false)
  const hasReferenceCards = Array.isArray(body.reference_cards) && body.reference_cards.length > 0
  const type = classifyUtterance(message, { hasReferenceCards })
  let served = null
  try {
    served = await servingGate.serve(message, { hasReferenceCards, type })
  } catch (error) {
    // 게이트가 던지면 승격이 없던 것처럼 API로 간다 — 대화가 먼저다.
    logWarn('[PROMOTION_GATE_WARN]', error?.message || error)
  }
  return { body, type, local: served?.source === 'local' ? served.reply : null }
}

ipcMain.handle('nightSchool:getState', async () => {
  try {
    const state = nightSchool.getState()
    const signals = await probeTrainingSignals()
    const s = nightSchool.loadStatus()
    // 관제판 "다음 예정 조건" — 잡이 지금 판정하면 뭐라고 할지 그대로 보여준다.
    const next = evaluateTrigger({
      ...signals,
      lastSuccessAt: s.lastSuccessAt,
      cardsAtLastSuccess: s.cardsAtLastSuccess
    })
    return { ...state, signals, next, running: nightSchoolJob.isRunning() }
  } catch (error) { return { error: error?.message || String(error) } }
})
ipcMain.handle('nightSchool:trainNow', async () => {
  try {
    const result = await nightSchoolJob.runOnce({ force: true })
    return { ...nightSchool.getState(), result }
  } catch (error) { return { error: error?.message || String(error) } }
})

// 승격 토글 — 사용자 승인 경로. 추천 배지가 없는 유형을 켜려는 요청은 여기서
// 거절한다(관제판이 이미 비활성화하지만, 승격은 UI 하나에 맡길 결정이 아니다).
ipcMain.handle('nightSchool:setPromotion', (e, { type, enabled } = {}) => {
  try {
    if (enabled && !nightSchool.shadowByType()[type]?.recommended) {
      return { ...nightSchool.getState(), result: { ok: false, error: '아직 승격 추천 조건을 채우지 못했어요' } }
    }
    const result = nightSchool.setPromotion(type, enabled)
    return { ...nightSchool.getState(), result }
  } catch (error) { return { error: error?.message || String(error) } }
})

// 되감기 — 보관 앵커로 채택 델타를 되돌린다.
//
// 확인은 **여기서** 받는다. 렌더러의 confirm()은 IPC를 직접 부르면 그냥
// 건너뛸 수 있는 장식이라, 델타를 갈아끼우는 실제 지점 앞에 네이티브
// 다이얼로그를 둔다(기본 버튼 = 취소).
ipcMain.handle('nightSchool:rewind', async (e, { version } = {}) => {
  try {
    if (!version) return { ...nightSchool.getState(), result: { ok: false, error: '앵커를 고르지 않았어요' } }
    const { response } = await dialog.showMessageBox(windows.getSettings() || windows.getMain(), {
      type: 'question',
      buttons: ['취소', '되감기'],
      defaultId: 0,
      cancelId: 0,
      title: '학습 결과 되감기',
      message: `학습 결과를 ${version} 시점으로 되돌릴까요?`,
      detail: '지금 쓰는 델타는 앵커로 그대로 남아 다시 앞으로 감을 수 있어요.'
    })
    if (response !== 1) return { ...nightSchool.getState(), result: { ok: false, cancelled: true } }
    const result = nightSchool.rewind(version)
    return { ...nightSchool.getState(), result }
  } catch (error) { return { error: error?.message || String(error) } }
})

// 학습 잡 — 교재 변환과 같은 15분 주기. 조건이 하나라도 어긋나면 nvidia-smi
// 한 번 부르고 끝난다.
let nightSchoolTimer = null

function startNightSchoolJob() {
  if (nightSchoolTimer) return
  // 앵커 이동 중 크래시로 남은 고아 디렉터리 정리. 채택 중인 것과 최근 8개는
  // pruneAnchors가 지키므로 여기서 더 판단할 게 없다.
  try { nightSchool.pruneAnchors() } catch (error) { logWarn('[TRAINING_PRUNE_WARN]', error?.message || error) }
  nightSchoolTimer = setInterval(() => {
    nightSchoolJob.runOnce().catch((error) => logWarn('[TRAINING_JOB_WARN]', error?.message || error))
  }, COURSEWARE_POLL_MS)
}

/**
 * 종료 = 학습도 끝. STOP을 써서 체크포인트를 남기고 **실제로 끝날 때까지 기다린다**
 * — 기다리지 않으면 Electron이 먼저 죽고 학습이 유령으로 남아 GPU를 계속 문다.
 * 유예 안에 안 끝나면 kill한다(학습기는 스텝마다 STOP을 보므로 보통 몇 초).
 */
function stopNightSchoolJob() {
  if (nightSchoolTimer) {
    clearInterval(nightSchoolTimer)
    nightSchoolTimer = null
  }
  try { fs.writeFileSync(nightSchool.paths.stopPath, 'app quit', 'utf-8') } catch {}
  return awaitChildExit(trainerChild, TRAINER_GRACE_MS, () =>
    logWarn('[TRAINING_KILL]', `학습 프로세스가 ${TRAINER_GRACE_MS}ms 안에 끝나지 않아 강제 종료`))
}

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
  patchSettings
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

// Local LLM (Qwen on the user's PC) can spend ~47s just loading the model on
// the first call, before any generation — a flat 30s timed out the very first
// chat ("Request timed out after 30000ms"). Give local a generous budget;
// cloud/auto stays tight since a hung request there should fail fast.
// claude_code는 CLI 프로세스를 새로 띄우고(부팅만 수 초) 도구 없는 단발이라도
// 왕복이 길어서 같은 관대한 버킷에 넣는다.
const SLOW_CHAT_MODES = new Set(['local', 'claude_code'])
const chatTimeoutFor = (mode) => (SLOW_CHAT_MODES.has(mode) ? 180000 : 30000)

// 역할별(디렉터/관전) 모델. ''이면 대화와 같은 모델을 쓴다.
const roleAiMode = (settings, key) => settings[key] || settings.aiMode

// 디렉터/관전은 원래 짧은 타임아웃(9s/15s)으로 돈다 — 실패해도 규칙기반으로
// 조용히 넘어가는 보조 호출이라 오래 붙잡을 이유가 없다. claude_code만 CLI
// 기동 비용 때문에 그 안에 못 들어와서 별도 예산을 준다.
const CLAUDE_CODE_AUX_TIMEOUT = 30000

ipcMain.handle('send-message', async (e, { message, history, useWeb }) => {
  ledgerTracker.noteUserMessage(message) // 계측 — 동기·비차단
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()
    // Per-message `useWeb` (boolean) overrides settings.useWebDefault when
    // explicit. `undefined` from older callers falls back to the saved
    // default. Cast to boolean either way so the payload is JSON-safe.
    const resolvedUseWeb = typeof useWeb === 'boolean'
      ? useWeb
      : settings.useWebDefault === true
    const chatTimeout = chatTimeoutFor(settings.aiMode)
    // A-2: 교재에서 이 발화와 겹치는 카드를 찾아 body에 싣는다. 토글이 꺼져
    // 있거나 겹치는 게 없으면 키 자체가 안 붙는다(= 기존과 같은 요청).
    // A-4: 승격된 유형이면 로컬 학생이 먼저 답한다(폴백은 아래 /chat 그대로).
    const { body, type, local } = await prepareExchange(message, {
      message,
      history,
      ai_mode: settings.aiMode,
      memory_turns: settings.memoryTurns,
      use_web: resolvedUseWeb
    }, settings)
    if (local) {
      ledgerTracker.noteReplyDone()
      // 로컬이 낸 답은 교재로도 그림자로도 되먹이지 않는다 — 자기 출력을 다시
      // 교재로 학습하면 모델이 자기 말버릇만 증폭한다(그림자도 비교 상대가
      // 자기 자신이라 점수가 무의미해진다).
      return { reply: local, emotion: 'neutral', citations: [] }
    }
    const reply = await requestBackendJson('/chat', {
      method: 'POST',
      timeout: chatTimeout,
      body
    })
    ledgerTracker.noteReplyDone()
    recordCoursewareExchange(message, reply?.reply) // 교재 버퍼 — 비동기 큐, 비차단
    recordShadow(message, reply?.reply, type)       // 그림자 — 기다리지 않는다(지연 0)
    return reply
  } catch (e) {
    return { error: e.message }
  }
})

// ── SSE 채팅 스트리밍 relay ───────────────────────────────────────────────
//
// /chat/stream(SSE)을 main에서 받아 요청한 창(event.sender)으로 델타/완료/에러
// 프레임을 중계한다. 창당 활성 스트림 1개만 유지: 새 요청이나 창 파괴 시 이전
// AbortController를 끊어 늦은 델타가 새 버블에 붙지 않게 한다(렌더러도 requestId
// 로 이중 방어). 에러 문자열은 raw로 넘기고, 사용자용 한국어화는 두 렌더러가
// 공유하는 chatShared.toUserMessage가 담당(단일 출처).
const activeChatStreams = new Map() // webContents.id → AbortController

async function* parseSSEFrames(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const json = dataLine.slice(5).trim()
        if (!json) continue
        try { yield JSON.parse(json) } catch {}
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

ipcMain.handle('chat:streamStart', async (event, { message, history, useWeb }) => {
  ledgerTracker.noteUserMessage(message) // 계측 — 동기·비차단
  const sender = event.sender
  const wcId = sender.id

  // Abort any in-flight stream for this window before starting a new one.
  const prev = activeChatStreams.get(wcId)
  if (prev) { try { prev.abort() } catch {} }

  const controller = new AbortController()
  activeChatStreams.set(wcId, controller)
  const requestId = `${wcId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const onGone = () => { try { controller.abort() } catch {} }
  sender.once('destroyed', onGone)

  const isCurrent = () => activeChatStreams.get(wcId) === controller && !sender.isDestroyed()

  const settings = loadSettings()
  const resolvedUseWeb = typeof useWeb === 'boolean' ? useWeb : settings.useWebDefault === true
  const chatTimeout = chatTimeoutFor(settings.aiMode)

  // Fire the SSE read detached from the invoke return so the renderer gets its
  // requestId immediately and can start filtering frames.
  ;(async () => {
    let timer = null
    let timedOut = false
    try {
      await backend.ensureAvailableForRequest()
      // A-2 참조 카드 + A-4 승격 서빙 — 비스트리밍 경로와 같은 규칙
      // (prepareExchange 단일 출처).
      const { body, type, local } = await prepareExchange(message, {
        message,
        history,
        ai_mode: settings.aiMode,
        memory_turns: settings.memoryTurns,
        use_web: resolvedUseWeb
      }, settings)
      if (local) {
        // 로컬 서빙은 한 덩어리다(스트림이 없다). 델타 프레임 없이 완료만
        // 보낸다 — 렌더러는 델타 없이 done이 와도 그 본문으로 버블을 채운다.
        if (isCurrent()) {
          ledgerTracker.noteReplyDone()
          sender.send('chat-stream-done', { requestId, reply: local, emotion: 'neutral', citations: [] })
        }
        return
      }
      timer = setTimeout(() => { timedOut = true; try { controller.abort() } catch {} }, chatTimeout)
      const response = await fetch(`${getBackendUrl()}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok || !response.body) {
        const details = await readErrorResponse(response).catch(() => '')
        throw new Error(`[${response.status}] ${details || response.statusText}`)
      }
      for await (const frame of parseSSEFrames(response.body)) {
        if (!isCurrent()) break
        if (frame.type === 'delta') {
          sender.send('chat-stream-delta', { requestId, text: frame.text || '' })
        } else if (frame.type === 'final') {
          ledgerTracker.noteReplyDone() // 계측 — 응답이 화면에 다 뜬 시점
          recordCoursewareExchange(message, frame.reply) // 교재 버퍼 — 비동기 큐, 비차단
          recordShadow(message, frame.reply, type)       // 그림자 — 기다리지 않는다(지연 0)
          sender.send('chat-stream-done', {
            requestId,
            reply: frame.reply,
            emotion: frame.emotion,
            citations: Array.isArray(frame.citations) ? frame.citations : []
          })
        } else if (frame.type === 'error') {
          sender.send('chat-stream-error', { requestId, error: frame.message || 'stream error' })
        }
      }
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      // A timeout abort still deserves a user-facing error; a new-request /
      // window-close abort must stay silent (it's superseded / gone).
      if (isCurrent() && (!aborted || timedOut)) {
        const message = timedOut
          ? `Request timed out after ${chatTimeout}ms`
          : (error?.message || String(error))
        try { sender.send('chat-stream-error', { requestId, error: message }) } catch {}
      }
    } finally {
      if (timer) clearTimeout(timer)
      try { sender.removeListener('destroyed', onGone) } catch {}
      if (activeChatStreams.get(wcId) === controller) activeChatStreams.delete(wcId)
    }
  })()

  return { requestId }
})

// J단계 — LLM 행동 디렉터. 채팅과 분리된 경량 호출. 짧은 타임아웃, 실패는 전부
// null로 흡수(렌더러 runner가 백오프). 백엔드 미가용이면 ensureAvailableForRequest가
// 던지고 catch → null → 규칙기반 유지.
ipcMain.handle('director:decide', async (e, context) => {
  try {
    await backend.ensureAvailableForRequest()
    const settings = loadSettings()
    const aiMode = roleAiMode(settings, 'aiModeDirector')
    const r = await requestBackendJson('/director', {
      method: 'POST',
      timeout: aiMode === 'claude_code' ? CLAUDE_CODE_AUX_TIMEOUT : 9000,
      body: { context: context || {}, ai_mode: aiMode }
    })
    return (r && typeof r.raw === 'string') ? r.raw : null
  } catch {
    return null
  }
})

// ── M2 관전 모드 ────────────────────────────────────────────────────────────
//
// 프라이버시 계약(신뢰 경계 — 여기서 게으르면 안 된다):
//   1. **창 단위만.** screenCapture는 types:['screen']을 절대 요청하지 않으므로
//      전체 화면/다른 모니터는 목록에도 안 오르고 캡처도 안 된다.
//   2. 이미지는 어디에도 저장하지 않는다 — 캡처 → 백엔드 POST → 폐기.
//   3. 일시정지는 디스크에 남아 재시작해도 유지되고, 정지 중엔 캡처 호출 자체를
//      하지 않는다(찍고 버리는 게 아니라 안 찍는다).
//   4. 캡처가 도는 동안 코너 창에 상시 표시가 켜진다.
const { listWindows: listCaptureWindows, createCaptureGate } = require('./services/screenCapture')

const spectate = {
  gate: createCaptureGate({ desktopCapturer }),
  sourceId: null,
  sourceName: '',
  fullscreenWarned: false
}

function spectateIsPaused() {
  return loadSettings().spectatePaused === true
}

// 캡처 표시 + 렌더러 상태 동기화. 창이 없으면 조용히 넘어간다.
function broadcastSpectateState() {
  const payload = {
    active: !!spectate.sourceId && !spectateIsPaused(),
    paused: spectateIsPaused(),
    sourceName: spectate.sourceName || ''
  }
  for (const w of [windows.getMain(), cornerWindow]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('spectate:state', payload) } catch {}
    }
  }
  return payload
}

function setSpectatePaused(paused) {
  patchSettings({ spectatePaused: !!paused })
  spectate.gate.reset() // 재개 시 첫 프레임은 무조건 새 프레임으로 취급
  return broadcastSpectateState()
}

ipcMain.handle('spectate:listWindows', async () => {
  try {
    return await listCaptureWindows(desktopCapturer)
  } catch (error) {
    logWarn('[SPECTATE_LIST_FAIL]', error?.message || error)
    return []
  }
})

ipcMain.handle('spectate:setSource', (e, { id, name } = {}) => {
  spectate.sourceId = typeof id === 'string' && id ? id : null
  spectate.sourceName = typeof name === 'string' ? name.slice(0, 120) : ''
  spectate.gate.reset()
  spectate.fullscreenWarned = false
  return broadcastSpectateState()
})

ipcMain.handle('spectate:pause', (e, paused) => setSpectatePaused(paused))
ipcMain.handle('spectate:state', () => broadcastSpectateState())

// 한 tick: 캡처 → 절약 게이트 → (통과 시에만) VLM. typed result라 렌더러가
// "말 안 함"과 "실패"를 구분할 수 있다 — 이 구분이 없으면 러너가 정상 무발화를
// 실패로 세서 백오프에 걸린다(Codex 사전검토 MUST-FIX).
ipcMain.handle('spectate:tick', async (e, context) => {
  if (spectateIsPaused()) return { status: 'paused' }
  if (!spectate.sourceId) return { status: 'no-source' }

  let shot
  try {
    shot = await spectate.gate.capture(spectate.sourceId)
  } catch (error) {
    logWarn('[SPECTATE_CAPTURE_FAIL]', error?.message || error)
    return { status: 'error', error: 'capture failed' }
  }

  if (shot.status === 'dead-frame') {
    // 창은 잡히는데 내용이 없다 = 전용 전체화면일 가능성이 높다. Electron엔 타
    // 프로세스의 전용 전체화면을 확인할 API가 없어서 이 신호로 대신하고, 배너는
    // 세션당 1회만 띄운다(연속 3회 이상일 때 — 로딩 중 검은 화면 오탐 회피).
    if (shot.deadStreak >= 3 && !spectate.fullscreenWarned) {
      spectate.fullscreenWarned = true
      const main = windows.getMain()
      if (main && !main.isDestroyed()) {
        try { main.webContents.send('spectate:fullscreen-hint') } catch {}
      }
    }
    return { status: 'dead-frame', deadStreak: shot.deadStreak }
  }
  if (shot.status !== 'ok') return shot // no-source | no-change

  const settings = loadSettings()
  // 관전 전용 모델을 명시했으면 그대로 쓴다 — 사용자가 관전 드롭다운에서 고른
  // 것은 이미 비전 가능한 모델뿐이라 우회할 이유가 없다.
  // 미지정('')이면 예전 그대로: 전역 aiMode를 쓰되 로컬 LLM만 강제 비활성한다 —
  // 관전은 사용자가 게임/영상을 돌리는 중에 도는 기능이라 7B 로컬 모델이 VRAM을
  // 같이 먹으면 둘 다 죽는다. 사용자 설정은 건드리지 않고 이 호출만 auto로
  // 우회한다(되돌리기 곤란한 설정 변경 금지).
  const aiMode = settings.aiModeSpectate
    || (settings.aiMode === 'local' ? 'auto' : settings.aiMode)

  try {
    await backend.ensureAvailableForRequest()
    const r = await requestBackendJson('/spectate', {
      method: 'POST',
      // ollama_vlm은 첫 호출에 모델 콜드 로드가 붙어 15s를 넘길 수 있다 —
      // claude_code와 같은 상한을 준다(러너의 35s보다는 여전히 앞에서 끊긴다).
      timeout: (aiMode === 'claude_code' || aiMode === 'ollama_vlm')
        ? CLAUDE_CODE_AUX_TIMEOUT
        : 15000,
      body: { image_b64: shot.dataUrl, context: context || {}, ai_mode: aiMode }
    })
    if (!r || typeof r.raw !== 'string') return { status: 'no-vision' }
    // diff는 로그용 — 첫 프레임의 Infinity는 JSON에서 null이 되므로 -1로 눕힌다.
    const diff = Number.isFinite(shot.diff) ? shot.diff : -1
    // 관전 전용 모델을 고른 경우엔 '우회'가 아니라 사용자의 명시 선택이다.
    const localBypassed = !settings.aiModeSpectate && settings.aiMode === 'local'
    return { status: 'ok', raw: r.raw, diff, localBypassed }
  } catch (error) {
    logWarn('[SPECTATE_VLM_FAIL]', error?.message || error)
    return { status: 'error', error: 'vlm call failed' }
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
    //
    // cosyvoice는 첫 발화에서 모델을 GPU에 올린다(실측 ~20s + 합성). 30s로는
    // 콜드 스타트가 통째로 타임아웃 나므로 이 엔진만 상한을 늘린다 — 백엔드는
    // 어차피 실패 시 기본 목소리로 폴백하니 늘려도 무음이 되지 않는다.
    // 240s = 백엔드 최악 경로(모델 로드 타임아웃 180s + 청크 30s + 폴백 합성)보다
    // 커야 IPC가 먼저 끊기지 않고 폴백 오디오라도 받는다.
    const engine = settings.ttsEngine === 'cosyvoice' ? 'cosyvoice' : null
    const response = await requestBackend('/tts', {
      method: 'POST',
      timeout: engine ? 240000 : 30000,
      body: { text, voice_id: voice_id ?? settings.voiceId ?? null, engine }
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
  // 검증 실패 시 기존 파일은 건드리지 않는다 — 반쪽짜리 세계로 덮어쓰느니
  // 마지막으로 성공한 세계를 지키는 편이 낫다(렌더러가 result.ok를 본다).
  return saveWorldDocument(WORLD_PATH, data, { warn: logWarn })
})

// 개발자 전용 로컬 엔진(관전 ollama_vlm / TTS cosyvoice) UI 노출 플래그.
// **저장되는 설정이 아니다** — 프로세스 환경일 뿐이라 get-settings 응답에만 얹어
// 보내고, 되돌아오는 저장 경로에서는 SettingsRepository.normalize가 지운다.
const DEV_LOCAL_ENGINES_ENABLED = process.env.APIA_DEV_LOCAL_ENGINES === '1'

ipcMain.handle('get-settings', () => ({
  ...loadSettings(),
  devLocalEnginesEnabled: DEV_LOCAL_ENGINES_ENABLED
}))

ipcMain.handle('save-settings', (e, data) => {
  const settings = patchSettings(data)
  return { ok: true, settings }
})

ipcMain.handle('open-settings', () => {
  windows.openSettings()
  return { ok: true }
})

ipcMain.handle('apply-settings', (e, s) => {
  // s는 설정 UI가 실제로 편집하는 필드만 담은 부분 payload다(settings.html save()).
  const settings = patchSettings(s)
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

// ── 환경설정: 다중 모니터 선택 ───────────────────────────────────────────────
//
// get-displays: 설정 창이 모니터 목록을 그릴 수 있게 최소 정보만 준다(현재
// 캐릭터가 있는 모니터 표시 포함). settings:moveToDisplay: 캐릭터 오버레이를
// 지정 모니터로 옮긴다 — 앵커는 WindowManager가 즉시 영속하므로 별도 설정
// 필드 없이 다음 실행에도 같은 모니터로 복원된다(단일 출처 유지).
ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay()?.id
  let currentId = null
  try {
    const main = windows.getMain()
    if (main && !main.isDestroyed()) {
      currentId = screen.getDisplayMatching(main.getBounds())?.id ?? null
    }
  } catch {}
  return displays.map((d, i) => ({
    id: d.id,
    index: i + 1,
    primary: d.id === primaryId,
    current: d.id === currentId,
    width: d.size?.width ?? d.bounds?.width ?? 0,
    height: d.size?.height ?? d.bounds?.height ?? 0
  }))
})

ipcMain.handle('settings:moveToDisplay', async (e, payload) => {
  const displayId = Number(payload?.displayId)
  if (!Number.isFinite(displayId)) return { ok: false, error: 'bad-display-id' }
  const display = screen.getAllDisplays().find((d) => d.id === displayId)
  if (!display?.workArea) return { ok: false, error: 'display-not-found' }
  const main = windows.getMain()
  if (!main || main.isDestroyed()) return { ok: false, error: 'no-main-window' }
  // 벽지모드로 부착된 채 setBounds만 하면 Progman-child 좌표가 어긋날 수 있고,
  // enableWallpaper는 attached 상태에선 no-op이라 재부착이 안 돈다 — 반드시
  // 분리 → 이동 → 재부착 순서(Codex MUST-FIX).
  // disableWallpaper는 헬퍼 프로세스를 spawn하는 async라 반드시 await한다. 안
  // 기다리면 창이 아직 Progman의 WS_CHILD인 채로 setBounds가 돌고, 자식 창의
  // SetWindowPos는 부모(가상 데스크톱) 기준 좌표라 엉뚱한 모니터에 떨어진다.
  if (wallpaperMode.isAttached()) {
    try { await wallpaperMode.disableWallpaper(main, { info: logInfo, warn: logWarn }) } catch {}
  }
  if (!windows.moveMainToWorkArea(display.workArea)) {
    return { ok: false, error: 'move-failed' }
  }
  // await 필수 — 부착이 끝나야 창이 새 모니터 rect에 앉는다. 안 기다리면
  // 핫코너가 이전 모니터 자리에 그대로 남는다.
  await syncWallpaperMode() // 벽지모드면 새 모니터 전체 bounds로 재부착, 아니면 유지
  repositionCornerWindow() // 핫코너도 캐릭터를 따라간다
  logInfo('[DISPLAY_MOVE]', { displayId, landed: main.getBounds() })
  return { ok: true }
})

// CosyVoice 참조 음성 저장. 렌더러가 이미 22.05kHz mono WAV로 정규화해서
// 보내므로(음성 복제 업로드와 같은 헬퍼) 여기선 규약 경로에 쓰기만 한다.
// 백엔드는 이 경로를 직접 읽는다 — 설정에 경로를 따로 저장하지 않는다.
ipcMain.handle('cosyvoice-set-prompt', async (_event, { wavBase64 }) => {
  try {
    const dir = path.join(settingsRepo.getDataDir(), 'cosyvoice')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'prompt.wav'), Buffer.from(String(wavBase64 || ''), 'base64'))
    return { ok: true }
  } catch (error) {
    logWarn('[COSYVOICE_PROMPT_WRITE_FAIL]', error)
    return { ok: false, error: error?.message || String(error) }
  }
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
      // 실제 분리를 await한다. markDetached는 내부 플래그만 지워서, 창이 아직
      // Progman 자식인 채로 syncWallpaperMode의 setBounds가 돌았다 — 자식 창
      // 좌표는 부모(가상 데스크톱) 기준이라 창이 엉뚱한 모니터로 튀었다.
      try { await wallpaperMode.disableWallpaper(main, { info: logInfo, warn: logWarn }) } catch {}
      await syncWallpaperMode()
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
  // 종료 중이면 재부착하지 않는다 — shutdownOnce가 분리를 기다리는 2초 동안
  // 디스플레이 이벤트가 들어오면 방금 뗀 창을 다시 붙여 놓는다.
  if (quittingApia) return
  if (rewallpaperTimer) clearTimeout(rewallpaperTimer)
  rewallpaperTimer = setTimeout(async () => {
    rewallpaperTimer = null
    if (quittingApia) return
    const settings = loadSettings()
    if (settings.useWallpaperMode === false) return
    try {
      // await 필수 — 분리 전에 syncWallpaperMode가 setBounds를 돌리면 아직
      // Progman 자식이라 좌표가 부모 기준으로 해석된다.
      await wallpaperMode.disableWallpaper(windows.getMain(), { info: logInfo, warn: logWarn })
    } catch {}
    // 분리를 기다리는 동안 종료가 시작됐을 수 있다. 여기서 안 막으면 shutdownOnce가
    // 막 떼어낸 창을 이 함수가 다시 붙여 놓는다(다음 실행 모니터 튐의 재발 경로).
    if (quittingApia) return
    // 재부착 완료까지 기다린 뒤 핫코너를 새 모니터로 옮긴다.
    await syncWallpaperMode()
    repositionCornerWindow()
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
      contents.once('did-finish-load', () => {
        if (win.isDestroyed()) return
        // Restore visibility only if the crash actually hid the window — avoids
        // needlessly re-show()ing the wallpaper-attached main window.
        if (wasVisible && !win.isVisible()) win.show()
        // 리로드된 렌더러는 wallpaperOpaque=false 상태로 되살아나는데, 창은 여전히
        // 벽지 레이어에 붙어 있다 → 투명하게 그려서 캐릭터가 영영 안 보인다.
        // 헬스 프로브는 HWND 부모만 보므로 이 상태를 절대 못 잡는다. sync를 다시
        // 돌려 opaque를 재전송한다(enableWallpaper는 이미 부착돼 있으면 no-op).
        if (win === windows.getMain()) {
          syncWallpaperMode().catch((error) => logWarn('[RECOVER_WALLPAPER_SYNC_FAIL]', error))
        }
      })
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
    loadSettings
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

  startLedgerDailyJob()
  startCoursewareJob()
  startNightSchoolJob()

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
    let idleSec
    try { idleSec = powerMonitor.getSystemIdleTime() } catch { return }
    // 같은 유휴초 피드를 원장도 본다 — 응답 대기 중 부재가 관측되면 그 교환의
    // 지연 신호를 무효화한다(자리를 비운 것은 회피가 아니다).
    ledgerTracker.notePresence(idleSec)
    const main = windows.getMain()
    if (!main || main.isDestroyed()) return
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

// 종료 시 5초 폴링을 끊는다 — unref도 안 돼 있어서 창이 다 닫힌 뒤에도 살아
// 있었다. powerMonitor 리스너는 프로세스와 함께 죽으므로 따로 떼지 않는다
// (startPresenceFeed의 재진입 가드가 중복 등록도 막는다).
function stopPresenceFeed() {
  if (presencePollTimer) {
    clearInterval(presencePollTimer)
    presencePollTimer = null
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

async function syncWallpaperMode() {
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
    // 이미 부착돼 있으면 건너뛴다 — 헬퍼가 이미 창을 모니터 물리 rect에 맞춰
    // 놨고, Progman 자식 상태의 setBounds는 부모 기준 좌표라 창을 엉뚱한
    // 모니터로 밀어낸다(설정 저장만 해도 캐릭터가 옆 모니터로 튀던 원인).
    if (!wallpaperMode.isAttached()) {
      try {
        const disp = screen.getDisplayMatching(main.getBounds())
        if (disp?.bounds) main.setBounds(disp.bounds)
      } catch {}
    }
    const ready = main.isVisible() ? Promise.resolve() : new Promise((resolve) => {
      main.once('ready-to-show', resolve)
    })
    // return 필수 — 이 체인을 안 돌려주면 await syncWallpaperMode()가 부착이
    // 끝나기 전에 반환된다. 부착 뒤 창 좌표에 의존하는 호출자(핫코너 재배치)가
    // 이전 모니터 자리를 그대로 쓰게 된다.
    return Promise.resolve(ready).then(async () => {
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
      // await 필수 — 분리가 끝나기 전 setBounds는 Progman 자식 좌표로 해석된다.
      try { await wallpaperMode.disableWallpaper(main, { info: logInfo, warn: logWarn }) } catch {}
    }
    // ON 분기와 대칭인 재확인. 분리를 기다리는 동안 사용자가 토글을 다시 켰다면
    // (빠른 연속 토글) 여기서 오버레이 상태를 복원해봐야 그 뒤 도착하는 부착과
    // 어긋나 "부착됐는데 오버레이 취급"(캐릭터 안 보임·코너 버튼 없음)이 된다.
    // 켜기를 유발한 그 호출이 자기 sync를 따로 돌리므로 여기선 빠지면 된다.
    const live = windows.getMain()
    if (!live || live.isDestroyed()) return
    if (loadSettings().useWallpaperMode !== false) return
    // Restore the normal overlay behavior (floating, accepts clicks) at workArea
    // bounds — a previous wallpaper session may have grown it to full display
    // bounds (Codex MUST-FIX: don't leave a taskbar-covering click sink).
    try {
      const d = screen.getDisplayMatching(live.getBounds())
      if (d?.workArea) live.setBounds(d.workArea)
    } catch {}
    try { live.setAlwaysOnTop(loadSettings().alwaysOnTop !== false) } catch {}
    try { live.setIgnoreMouseEvents(false) } catch {}
    try { live.webContents?.send('wallpaper:opaque', false) } catch {}
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
  // Ctrl+Alt+S = 관전 일시정지/재개. 전역 핫키인 이유: 화면을 보고 있는 기능이라
  // 창을 찾아 클릭할 시간 없이 즉시 멈출 수 있어야 한다(프라이버시).
  try {
    if (!globalShortcut.isRegistered('CommandOrControl+Alt+S')) {
      const ok = globalShortcut.register('CommandOrControl+Alt+S', () => {
        const state = setSpectatePaused(!spectateIsPaused())
        logInfo('[SPECTATE_TOGGLE]', state.paused ? 'paused' : 'resumed')
      })
      if (!ok) logWarn('[GLOBAL_SHORTCUT_REGISTER_BUSY]', 'Ctrl+Alt+S already in use by another app')
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
  'show-main-chat', 'call', 'look-at'
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
  // look-at: 정규화 화면좌표 {x,y}(-1..1). 유한수만 통과시킨다 — 렌더러의
  // setLookTarget이 clamp까지 하지만 NaN은 clamp를 통과해 시선을 죽인다.
  if (payload.action === 'look-at') {
    if (!Number.isFinite(payload.value?.x) || !Number.isFinite(payload.value?.y)) {
      logWarn('[CHARACTER_NOTIFY_REJECTED]', 'look-at needs finite {x,y}')
      return { ok: false, reason: 'invalid look-at payload' }
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

// ── 종료 경로 단일화 ────────────────────────────────────────────────────────
//
// 예전엔 quitApia()와 before-quit이 각자 정리(분리 + backend.stop)를 돌렸고,
// 둘 다 disableWallpaper를 await하지 않았다. 분리는 Win32 헬퍼를 spawn하는
// 비동기 작업이라, 프로세스가 먼저 죽으면 창이 Progman 자식인 채로 남아
// 다음 실행에서 좌표가 부모(가상 데스크톱) 기준으로 해석돼 캐릭터가 엉뚱한
// 모니터로 튀었다. 이제 두 경로가 같은 shutdownOnce()를 통과한다 — 이중 분리도,
// 이중 backend.stop도 구조적으로 불가능하다.
const SHUTDOWN_DETACH_TIMEOUT_MS = 2000
let quittingApia = false
let shutdownPromise = null

function shutdownOnce() {
  if (shutdownPromise) return shutdownPromise
  // 플래그부터 세운다 — 분리를 기다리는 2초 동안 디스플레이 이벤트가 들어와도
  // 재부착하지 않도록(rewallpaperOnDisplayChange가 이 플래그를 본다).
  quittingApia = true
  shutdownPromise = (async () => {
    try { globalShortcut.unregisterAll() } catch {}
    try { tray?.destroy?.(); tray = null } catch {}
    if (rewallpaperTimer) { clearTimeout(rewallpaperTimer); rewallpaperTimer = null }
    stopCursorFeed()
    stopPresenceFeed()
    stopLedgerDailyJob()
    stopCoursewareJob()
    // 학습 자식이 실제로 끝날 때까지 기다린다(상한 TRAINER_GRACE_MS).
    try { await stopNightSchoolJob() } catch (error) { logWarn('[TRAINING_SHUTDOWN_WARN]', error?.message || error) }
    // 종료 = 대화 종료. 확정 안 된 마지막 교환은 버리고(종료≠회피) 일일 집계를
    // 한 번 돌려 원장을 최신 상태로 닫는다.
    try {
      ledgerTracker.endConversation()
      ledger.aggregate()
    } catch (error) { logWarn('[LEDGER_SHUTDOWN_WARN]', error?.message || error) }
    stopWallpaperHealthCheck()
    try { destroyCornerWindow() } catch {}
    // Phase F2: destroy chatWindow on real quit so it doesn't keep the process
    // alive after backend stop.
    try {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy()
      chatWindow = null
    } catch {}
    // Drain the debounced anchor save before the window is gone — otherwise
    // a quit during a drag loses the final position.
    try { windows.flushPendingAnchor() } catch (error) { logWarn('[QUIT_ANCHOR_FLUSH_WARN]', error?.message || error) }
    // 분리를 실제로 기다리되 상한을 둔다 — 헬퍼가 멈춰도 종료가 영원히 막히면 안 된다.
    try {
      await Promise.race([
        wallpaperMode.disableWallpaper(windows.getMain(), { info: logInfo, warn: logWarn }),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DETACH_TIMEOUT_MS))
      ])
    } catch (error) {
      logWarn('[QUIT_DETACH_WARN]', error?.message || error)
    }
    if (backend.isStartedByApp()) backend.stop()
  })()
  return shutdownPromise
}

function quitApia() {
  shutdownOnce().finally(() => app.quit())
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

app.on('before-quit', (event) => {
  logInfo('[BEFORE_QUIT]', { backendStartedByApp: backend.isStartedByApp() })
  // H단계 — quit이 quitApia()가 아닌 경로(OS 종료, E2E의 app.close())로
  // 시작되면 chatWindow의 close 핸들러가 preventDefault로 종료를 영원히
  // 막는다. shutdownOnce()가 플래그를 세워 "진짜 종료"임을 알린다.
  //
  // 종료를 한 번 붙잡아 두고(정리는 비동기다) 끝난 뒤 exit한다. preventDefault
  // 없이 두면 벽지 분리 헬퍼가 끝나기 전에 프로세스가 사라진다.
  event.preventDefault()
  shutdownOnce().finally(() => app.exit(0))
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
