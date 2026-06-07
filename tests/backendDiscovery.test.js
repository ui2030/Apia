/**
 * Pure tests for electron/services/backendDiscovery.js.
 *
 * The discovery module's expensive primitives (`net.createServer().listen`
 * for port probing, `fs.existsSync` for launch-candidate discovery) are
 * accepted as injectable options on the public helpers — defaults bind to
 * the real ones, tests pass deterministic stubs. backendLifecycle uses
 * defaults; nothing in production code passes these options.
 */
import { describe, it, expect, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  trimTrailingSlashes,
  normalizeBackendHostname,
  parseBackendUrl,
  isLocalBackendUrl,
  getBackendSpawnConfig,
  pickAvailableBackendUrl,
  getPackagedBackendExecutableCandidates,
  getBackendLaunchCandidates
} = require('../electron/services/backendDiscovery')

// ── trimTrailingSlashes ──────────────────────────────────────────────────

describe('trimTrailingSlashes', () => {
  it('returns empty string for falsy input', () => {
    expect(trimTrailingSlashes('')).toBe('')
    expect(trimTrailingSlashes(null)).toBe('')
    expect(trimTrailingSlashes(undefined)).toBe('')
  })

  it('strips a single trailing slash', () => {
    expect(trimTrailingSlashes('http://x/')).toBe('http://x')
  })

  it('strips multiple trailing slashes', () => {
    expect(trimTrailingSlashes('http://x///')).toBe('http://x')
  })

  it('leaves mid-string slashes alone', () => {
    expect(trimTrailingSlashes('http://x/foo/bar')).toBe('http://x/foo/bar')
  })
})

// ── normalizeBackendHostname ─────────────────────────────────────────────

describe('normalizeBackendHostname', () => {
  it('strips IPv6 brackets', () => {
    expect(normalizeBackendHostname('[::1]')).toBe('::1')
    expect(normalizeBackendHostname('[2001:db8::1]')).toBe('2001:db8::1')
  })

  it('passes IPv4 and DNS hostnames through unchanged', () => {
    expect(normalizeBackendHostname('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeBackendHostname('localhost')).toBe('localhost')
    expect(normalizeBackendHostname('api.example.com')).toBe('api.example.com')
  })

  it('returns non-string input unchanged', () => {
    expect(normalizeBackendHostname(undefined)).toBe(undefined)
    expect(normalizeBackendHostname(null)).toBe(null)
  })
})

// ── parseBackendUrl ──────────────────────────────────────────────────────

describe('parseBackendUrl', () => {
  it('returns a URL object for a valid URL', () => {
    const url = parseBackendUrl('http://example.com:1234')
    expect(url.hostname).toBe('example.com')
    expect(url.port).toBe('1234')
  })

  it('triggers onInvalid and falls back to DEFAULT_BACKEND_URL on garbage', () => {
    const onInvalid = vi.fn()
    const url = parseBackendUrl('not a url at all', { onInvalid })
    expect(onInvalid).toHaveBeenCalledWith(expect.objectContaining({
      rawUrl: 'not a url at all'
    }))
    expect(url.hostname).toBe('127.0.0.1')
  })

  it('tolerates missing onInvalid callback', () => {
    expect(() => parseBackendUrl('not a url at all')).not.toThrow()
  })
})

// ── isLocalBackendUrl ────────────────────────────────────────────────────

describe('isLocalBackendUrl', () => {
  it('returns true for 127.0.0.1', () => {
    expect(isLocalBackendUrl('http://127.0.0.1:8000')).toBe(true)
  })

  it('returns true for localhost', () => {
    expect(isLocalBackendUrl('http://localhost:8000')).toBe(true)
  })

  it('returns true for the bracketed [::1] form (regression: URL constructor returns this)', () => {
    // `new URL('http://[::1]:8000').hostname === '[::1]'`. Earlier the
    // LOCAL_HOSTS set only contained '::1', so the bracketed form
    // returned false and the lifecycle skipped local auto-start.
    expect(isLocalBackendUrl('http://[::1]:8000')).toBe(true)
  })

  it('returns false for arbitrary external hostnames', () => {
    expect(isLocalBackendUrl('http://api.example.com:8000')).toBe(false)
    expect(isLocalBackendUrl('http://10.0.0.1:8000')).toBe(false)
  })
})

// ── getBackendSpawnConfig ────────────────────────────────────────────────

describe('getBackendSpawnConfig', () => {
  it('returns host/port/dataDir from a configured URL + userDataPath', () => {
    const config = getBackendSpawnConfig('http://127.0.0.1:9001', '/var/userData')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe('9001')
    expect(config.dataDir).toContain('backend-data')
  })

  it('strips IPv6 brackets from the host so the value is safe for uvicorn bind', () => {
    // Same regression source as isLocalBackendUrl — `[::1]` from URL
    // parsing would be passed straight into APIA_BACKEND_HOST env var
    // and break uvicorn's bind.
    const config = getBackendSpawnConfig('http://[::1]:9002', '/var/userData')
    expect(config.host).toBe('::1')
    expect(config.port).toBe('9002')
  })

  it('falls back to default host/port on garbage input', () => {
    const config = getBackendSpawnConfig('not a url', '/var/userData')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe('8000')
  })
})

// ── pickAvailableBackendUrl ──────────────────────────────────────────────

describe('pickAvailableBackendUrl', () => {
  function neverProbe() {
    return Promise.reject(new Error('probe must not be called for external URL'))
  }

  it('returns external+committed without probing when hasExplicitBackendUrl is true', async () => {
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://127.0.0.1:8000',
      hasExplicitBackendUrl: true,
      isPortAvailable: neverProbe
    })
    // Discovery returns a canonical (trim-trailing-slash) URL string. The
    // lifecycle's setUrl re-trims as a defensive backstop, but discovery
    // now owns the invariant.
    expect(result).toMatchObject({
      url: 'http://127.0.0.1:8000',
      configuredPort: 8000,
      selectedPort: 8000,
      conflicted: false,
      external: true
    })
  })

  it('returns external when URL host is not a loopback', async () => {
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://api.example.com:8000',
      hasExplicitBackendUrl: false,
      isPortAvailable: neverProbe
    })
    expect(result.external).toBe(true)
    expect(result.url).toBe('http://api.example.com:8000')
  })

  it('commits the configured port when free', async () => {
    const probe = vi.fn(async () => true)
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://127.0.0.1:8000',
      hasExplicitBackendUrl: false,
      isPortAvailable: probe
    })
    expect(result.conflicted).toBe(false)
    expect(result.selectedPort).toBe(8000)
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 8000)
  })

  it('walks to the next free port and flags conflicted', async () => {
    // First port busy, +1 busy, +2 free.
    const probe = vi.fn(async (_host, port) => port === 8002)
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://127.0.0.1:8000',
      hasExplicitBackendUrl: false,
      isPortAvailable: probe
    })
    expect(result.conflicted).toBe(true)
    expect(result.selectedPort).toBe(8002)
    expect(result.configuredPort).toBe(8000)
    expect(result.url).toContain(':8002')
  })

  it('falls back to configured URL when every probed port is busy', async () => {
    const probe = vi.fn(async () => false)
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://127.0.0.1:8000',
      hasExplicitBackendUrl: false,
      isPortAvailable: probe
    })
    expect(result.url).toBe('http://127.0.0.1:8000')
    expect(result.conflicted).toBe(false)
    expect(result.external).toBe(false)
    // PROBE_SPAN=25, so the loop tried port 8000 once + 24 more.
    expect(probe.mock.calls.length).toBe(25)
  })

  it('probes IPv6 loopback with canonical ::1 (not bracketed) — regression', async () => {
    // The whole point of normalizing: net.createServer().listen does NOT
    // accept '[::1]'. If pickAvailableBackendUrl forwards the URL's
    // bracketed hostname to the probe, listen() rejects and the probe
    // would falsely report "occupied".
    const probe = vi.fn(async () => true)
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'http://[::1]:8000',
      hasExplicitBackendUrl: false,
      isPortAvailable: probe
    })
    expect(probe).toHaveBeenCalledWith('::1', 8000)
    expect(result.external).toBe(false)
    expect(result.selectedPort).toBe(8000)
  })

  it('falls back to default URL when the configured URL is garbage', async () => {
    const probe = vi.fn(async () => true)
    const result = await pickAvailableBackendUrl({
      configuredBackendUrl: 'not a url',
      hasExplicitBackendUrl: false,
      isPortAvailable: probe
    })
    // parseBackendUrl substitutes DEFAULT_BACKEND_URL (http://127.0.0.1:8000),
    // so locality + probing proceeds on the loopback default.
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 8000)
    expect(result.selectedPort).toBe(8000)
    expect(result.external).toBe(false)
  })
})

// ── getPackagedBackendExecutableCandidates ───────────────────────────────

describe('getPackagedBackendExecutableCandidates', () => {
  // Note: returns are platform-dependent on `process.platform`. Cannot stub
  // process.platform from the test runner cleanly, so we just assert the
  // shape on the current platform.
  it('returns two candidate paths under resources/backend', () => {
    const candidates = getPackagedBackendExecutableCandidates('/tmp/resources')
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate).toMatch(/[/\\]resources[/\\]backend[/\\]/)
    }
  })

  it('on win32 returns .exe variants', () => {
    if (process.platform !== 'win32') return
    const candidates = getPackagedBackendExecutableCandidates('C:\\app\\resources')
    expect(candidates[0]).toMatch(/ApiaBackend\.exe$/)
    expect(candidates[1]).toMatch(/backend\.exe$/)
  })

  it('on non-win32 returns extensionless variants', () => {
    if (process.platform === 'win32') return
    const candidates = getPackagedBackendExecutableCandidates('/app/resources')
    expect(candidates[0]).toMatch(/apia-backend$/)
    expect(candidates[1]).toMatch(/backend$/)
  })
})

// ── getBackendLaunchCandidates ───────────────────────────────────────────

describe('getBackendLaunchCandidates', () => {
  it('returns an empty list when isLocal is false', () => {
    const candidates = getBackendLaunchCandidates({
      isLocal: false,
      workspaceRoot: '/ws',
      resourcesPath: '/res',
      fileExists: () => true
    })
    expect(candidates).toEqual([])
  })

  it('returns empty when no files exist anywhere', () => {
    const candidates = getBackendLaunchCandidates({
      isLocal: true,
      workspaceRoot: '/ws',
      resourcesPath: '/res',
      fileExists: () => false
    })
    expect(candidates).toEqual([])
  })

  it('places a packaged executable at the front of the list', () => {
    // Only the first packaged exe candidate exists; nothing else.
    const candidates = getPackagedBackendExecutableCandidates('/res')
    const packagedExe = candidates[0]
    const launches = getBackendLaunchCandidates({
      isLocal: true,
      workspaceRoot: '/ws',
      resourcesPath: '/res',
      fileExists: (p) => p === packagedExe
    })
    expect(launches[0]).toMatchObject({
      command: packagedExe,
      args: []
    })
    expect(launches[0].label).toMatch(/^(ApiaBackend\.exe|apia-backend)$/)
  })

  it('appends workspace python candidates when backend/main.py exists', () => {
    const path = require('path')
    // Build the same way production code does so the equality check matches
    // on both posix and win32 path separators.
    const workspaceMain = path.join('/ws', 'backend', 'main.py')
    const launches = getBackendLaunchCandidates({
      isLocal: true,
      workspaceRoot: '/ws',
      resourcesPath: '/res',
      fileExists: (p) => p === workspaceMain
    })
    // No exe, no packaged main → only workspace python lines.
    expect(launches.length).toBeGreaterThan(0)
    for (const launch of launches) {
      expect(launch.label).toContain('workspace')
      expect(launch.cwd).toContain('backend')
    }
  })

  it('prefers exe over python when both exist', () => {
    const path = require('path')
    const exe = getPackagedBackendExecutableCandidates('/res')[0]
    const workspaceMain = path.join('/ws', 'backend', 'main.py')
    const launches = getBackendLaunchCandidates({
      isLocal: true,
      workspaceRoot: '/ws',
      resourcesPath: '/res',
      fileExists: (p) => p === exe || p === workspaceMain
    })
    expect(launches[0].command).toBe(exe)
    // Workspace fallbacks come after.
    expect(launches.slice(1).every((l) => l.label.includes('workspace'))).toBe(true)
  })
})
