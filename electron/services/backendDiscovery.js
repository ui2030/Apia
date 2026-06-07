/**
 * State-free backend discovery helpers extracted from electron/main.js.
 *
 * Everything here takes its inputs explicitly (no Electron `app`, no module-
 * level mutable state). The caller owns lifecycle state (the actual chosen
 * URL, the spawned process, the start-cooldown timestamp). This module just
 * computes "given these inputs, what should we try?".
 *
 * Why this boundary: the previous monolithic main.js mixed pure URL/port
 * discovery with stateful spawning. Pulling the pure half out makes both
 * sides individually testable and keeps the next round of splits (the
 * stateful half) clearly scoped.
 *
 * What deliberately STAYS in main.js (don't move):
 *   - runtimeBackendUrl + get/setBackendUrl (caller-owned mutable state)
 *   - isBackendHealthy (uses caller's current URL)
 *   - ensureBackendRunning / trySpawnBackendCandidate / stopBackendProcess
 *     (manage backendProcess + child stdio piping)
 *   - shouldForceAutoAiMode (settings policy, not discovery)
 *   - ensureBackendRuntimeFiles + BACKEND_ENV_EXAMPLE_* (file side-effect,
 *     separate concern from discovery)
 */
const fs = require('fs')
const net = require('net')
const path = require('path')

const DEFAULT_BACKEND_HOST = '127.0.0.1'
const DEFAULT_BACKEND_PORT = '8000'
const DEFAULT_BACKEND_URL = `http://${DEFAULT_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Node's `URL` returns IPv6 hostnames wrapped in brackets — `new
 * URL('http://[::1]:8000').hostname === '[::1]'`. That broke
 * `LOCAL_HOSTS.has(...)` checks for IPv6 loopback and would also send the
 * literal `[::1]` into `net.createServer().listen(...)` (rejected) and into
 * the backend's `APIA_BACKEND_HOST` env var. Strip the brackets at the
 * application boundary so the URL object stays standard while comparison
 * + binding code sees the canonical `::1`.
 */
function normalizeBackendHostname(hostname) {
  if (typeof hostname !== 'string') return hostname
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function parseBackendUrl(rawUrl, { onInvalid } = {}) {
  try {
    return new URL(rawUrl)
  } catch (error) {
    onInvalid?.({ rawUrl, error })
    return new URL(DEFAULT_BACKEND_URL)
  }
}

function isLocalBackendUrl(rawUrl) {
  const url = parseBackendUrl(rawUrl)
  return LOCAL_HOSTS.has(normalizeBackendHostname(url.hostname))
}

function getBackendSpawnConfig(rawUrl, userDataPath) {
  const url = parseBackendUrl(rawUrl)
  // host is fed straight into the backend's APIA_BACKEND_HOST env var, so
  // the bracketed `[::1]` form would be rejected by uvicorn's bind. Strip.
  const host = normalizeBackendHostname(url.hostname) || DEFAULT_BACKEND_HOST
  const port = url.port || DEFAULT_BACKEND_PORT
  const dataDir = path.join(userDataPath, 'backend-data')

  return { host, port, dataDir }
}

function isPortAvailable(host, port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer()

    server.once('error', () => {
      resolvePromise(false)
    })

    server.once('listening', () => {
      server.close(() => resolvePromise(true))
    })

    server.listen(Number(port), host)
  })
}

/**
 * Picks a usable local backend URL. Returns a description of what was found —
 * the caller is responsible for committing the result (setBackendUrl) and
 * logging the conflict. Earlier this mutated module-level state via a setter
 * callback, which made the function awkward to test and hid the conflict
 * signal from the caller.
 *
 * Returns: { url, configuredPort, selectedPort, conflicted, external }
 *   - external: configured URL was either explicitly set by env or non-local;
 *     no port probing happens, caller should just use it as-is.
 *   - conflicted: configured port was occupied and we picked a different one.
 *   - selectedPort === configuredPort and !conflicted: original port was free.
 */
// Single helper so every return branch of pickAvailableBackendUrl produces a
// canonicalized URL string. URL.toString() always appends a trailing slash
// for hostname-only URLs (`http://x:8000` → `http://x:8000/`), which is
// canonical per spec but inconvenient for the caller storing it as a base.
// Centralizing the trim here means a new return branch can't drift.
function canonicalUrl(url) {
  return trimTrailingSlashes(url.toString())
}

async function pickAvailableBackendUrl({
  configuredBackendUrl,
  hasExplicitBackendUrl,
  // Injectable so tests can use a deterministic probe. Defaults to the
  // real net-based one above.
  isPortAvailable: probe = isPortAvailable
}) {
  const configuredUrl = parseBackendUrl(configuredBackendUrl)
  const configuredPort = Number(configuredUrl.port || DEFAULT_BACKEND_PORT)
  // Canonical host for both locality comparison AND the listen() probe.
  // `net.createServer().listen(...)` does not accept the bracketed
  // `[::1]` form that `URL.hostname` returns for IPv6.
  const probeHost = normalizeBackendHostname(configuredUrl.hostname)

  if (hasExplicitBackendUrl || !LOCAL_HOSTS.has(probeHost)) {
    return {
      url: canonicalUrl(configuredUrl),
      configuredPort,
      selectedPort: configuredPort,
      conflicted: false,
      external: true
    }
  }

  if (await probe(probeHost, configuredPort)) {
    return {
      url: canonicalUrl(configuredUrl),
      configuredPort,
      selectedPort: configuredPort,
      conflicted: false,
      external: false
    }
  }

  // PROBE_SPAN intentionally bounded to 25 so a runaway loop on a host with
  // 8000-8024 all occupied bails fast instead of stalling startup.
  const PROBE_SPAN = 25
  for (let port = configuredPort + 1; port < configuredPort + PROBE_SPAN; port += 1) {
    if (await probe(probeHost, port)) {
      configuredUrl.port = String(port)
      return {
        url: canonicalUrl(configuredUrl),
        configuredPort,
        selectedPort: port,
        conflicted: true,
        external: false
      }
    }
  }

  // All probed ports busy. Return the configured URL anyway so the caller
  // still has something to attempt; spawn will fail loudly with a real error.
  return {
    url: canonicalUrl(configuredUrl),
    configuredPort,
    selectedPort: configuredPort,
    conflicted: false,
    external: false
  }
}

function getPackagedBackendExecutableCandidates(resourcesPath) {
  if (process.platform === 'win32') {
    return [
      path.join(resourcesPath, 'backend', 'ApiaBackend.exe'),
      path.join(resourcesPath, 'backend', 'backend.exe')
    ]
  }

  return [
    path.join(resourcesPath, 'backend', 'apia-backend'),
    path.join(resourcesPath, 'backend', 'backend')
  ]
}

function appendPythonLaunchCandidates(candidates, backendDir, backendMain, sourceLabel, fileExists) {
  if (!fileExists(backendMain)) {
    return
  }

  if (process.platform === 'win32') {
    candidates.push({ label: `py:${sourceLabel}`, command: 'py', args: ['-3', 'main.py'], cwd: backendDir })
    candidates.push({ label: `python:${sourceLabel}`, command: 'python', args: ['main.py'], cwd: backendDir })
    return
  }

  candidates.push({ label: `python3:${sourceLabel}`, command: 'python3', args: ['main.py'], cwd: backendDir })
  candidates.push({ label: `python:${sourceLabel}`, command: 'python', args: ['main.py'], cwd: backendDir })
}

/**
 * Build the ordered list of backend launch attempts.
 *
 * `isLocal` is taken as an explicit parameter (was previously read implicitly
 * from `isLocalBackendUrl()` calling the module's mutable state). Caller now
 * passes a boolean so the function has no hidden inputs.
 *
 * `fileExists` is injectable so tests can probe a synthetic filesystem
 * without leaning on real `fs.existsSync` (which would need a fixture
 * tree mirroring `backend/main.py` and packaged exe paths to be meaningful).
 */
function getBackendLaunchCandidates({
  isLocal,
  workspaceRoot,
  resourcesPath,
  fileExists = fs.existsSync
}) {
  if (!isLocal) {
    return []
  }

  const candidates = []
  const backendDir = path.join(workspaceRoot, 'backend')
  const backendMain = path.join(backendDir, 'main.py')
  const packagedBackendDir = path.join(resourcesPath, 'backend')
  const packagedBackendMain = path.join(packagedBackendDir, 'main.py')

  const packagedExeCandidates = getPackagedBackendExecutableCandidates(resourcesPath)

  for (const executable of packagedExeCandidates) {
    if (fileExists(executable)) {
      candidates.unshift({
        label: path.basename(executable),
        command: executable,
        args: [],
        cwd: path.dirname(executable)
      })
    }
  }

  appendPythonLaunchCandidates(candidates, packagedBackendDir, packagedBackendMain, 'packaged', fileExists)
  appendPythonLaunchCandidates(candidates, backendDir, backendMain, 'workspace', fileExists)

  return candidates
}

module.exports = {
  DEFAULT_BACKEND_HOST,
  DEFAULT_BACKEND_PORT,
  DEFAULT_BACKEND_URL,
  trimTrailingSlashes,
  normalizeBackendHostname,
  parseBackendUrl,
  isLocalBackendUrl,
  getBackendSpawnConfig,
  isPortAvailable,
  pickAvailableBackendUrl,
  getPackagedBackendExecutableCandidates,
  getBackendLaunchCandidates
}
