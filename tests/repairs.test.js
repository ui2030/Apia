/**
 * Tests for the repair-aware parse helpers in electron/schemas.js.
 *
 * These helpers exist because the on-disk registry and world files are
 * *collections* — one bad child entry should not drop the whole file. The
 * helpers separate valid children from invalid ones and return a small
 * `repaired` report so the caller can log diagnostics.
 *
 * Aggregate-level consistency (e.g. activeCharacterId rebinding when an
 * entry was dropped) is the registryService's job, not these helpers' —
 * those are covered by integration paths, not unit tests here.
 */
import { describe, it, expect } from 'vitest'
import { parseCharacterEntries, parseWorldObjects } from '../electron/schemas.js'

describe('parseCharacterEntries', () => {
  const validEntry = {
    id: 'c1',
    displayName: 'Alice',
    modelType: 'vrm',
    basePath: 'C:/x'
  }

  it('returns all entries when every one is valid', () => {
    const { entries, repaired } = parseCharacterEntries([validEntry, { ...validEntry, id: 'c2' }])
    expect(entries).toHaveLength(2)
    expect(repaired.count).toBe(0)
    expect(repaired.sampleReasons).toEqual([])
  })

  it('drops invalid entries and keeps valid ones', () => {
    const { entries, repaired } = parseCharacterEntries([
      validEntry,
      { id: 'broken', modelType: 'gltf' }, // missing displayName + basePath + bad modelType
      { ...validEntry, id: 'c3' }
    ])
    expect(entries.map((e) => e.id)).toEqual(['c1', 'c3'])
    expect(repaired.count).toBe(1)
    expect(repaired.sampleReasons.length).toBeGreaterThan(0)
  })

  it('caps sampleReasons at 3 for diagnostic noise control', () => {
    const broken = [{}, {}, {}, {}, {}] // 5 invalid entries
    const { entries, repaired } = parseCharacterEntries(broken)
    expect(entries).toHaveLength(0)
    expect(repaired.count).toBe(5)
    expect(repaired.sampleReasons).toHaveLength(3)
  })

  it('handles empty input gracefully', () => {
    expect(parseCharacterEntries([])).toEqual({
      entries: [],
      repaired: { count: 0, sampleReasons: [] }
    })
  })

  it('handles non-array input gracefully', () => {
    // A registry that lost its `characters` array entirely should still
    // produce a clean empty result, not a TypeError.
    expect(parseCharacterEntries(null)).toEqual({
      entries: [],
      repaired: { count: 0, sampleReasons: [] }
    })
    expect(parseCharacterEntries(undefined).entries).toEqual([])
  })
})

describe('parseWorldObjects', () => {
  const chair = {
    id: 'chair_window',
    type: 'chair',
    label: 'Window Chair',
    x: 1.95, y: 0, z: 3.4
  }
  const decoration = {
    id: 'desk',
    type: 'decoration',
    label: 'Desk',
    x: -2.65, y: 0, z: 4.65
  }

  it('returns all objects when every one is valid', () => {
    const { objects, repaired } = parseWorldObjects([chair, decoration])
    expect(objects).toHaveLength(2)
    expect(repaired.count).toBe(0)
  })

  it('drops objects with a non-finite numeric field and keeps the rest', () => {
    const { objects, repaired } = parseWorldObjects([
      chair,
      { ...decoration, id: 'broken', x: Infinity },
      { ...chair, id: 'chair_2' }
    ])
    expect(objects.map((o) => o.id)).toEqual(['chair_window', 'chair_2'])
    expect(repaired.count).toBe(1)
  })

  it('drops objects with an unknown type', () => {
    const { objects, repaired } = parseWorldObjects([
      chair,
      { id: 'lamp', type: 'lamp', label: 'Lamp', x: 0, y: 0, z: 0 }
    ])
    expect(objects).toHaveLength(1)
    expect(objects[0].id).toBe('chair_window')
    expect(repaired.count).toBe(1)
  })

  it('handles empty + non-array input gracefully', () => {
    expect(parseWorldObjects([]).objects).toEqual([])
    expect(parseWorldObjects(null).objects).toEqual([])
  })
})
