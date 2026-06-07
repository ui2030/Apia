/**
 * Tests for the pure windowBoundsPolicy helpers.
 *
 * The policy lives in its own module so it can be exercised without any
 * Electron shim. These tests focus on the failure modes that show up at
 * runtime: anchor on a phantom monitor, partial payload from an old
 * settings file, multi-display tie-breaking.
 */
import { describe, it, expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  MIN_DIMENSION,
  normalizeAnchor,
  normalizeBounds,
  workAreaContains,
  workAreaCentre,
  pickTargetWorkArea
} = require('../electron/services/windowBoundsPolicy')

describe('normalizeAnchor', () => {
  it('returns null for missing / non-object input', () => {
    expect(normalizeAnchor(undefined)).toBeNull()
    expect(normalizeAnchor(null)).toBeNull()
    expect(normalizeAnchor('foo')).toBeNull()
    expect(normalizeAnchor(42)).toBeNull()
  })

  it('returns null when x or y is not finite', () => {
    expect(normalizeAnchor({ x: 1 })).toBeNull()
    expect(normalizeAnchor({ y: 1 })).toBeNull()
    expect(normalizeAnchor({ x: Infinity, y: 1 })).toBeNull()
    expect(normalizeAnchor({ x: 1, y: NaN })).toBeNull()
  })

  it('coerces string numbers to numbers', () => {
    // Forward-compatible: an older settings file might have stringified
    // the anchor. Don't punish the user — just coerce.
    expect(normalizeAnchor({ x: '100', y: '200' })).toEqual({ x: 100, y: 200 })
  })

  it('passes through a clean payload', () => {
    expect(normalizeAnchor({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
  })
})

describe('normalizeBounds', () => {
  it('rejects non-finite or undersized payloads', () => {
    expect(normalizeBounds(null)).toBeNull()
    expect(normalizeBounds({ x: 0, y: 0, width: 10, height: 10 })).toBeNull()
    expect(normalizeBounds({ x: 0, y: 0, width: MIN_DIMENSION - 1, height: 100 })).toBeNull()
    expect(normalizeBounds({ x: 0, y: 0, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
})

describe('workAreaContains', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 }

  it('returns true for points strictly inside', () => {
    expect(workAreaContains(wa, 10, 10)).toBe(true)
  })

  it('includes the top-left edge, excludes the bottom-right', () => {
    expect(workAreaContains(wa, 0, 0)).toBe(true)
    expect(workAreaContains(wa, 1920, 1080)).toBe(false)
    expect(workAreaContains(wa, 1919, 1079)).toBe(true)
  })

  it('returns false for points outside', () => {
    expect(workAreaContains(wa, -1, 0)).toBe(false)
    expect(workAreaContains(wa, 2000, 500)).toBe(false)
  })

  it('returns false for a null/missing workArea', () => {
    expect(workAreaContains(null, 0, 0)).toBe(false)
    expect(workAreaContains(undefined, 0, 0)).toBe(false)
  })
})

describe('workAreaCentre', () => {
  it('returns the centre point of the workArea', () => {
    expect(workAreaCentre({ x: 0, y: 0, width: 1920, height: 1080 }))
      .toEqual({ x: 960, y: 540 })
  })

  it('handles a non-zero origin (secondary monitor)', () => {
    expect(workAreaCentre({ x: 1920, y: 0, width: 1280, height: 720 }))
      .toEqual({ x: 1920 + 640, y: 360 })
  })

  it('returns null for missing workArea', () => {
    expect(workAreaCentre(null)).toBeNull()
  })
})

describe('pickTargetWorkArea', () => {
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }

  it('throws if primaryDisplay is missing (programmer error)', () => {
    expect(() => pickTargetWorkArea({
      anchor: null, displays: [primary], primaryDisplay: null
    })).toThrow(/primaryDisplay/)
  })

  it('falls back to primary workArea when anchor is null', () => {
    expect(pickTargetWorkArea({
      anchor: null,
      displays: [primary, secondary],
      primaryDisplay: primary
    })).toEqual(primary.workArea)
  })

  it('falls back to primary workArea when anchor is invalid', () => {
    expect(pickTargetWorkArea({
      anchor: { x: NaN, y: 0 },
      displays: [primary, secondary],
      primaryDisplay: primary
    })).toEqual(primary.workArea)
  })

  it('returns the display whose workArea contains the anchor', () => {
    expect(pickTargetWorkArea({
      anchor: { x: 100, y: 100 },
      displays: [primary, secondary],
      primaryDisplay: primary
    })).toEqual(primary.workArea)

    expect(pickTargetWorkArea({
      anchor: { x: 2400, y: 360 },
      displays: [primary, secondary],
      primaryDisplay: primary
    })).toEqual(secondary.workArea)
  })

  it('falls back to primary when the anchor is on a phantom (disconnected) monitor', () => {
    // User unplugged their second monitor — saved anchor at x=2400,y=360 no
    // longer matches any live display. Restore to primary instead of
    // sticking the window off-screen.
    expect(pickTargetWorkArea({
      anchor: { x: 2400, y: 360 },
      displays: [primary],
      primaryDisplay: primary
    })).toEqual(primary.workArea)
  })

  it('handles a missing displays array gracefully', () => {
    expect(pickTargetWorkArea({
      anchor: { x: 100, y: 100 },
      displays: undefined,
      primaryDisplay: primary
    })).toEqual(primary.workArea)
  })
})
