/**
 * Stateful backend lifecycle for the Electron main process.
 *
 * Owns:
 *   - the current live backend URL (mutated when port collision picks an
 *     alternate, or when the configured URL is committed for the first time)
 *   - the spawned child process handle and its "started by us" flag
 *   - the dedup promise for in-flight `ensureRunning` calls
 *   - the cooldown clock that prevents tight respawn loops
 *
 * Stays out of (consumed via constructor deps):
 *   - logging surface (`log.info/warn/error/childOutput`)
 *   - settings + IPC + window management (caller-owned)
 *   - pure URL/port/launch-candidate computation (delegated to
 *     `backendDiscovery.js`)
 *
 * Why class instead of factory: lifecycle has real mutable state (process
 * handle, in-flight promise, last-launch timestamp), and method-on-instance
 * reads slightly cleaner at call sites than `controller.method(state, ...)`.
 * Constructor takes platform/env/spawn as injectable deps so the class is
 * unit-testable without spinning up a real backend.
 */
const httpDefault = require('http')
const httpsDefault = require('https')
const path = require('path')
const fs = require('fs')
const { spawn: spawnDefault, spawnSync: spawnSyncDefault } = require('child_process')

const discoveryModule = require('./backendDiscovery')

const {
  DEFAULT_BACKEND_URL,
  trimTrailingSlashes,
  parseBackendUrl: parseBackendUrlRaw,
  isLocalBackendUrl: isLocalBackendUrlRaw,
  getBackendSpawnConfig: getBackendSpawnConfigRaw
} = discoveryModule

const DEFAULT_COOLDOWN_MS = 15000
const DEFAULT_READY_TIMEOUT_MS = 20000
const DEFAULT_READY_INTERVAL_MS = 500
const DEFAULT_PROBE_TIMEOUT_MS = 8000

// 이전 실행이 남긴 고아 백엔드를 다시 우리 것으로 인정(adoption)하기 위한 기록.
// DATA_DIR에 둔다 — 백엔드가 이미 쓰는 디렉터리라 새 경로 규약이 늘지 않는다.
const PID_FILE_NAME = 'backend.pid.json'

/**
 * 살아 있는 프로세스의 커맨드라인에 실제로 찍히는 절대 경로 하나를 고른다.
 * 채택 시 "그때 그 백엔드가 맞는가"를 이 문자열 포함 여부로 판별한다.
 *
 * ponytail: `py -3 main.py`처럼 커맨드가 상대 런처인 후보는 커맨드라인에
 * 절대 경로가 안 찍혀 채택에 실패한다(=오늘과 같은 not-managed로 후퇴).
 * 실제 운영 경로인 venv/packaged 후보는 command가 절대라 커버된다. 느슨하게
 * 매칭하느니 못 잡는 편이 낫다 — PID가 재사용된 남의 프로세스를 taskkill하는
 * 것이 훨씬 나쁜 실패다.
 */
function resolveBackendPath(candidate) {
  if (path.isAbsolute(candidate.command)) return candidate.command
  const script = candidate.args?.[candidate.args.length - 1]
  return script ? path.resolve(candidate.cwd || '.', script) : candidate.command
}

class BackendLifecycle {
  // Private state — anything callers want must be exposed via a method, so
  // the lifetime invariants ("process handle nulls itself when the child
  // exits, whether we asked or not") stay encapsulated.
  #url
  #configuredUrl
  #hasExplicitUrl
  #isDev
  #userDataPath
  #resourcesPath
  #workspaceRoot
  #log
  #cooldownMs
  #platform
  #env
  #spawn
  #spawnSync
  #http
  #https
  #fs
  #queryCommandLine

  #process = null
  // 채택한(이전 실행이 남긴) 백엔드의 PID. #process가 null이어도 stop()이
  // 이 pid로 죽일 수 있어야 restart가 실제로 재시작이 된다. 죽일 때 신원을
  // 다시 확인해야 하므로 pidfile 레코드도 함께 들고 있는다.
  #ownedPid = null
  #ownedRecord = null
  #startedByApp = false
  #ensurePromise = null
  #lastLaunchAt = 0
  #discovery
  #e2eDisable

  constructor({
    configuredUrl,
    hasExplicitUrl,
    isDev,
    userDataPath,
    resourcesPath,
    workspaceRoot,
    log,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    // Injectable so unit tests can stub.
    platform = process.platform,
    env = process.env,
    spawn = spawnDefault,
    spawnSync = spawnSyncDefault,
    http = httpDefault,
    https = httpsDefault,
    // pidfile IO + 프로세스 커맨드라인 조회도 주입 — 테스트가 실제 디스크나
    // 실제 프로세스 조회 없이 채택 경로를 통째로 돌릴 수 있어야 한다.
    fs: fsDep = fs,
    queryCommandLine = null,
    // Discovery helpers are injected as a single bag so tests can swap
    // them without monkey-patching the require cache. Default is the
    // real backendDiscovery module — production code never passes this.
    discovery = {
      pickAvailableBackendUrl: discoveryModule.pickAvailableBackendUrl,
      getBackendLaunchCandidates: discoveryModule.getBackendLaunchCandidates
    }
  } = {}) {
    if (!log || typeof log.info !== 'function') {
      throw new Error('BackendLifecycle requires a log object with info/warn/error/childOutput methods')
    }

    this.#configuredUrl = configuredUrl
    this.#hasExplicitUrl = hasExplicitUrl
    this.#isDev = isDev
    this.#userDataPath = userDataPath
    this.#resourcesPath = resourcesPath
    this.#workspaceRoot = workspaceRoot
    this.#log = log
    this.#cooldownMs = cooldownMs
    this.#platform = platform
    this.#env = env
    this.#spawn = spawn
    this.#spawnSync = spawnSync
    this.#http = http
    this.#https = https
    this.#fs = fsDep
    this.#queryCommandLine = queryCommandLine || ((pid) => this.#defaultQueryCommandLine(pid))

    this.#url = trimTrailingSlashes(configuredUrl) || DEFAULT_BACKEND_URL
    this.#discovery = discovery
    // E2E seam: when GUI tests set APIA_E2E_DISABLE_BACKEND=1, every spawn
    // path here short-circuits. Without this, an IPC like `get-voices` or
    // `warmup:status` would still try to spawn the Python backend mid-test
    // and either succeed (polluting the test env) or fail noisily.
    this.#e2eDisable = env?.APIA_E2E_DISABLE_BACKEND === '1'
  }

  // ── URL state ──────────────────────────────────────────────────────────

  getUrl() {
    return this.#url
  }

  setUrl(nextUrl) {
    this.#url = trimTrailingSlashes(nextUrl) || DEFAULT_BACKEND_URL
    this.#log.info('[BACKEND_URL_SET]', { url: this.#url })
  }

  parseUrl(rawUrl = this.#url) {
    return parseBackendUrlRaw(rawUrl, {
      onInvalid: ({ rawUrl: invalid, error }) =>
        this.#log.warn('[BACKEND_URL_INVALID]', { rawUrl: invalid, error })
    })
  }

  isLocalUrl(rawUrl = this.#url) {
    return isLocalBackendUrlRaw(rawUrl)
  }

  getSpawnConfig(rawUrl = this.#url) {
    return getBackendSpawnConfigRaw(rawUrl, this.#userDataPath)
  }

  // ── Lifecycle state ────────────────────────────────────────────────────

  isStartedByApp() {
    return this.#startedByApp
  }

  // Exposed so main.js can branch on the e2e seam without re-reading
  // process.env (the source of truth lives in the lifecycle constructor).
  isE2EDisabled() {
    return this.#e2eDisable
  }

  // ── Pidfile + 고아 백엔드 채택 ──────────────────────────────────────────
  //
  // 문제: 앱이 크래시로 죽으면 백엔드만 살아남는다. 다음 실행에서 /health가
  // 응답하므로 ensureRunning은 스폰 없이 true로 빠지고, #startedByApp이 false로
  // 남아 restart()가 'not-managed'를 돌려준다 → 설정 창은 "외부 백엔드"라고
  // 안내하고 새 API 키는 영영 적용되지 않는다.
  //
  // 해결: 스폰할 때 pid/port/절대경로를 파일로 남기고, 다음 실행에서 신원
  // 3중 확인(pid 생존 + 커맨드라인에 그 절대경로 포함 + 포트 일치)이 전부
  // 맞을 때만 소유권을 되찾는다. 하나라도 어긋나면 오늘과 같은 동작(채택 안 함).

  #pidFilePath() {
    if (!this.#userDataPath) return null
    try {
      return path.join(this.getSpawnConfig().dataDir, PID_FILE_NAME)
    } catch {
      return null
    }
  }

  #writePidFile(pid, candidate) {
    const target = this.#pidFilePath()
    if (!target || !pid) return
    try {
      this.#fs.mkdirSync(path.dirname(target), { recursive: true })
      this.#fs.writeFileSync(target, JSON.stringify({
        pid,
        port: this.getSpawnConfig().port,
        backendPath: resolveBackendPath(candidate),
        spawnTime: new Date().toISOString()
      }, null, 2), 'utf-8')
    } catch (error) {
      this.#log.warn('[BACKEND_PIDFILE_WRITE_FAIL]', error?.message || error)
    }
  }

  #deletePidFile() {
    const target = this.#pidFilePath()
    if (!target) return
    try {
      if (this.#fs.existsSync(target)) this.#fs.unlinkSync(target)
    } catch (error) {
      this.#log.warn('[BACKEND_PIDFILE_DELETE_FAIL]', error?.message || error)
    }
  }

  #readPidFile() {
    const target = this.#pidFilePath()
    if (!target) return null
    try {
      if (!this.#fs.existsSync(target)) return null
      const record = JSON.parse(this.#fs.readFileSync(target, 'utf-8'))
      const pid = Number(record?.pid)
      if (!Number.isInteger(pid) || pid <= 0) return null
      if (!record?.backendPath) return null
      return { ...record, pid }
    } catch (error) {
      this.#log.warn('[BACKEND_PIDFILE_READ_FAIL]', error?.message || error)
      return null
    }
  }

  #defaultQueryCommandLine(pid) {
    try {
      // Number()로 한 번 걸러서 pid가 셸/PowerShell 문자열에 그대로 끼어드는 걸 막는다.
      const safePid = Number(pid)
      if (!Number.isInteger(safePid) || safePid <= 0) return null
      const result = this.#platform === 'win32'
        ? this.#spawnSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${safePid}"; if ($p) { $p.CommandLine }`
          ], { windowsHide: true, encoding: 'utf-8', timeout: 5000 })
        : this.#spawnSync('ps', ['-p', String(safePid), '-o', 'args='], {
            encoding: 'utf-8',
            timeout: 5000
          })
      // 죽은 pid면 ps는 status!=0, PowerShell은 빈 출력 — 둘 다 null로 수렴.
      if (!result || result.status !== 0) return null
      const out = String(result.stdout || '').trim()
      return out || null
    } catch (error) {
      this.#log.warn('[BACKEND_PID_QUERY_FAIL]', error?.message || error)
      return null
    }
  }

  /**
   * 기록된 pid가 "그때 그 백엔드"로 아직 살아 있는가. 채택할 때와 죽일 때
   * **같은 판정**을 쓴다 — 그 사이에 프로세스가 죽고 OS가 pid를 남에게
   * 재사용시켰을 수 있고, 그 상태로 taskkill하면 애먼 프로세스를 죽인다.
   * @returns 'ok' | 'pid-not-alive' | 'identity-mismatch'
   */
  #pidIdentity(record) {
    const commandLine = this.#queryCommandLine(record.pid)
    if (!commandLine) return 'pid-not-alive'
    // 경로 비교는 소문자로 — Windows 파일시스템이 대소문자를 구분하지 않는다.
    return commandLine.toLowerCase().includes(String(record.backendPath).toLowerCase())
      ? 'ok'
      : 'identity-mismatch'
  }

  #tryAdoptExisting() {
    if (this.#startedByApp || this.#e2eDisable) return false
    const record = this.#readPidFile()
    if (!record) return false

    // 채택에 실패한 기록은 지운다. 죽었거나(pid-not-alive), 남에게 넘어갔거나
    // (identity-mismatch), 지금 설정으로는 무의미한(port-mismatch) 기록이라
    // 나중에 다시 채택될 일이 없다 — 안 지우면 실행할 때마다 커맨드라인 조회
    // (win32에선 PowerShell 스폰)를 되풀이하고 같은 경고만 쌓인다.
    if (String(record.port) !== String(this.getSpawnConfig().port)) {
      this.#log.warn('[BACKEND_ADOPT_SKIP]', { reason: 'port-mismatch', recorded: record.port })
      this.#deletePidFile()
      return false
    }

    const identity = this.#pidIdentity(record)
    if (identity !== 'ok') {
      this.#log.warn('[BACKEND_ADOPT_SKIP]', { reason: identity, pid: record.pid })
      this.#deletePidFile()
      return false
    }

    this.#ownedPid = record.pid
    this.#ownedRecord = record
    this.#startedByApp = true
    this.#log.info('[BACKEND_ADOPTED]', { pid: record.pid, port: record.port })
    return true
  }

  // ── URL discovery (port collision) ─────────────────────────────────────

  async pickAvailableUrl() {
    const result = await this.#discovery.pickAvailableBackendUrl({
      configuredBackendUrl: this.#configuredUrl,
      hasExplicitBackendUrl: this.#hasExplicitUrl
    })

    if (result.conflicted) {
      this.#log.warn('[BACKEND_PORT_CONFLICT]', {
        configuredPort: result.configuredPort,
        selectedPort: result.selectedPort
      })
    }

    this.setUrl(result.url)
    return this.#url
  }

  // ── Health probe ───────────────────────────────────────────────────────
  //
  // Uses raw node:http/https rather than fetch because this is the readiness
  // probe — `regressionNotes` "Backend readiness probes should use a simple
  // Node HTTP request, not a generic fetch helper" pins this choice. Keep it.
  async isHealthy(timeout = 2500) {
    return new Promise((resolvePromise) => {
      let settled = false

      const finish = (value) => {
        if (settled) return
        settled = true
        resolvePromise(value)
      }

      try {
        const url = new URL(`${this.#url}/health`)
        const transport = url.protocol === 'https:' ? this.#https : this.#http

        const request = transport.request(url, {
          method: 'GET',
          timeout
        }, (response) => {
          response.resume()
          finish(response.statusCode >= 200 && response.statusCode < 300)
        })

        request.on('timeout', () => {
          request.destroy()
          finish(false)
        })

        request.on('error', () => {
          finish(false)
        })

        request.end()
      } catch {
        finish(false)
      }
    })
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  #getLaunchCandidates() {
    return this.#discovery.getBackendLaunchCandidates({
      isLocal: this.isLocalUrl(),
      workspaceRoot: this.#workspaceRoot,
      resourcesPath: this.#resourcesPath
    })
  }

  #attachChild(child, label) {
    child.stdout?.on('data', (chunk) => {
      this.#log.childOutput('INFO', `[BACKEND:${label}]`, chunk)
    })

    child.stderr?.on('data', (chunk) => {
      this.#log.childOutput('ERROR', `[BACKEND:${label}:ERR]`, chunk)
    })

    child.on('exit', (code, signal) => {
      this.#log.warn('[BACKEND_EXIT]', { label, code, signal })
      // `#process === child` 조건이 재시작 레이스도 막아준다 — stop()이 이미
      // #process를 비운 뒤 새 자식을 스폰했다면 여기서 새 pidfile을 지우지 않는다.
      if (this.#process === child) {
        this.#process = null
        this.#startedByApp = false
        this.#deletePidFile()
      }
    })

    child.on('error', (error) => {
      this.#log.error('[BACKEND_SPAWN_ERROR]', { label, error })
      // codex NICE-TO-HAVE: also clear current-process on spawn error, so
      // a child that errored before exit doesn't leave us thinking we own
      // a live backend.
      if (this.#process === child) {
        this.#process = null
        this.#startedByApp = false
      }
    })
  }

  async #waitForReady(
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    intervalMs = DEFAULT_READY_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS
  ) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.isHealthy(probeTimeoutMs)) return true
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  async #trySpawnCandidate(candidate) {
    let child = null
    const spawnConfig = this.getSpawnConfig()

    try {
      child = this.#spawn(candidate.command, candidate.args, {
        cwd: candidate.cwd,
        env: {
          ...this.#env,
          APIA_BACKEND_HOST: spawnConfig.host,
          APIA_BACKEND_PORT: spawnConfig.port,
          DATA_DIR: spawnConfig.dataDir,
          // PYTHONUTF8 forces utf-8 for filesystem operations; PYTHONIOENCODING
          // makes stdout/stderr utf-8 too. Without both, Windows consoles
          // default to cp949/cp1252 and Korean log lines arrive at our
          // logChildOutput as mojibake.
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8'
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.#log.warn(`[BACKEND_START_FAIL] ${candidate.label}`, error)
      return false
    }

    this.#process = child
    this.#startedByApp = true
    this.#attachChild(child, candidate.label)

    const ready = await this.#waitForReady()
    if (ready) {
      // 준비된 뒤에만 기록한다 — 뜨다 만 프로세스의 pid를 남기면 다음 실행이
      // 엉뚱한 것을 채택한다.
      this.#writePidFile(child.pid, candidate)
      this.#log.info(`[BACKEND_READY] ${candidate.label}`, { url: this.#url })
      return true
    }

    this.#log.warn(`[BACKEND_READY_TIMEOUT] ${candidate.label}`, { url: this.#url })
    if (this.#process === child) {
      this.stop()
    }
    return false
  }

  // ── Public ensure / stop ───────────────────────────────────────────────

  ensureRunning({ force = false, skipHealthCheck = false } = {}) {
    if (this.#e2eDisable) return Promise.resolve(false)
    // Dedup is set up *synchronously* — earlier this lived after
    // `await this.isHealthy()`, so a second call landing during the very
    // first awaited microtask saw `#ensurePromise === null` and started its
    // own racing ensure. A more visible symptom: `restart()` running
    // immediately after `ensureRunning()` would miss the in-flight gate and
    // incorrectly bail with `skipped:'not-managed'`. Wrapping the async
    // body and assigning #ensurePromise before returning closes that gap.
    if (this.#ensurePromise) return this.#ensurePromise

    this.#ensurePromise = this.#ensureBody({ force, skipHealthCheck }).finally(() => {
      this.#ensurePromise = null
    })
    return this.#ensurePromise
  }

  async #ensureBody({ force, skipHealthCheck }) {
    // restart() passes skipHealthCheck=true because a child we just killed
    // can still answer /health for a few milliseconds while its socket
    // lingers — without this skip, restart would return ok:true without
    // spawning a replacement. Codex MUST-FIX.
    if (!skipHealthCheck && await this.isHealthy()) {
      // 이미 살아 있다 = 우리가 띄운 것이거나, 이전 실행이 남긴 고아다.
      // 후자를 여기서 되찾아야 restart()가 'not-managed'로 빠지지 않는다.
      this.#tryAdoptExisting()
      return true
    }
    return this.#runEnsure({ force })
  }

  async #runEnsure({ force }) {
    await this.pickAvailableUrl()

    if (!this.isLocalUrl()) {
      this.#log.warn('[BACKEND_START_SKIP] remote backend URL configured; local auto-start disabled')
      return false
    }

    const withinCooldown = Date.now() - this.#lastLaunchAt < this.#cooldownMs
    if (!force && withinCooldown) return false

    this.#lastLaunchAt = Date.now()

    const candidates = this.#getLaunchCandidates()
    if (candidates.length === 0) {
      this.#log.warn('[BACKEND_START_SKIP] no launch candidates were found')
      return false
    }

    for (const candidate of candidates) {
      const started = await this.#trySpawnCandidate(candidate)
      if (started) return true
    }

    return false
  }

  async ensureAvailableForRequest() {
    if (this.#e2eDisable) return false
    if (await this.isHealthy(800)) return true
    return this.ensureRunning()
  }

  // Stop the current child and force a fresh spawn. The naive call site
  // pattern `stop(); ensureRunning({force:true})` is wrong: ensureRunning
  // returns the existing in-flight `#ensurePromise` if one exists, so a
  // restart could end up awaiting the *original* non-forced start instead
  // of a fresh spawn. Wait for that to settle here, then run a clean
  // stop+ensure inside a brand-new dedup promise. Codex MUST-FIX.
  async restart() {
    if (this.#e2eDisable) return { ok: false, skipped: 'e2e' }

    // Await any in-flight ensureRunning first — it may itself be the call
    // that flips startedByApp true. Checking startedByApp before awaiting
    // would race the very first spawn and incorrectly report not-managed.
    let inFlightFailed = false
    if (this.#ensurePromise) {
      try {
        const inFlightStarted = await this.#ensurePromise
        inFlightFailed = !inFlightStarted
      } catch {
        inFlightFailed = true
      }
    }

    // pidfile이 뒤늦게 나타났을 수도 있으니(부팅 직후 백엔드가 먼저 뜬 경우 등)
    // 포기 직전에 한 번 더 채택을 시도한다.
    if (!this.#startedByApp) this.#tryAdoptExisting()

    if (!this.#startedByApp) {
      // Distinguish "we never managed this backend" from "we tried but the
      // last spawn failed". Codex NICE-TO-HAVE: the renderer can show a
      // backend-startup error toast instead of mislabeling a local failure
      // as an external backend.
      return inFlightFailed
        ? { ok: false, skipped: 'failed-start' }
        : { ok: false, skipped: 'not-managed' }
    }

    this.stop()
    // Reset the cooldown clock so the upcoming spawn is never blocked by a
    // recent failed attempt; force=true would also skip the cooldown, but
    // making it explicit means a future caller can't accidentally remove
    // the force flag and silently regress to "cooldown swallows the
    // restart".
    this.#lastLaunchAt = 0

    // skipHealthCheck: a process we just SIGTERM/taskkill'd can still
    // briefly respond to /health while its socket lingers, which would
    // cause ensureRunning's preflight to return true *without* spawning a
    // replacement. Codex MUST-FIX.
    const started = await this.ensureRunning({ force: true, skipHealthCheck: true })
    return { ok: Boolean(started), started: Boolean(started) }
  }

  stop() {
    const child = this.#process
    // 채택한 백엔드는 자식 핸들이 없다 — pid만으로 죽일 수 있어야 한다.
    const ownedPid = this.#ownedPid
    const ownedRecord = this.#ownedRecord

    if (!child && !ownedPid) return

    this.#process = null
    this.#ownedPid = null
    this.#ownedRecord = null
    this.#startedByApp = false

    if (!child) {
      this.#stopAdopted(ownedPid, ownedRecord)
      return
    }

    try {
      // Windows tree-kill is REQUIRED for packaged PyInstaller backends —
      // child.kill() can let the launched ApiaBackend.exe survive and lock
      // the file for the next build. See REGRESSION_NOTES "Windows packaged
      // backend shutdown must kill the whole process tree".
      if (this.#platform === 'win32') {
        if (child.pid) {
          this.#spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          })
        } else {
          // Unexpected on Windows: we owned the process but it had no PID.
          // taskkill needs one, so fall back to child.kill('SIGTERM') as a
          // best-effort. Windows SIGTERM is unreliable but it's better than
          // silently dropping the stop request — and the warn makes the
          // missed taskkill path observable in runtime logs.
          this.#log.warn('[BACKEND_STOP_NO_PID]', {
            platform: 'win32',
            pid: null,
            startedByApp: false  // already cleared above; recorded as the post-stop state
          })
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
    } catch (error) {
      this.#log.warn('[BACKEND_STOP_WARN]', error)
    }
    this.#deletePidFile()
  }

  // 핸들 없이 pid만 있는 경우(채택한 백엔드)의 종료 경로. 자식 핸들이 있을 때와
  // 같은 이유로 Windows는 트리 킬이 필수다(패키지 백엔드가 손자 프로세스를 남긴다).
  //
  // 채택한 백엔드에는 exit 리스너가 없다 — 채택과 stop 사이에 그 프로세스가
  // 조용히 죽고 OS가 pid를 남에게 물려줬을 수 있다. 죽이기 직전에 신원을 다시
  // 확인한다. 어긋나면 안 죽이고 기록만 정리한다(남의 프로세스를 죽이는 것이
  // 백엔드 하나 못 죽이는 것보다 훨씬 나쁜 실패다).
  #stopAdopted(pid, record) {
    if (!pid) return
    if (record && this.#pidIdentity(record) !== 'ok') {
      this.#log.warn('[BACKEND_STOP_STALE_PID]', { pid })
      this.#deletePidFile()
      return
    }
    try {
      if (this.#platform === 'win32') {
        this.#spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } else {
        this.#spawnSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' })
      }
      this.#log.info('[BACKEND_ADOPTED_STOP]', { pid })
    } catch (error) {
      this.#log.warn('[BACKEND_STOP_WARN]', error)
    }
    this.#deletePidFile()
  }
}

module.exports = { BackendLifecycle }
