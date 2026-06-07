/**
 * Tests for BackendEnvRepository.
 *
 * Boundary contract: read/write of `backend.env` must round-trip with the
 * Python loader in `backend/ai_config.py` (which preserves comments + blank
 * lines and ignores unknown keys). These tests exercise the allowlist,
 * comment preservation, atomic write, presence flag, and clear semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  BackendEnvRepository,
  ALLOWED_KEYS,
  ENV_FILENAME
} = require('../electron/services/backendEnvRepository')

let tmpDir
let dataDir
let log

function createRepo() {
  return new BackendEnvRepository({ dataDir, log })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-backend-env-'))
  dataDir = join(tmpDir, 'backend-data')
  log = { warn: vi.fn() }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('constructor', () => {
  it('rejects missing dataDir', () => {
    expect(() => new BackendEnvRepository({ log })).toThrow(/dataDir/)
  })

  it('rejects missing log.warn', () => {
    expect(() => new BackendEnvRepository({ dataDir, log: {} })).toThrow(/log\.warn/)
  })
})

describe('presence', () => {
  it('reports all-absent when backend.env does not exist', () => {
    const repo = createRepo()
    const presence = repo.presence()
    for (const key of ALLOWED_KEYS) {
      expect(presence[key].present).toBe(false)
    }
  })

  it('reports present=true only for non-empty allowlisted keys', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, ENV_FILENAME), [
      '# comment',
      'APIA_GROQ_KEY=gsk_realkey',
      'APIA_ANTHROPIC_KEY=',
      'IGNORED_KEY=should-not-leak'
    ].join('\n'), { encoding: 'utf-8' })

    const repo = createRepo()
    const presence = repo.presence()
    expect(presence.APIA_GROQ_KEY.present).toBe(true)
    expect(presence.APIA_ANTHROPIC_KEY.present).toBe(false)
    expect(presence.APIA_HF_TOKEN.present).toBe(false)
    // IGNORED_KEY must not appear on the response surface — the allowlist
    // is structural, not just a filter at write time.
    expect(presence.IGNORED_KEY).toBeUndefined()
  })
})

describe('presence + applyUpdates end-to-end', () => {
  it('round-trips a write and reads back presence', async () => {
    const repo = createRepo()
    const result = repo.applyUpdates({ APIA_GROQ_KEY: 'gsk_test' })
    expect(result.written).toEqual(['APIA_GROQ_KEY'])
    expect(result.cleared).toEqual([])

    const presence = repo.presence()
    expect(presence.APIA_GROQ_KEY.present).toBe(true)
    expect(presence.APIA_ANTHROPIC_KEY.present).toBe(false)
    expect(presence.APIA_HF_TOKEN.present).toBe(false)

    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).toContain('APIA_GROQ_KEY=gsk_test')
  })

  it('preserves comments and blank lines around an updated key', async () => {
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'first' })
    // Hand-edit to add a comment and blank line, then update.
    const envPath = join(dataDir, ENV_FILENAME)
    await writeFile(envPath, [
      '# Apia keys',
      'APIA_GROQ_KEY=first',
      '',
      '# anthropic block',
      'APIA_ANTHROPIC_KEY=keep-me'
    ].join('\n'), { encoding: 'utf-8' })

    repo.applyUpdates({ APIA_GROQ_KEY: 'second' })
    const content = await readFile(envPath, 'utf-8')
    expect(content).toContain('# Apia keys')
    expect(content).toContain('APIA_GROQ_KEY=second')
    expect(content).not.toContain('APIA_GROQ_KEY=first')
    expect(content).toContain('# anthropic block')
    expect(content).toContain('APIA_ANTHROPIC_KEY=keep-me')
  })

  it('appends a new key at the end of the file when absent', async () => {
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'a' })
    repo.applyUpdates({ APIA_ANTHROPIC_KEY: 'b' })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    const groqIdx = content.indexOf('APIA_GROQ_KEY=')
    const claudeIdx = content.indexOf('APIA_ANTHROPIC_KEY=')
    expect(groqIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(groqIdx)
  })

  it('ignores keys outside the allowlist (security: renderer cannot seed arbitrary env vars)', async () => {
    const repo = createRepo()
    repo.applyUpdates({
      APIA_GROQ_KEY: 'ok',
      AWS_SECRET_ACCESS_KEY: 'should-be-dropped',
      PATH: '/etc/passwd'
    })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).toContain('APIA_GROQ_KEY=ok')
    expect(content).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(content).not.toContain('/etc/passwd')
  })

  it('empty string value is treated as "no change" (not delete)', async () => {
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'keep' })
    repo.applyUpdates({ APIA_GROQ_KEY: '' })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).toContain('APIA_GROQ_KEY=keep')
  })

  it('_clear flag removes the line so the backend default kicks in', async () => {
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'temp' })
    const result = repo.applyUpdates({ APIA_GROQ_KEY_clear: true })
    expect(result.cleared).toEqual(['APIA_GROQ_KEY'])

    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).not.toContain('APIA_GROQ_KEY=')
    expect(repo.presence().APIA_GROQ_KEY.present).toBe(false)
  })

  it('clear + new value in same payload: clear wins (user intent: reset and start over)', async () => {
    // The renderer enforces "typing cancels pending clear" but the repo
    // should be resilient if a bad caller sends both. Document the policy
    // here so future contributors see the intent.
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'before' })
    const result = repo.applyUpdates({
      APIA_GROQ_KEY: 'after',
      APIA_GROQ_KEY_clear: true
    })
    expect(result.cleared).toEqual(['APIA_GROQ_KEY'])
    expect(result.written).toEqual([])
    expect(repo.presence().APIA_GROQ_KEY.present).toBe(false)
  })

  it('write uses utf-8 (mojibake guard)', async () => {
    const repo = createRepo()
    // Real keys are ASCII, but the writer should still be utf-8 explicit
    // so a future free-text field doesn't corrupt the file.
    repo.applyUpdates({ APIA_GROQ_KEY: 'gsk_한글테스트' })
    const buf = await readFile(join(dataDir, ENV_FILENAME))
    const text = buf.toString('utf-8')
    expect(text).toContain('gsk_한글테스트')
  })

  it('atomic write leaves no stale .tmp on success', async () => {
    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'final' })
    const tmpPath = join(dataDir, `${ENV_FILENAME}.tmp`)
    let stillExists = true
    try {
      await access(tmpPath)
    } catch {
      stillExists = false
    }
    expect(stillExists).toBe(false)
  })

  it('clear removes every duplicate occurrence so the default actually kicks in', async () => {
    // A hand-edited file with duplicate keys: the dotenv loader (and our
    // presence map) keeps the *last* value, so clearing only the first
    // occurrence would leave a stale value still effective. clear must
    // sweep every duplicate.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, ENV_FILENAME), [
      'APIA_GROQ_KEY=first',
      '# something',
      'APIA_GROQ_KEY=second',
      'APIA_GROQ_KEY=third'
    ].join('\n'), { encoding: 'utf-8' })

    const repo = createRepo()
    expect(repo.presence().APIA_GROQ_KEY.present).toBe(true)
    repo.applyUpdates({ APIA_GROQ_KEY_clear: true })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).not.toContain('APIA_GROQ_KEY=')
    expect(repo.presence().APIA_GROQ_KEY.present).toBe(false)
  })

  it('update rewrites only the last duplicate (matches dotenv last-wins) and drops earlier copies', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, ENV_FILENAME), [
      'APIA_GROQ_KEY=old1',
      'APIA_GROQ_KEY=old2'
    ].join('\n'), { encoding: 'utf-8' })

    const repo = createRepo()
    repo.applyUpdates({ APIA_GROQ_KEY: 'fresh' })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).toContain('APIA_GROQ_KEY=fresh')
    expect(content).not.toContain('APIA_GROQ_KEY=old1')
    expect(content).not.toContain('APIA_GROQ_KEY=old2')
    // Exactly one occurrence remains.
    const occurrences = content.split('APIA_GROQ_KEY=').length - 1
    expect(occurrences).toBe(1)
  })

  it('round-trips quoted / whitespace-containing values', async () => {
    const repo = createRepo()
    // Real API keys don't have spaces, but the writer should still be
    // correct if one does — otherwise the dotenv loader splits on the
    // wrong character and the backend sees a truncated key.
    repo.applyUpdates({ APIA_GROQ_KEY: 'has spaces in it' })
    const content = await readFile(join(dataDir, ENV_FILENAME), 'utf-8')
    expect(content).toContain('APIA_GROQ_KEY="has spaces in it"')
  })
})

describe('presence with hand-written file', () => {
  it('parses an existing backend.env created outside the app', async () => {
    const envPath = join(dataDir, ENV_FILENAME)
    // Need to mkdir first since we're writing directly.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dataDir, { recursive: true })
    await writeFile(envPath, [
      '# hand-edited',
      'export APIA_HF_TOKEN="hf_quoted"',
      'APIA_GROQ_KEY=',
      'IGNORED=should-not-show-up'
    ].join('\n'), { encoding: 'utf-8' })

    const repo = createRepo()
    const presence = repo.presence()
    expect(presence.APIA_HF_TOKEN.present).toBe(true)
    expect(presence.APIA_GROQ_KEY.present).toBe(false)
    expect(presence.APIA_ANTHROPIC_KEY.present).toBe(false)
  })
})
