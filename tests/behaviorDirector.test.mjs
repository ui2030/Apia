/**
 * Pure tests for src/behaviorDirector.js — the LLM behavior director core.
 *
 * Per Codex pre-review, the director must be a *modulation* layer that fails
 * safe: any parse/enum/ttl/timeout/network failure resolves to directive=null
 * and the rule-based behavior continues. These tests lock that contract plus
 * the runner's single-flight / min-interval / backoff / expiry semantics with
 * an injected clock so they stay deterministic (no real timers for logic).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildDirectorContext,
  parseDirective,
  directiveActive,
  applyDirective,
  createDirectorRunner
} from '../src/behaviorDirector.js'

const BASE_CFG = { walkShare: 0.36, inPlaceIdleBias: 0.28, chairBias: 0.5 }

describe('buildDirectorContext', () => {
  it('normalizes and clamps fields', () => {
    const c = buildDirectorContext({ hour: 14, personality: 'active', attentiveness: 0.731, idleStreakMs: 185000, presence: 'away', awayMs: 421000 })
    expect(c).toEqual({ hour: 14, personality: 'active', attentiveness: 0.73, idleMinutes: 3, presence: 'away', awayMinutes: 7 })
  })
  it('falls back on missing/invalid input', () => {
    const c = buildDirectorContext({})
    expect(c).toEqual({ hour: null, personality: 'calm', attentiveness: 0, idleMinutes: 0, presence: 'active', awayMinutes: 0 })
  })
  it('clamps out-of-range hour and attentiveness', () => {
    const c = buildDirectorContext({ hour: 99, attentiveness: 5 })
    expect(c.hour).toBe(23)
    expect(c.attentiveness).toBe(1)
  })
  it('whitelists presence values (unknown → active)', () => {
    expect(buildDirectorContext({ presence: 'zombie' }).presence).toBe('active')
    expect(buildDirectorContext({ presence: 'short-idle' }).presence).toBe('short-idle')
  })
})

describe('parseDirective', () => {
  const now = 1_000_000

  it('parses a clean object', () => {
    const d = parseDirective({ mood: 'restless', focus: 'room', activityBias: 0.5, ttlSec: 300, note: 'bored' }, now)
    expect(d).toMatchObject({ mood: 'restless', focus: 'room', activityBias: 0.5, note: 'bored' })
    expect(d.expiresAt).toBe(now + 300_000)
  })

  it('extracts JSON embedded in prose / markdown fences', () => {
    const raw = 'Sure! ```json\n{"mood":"focused","activityBias":-0.3}\n``` hope that helps'
    const d = parseDirective(raw, now)
    expect(d.mood).toBe('focused')
    expect(d.activityBias).toBe(-0.3)
  })

  it('rejects non-JSON strings', () => {
    expect(parseDirective('no json here', now)).toBeNull()
    expect(parseDirective('{ not valid json', now)).toBeNull()
  })

  it('rejects null / arrays / primitives', () => {
    expect(parseDirective(null, now)).toBeNull()
    expect(parseDirective([1, 2], now)).toBeNull()
    expect(parseDirective(42, now)).toBeNull()
  })

  it('drops out-of-enum mood/focus but keeps usable bias', () => {
    const d = parseDirective({ mood: 'hyperdrive', focus: 'mars', activityBias: 0.2 }, now)
    expect(d.mood).toBeNull()
    expect(d.focus).toBeNull()
    expect(d.activityBias).toBe(0.2)
  })

  it('returns null when no dimension is usable', () => {
    expect(parseDirective({ mood: 'bogus', focus: 'bogus' }, now)).toBeNull()
    expect(parseDirective({ note: 'just a note' }, now)).toBeNull()
  })

  it('clamps activityBias and ttlSec to range', () => {
    const hi = parseDirective({ activityBias: 9, ttlSec: 99999 }, now)
    expect(hi.activityBias).toBe(1)
    expect(hi.expiresAt).toBe(now + TTL_MAX())

    const lo = parseDirective({ activityBias: -9, ttlSec: 1 }, now)
    expect(lo.activityBias).toBe(-1)
    expect(lo.expiresAt).toBe(now + 120_000) // ttl floor 120s
  })

  it('defaults ttl when missing and truncates note to 80 chars', () => {
    const d = parseDirective({ mood: 'calm', note: 'x'.repeat(200) }, now)
    expect(d.expiresAt).toBe(now + 300_000) // default 300s
    expect(d.note.length).toBe(80)
  })

  function TTL_MAX() { return 600_000 }
})

describe('directiveActive', () => {
  it('is true only before expiry', () => {
    const d = { expiresAt: 5000 }
    expect(directiveActive(d, 4999)).toBe(true)
    expect(directiveActive(d, 5000)).toBe(false)
    expect(directiveActive(null, 0)).toBe(false)
    expect(directiveActive({}, 0)).toBe(false)
  })
})

describe('applyDirective', () => {
  const now = 0
  const live = (extra) => ({ activityBias: 0, expiresAt: now + 10_000, mood: null, focus: null, ...extra })

  it('returns config unchanged when directive is null or expired', () => {
    expect(applyDirective(BASE_CFG, null, now)).toBe(BASE_CFG)
    expect(applyDirective(BASE_CFG, { ...live(), expiresAt: now - 1 }, now)).toBe(BASE_CFG)
  })

  it('positive activityBias raises walk, lowers idle (weak ±0.25)', () => {
    const out = applyDirective(BASE_CFG, live({ activityBias: 1 }), now)
    expect(out.walkShare).toBeGreaterThan(BASE_CFG.walkShare)
    expect(out.inPlaceIdleBias).toBeLessThan(BASE_CFG.inPlaceIdleBias)
    // weak: within ~25% swing, not a full takeover
    expect(out.walkShare).toBeLessThan(BASE_CFG.walkShare * 1.30)
    expect(out).not.toBe(BASE_CFG) // new object
  })

  it('negative activityBias lowers walk, raises idle', () => {
    const out = applyDirective(BASE_CFG, live({ activityBias: -1 }), now)
    expect(out.walkShare).toBeLessThan(BASE_CFG.walkShare)
    expect(out.inPlaceIdleBias).toBeGreaterThan(BASE_CFG.inPlaceIdleBias)
  })

  it('keeps walk+idle within the 0.94 cap', () => {
    const out = applyDirective({ walkShare: 0.6, inPlaceIdleBias: 0.5 }, live({ activityBias: -1, mood: 'sleepy' }), now)
    expect(out.walkShare + out.inPlaceIdleBias).toBeLessThanOrEqual(0.9401)
  })

  it('respects clamp floors/ceilings', () => {
    const out = applyDirective({ walkShare: 0.16, inPlaceIdleBias: 0.13 }, live({ activityBias: -1, mood: 'sleepy' }), now)
    expect(out.walkShare).toBeGreaterThanOrEqual(0.15)
    expect(out.inPlaceIdleBias).toBeLessThanOrEqual(0.5)
  })

  it('maps each director mood to an idle gesture flavor', () => {
    expect(applyDirective(BASE_CFG, live({ mood: 'focused' }), now).idleMood).toBe('engaged')
    expect(applyDirective(BASE_CFG, live({ mood: 'playful' }), now).idleMood).toBe('energetic')
    expect(applyDirective(BASE_CFG, live({ mood: 'calm' }), now).idleMood).toBe('quiet')
    expect(applyDirective(BASE_CFG, live({ mood: 'sleepy' }), now).idleMood).toBe('quiet')
    expect(applyDirective(BASE_CFG, live({ mood: 'restless' }), now).idleMood).toBe('fidgety')
  })

  it('user focus forces engaged, overriding a quiet/restless mood', () => {
    expect(applyDirective(BASE_CFG, live({ focus: 'user' }), now).idleMood).toBe('engaged')
    expect(applyDirective(BASE_CFG, live({ mood: 'sleepy', focus: 'user' }), now).idleMood).toBe('engaged')
    expect(applyDirective(BASE_CFG, live({ mood: 'restless', focus: 'user' }), now).idleMood).toBe('engaged')
  })

  it('keeps config.idleMood when mood has no flavor mapping and focus is not user', () => {
    // null mood / room focus → 매핑 없음 → 기존 idleMood 유지(여기선 미설정=undefined).
    expect(applyDirective(BASE_CFG, live({ focus: 'room' }), now).idleMood).toBeUndefined()
    expect(applyDirective({ ...BASE_CFG, idleMood: 'engaged' }, live({ focus: 'room' }), now).idleMood).toBe('engaged')
  })
})

describe('createDirectorRunner', () => {
  const ctx = { hour: 2 }

  it('returns parsed directive and enforces min-interval (single success)', async () => {
    let t = 0
    const call = vi.fn().mockResolvedValue({ mood: 'sleepy', activityBias: -0.4, ttlSec: 300 })
    const runner = createDirectorRunner({ call, now: () => t, minIntervalMs: 200000, jitterMs: 0 })

    const d = await runner.maybeRun(ctx)
    expect(d.mood).toBe('sleepy')
    expect(call).toHaveBeenCalledTimes(1)

    // within min interval → no second call
    t = 100000
    await runner.maybeRun(ctx)
    expect(call).toHaveBeenCalledTimes(1)

    // past min interval → calls again
    t = 200001
    await runner.maybeRun(ctx)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('absorbs a thrown call and backs off, keeping directive null', async () => {
    let t = 0
    const call = vi.fn().mockRejectedValue(new Error('network'))
    const runner = createDirectorRunner({ call, now: () => t, backoffBaseMs: 60000 })

    expect(await runner.maybeRun(ctx)).toBeNull()
    expect(runner.current(t)).toBeNull()

    // still in backoff window → no new call
    t = 30000
    await runner.maybeRun(ctx)
    expect(call).toHaveBeenCalledTimes(1)

    // backoff (1 fail → 60s) elapsed → retries, fails again → longer backoff
    t = 60001
    await runner.maybeRun(ctx)
    expect(call).toHaveBeenCalledTimes(2)
    t = 90000 // 2 fails → 120s backoff, not yet elapsed
    await runner.maybeRun(ctx)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('treats unusable LLM output as failure (backoff, null)', async () => {
    let t = 0
    const call = vi.fn().mockResolvedValue('garbage not json')
    const runner = createDirectorRunner({ call, now: () => t, backoffBaseMs: 60000 })
    expect(await runner.maybeRun(ctx)).toBeNull()
  })

  it('times out a hung call and fails safe', async () => {
    let t = 0
    const call = () => new Promise(() => {}) // never resolves
    const runner = createDirectorRunner({ call, now: () => t, timeoutMs: 20 })
    const d = await runner.maybeRun(ctx)
    expect(d).toBeNull()
  })

  it('expires a directive after its ttl (returns to null)', async () => {
    let t = 0
    const call = vi.fn().mockResolvedValue({ activityBias: 0.5, ttlSec: 120 })
    const runner = createDirectorRunner({ call, now: () => t, jitterMs: 0 })
    await runner.maybeRun(ctx)
    expect(runner.current(0)).not.toBeNull()
    expect(runner.current(120001)).toBeNull() // ttl 120s elapsed
  })

  it('single-flights concurrent calls', async () => {
    let t = 0
    let resolveCall
    const call = vi.fn(() => new Promise((r) => { resolveCall = r }))
    const runner = createDirectorRunner({ call, now: () => t })
    const p1 = runner.maybeRun(ctx)
    const p2 = runner.maybeRun(ctx) // in-flight → must not call again
    expect(call).toHaveBeenCalledTimes(1)
    resolveCall({ activityBias: 0.2 })
    await Promise.all([p1, p2])
  })

  it('reset clears directive and timers', async () => {
    let t = 0
    const call = vi.fn().mockResolvedValue({ activityBias: 0.5 })
    const runner = createDirectorRunner({ call, now: () => t, minIntervalMs: 999999, jitterMs: 0 })
    await runner.maybeRun(ctx)
    runner.reset()
    expect(runner.current(0)).toBeNull()
    await runner.maybeRun(ctx) // min-interval was reset → allowed again
    expect(call).toHaveBeenCalledTimes(2)
  })
})
