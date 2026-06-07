// Tests for registryService.readRegistry aggregate-level invariant:
// activeCharacterId never dangles after per-element repair.
//
// registryService has a globalThis.__APIA_TEST_USERDATA__ seam: when set,
// it treats that as the userData root and never touches Electron's app.
// Production never sets it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: {} }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const registryService = require('../electron/services/registryService')

let tmpDir
let consoleSpy

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-registry-'))
  mkdirSync(join(tmpDir, 'characters'), { recursive: true })
  globalThis.__APIA_TEST_USERDATA__ = tmpDir
  consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  delete globalThis.__APIA_TEST_USERDATA__
  consoleSpy.mockRestore()
})

const registryPath = () => join(tmpDir, 'characters', 'character_registry.json')

const validEntry = (id) => ({
  id,
  displayName: `Char ${id}`,
  modelType: 'vrm',
  basePath: `C:/x/${id}`
})

describe('readRegistry aggregate consistency', () => {
  it('returns the file as-is when every entry is valid and activeCharacterId points at one', async () => {
    await writeFile(registryPath(), JSON.stringify({
      version: 2,
      activeCharacterId: 'c2',
      characters: [validEntry('c1'), validEntry('c2'), validEntry('c3')]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.activeCharacterId).toBe('c2')
    expect(registry.characters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('rebinds activeCharacterId to the first surviving entry when the original was dropped', async () => {
    // c2 is invalid (missing required fields). Active points at c2.
    await writeFile(registryPath(), JSON.stringify({
      version: 2,
      activeCharacterId: 'c2',
      characters: [
        validEntry('c1'),
        { id: 'c2' }, // invalid — missing displayName/modelType/basePath
        validEntry('c3')
      ]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.characters.map((c) => c.id)).toEqual(['c1', 'c3'])
    expect(registry.activeCharacterId).toBe('c1') // first surviving
  })

  it('rebinds activeCharacterId to null when every entry was dropped', async () => {
    await writeFile(registryPath(), JSON.stringify({
      version: 2,
      activeCharacterId: 'c2',
      characters: [{ id: 'c1' }, { id: 'c2' }]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.characters).toEqual([])
    expect(registry.activeCharacterId).toBe(null)
  })

  it('rebinds when activeCharacterId points at a non-existent entry from the start (pre-existing dangle)', async () => {
    // File on disk had a stale activeCharacterId pointing at a character
    // that was never in the list. Read should clean it up.
    await writeFile(registryPath(), JSON.stringify({
      version: 2,
      activeCharacterId: 'ghost',
      characters: [validEntry('c1')]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.activeCharacterId).toBe('c1')
  })

  it('leaves null activeCharacterId alone — it was already coherent', async () => {
    await writeFile(registryPath(), JSON.stringify({
      version: 2,
      activeCharacterId: null,
      characters: [validEntry('c1')]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.activeCharacterId).toBe(null)
  })

  it('falls back to empty registry when the envelope fails (e.g. wrong version)', async () => {
    await writeFile(registryPath(), JSON.stringify({
      version: 1, // wrong — current is z.literal(2)
      activeCharacterId: null,
      characters: [validEntry('c1')]
    }), 'utf-8')

    const registry = registryService.readRegistry()
    expect(registry.version).toBe(2)
    expect(registry.activeCharacterId).toBe(null)
    expect(registry.characters).toEqual([])
  })
})
