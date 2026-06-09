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

  #process = null
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
      if (this.#process === child) {
        this.#process = null
        this.#startedByApp = false
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
    if (!skipHealthCheck && await this.isHealthy()) return true
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
    if (!child) return

    this.#process = null
    this.#startedByApp = false

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
  }
}

module.exports = { BackendLifecycle }
