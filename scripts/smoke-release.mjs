import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'

const rootDir = process.cwd()
const isWindows = process.platform === 'win32'
const releaseDir = resolve(rootDir, isWindows ? 'release/win-unpacked' : 'release/linux-unpacked')
const releaseExePath = resolve(releaseDir, isWindows ? 'Apia.exe' : 'apia')
const appDataDir = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const runtimeRoot = join(appDataDir, 'apia')
const runtimeLogPath = join(runtimeRoot, 'logs', 'main.log')
const backendEnvExamplePath = join(runtimeRoot, 'backend-data', 'backend.env.example')
const successMarkers = ['[APP_READY]', '[WINDOW_LOAD_FINISH] main', '[BACKEND_READY]']
// Always-fatal runtime markers — any of these means the packaged app is broken
// regardless of anything else, so we bail the moment one appears.
const failureMarkers = [
  '[BACKEND_READY_TIMEOUT]',
  '[BACKEND_SPAWN_ERROR]',
  '[UNCAUGHT_EXCEPTION]',
  '[UNHANDLED_REJECTION]',
]

// ── Wallpaper attach (Phase F1) ─────────────────────────────────────────────
// Packaged-build-only path. wallpaperMode.js tries two strategies in order:
//   1. native module (electron-as-wallpaper) → [WALLPAPER_ATTACH_OK], or
//      [WALLPAPER_ATTACH_FAIL] (e.g. "couldn't locate WorkerW") / the binding
//      failing to load → [WALLPAPER_NATIVE_UNAVAILABLE], then it falls through.
//   2. Progman-child fallback (async helper) → [WALLPAPER_PROGMAN_CHILD_OK] /
//      [WALLPAPER_PROGMAN_CHILD_FAIL].
// Win11 builds like 26200 have no WorkerW, so strategy 1 *always* fails there
// and strategy 2 is the supported path — blocking on [WALLPAPER_ATTACH_FAIL]
// would fail every release on those machines. The real question is whether the
// window ended up attached by *some* strategy, so we judge the final outcome,
// not any single marker.
const WALLPAPER_OK_MARKERS = ['[WALLPAPER_ATTACH_OK]', '[WALLPAPER_PROGMAN_CHILD_OK]']
const WALLPAPER_FALLBACK_FAILED = '[WALLPAPER_PROGMAN_CHILD_FAIL]'
const WALLPAPER_NATIVE_MISSING = '[WALLPAPER_NATIVE_UNAVAILABLE]'
// Any marker proving the wallpaper attach path actually ran. If none of these
// show up at all, wallpaper mode was silently skipped — itself a regression.
const WALLPAPER_ATTEMPT_MARKERS = [
  ...WALLPAPER_OK_MARKERS,
  '[WALLPAPER_ATTACH_FAIL]',
  WALLPAPER_NATIVE_MISSING,
  WALLPAPER_FALLBACK_FAILED,
]
// The Progman-child fallback is async (spawns a helper), so its terminal marker
// can lag the core startup markers. Give it this long to settle before deciding.
const WALLPAPER_GRACE_MS = 4000

// Returns { state: 'ok' | 'fail' | 'pending', attempted?, reason? }.
function assessWallpaper(logText) {
  if (WALLPAPER_OK_MARKERS.some((marker) => logText.includes(marker))) {
    return { state: 'ok' }
  }
  // Last-resort fallback explicitly failed and nothing succeeded → mode is dead.
  if (logText.includes(WALLPAPER_FALLBACK_FAILED)) {
    return {
      state: 'fail',
      reason: 'native attach unavailable/failed and Progman-child fallback also failed'
    }
  }
  // No success and no terminal failure yet — the async fallback may still be in
  // flight. `attempted` tells the caller whether the path even ran.
  return {
    state: 'pending',
    attempted: WALLPAPER_ATTEMPT_MARKERS.some((marker) => logText.includes(marker))
  }
}

async function assertExists(targetPath, errorCode) {
  try {
    await access(targetPath)
  } catch {
    throw new Error(`[${errorCode}] ${targetPath}`)
  }
}

function createSpawnEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function waitForProcessExit(child, timeoutMs = 10000) {
  if (!child?.pid) return
  if (child.exitCode !== null || child.killed) return

  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

async function stopProcessTree(child) {
  if (!child?.pid) return

  if (isWindows) {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('exit', () => resolvePromise())
      killer.once('error', () => resolvePromise())
    })
    await waitForProcessExit(child)
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // Best effort cleanup.
  }
  await waitForProcessExit(child)
}

async function waitForSmokeSuccess(child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let coreReadyAt = null

  while (Date.now() < deadline) {
    let logText
    try {
      logText = await readFile(runtimeLogPath, 'utf8')
    } catch {
      // Log file may not exist yet; just wait for the next tick. Don't fold
      // this into the same try/catch as the failure-marker check below,
      // because that catch used to swallow our intentional throw and turn
      // a clean runtime failure into a slow timeout.
      logText = null
    }

    if (logText !== null) {
      const hasFailure = failureMarkers.find((marker) => logText.includes(marker))
      if (hasFailure) {
        throw new Error(`[SMOKE_RELEASE_RUNTIME_FAILURE] ${hasFailure}\n${logText}`)
      }

      const hasMarkers = successMarkers.every((marker) => logText.includes(marker))
      const hasEnvExample = await access(backendEnvExamplePath).then(() => true).catch(() => false)

      if (hasMarkers && hasEnvExample) {
        if (coreReadyAt === null) coreReadyAt = Date.now()

        const wallpaper = assessWallpaper(logText)
        if (wallpaper.state === 'fail') {
          throw new Error(`[SMOKE_RELEASE_WALLPAPER_FAILURE] ${wallpaper.reason}\n${logText}`)
        }
        if (wallpaper.state === 'ok') {
          if (logText.includes(WALLPAPER_NATIVE_MISSING)) {
            console.warn(
              `[SMOKE_RELEASE_WARN] ${WALLPAPER_NATIVE_MISSING}: native wallpaper binding did not load, ` +
              'but a fallback attach succeeded. Check asarUnpack if the native module is expected to ship.'
            )
          }
          return logText
        }

        // Wallpaper outcome still pending. The async fallback can lag the core
        // markers, so wait out a short grace window. Only pass on grace/deadline
        // if the attach path actually ran — a total absence of wallpaper markers
        // means the mode was skipped, which is a regression we must not wave through.
        const graceExpired = Date.now() - coreReadyAt >= WALLPAPER_GRACE_MS
        const deadlineNear = Date.now() + 1000 >= deadline
        if (graceExpired || deadlineNear) {
          if (wallpaper.attempted) {
            console.warn(
              '[SMOKE_RELEASE_WARN] wallpaper attach ran but its final fallback result did not resolve ' +
              'within the grace window; passing on core startup + behavior probes.'
            )
            return logText
          }
          throw new Error(
            `[SMOKE_RELEASE_WALLPAPER_ABSENT] no wallpaper attach markers observed; ` +
            `wallpaper mode appears to have been skipped\n${logText}`
          )
        }
      }
    }

    if (child.exitCode !== null) {
      let logTail = ''
      try {
        logTail = await readFile(runtimeLogPath, 'utf8')
      } catch {
        // Keep the default empty tail.
      }

      throw new Error(
        `[SMOKE_RELEASE_EARLY_EXIT] Packaged app exited with code ${child.exitCode}\n${logTail}`
      )
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }

  let logTail = ''
  try {
    logTail = await readFile(runtimeLogPath, 'utf8')
  } catch {
    // Keep the default empty tail.
  }

  throw new Error(
    `[SMOKE_RELEASE_TIMEOUT] Did not observe startup markers in ${runtimeLogPath}\n${logTail}`
  )
}

// ── Behavior probes ─────────────────────────────────────────────────────
//
// The marker scrape proves the packaged app *started*. These probes prove the
// packaged backend actually responds with the contract shapes the UI relies
// on. Source-Python contract tests under backend/tests/ exercise the same
// shapes against the running source code, but smoke catches a different
// failure mode — PyInstaller bundle drift (excluded module, wrong python
// version, missing data file) that the source tests cannot see.
//
// Probes are shape-only on purpose. `/warmup` GET will return empty
// `available_modes` when no provider has credentials in the packaged smoke
// environment; that's still a valid contract.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function extractBackendUrl(logText) {
  // Latest BACKEND_READY wins — earlier ones could be from a previous port
  // collision retry. Log format: `[BACKEND_READY] <label> {"url":"http://..."}`
  const matches = [...logText.matchAll(/\[BACKEND_READY\][^\n]*\{[^}]*"url":"([^"]+)"/g)]
  if (matches.length === 0) return null
  return matches[matches.length - 1][1]
}

function isLocalhostUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function httpGetJson(baseUrl, pathSegment, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(pathSegment, baseUrl)
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        resolvePromise({ status: response.statusCode || 0, body })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    request.on('error', (error) => {
      rejectPromise(error)
    })
  })
}

function httpPostBinary(baseUrl, pathSegment, payload, timeoutMs = 30000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(pathSegment, baseUrl)
    const body = JSON.stringify(payload)
    const request = http.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolvePromise({
          status: response.statusCode || 0,
          contentType: response.headers['content-type'] || '',
          buffer: Buffer.concat(chunks),
          get body() { return this.buffer.toString('utf-8') }
        })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    request.on('error', (error) => {
      rejectPromise(error)
    })
    request.end(body)
  })
}

// I단계 — /tts는 GET+JSON 계약이 아니라 POST+바이너리라 별도 프로브.
// /health·/voices만으로는 edge-tts(aiohttp 등) hidden-import 누락 같은
// PyInstaller 번들 드리프트를 못 잡는다. 합성 엔진은 환경에 따라
// edge(mp3)/pyttsx3(wav)/silent(wav) 어느 쪽이든 유효 — 계약은
// "200 + audio/* + 비어있지 않은 본문"이다.
async function probeTts(backendUrl) {
  let response
  try {
    response = await httpPostBinary(backendUrl, '/tts', { text: '스모크 테스트', voice_id: null })
  } catch (error) {
    return { ok: false, failure: describeProbeFailure('/tts', error, null) }
  }
  if (response.status !== 200) {
    return { ok: false, failure: describeProbeFailure('/tts', null, response) }
  }
  if (!response.contentType.startsWith('audio/')) {
    return { ok: false, failure: `/tts: content-type "${response.contentType}" is not audio/*` }
  }
  if (response.buffer.length < 44) {
    return { ok: false, failure: `/tts: body too small (${response.buffer.length} bytes)` }
  }
  return { ok: true }
}

function describeProbeFailure(name, error, response) {
  if (response) {
    const snippet = (response.body || '').slice(0, 200).replace(/\s+/g, ' ')
    return `${name}: status=${response.status} body="${snippet}"`
  }
  return `${name}: ${error?.message || String(error)}`
}

async function probeEndpoint(baseUrl, pathSegment, validate) {
  let response
  try {
    response = await httpGetJson(baseUrl, pathSegment)
  } catch (error) {
    return { ok: false, failure: describeProbeFailure(pathSegment, error, null) }
  }

  if (response.status !== 200) {
    return { ok: false, failure: describeProbeFailure(pathSegment, null, response) }
  }

  let parsed
  try {
    parsed = JSON.parse(response.body)
  } catch (error) {
    return { ok: false, failure: describeProbeFailure(pathSegment, error, response) }
  }

  const validationError = validate(parsed)
  if (validationError) {
    return { ok: false, failure: `${pathSegment}: ${validationError}` }
  }
  return { ok: true }
}

async function runBehaviorProbes(logText) {
  const backendUrl = extractBackendUrl(logText)
  if (!backendUrl) {
    throw new Error('[SMOKE_RELEASE_BEHAVIOR_FAIL] could not extract backend URL from [BACKEND_READY] in main.log')
  }
  if (!isLocalhostUrl(backendUrl)) {
    throw new Error(`[SMOKE_RELEASE_BEHAVIOR_FAIL] backend URL is not a local http endpoint: ${backendUrl}`)
  }

  const probes = [
    {
      path: '/health',
      validate: (data) => {
        if (data?.status !== 'ok') return `expected {status:"ok"}, got ${JSON.stringify(data)}`
        return null
      }
    },
    {
      path: '/voices',
      validate: (data) => {
        if (!Array.isArray(data?.voices)) return 'missing voices: []'
        if (!Array.isArray(data?.unsupported_custom_voices)) return 'missing unsupported_custom_voices: []'
        return null
      }
    },
    {
      path: '/warmup',
      validate: (data) => {
        // Shape only. available_modes can legitimately be [] in a smoke env
        // with no credentials; that's still a valid contract response.
        const required = ['initialized_modes', 'available_modes', 'mode', 'default_mode', 'warming']
        for (const key of required) {
          if (!(key in data)) return `missing key "${key}"`
        }
        if (!Array.isArray(data.initialized_modes)) return 'initialized_modes is not an array'
        if (!Array.isArray(data.available_modes)) return 'available_modes is not an array'
        if (typeof data.warming !== 'boolean') return 'warming is not a boolean'
        return null
      }
    },
    // Step 2-4 store/* surface. Every endpoint must return 200 with a shape
    // the renderer can read even when the underlying feature is disabled
    // (web provider 미설정 등). Codex MUST-FIX (frontend integration round 1):
    // web's `enabled:false` is the normal state in a fresh packaged install.
    {
      path: '/store/embedding/status',
      validate: (data) => {
        if (typeof data?.model_name !== 'string') return 'missing model_name'
        if (typeof data?.loaded !== 'boolean') return 'loaded is not a boolean'
        if (typeof data?.dim !== 'number') return 'dim is not a number'
        return null
      }
    },
    {
      path: '/store/memory/stats',
      validate: (data) => {
        if (typeof data?.enabled !== 'boolean') return 'enabled is not a boolean'
        if (typeof data?.turn_count !== 'number') return 'turn_count is not a number'
        if (typeof data?.summary_count !== 'number') return 'summary_count is not a number'
        return null
      }
    },
    {
      path: '/store/files/stats',
      validate: (data) => {
        if (typeof data?.enabled !== 'boolean') return 'enabled is not a boolean'
        if (typeof data?.folder_count !== 'number') return 'folder_count is not a number'
        return null
      }
    },
    {
      path: '/store/web/stats',
      validate: (data) => {
        if (typeof data?.enabled !== 'boolean') return 'enabled is not a boolean'
        if (typeof data?.provider !== 'string') return 'provider is not a string'
        return null
      }
    }
  ]

  const failures = []
  for (const probe of probes) {
    // Sequential — when one fails, the others' output is much easier to read
    // when grouped, and we'd rather not flood the backend with parallel
    // requests when the bundle is broken in some unrelated way.
    const result = await probeEndpoint(backendUrl, probe.path, probe.validate)
    if (!result.ok) failures.push(result.failure)
  }

  const ttsResult = await probeTts(backendUrl)
  if (!ttsResult.ok) failures.push(ttsResult.failure)

  if (failures.length > 0) {
    throw new Error(`[SMOKE_RELEASE_BEHAVIOR_FAIL] backend=${backendUrl}\n  - ${failures.join('\n  - ')}`)
  }

  return backendUrl
}

async function main() {
  await assertExists(releaseExePath, 'SMOKE_RELEASE_EXE_MISSING')
  await mkdir(resolve(runtimeRoot, 'logs'), { recursive: true })
  await mkdir(resolve(runtimeRoot, 'backend-data'), { recursive: true })
  await rm(runtimeLogPath, { force: true })

  const child = spawn(releaseExePath, [], {
    cwd: releaseDir,
    env: createSpawnEnv(),
    windowsHide: true,
    stdio: 'ignore'
  })

  let probedBackendUrl = null

  try {
    const logText = await waitForSmokeSuccess(child)
    probedBackendUrl = await runBehaviorProbes(logText)
  } finally {
    await stopProcessTree(child)
  }

  console.log(`[SMOKE_RELEASE_OK] packaged app booted; behavior probes passed (backend=${probedBackendUrl})`)
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error))
  process.exit(1)
})
