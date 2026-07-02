/**
 * Tests for src/needsManager.js — the J단계 needs + personality utility AI.
 *
 * Per Codex pre-review: needs rise over wall-clock (dt clamped so a sleep/resume
 * gap doesn't slam everything to max), selection is argmax-over-(need×fill) with
 * a threshold (else fall through to idle), a cooldown prevents fixation on one
 * object, and only normal completion (satisfy) drains needs. Clock + rng are
 * injected so everything is deterministic.
 */
import { describe, it, expect } from 'vitest'
import { createNeedsManager } from '../src/needsManager.js'

// Deterministic clock + rng helpers.
function fixedRng(value = 0) { return () => value }

describe('needsManager — rise over time (tick)', () => {
  it('raises needs proportional to elapsed minutes (1-min ticks accumulate)', () => {
    let t = 0
    const n = createNeedsManager({ now: () => t, getPersonality: () => 'calm' })
    expect(n.snapshot().thirst).toBe(0)
    // dt is clamped to 1 min/tick (resume protection), so 45 one-minute ticks
    // accumulate to full thirst (base rise 1/45 per min).
    for (let i = 0; i < 45; i++) { t += 60000; n.tick() }
    expect(n.snapshot().thirst).toBeCloseTo(1, 1)
  })

  it('clamps a huge elapsed gap (sleep/resume) to at most one minute of rise', () => {
    let t = 0
    const n = createNeedsManager({ now: () => t, getPersonality: () => 'calm' })
    t = 10 * 60 * 60000 // 10 hours later (laptop slept)
    n.tick()
    // capped at 1 min of rise → boredom (fastest, 1/35) stays small, nowhere near 1
    expect(n.snapshot().boredom).toBeLessThan(0.1)
  })

  it('personality weights the rise rate (active gets bored faster than shy)', () => {
    let t = 0
    const active = createNeedsManager({ now: () => t, getPersonality: () => 'active' })
    const shy = createNeedsManager({ now: () => t, getPersonality: () => 'shy' })
    t = 10 * 60000
    active.tick(); shy.tick()
    expect(active.snapshot().boredom).toBeGreaterThan(shy.snapshot().boredom)
  })
})

describe('needsManager — chooseActivity', () => {
  const WATER = { id: 'drinkWater', needFill: { thirst: 0.85 } }
  const COFFEE = { id: 'brewCoffee', focus: 'self', needFill: { comfort: 0.6, boredom: 0.35 } }
  const REST = { id: 'rest', needFill: { tiredness: 0.75 } }

  it('returns null when all needs are low (fall through to idle/walk)', () => {
    const n = createNeedsManager({ now: () => 0, rng: fixedRng() })
    expect(n.chooseActivity([WATER, COFFEE, REST])).toBeNull()
  })

  it('picks the activity that best fills the most-pressing need', () => {
    const n = createNeedsManager({ now: () => 0, rng: fixedRng() })
    n.setNeed('thirst', 0.9) // very thirsty
    const pick = n.chooseActivity([WATER, COFFEE, REST])
    expect(pick.id).toBe('drinkWater')
  })

  it('applies a cooldown so it does not immediately repeat the same activity', () => {
    let t = 0
    const n = createNeedsManager({ now: () => t, rng: fixedRng() })
    n.setNeed('thirst', 1)
    n.setNeed('tiredness', 0.55)
    expect(n.chooseActivity([WATER, REST]).id).toBe('drinkWater')
    n.satisfy(WATER) // drains thirst + records cooldown
    // even if we re-raise thirst, the just-done water is penalized for a while
    n.setNeed('thirst', 1)
    t = 5000 // 5s later, within cooldown
    const pick = n.chooseActivity([WATER, REST])
    expect(pick.id).toBe('rest') // cooldown pushed water below rest
  })

  it('directive focus match flips a close call toward the focused activity', () => {
    // water: thirst 0.5×0.85 = 0.425. coffee: comfort 0.7×0.6 = 0.42 (boredom 0).
    // Without focus water edges it; with focus:self coffee ×1.15 = 0.483 clears
    // the 0.97 band over water → coffee wins.
    const base = { thirst: 0.5, comfort: 0.7 }
    const noFocus = createNeedsManager({ now: () => 0, rng: fixedRng(), initial: base })
    expect(noFocus.chooseActivity([WATER, COFFEE]).id).toBe('drinkWater')
    const withFocus = createNeedsManager({ now: () => 0, rng: fixedRng(), initial: base })
    expect(withFocus.chooseActivity([WATER, COFFEE], { directiveFocus: 'self' }).id).toBe('brewCoffee')
  })
})

describe('needsManager — hygiene need (bathroom)', () => {
  const BATHROOM = { id: 'bathroom', needFill: { hygiene: 0.9 } }
  it('hygiene rises over time and bathroom is picked when pressing', () => {
    let t = 0
    const n = createNeedsManager({ now: () => t, rng: fixedRng() })
    n.setNeed('hygiene', 0.8)
    expect(n.chooseActivity([BATHROOM]).id).toBe('bathroom')
    n.satisfy(BATHROOM)
    expect(n.snapshot().hygiene).toBe(0) // 0.8 - 0.9 clamped
  })
  it('hygiene is one of the tracked needs', () => {
    const n = createNeedsManager({ now: () => 0 })
    expect(Object.keys(n.snapshot())).toContain('hygiene')
  })
})

describe('needsManager — satisfy (complete only)', () => {
  it('drains the filled needs and clamps at 0', () => {
    const n = createNeedsManager({ now: () => 0 })
    n.setNeed('thirst', 0.5)
    n.satisfy({ id: 'drinkWater', needFill: { thirst: 0.85 } })
    expect(n.snapshot().thirst).toBe(0) // 0.5 - 0.85 clamped to 0
  })
})

describe('needsManager — persistence (load + offline rise)', () => {
  it('load restores saved values, clamps garbage, zeroes missing keys', () => {
    const n = createNeedsManager({ now: () => 0 })
    n.load({ thirst: 0.4, boredom: 7, care: 'x' })
    expect(n.snapshot().thirst).toBe(0.4)
    expect(n.snapshot().boredom).toBe(1) // clamped
    expect(n.snapshot().care).toBe(0) // non-numeric → 0
    expect(n.snapshot().tiredness).toBe(0) // missing → 0
  })

  it('load(null) resets everything to 0', () => {
    const n = createNeedsManager({ now: () => 0, initial: { thirst: 0.9 } })
    n.load(null)
    expect(n.snapshot().thirst).toBe(0)
  })

  it('applyOfflineRise adds real elapsed rise for short gaps (no MAX_TICK clamp)', () => {
    const n = createNeedsManager({ now: () => 0, getPersonality: () => 'calm' })
    n.applyOfflineRise(10 * 60000) // 10 minutes offline
    // thirst rises 1/45 per min → 10/45 ≈ 0.222 (a real 10-min rise, not 1-min)
    expect(n.snapshot().thirst).toBeCloseTo(10 / 45, 2)
  })

  it('caps the per-need added delta at 0.5 for an overnight gap', () => {
    const n = createNeedsManager({ now: () => 0, getPersonality: () => 'calm' })
    n.applyOfflineRise(8 * 60 * 60000) // 8 hours
    // uncapped thirst would be 8*60/45 > 10 → capped to +0.5
    expect(n.snapshot().thirst).toBe(0.5)
    expect(n.snapshot().care).toBeCloseTo(0.5, 5) // slowest need also capped-or-less
  })

  it('cap is an added delta, not a target — already-high needs keep their level and clamp at 1', () => {
    const n = createNeedsManager({ now: () => 0, getPersonality: () => 'calm' })
    n.setNeed('thirst', 0.8)
    n.applyOfflineRise(8 * 60 * 60000)
    expect(n.snapshot().thirst).toBe(1) // 0.8 + 0.5 → clamp 1 (not pulled DOWN to 0.5)
  })

  it('after load+applyOfflineRise the next tick does not double-count the gap', () => {
    let t = 0
    const n = createNeedsManager({ now: () => t, getPersonality: () => 'calm' })
    t = 60 * 60000 // "woke up" an hour later
    n.load({ thirst: 0.1 }, t)
    n.applyOfflineRise(60 * 60000, t)
    const afterRestore = n.snapshot().thirst
    n.tick(t) // same instant — dt 0
    expect(n.snapshot().thirst).toBe(afterRestore)
  })
})
