/**
 * Unit tests for electron/services/backendLifecycle.js.
 *
 * The class takes platform/env/spawn/spawnSync/http/https as constructor
 * deps specifically so these tests can run without a real backend, real
 * sockets, or a real Electron app. Each test builds a fresh instance with
 * just-enough fakes for the surface it's exercising.
 *
 * Design notes (Codex review pinned these down):
 *   - Cannot assert "same Promise object" for in-flight dedup — `async`
 *     methods wrap their returns, so identity comparison always fails.
 *     Assert by *effect*: spawn was called exactly once.
 *   - Spawn-path tests need first health probe to return false; otherwise
 *     ensureRunning short-circuits before any spawn happens.
 *   - Cooldown tests need the first ensure to *finish* before the second
 *     call exercises cooldown (a rapid second call is the dedup path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Discovery helpers are injected via the constructor's `discovery` option,
// so no module-level mocking is needed. Tests build a fresh discovery bag
// per case via `createBaseDeps`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BackendLifecycle } = require('../electron/services/backendLifecycle')

// ── Fakes ────────────────────────────────────────────────────────────────

function createFakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    childOutput: vi.fn()
  }
}

function createFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

/**
 * Builds a fake `http`/`https` pair where each `request()` call uses the
 * next entry from `responses`. An entry can be:
 *   - { status: 200 } → fire 'response' with that status, then 'end'
 *   - { error: Error } → fire 'error' on the request
 *   - { timeout: true } → fire 'timeout' on the request
 * The request also exposes `.end()`, `.on()`, and `.destroy()` like the
 * real one.
 */
function createFakeHttp(responses) {
  const queue = [...responses]
  const requestImpl = (_url, _opts, cb) => {
    const request = new EventEmitter()
    request.destroy = vi.fn()
    const plan = queue.shift() || { error: new Error('no more planned responses') }

    // The response only fires after `request.end()` is called. Earlier the
    // fake fired unconditionally via setImmediate, so a production regression
    // that forgot to call end() would still see the test pass. Hanging it
    // off end() makes the test actually depend on production calling end().
    let ended = false
    request.end = vi.fn(() => {
      if (ended) return
      ended = true
      setImmediate(() => {
        if (plan.timeout) {
          request.emit('timeout')
          return
        }
        if (plan.error) {
          request.emit('error', plan.error)
          return
        }
        const response = new EventEmitter()
        response.statusCode = plan.status
        response.resume = vi.fn()
        cb?.(response)
        response.emit('end')
      })
    })

    return request
  }
  return {
    http: { request: requestImpl },
    https: { request: requestImpl },
    queue,
  }
}

function createDefaultDiscovery() {
  return {
    pickAvailableBackendUrl: vi.fn(async () => ({
      url: 'http://127.0.0.1:8000',
      configuredPort: 8000,
      selectedPort: 8000,
      conflicted: false,
      external: false
    })),
    getBackendLaunchCandidates: vi.fn(() => [
      { label: 'py:test', command: 'python3', args: ['main.py'], cwd: '/tmp/backend' }
    ])
  }
}

function createBaseDeps(overrides = {}) {
  const log = createFakeLog()
  const spawn = vi.fn()
  const spawnSync = vi.fn()
  return {
    configuredUrl: 'http://127.0.0.1:8000/',
    hasExplicitUrl: false,
    isDev: false,
    userDataPath: '/tmp/userData',
    resourcesPath: '/tmp/resources',
    workspaceRoot: '/tmp/workspace',
    log,
    cooldownMs: 15000,
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    spawn,
    spawnSync,
    http: { request: vi.fn() },
    https: { request: vi.fn() },
    discovery: createDefaultDiscovery(),
    ...overrides
  }
}

// ── URL state ────────────────────────────────────────────────────────────

describe('URL state', () => {
  it('trims trailing slashes from the initial configured URL', () => {
    const backend = new BackendLifecycle(createBaseDeps({ configuredUrl: 'http://127.0.0.1:8000///' }))
    expect(backend.getUrl()).toBe('http://127.0.0.1:8000')
  })

  it('falls back to default URL when configuredUrl is empty', () => {
    const backend = new BackendLifecycle(createBaseDeps({ configuredUrl: '' }))
    expect(backend.getUrl()).toBe('http://127.0.0.1:8000')
  })

  it('setUrl trims and logs [BACKEND_URL_SET]', () => {
    const deps = createBaseDeps()
    const backend = new BackendLifecycle(deps)
    backend.setUrl('http://10.0.0.1:9000///')
    expect(backend.getUrl()).toBe('http://10.0.0.1:9000')
    expect(deps.log.info).toHaveBeenCalledWith('[BACKEND_URL_SET]', { url: 'http://10.0.0.1:9000' })
  })

  it('parseUrl returns a URL object for valid input', () => {
    const backend = new BackendLifecycle(createBaseDeps())
    expect(backend.parseUrl('http://example.com:1234').hostname).toBe('example.com')
  })

  it('parseUrl warns and returns default URL on garbage input', () => {
    const deps = createBaseDeps()
    const backend = new BackendLifecycle(deps)
    const parsed = backend.parseUrl('not a url at all')
    expect(parsed.hostname).toBe('127.0.0.1')
    expect(deps.log.warn).toHaveBeenCalledWith('[BACKEND_URL_INVALID]', expect.objectContaining({ rawUrl: 'not a url at all' }))
  })

  it('isLocalUrl is true for loopback hostnames', () => {
    const backend = new BackendLifecycle(createBaseDeps())
    expect(backend.isLocalUrl('http://127.0.0.1:8000')).toBe(true)
    expect(backend.isLocalUrl('http://localhost:8000')).toBe(true)
  })

  it('isLocalUrl is false for arbitrary hostnames', () => {
    const backend = new BackendLifecycle(createBaseDeps())
    expect(backend.isLocalUrl('http://api.example.com:8000')).toBe(false)
    expect(backend.isLocalUrl('http://10.0.0.1:8000')).toBe(false)
  })

  it('getSpawnConfig derives host/port/dataDir from URL + userDataPath', () => {
    const backend = new BackendLifecycle(createBaseDeps({
      configuredUrl: 'http://127.0.0.1:9001',
      userDataPath: '/var/userData'
    }))
    const config = backend.getSpawnConfig()
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe('9001')
    expect(config.dataDir).toContain('backend-data')
  })
})

// ── Health probe ─────────────────────────────────────────────────────────

describe('isHealthy', () => {
  it('resolves true on 2xx response', async () => {
    const { http, https } = createFakeHttp([{ status: 200 }])
    const backend = new BackendLifecycle(createBaseDeps({ http, https }))
    await expect(backend.isHealthy()).resolves.toBe(true)
  })

  it('resolves false on non-2xx response', async () => {
    const { http, https } = createFakeHttp([{ status: 500 }])
    const backend = new BackendLifecycle(createBaseDeps({ http, https }))
    await expect(backend.isHealthy()).resolves.toBe(false)
  })

  it('resolves false on socket error', async () => {
    const { http, https } = createFakeHttp([{ error: new Error('ECONNREFUSED') }])
    const backend = new BackendLifecycle(createBaseDeps({ http, https }))
    await expect(backend.isHealthy()).resolves.toBe(false)
  })

  it('resolves false when the request fires timeout', async () => {
    const { http, https } = createFakeHttp([{ timeout: true }])
    const backend = new BackendLifecycle(createBaseDeps({ http, https }))
    await expect(backend.isHealthy(100)).resolves.toBe(false)
  })
})

// ── pickAvailableUrl ─────────────────────────────────────────────────────

describe('pickAvailableUrl', () => {
  it('commits the discovery result via setUrl', async () => {
    const deps = createBaseDeps({
      discovery: {
        pickAvailableBackendUrl: vi.fn(async () => ({
          url: 'http://127.0.0.1:8003',
          configuredPort: 8000,
          selectedPort: 8003,
          conflicted: true,
          external: false
        })),
        getBackendLaunchCandidates: vi.fn(() => [])
      }
    })
    const backend = new BackendLifecycle(deps)
    const url = await backend.pickAvailableUrl()
    expect(url).toBe('http://127.0.0.1:8003')
    expect(backend.getUrl()).toBe('http://127.0.0.1:8003')
  })

  it('logs [BACKEND_PORT_CONFLICT] when discovery flags a conflict', async () => {
    const deps = createBaseDeps({
      discovery: {
        pickAvailableBackendUrl: vi.fn(async () => ({
          url: 'http://127.0.0.1:8003',
          configuredPort: 8000,
          selectedPort: 8003,
          conflicted: true,
          external: false
        })),
        getBackendLaunchCandidates: vi.fn(() => [])
      }
    })
    const backend = new BackendLifecycle(deps)
    await backend.pickAvailableUrl()
    expect(deps.log.warn).toHaveBeenCalledWith('[BACKEND_PORT_CONFLICT]', {
      configuredPort: 8000,
      selectedPort: 8003
    })
  })

  it('does not log conflict when port was free', async () => {
    const deps = createBaseDeps()
    const backend = new BackendLifecycle(deps)
    await backend.pickAvailableUrl()
    const conflictCalls = deps.log.warn.mock.calls.filter((c) => c[0] === '[BACKEND_PORT_CONFLICT]')
    expect(conflictCalls).toHaveLength(0)
  })
})

// ── ensureRunning early-exit branches ────────────────────────────────────

describe('ensureRunning short-circuits', () => {
  it('returns true immediately when backend is already healthy', async () => {
    const { http, https } = createFakeHttp([{ status: 200 }])
    const deps = createBaseDeps({ http, https })
    const backend = new BackendLifecycle(deps)
    await expect(backend.ensureRunning()).resolves.toBe(true)
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('returns false and logs skip when URL is non-local', async () => {
    // First isHealthy returns false → pickAvailableUrl runs and commits a
    // remote URL → isLocalUrl() is false → skip + return false.
    const { http, https } = createFakeHttp([
      { error: new Error('not running yet') }
    ])
    const deps = createBaseDeps({
      http,
      https,
      discovery: {
        pickAvailableBackendUrl: vi.fn(async () => ({
          url: 'http://remote.example.com:8000',
          configuredPort: 8000,
          selectedPort: 8000,
          conflicted: false,
          external: true
        })),
        getBackendLaunchCandidates: vi.fn(() => [])
      }
    })
    const backend = new BackendLifecycle(deps)
    await expect(backend.ensureRunning()).resolves.toBe(false)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      '[BACKEND_START_SKIP] remote backend URL configured; local auto-start disabled'
    )
  })

  it('returns false and logs skip when there are no launch candidates', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not running yet') }
    ])
    const discovery = createDefaultDiscovery()
    discovery.getBackendLaunchCandidates = vi.fn(() => [])
    const deps = createBaseDeps({ http, https, discovery })
    const backend = new BackendLifecycle(deps)
    await expect(backend.ensureRunning()).resolves.toBe(false)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      '[BACKEND_START_SKIP] no launch candidates were found'
    )
  })

  it('returns false without probing or spawning when APIA_E2E_DISABLE_BACKEND=1 (e2e seam)', async () => {
    // E2E tests rely on this to keep `get-voices` / `warmup` / `send-message`
    // IPCs from quietly spawning a Python backend mid-test. The gate must
    // sit *before* any health probe — even a probe leaks state via the
    // injected http stub during smoke runs.
    const deps = createBaseDeps({
      env: { APIA_E2E_DISABLE_BACKEND: '1', PATH: '/usr/bin' }
    })
    const backend = new BackendLifecycle(deps)
    await expect(backend.ensureRunning()).resolves.toBe(false)
    await expect(backend.ensureAvailableForRequest()).resolves.toBe(false)
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.http.request).not.toHaveBeenCalled()
  })
})

// ── ensureRunning dedup + cooldown ───────────────────────────────────────

describe('ensureRunning dedup and cooldown', () => {
  it('dedups concurrent calls (spawn fires only once)', async () => {
    // Health: first two probes are "no backend" (ensure dedup window).
    // After spawn, #waitForReady probes again and gets a 200.
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },   // first ensureRunning's isHealthy
      { error: new Error('not yet') },   // second ensureRunning's isHealthy
      { status: 200 }                    // #waitForReady probe
    ])
    const deps = createBaseDeps({ http, https })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)

    const [a, b] = await Promise.all([
      backend.ensureRunning(),
      backend.ensureRunning()
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(deps.spawn).toHaveBeenCalledTimes(1)
  })

  it('dedups even when discovery is slow (regression: dedup gate ran after pickAvailableUrl await)', async () => {
    // Earlier the in-flight promise was only set after `await pickAvailableUrl`.
    // A slow discovery let both concurrent callers pass the dedup check and
    // double-spawn. This test installs a deliberately delayed discovery and
    // proves only ONE candidate-selection + spawn happens.
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },  // 1st ensure's isHealthy
      { error: new Error('not yet') },  // 2nd ensure's isHealthy
      { status: 200 }                   // #waitForReady probe
    ])
    let pickCallCount = 0
    const discovery = {
      pickAvailableBackendUrl: vi.fn(async () => {
        pickCallCount += 1
        // 50ms delay so the second ensureRunning starts and would reach the
        // dedup check while the first is still awaiting discovery.
        await new Promise((r) => setTimeout(r, 50))
        return {
          url: 'http://127.0.0.1:8000',
          configuredPort: 8000,
          selectedPort: 8000,
          conflicted: false,
          external: false
        }
      }),
      getBackendLaunchCandidates: vi.fn(() => [
        { label: 'py:test', command: 'python3', args: ['main.py'], cwd: '/tmp/backend' }
      ])
    }
    const deps = createBaseDeps({ http, https, discovery })
    deps.spawn.mockReturnValue(createFakeChild())
    const backend = new BackendLifecycle(deps)

    const [a, b] = await Promise.all([
      backend.ensureRunning(),
      backend.ensureRunning()
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    // Both calls returned true via the same dedup'd work. Discovery and the
    // candidate lookup each fired exactly once; spawn fired exactly once.
    expect(pickCallCount).toBe(1)
    expect(discovery.getBackendLaunchCandidates).toHaveBeenCalledTimes(1)
    expect(deps.spawn).toHaveBeenCalledTimes(1)
  })

  it('respects cooldown: a fully-completed first attempt blocks a second within cooldown', async () => {
    // First ensure fully completes (success). The dedup promise resolves
    // and is cleared in finally. The second call then hits cooldown — its
    // isHealthy is false (backend not running again), pickAvailableUrl
    // commits, and cooldown gate returns false without launching.
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },   // 1st ensureRunning's isHealthy
      { status: 200 },                   // #waitForReady (1st attempt's success)
      { error: new Error('still no') },  // 2nd ensureRunning's isHealthy
    ])
    const deps = createBaseDeps({
      http,
      https,
      cooldownMs: 60_000 // large enough that the second call lands inside it
    })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)

    await expect(backend.ensureRunning()).resolves.toBe(true)
    expect(deps.spawn).toHaveBeenCalledTimes(1)

    await expect(backend.ensureRunning()).resolves.toBe(false)
    expect(deps.spawn).toHaveBeenCalledTimes(1) // still one
    // Discovery ran on BOTH attempts — proves the second call passed the
    // dedup + isLocal gates and reached the cooldown check, not that it
    // was rejected at an earlier branch.
    expect(deps.discovery.pickAvailableBackendUrl).toHaveBeenCalledTimes(2)
  })

  it('force=true bypasses cooldown', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },   // 1st ensure isHealthy
      { status: 200 },                   // 1st #waitForReady
      { error: new Error('still no') },  // 2nd ensure isHealthy
      { status: 200 }                    // 2nd #waitForReady
    ])
    const deps = createBaseDeps({
      http,
      https,
      cooldownMs: 60_000
    })
    deps.spawn.mockReturnValue(createFakeChild({ pid: 1 }))
    const backend = new BackendLifecycle(deps)

    await expect(backend.ensureRunning()).resolves.toBe(true)
    // Second call would normally hit cooldown — force flag overrides.
    deps.spawn.mockReturnValueOnce(createFakeChild({ pid: 2 }))
    await expect(backend.ensureRunning({ force: true })).resolves.toBe(true)
    expect(deps.spawn).toHaveBeenCalledTimes(2)
  })
})

// ── Spawn lifecycle ──────────────────────────────────────────────────────

describe('spawn lifecycle', () => {
  it('passes the correct env vars to spawn', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({
      http,
      https,
      env: { PATH: '/usr/bin', SOMETHING_ELSE: 'preserved' }
    })
    deps.spawn.mockReturnValue(createFakeChild())
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    const [, , spawnOpts] = deps.spawn.mock.calls[0]
    expect(spawnOpts.env.APIA_BACKEND_HOST).toBe('127.0.0.1')
    expect(spawnOpts.env.APIA_BACKEND_PORT).toBe('8000')
    expect(spawnOpts.env.PYTHONUTF8).toBe('1')
    expect(spawnOpts.env.SOMETHING_ELSE).toBe('preserved') // existing env preserved
    expect(spawnOpts.env.DATA_DIR).toContain('backend-data')
  })

  it('child stdout fires log.childOutput with INFO prefix', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    child.stdout.emit('data', Buffer.from('startup line\n'))
    expect(deps.log.childOutput).toHaveBeenCalledWith('INFO', expect.stringContaining('[BACKEND:'), expect.anything())
  })

  it('child exit nulls state when the child is the current one', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()
    expect(backend.isStartedByApp()).toBe(true)

    child.emit('exit', 0, null)
    expect(backend.isStartedByApp()).toBe(false)
  })

  it('child error nulls state when the child is the current one', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    child.emit('error', new Error('spawn fault after start'))
    expect(backend.isStartedByApp()).toBe(false)
    expect(deps.log.error).toHaveBeenCalledWith(
      '[BACKEND_SPAWN_ERROR]',
      expect.objectContaining({ error: expect.any(Error) })
    )
  })

  it('returns false and logs when spawn throws', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') }
    ])
    const deps = createBaseDeps({ http, https })
    deps.spawn.mockImplementation(() => { throw new Error('exec not found') })
    const backend = new BackendLifecycle(deps)
    await expect(backend.ensureRunning()).resolves.toBe(false)
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('[BACKEND_START_FAIL]'),
      expect.any(Error)
    )
  })
})

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop', () => {
  it('on win32 calls spawnSync with taskkill /T /F', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https, platform: 'win32' })
    const child = createFakeChild({ pid: 1234 })
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    backend.stop()
    expect(deps.spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/T', '/F'],
      expect.any(Object)
    )
    expect(backend.isStartedByApp()).toBe(false)
  })

  it('on linux calls child.kill(SIGTERM)', async () => {
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https, platform: 'linux' })
    const child = createFakeChild()
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    backend.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(backend.isStartedByApp()).toBe(false)
  })

  it('is a no-op when there is no current child', () => {
    const deps = createBaseDeps()
    const backend = new BackendLifecycle(deps)
    backend.stop()
    expect(deps.spawnSync).not.toHaveBeenCalled()
  })

  it('on win32 with no pid: logs [BACKEND_STOP_NO_PID] and falls back to SIGTERM', async () => {
    // Spawn a child that has no pid. taskkill needs a pid, so the
    // lifecycle should log the missed path and try child.kill('SIGTERM')
    // as a best-effort instead of silently dropping the stop.
    const { http, https } = createFakeHttp([
      { error: new Error('not yet') },
      { status: 200 }
    ])
    const deps = createBaseDeps({ http, https, platform: 'win32' })
    // null bypasses the default-parameter substitution (undefined would
    // trigger it and the test would silently exercise the wrong path).
    const child = createFakeChild({ pid: null })
    deps.spawn.mockReturnValue(child)
    const backend = new BackendLifecycle(deps)
    await backend.ensureRunning()

    backend.stop()
    expect(deps.spawnSync).not.toHaveBeenCalled() // taskkill skipped (no pid)
    expect(deps.log.warn).toHaveBeenCalledWith('[BACKEND_STOP_NO_PID]', expect.objectContaining({
      platform: 'win32',
      pid: null,
      startedByApp: false
    }))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(backend.isStartedByApp()).toBe(false)
  })
})
