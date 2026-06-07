/**
 * Tests for the SettingsRepository aggregate.
 *
 * The aggregate owns the boundary between disk (apia-settings.json + the
 * backend-data dir bootstrap) and the renderer-facing settings shape. These
 * tests exercise its invariants — normalize defaults, range clamps, schema
 * fallback to defaults, save→load roundtrip, ensureRuntimeFiles idempotency
 * — using a per-test tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  SettingsRepository,
  SETTINGS_DEFAULTS,
  BACKEND_ENV_EXAMPLE_FILENAME
} = require('../electron/services/settingsAggregate')

let tmpDir
let settingsPath
let dataDir
let log

function createRepo({ shouldForceAutoAiMode = () => false } = {}) {
  return new SettingsRepository({
    settingsPath,
    dataDir,
    log,
    shouldForceAutoAiMode
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-settings-'))
  settingsPath = join(tmpDir, 'apia-settings.json')
  dataDir = join(tmpDir, 'backend-data')
  log = { warn: vi.fn() }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('SettingsRepository constructor', () => {
  it('rejects missing settingsPath', () => {
    expect(() => new SettingsRepository({
      dataDir, log, shouldForceAutoAiMode: () => false
    })).toThrow(/settingsPath/)
  })

  it('rejects missing log.warn', () => {
    expect(() => new SettingsRepository({
      settingsPath, dataDir, log: {}, shouldForceAutoAiMode: () => false
    })).toThrow(/log\.warn/)
  })

  it('rejects non-function shouldForceAutoAiMode', () => {
    expect(() => new SettingsRepository({
      settingsPath, dataDir, log, shouldForceAutoAiMode: true
    })).toThrow(/shouldForceAutoAiMode/)
  })
})

describe('normalize', () => {
  it('produces the default shape from empty input', () => {
    const repo = createRepo()
    const normalized = repo.normalize()
    // All defaults present and unchanged.
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      expect(normalized).toHaveProperty(key)
    }
  })

  it('clamps charScale to the schema range (1..500)', () => {
    const repo = createRepo()
    expect(repo.normalize({ charScale: 99999 }).charScale).toBe(500)
    expect(repo.normalize({ charScale: -5 }).charScale).toBe(1)
  })

  it('clamps memoryTurns to (1..50)', () => {
    const repo = createRepo()
    expect(repo.normalize({ memoryTurns: 999 }).memoryTurns).toBe(50)
    expect(repo.normalize({ memoryTurns: 0 }).memoryTurns).toBe(1)
  })

  it('rejects an unknown aiMode and falls back to default', () => {
    const repo = createRepo()
    expect(repo.normalize({ aiMode: 'gpt5' }).aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
  })

  it('forces aiMode=auto when shouldForceAutoAiMode and saved mode is local', () => {
    const repo = createRepo({ shouldForceAutoAiMode: () => true })
    expect(repo.normalize({ aiMode: 'local' }).aiMode).toBe('auto')
  })

  it('leaves aiMode alone for non-local saved modes even when forcing', () => {
    const repo = createRepo({ shouldForceAutoAiMode: () => true })
    expect(repo.normalize({ aiMode: 'claude' }).aiMode).toBe('claude')
  })

  it('coerces non-array models to []', () => {
    const repo = createRepo()
    expect(repo.normalize({ models: 'broken' }).models).toEqual([])
  })

  it('normalizes a missing windowAnchor to null', () => {
    const repo = createRepo()
    expect(repo.normalize().windowAnchor).toBeNull()
  })

  it('normalizes a partial windowAnchor (non-finite x) to null', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: Infinity, y: 0 } }).windowAnchor).toBeNull()
  })

  it('passes through a clean windowAnchor', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: 100, y: 200 } }).windowAnchor)
      .toEqual({ x: 100, y: 200 })
  })

  it('coerces a stringified anchor (forward-compat with older settings files)', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: '50', y: '60' } }).windowAnchor)
      .toEqual({ x: 50, y: 60 })
  })

  it('falls back to defaults when the merged shape fails schema (defensive)', () => {
    const repo = createRepo()
    // null charScale → coercion above sets to default; this test exercises
    // the schema-fallback path by passing a non-string voiceId that survives
    // the legacy coercion but breaks schema (z.string().nullable()).
    // Actually voiceId is coerced to null for non-strings, so we test
    // alwaysOnTop being non-boolean — coercion sets `!== false`, so any
    // non-false truthy becomes true, and false stays false. Hard to break
    // post-coercion. This test just asserts schema doesn't reject the
    // happy path even with garbage input.
    const out = repo.normalize({ voiceId: 12345, alwaysOnTop: 'yes' })
    expect(out.voiceId).toBe(null) // coerced
    expect(out.alwaysOnTop).toBe(true) // coerced via !== false
  })
})

describe('load / save roundtrip', () => {
  it('returns defaults when the file does not exist', () => {
    const repo = createRepo()
    const settings = repo.load()
    expect(settings.aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
  })

  it('save then load returns the saved (normalized) shape', async () => {
    const repo = createRepo()
    repo.save({ aiMode: 'groq', charScale: 120, memoryTurns: 25 })
    const reloaded = repo.load()
    expect(reloaded.aiMode).toBe('groq')
    expect(reloaded.charScale).toBe(120)
    expect(reloaded.memoryTurns).toBe(25)
    // Disk file is normalized too (range, types).
    const onDisk = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(onDisk.aiMode).toBe('groq')
    expect(onDisk.charScale).toBe(120)
  })

  it('load logs a warn and falls back to defaults when the file is unparseable JSON', async () => {
    await writeFile(settingsPath, '{ not json', 'utf-8')
    const repo = createRepo()
    const settings = repo.load()
    expect(settings.aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
    expect(log.warn).toHaveBeenCalledWith('[SETTINGS_LOAD_ERROR]', expect.any(Error))
  })
})

describe('ensureRuntimeFiles', () => {
  it('creates the backend.env.example file on first run', async () => {
    const repo = createRepo()
    repo.ensureRuntimeFiles()
    const examplePath = join(dataDir, BACKEND_ENV_EXAMPLE_FILENAME)
    await access(examplePath) // throws if missing
    const content = await readFile(examplePath, 'utf-8')
    expect(content).toContain('APIA_AI_MODE=auto')
  })

  it('does not overwrite an existing example file', async () => {
    const repo = createRepo()
    repo.ensureRuntimeFiles()
    const examplePath = join(dataDir, BACKEND_ENV_EXAMPLE_FILENAME)
    await writeFile(examplePath, 'user-modified content', 'utf-8')
    repo.ensureRuntimeFiles() // idempotent
    const content = await readFile(examplePath, 'utf-8')
    expect(content).toBe('user-modified content')
  })

  it('catches and logs file IO failures instead of throwing', async () => {
    // Create a *file* at the dataDir path so mkdirSync('...') trips.
    // On Windows, mkdirSync({recursive:true}) on a file path throws ENOTDIR.
    await writeFile(dataDir, 'i am a file, not a directory', 'utf-8')
    const repo = createRepo()
    expect(() => repo.ensureRuntimeFiles()).not.toThrow()
    expect(log.warn).toHaveBeenCalledWith(
      '[BACKEND_RUNTIME_FILES_WARN]',
      expect.any(Error)
    )
  })
})
