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
// Step 4 — wallpaper attach (Phase F1) is a packaged-build-only path:
// require('electron-as-wallpaper') resolves a native .node binding that
// is unpacked from .asar via asarUnpack. If asarUnpack drops or the
// binary doesn't ship, wallpaperMode.js logs [WALLPAPER_ATTACH_FAIL] or
// [WALLPAPER_UNAVAILABLE]. Either is a release-blocking regression that
// no source-tree test catches, so we sniff them here.
const failureMarkers = [
  '[BACKEND_READY_TIMEOUT]',
  '[BACKEND_SPAWN_ERROR]',
  '[UNCAUGHT_EXCEPTION]',
  '[UNHANDLED_REJECTION]',
  '[WALLPAPER_ATTACH_FAIL]',
  '[WALLPAPER_UNAVAILABLE]',
]

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

async function waitForSmokeSuccess(child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs

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
        return logText
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
