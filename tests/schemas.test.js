/**
 * Schema contract tests for the on-disk files Electron reads.
 *
 * These don't boot Electron — they only exercise electron/schemas.js against
 * representative happy- and unhappy-path inputs. The goal is to make schema
 * drift (e.g. someone removes `aiMode` from SettingsSchema or adds a new
 * `worldType` value without telling normalizeWorldObject) fail loudly.
 */
import { describe, it, expect } from 'vitest'
import {
  SettingsSchema,
  WorldDocumentSchema,
  CharacterEntrySchema,
  CharacterRegistrySchema
} from '../electron/schemas.js'

// Mirror of SETTINGS_DEFAULTS in electron/main.js. If the defaults change,
// this constant should change too — the test is here to catch *schema* drift
// (e.g. enum value removal) against the same shape the main process uses.
const DEFAULT_SETTINGS = {
  activeModel: 'dummy',
  activeCharacter: null,
  models: [],
  alwaysOnTop: true,
  charScale: 100,
  autoBehavior: true,
  aiMode: 'auto',
  memoryTurns: 10,
  ttsEnabled: true,
  voiceId: null,
  windowAnchor: null
}

describe('SettingsSchema', () => {
  it('accepts the default settings shape', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(parsed.success).toBe(true)
  })

  it('accepts a realistic populated settings object', () => {
    const populated = {
      ...DEFAULT_SETTINGS,
      activeModel: 'vrm-1234',
      activeCharacter: 'char-abcd',
      models: [{ id: 'vrm-1234', name: 'Alice' }],
      charScale: 120,
      aiMode: 'groq',
      memoryTurns: 25,
      voiceId: 'system-voice-1'
    }
    expect(SettingsSchema.safeParse(populated).success).toBe(true)
  })

  it('rejects an unknown aiMode value', () => {
    const bad = { ...DEFAULT_SETTINGS, aiMode: 'gpt5' }
    const parsed = SettingsSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
  })

  it('rejects out-of-range memoryTurns', () => {
    const bad = { ...DEFAULT_SETTINGS, memoryTurns: 100 }
    expect(SettingsSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects non-boolean alwaysOnTop', () => {
    const bad = { ...DEFAULT_SETTINGS, alwaysOnTop: 'yes' }
    expect(SettingsSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects missing activeCharacter (must be string or null, not undefined)', () => {
    const { activeCharacter, ...withoutActiveChar } = DEFAULT_SETTINGS
    expect(SettingsSchema.safeParse(withoutActiveChar).success).toBe(false)
  })
})

describe('WorldDocumentSchema', () => {
  it('accepts an empty objects array', () => {
    expect(WorldDocumentSchema.safeParse({ objects: [] }).success).toBe(true)
  })

  it('accepts a fully-populated chair object', () => {
    const doc = {
      version: 1,
      objects: [{
        id: 'chair_window',
        type: 'chair',
        label: 'Window Chair',
        x: 1.95, y: 0, z: 3.4,
        sitOffset: { x: 0, y: 0.04, z: -0.12 },
        sitRotY: Math.PI * 0.9,
        autoBehavior: true,
        clickable: true,
        bubbleText: 'I will sit by the window for a moment.'
      }]
    }
    expect(WorldDocumentSchema.safeParse(doc).success).toBe(true)
  })

  it('accepts point and decoration types without sitOffset', () => {
    const doc = {
      objects: [
        { id: 'p1', type: 'point', label: 'Spot', x: 0, y: 0, z: 0 },
        { id: 'd1', type: 'decoration', label: 'Desk', x: 1, y: 0, z: 0 }
      ]
    }
    expect(WorldDocumentSchema.safeParse(doc).success).toBe(true)
  })

  it('rejects an unknown world type', () => {
    const doc = {
      objects: [{ id: 'x', type: 'lamp', label: 'Lamp', x: 0, y: 0, z: 0 }]
    }
    expect(WorldDocumentSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects an object missing required positional fields', () => {
    const doc = {
      objects: [{ id: 'x', type: 'point', label: 'p' }]
    }
    expect(WorldDocumentSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects non-finite numeric fields (NaN / Infinity)', () => {
    // JSON.parse cannot produce Infinity, but a hand-edited file with
    // `1e9999` parses to Infinity on some runtimes. .finite() makes this
    // an explicit boundary failure.
    const docInf = {
      objects: [{ id: 'p', type: 'point', label: 'p', x: Infinity, y: 0, z: 0 }]
    }
    expect(WorldDocumentSchema.safeParse(docInf).success).toBe(false)

    const docNaN = {
      objects: [{ id: 'p', type: 'point', label: 'p', x: NaN, y: 0, z: 0 }]
    }
    expect(WorldDocumentSchema.safeParse(docNaN).success).toBe(false)
  })
})

describe('CharacterEntrySchema', () => {
  it('accepts the minimum required fields', () => {
    const entry = {
      id: 'char-1',
      displayName: 'Alice',
      modelType: 'vrm',
      basePath: 'C:/users/x/characters/alice'
    }
    expect(CharacterEntrySchema.safeParse(entry).success).toBe(true)
  })

  it('accepts a fully-populated import entry', () => {
    const entry = {
      id: 'char-1',
      displayName: 'Alice',
      customName: 'Alice',
      summary: 'A cheerful character',
      originalDescription: 'long description',
      modelType: 'pmx',
      importSource: 'zip',
      basePath: 'C:/x',
      modelManifestPath: 'C:/x/model/model_manifest.json',
      profileGeneratedPath: 'C:/x/profile.generated.json',
      profileUserPath: 'C:/x/profile.user.json',
      interpretationsPath: 'C:/x/interpretation_presets.json',
      thumbnail: null,
      documents: [{ name: 'README.md', path: 'C:/x/docs/README.md', type: 'md' }],
      status: 'ready',
      analysis: { modelFound: true, texturesResolved: true, imageCount: 4 },
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    }
    expect(CharacterEntrySchema.safeParse(entry).success).toBe(true)
  })

  it('rejects an unsupported modelType', () => {
    const entry = {
      id: 'c', displayName: 'Bob', modelType: 'gltf', basePath: 'C:/x'
    }
    expect(CharacterEntrySchema.safeParse(entry).success).toBe(false)
  })
})

describe('CharacterRegistrySchema', () => {
  it('accepts the empty initial registry at the current version', () => {
    const reg = { version: 2, activeCharacterId: null, characters: [] }
    expect(CharacterRegistrySchema.safeParse(reg).success).toBe(true)
  })

  it('rejects a registry missing the version field', () => {
    const reg = { activeCharacterId: null, characters: [] }
    expect(CharacterRegistrySchema.safeParse(reg).success).toBe(false)
  })

  it('rejects a registry with a non-current version (literal check)', () => {
    // version is z.literal(CURRENT_REGISTRY_VERSION). A hypothetical legacy
    // v1 file should fail strict parsing here — the repair-aware read
    // path catches this and falls back to empty (or migrates, when a
    // migration service exists).
    const reg = { version: 1, activeCharacterId: null, characters: [] }
    expect(CharacterRegistrySchema.safeParse(reg).success).toBe(false)
  })
})
