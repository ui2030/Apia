/**
 * Tests for src/activityRunner.js — the J단계 smart-object activity sequencer.
 *
 * Per Codex pre-review the runner must be a first-class, abort-token guarded
 * sequencer (not unguarded nested onArrive callbacks): isActive() gates the
 * scheduler, abort() releases held sit + clears timers/bubbles so an interrupt
 * (call-response) can take over cleanly, and stale callbacks after an abort
 * must no-op. Timers and arrivals are injected so the sequence is deterministic.
 */
import { describe, it, expect } from 'vitest'
import { createActivityRunner } from '../src/activityRunner.js'

function makeHarness({ personality = 'calm', objects: objOverride } = {}) {
  const calls = { walkTo: [], playMotion: [], showBubble: [], releaseSit: 0, finish: 0, attachProp: [], detachProp: 0, finishReasons: [], reach: [] }
  const timers = []
  const objects = objOverride || {
    coffeeMachine: { id: 'coffeeMachine', x: 2, z: 6 },
    chair: { id: 'chair', x: -0.7, z: 4.3, sitOffset: { x: 0, y: 0.04, z: -0.08 }, sitRotY: Math.PI, seatHeight: 0.45 },
    sink: { id: 'sink', x: 2.5, z: 3.9 }
  }
  const runner = createActivityRunner({
    walkTo: (cfg) => calls.walkTo.push(cfg),
    releaseSit: () => { calls.releaseSit++ },
    playMotion: (m) => calls.playMotion.push(m),
    pickPose: (o) => ({ category: 'idle', name: 'idle_pose', mood: o?.mood }),
    showBubble: (t, ms) => calls.showBubble.push([t, ms]),
    getObjectById: (id) => objects[id] || null,
    getPersonality: () => personality,
    attachProp: (spec) => calls.attachProp.push(spec),
    detachProp: () => { calls.detachProp++ },
    setReach: (on) => calls.reach.push(on),
    onFinish: (reason) => { calls.finish++; calls.finishReasons.push(reason) },
    setTimer: (fn, ms) => { const h = { fn, ms, cancelled: false, fired: false }; timers.push(h); return h },
    clearTimer: (h) => { if (h) h.cancelled = true }
  })

  // Fire the latest still-pending timer (one is pending at a time in practice).
  const fireTimer = () => {
    for (let i = timers.length - 1; i >= 0; i--) {
      if (!timers[i].cancelled && !timers[i].fired) { timers[i].fired = true; timers[i].fn(); return }
    }
    throw new Error('no pending timer to fire')
  }
  // Simulate arrival → invoke onArrive of the most recent walkTo.
  const arrive = () => {
    const last = calls.walkTo[calls.walkTo.length - 1]
    last?.onArrive?.()
  }
  const lastWalk = () => calls.walkTo[calls.walkTo.length - 1]
  const bubbleTexts = () => calls.showBubble.map((b) => b[0])

  return { runner, calls, timers, fireTimer, arrive, lastWalk, bubbleTexts }
}

const COFFEE = {
  id: 'brewCoffee',
  steps: [
    { kind: 'goto', targetId: 'coffeeMachine', bubble: 'b-goto-machine' },
    { kind: 'pose', durationMs: 4000, bubble: 'b-brew' },
    { kind: 'goto', targetId: 'chair', bubble: 'b-goto-chair' },
    { kind: 'sit', targetId: 'chair', durationMs: 9000, bubble: 'b-sip' },
    { kind: 'cleanup' }
  ]
}

describe('createActivityRunner — happy path (full coffee chain)', () => {
  it('runs goto → pose → goto → held-sit → cleanup in order, then finishes', () => {
    const h = makeHarness({ personality: 'calm' })
    expect(h.runner.start(COFFEE)).toBe(true)
    expect(h.runner.isActive()).toBe(true)

    // step0 goto coffeeMachine
    expect(h.lastWalk()).toMatchObject({ x: 2, z: 6 })
    expect(h.lastWalk().sitOffset).toBeUndefined()
    h.arrive()

    // step1 pose: plays a motion, waits on a timer
    expect(h.calls.playMotion.length).toBe(1)
    h.fireTimer()

    // step2 goto chair (plain walk, no sit yet)
    expect(h.lastWalk()).toMatchObject({ x: -0.7, z: 4.3 })
    expect(h.lastWalk().holdSit).toBeFalsy()
    h.arrive()

    // step3 sit: walk to chair WITH held sit + seat data
    expect(h.lastWalk()).toMatchObject({ x: -0.7, z: 4.3, holdSit: true, seatHeight: 0.45 })
    expect(h.lastWalk().sitOffset).toEqual({ x: 0, y: 0.04, z: -0.08 })
    h.arrive() // sit down → sip pose + dwell timer
    expect(h.calls.playMotion.length).toBe(2)
    expect(h.calls.releaseSit).toBe(0) // not released until dwell ends
    h.fireTimer() // dwell over → releaseSit, then cleanup

    expect(h.calls.releaseSit).toBe(1)
    // step4 cleanup (calm = tidy) → walk to sink
    expect(h.lastWalk()).toMatchObject({ x: 2.5, z: 3.9 })
    h.arrive() // → finish

    expect(h.runner.isActive()).toBe(false)
    expect(h.calls.finish).toBe(1)
    expect(h.bubbleTexts()).toContain('b-brew')
    expect(h.bubbleTexts()).toContain('컵은 정리하고~')
  })
})

const COFFEE_WITH_CUP = {
  id: 'brewCoffee',
  needFill: { comfort: 0.6 },
  steps: [
    { kind: 'goto', targetId: 'coffeeMachine' },
    { kind: 'prop', op: 'attach', propKind: 'cup', hand: 'right' },
    { kind: 'goto', targetId: 'chair' },
    { kind: 'sit', targetId: 'chair', durationMs: 9000 },
    { kind: 'prop', op: 'detach' },
    { kind: 'cleanup' }
  ]
}

describe('createActivityRunner — prop steps & finish reason', () => {
  it('attaches the cup after brew and detaches it after drinking; finish reason = complete', () => {
    const h = makeHarness({ personality: 'shy' }) // shy → cleanup has no sink trip
    h.runner.start(COFFEE_WITH_CUP)
    h.arrive() // goto machine done → prop attach → goto chair
    expect(h.calls.attachProp).toEqual([{ kind: 'cup', hand: 'right' }])
    h.arrive() // goto chair → sit
    h.arrive() // sit down → sip + dwell timer
    expect(h.calls.detachProp).toBe(0) // not yet
    h.fireTimer() // dwell over → releaseSit → prop detach → cleanup(shy: settle timer)
    expect(h.calls.detachProp).toBe(1)
    h.fireTimer() // cleanup settle → finish
    expect(h.runner.isActive()).toBe(false)
    expect(h.calls.finishReasons).toEqual(['complete'])
  })

  it('abort during the hold detaches the cup and reports reason = abort', () => {
    const h = makeHarness()
    h.runner.start(COFFEE_WITH_CUP)
    h.arrive() // prop attached
    expect(h.calls.attachProp.length).toBe(1)
    h.runner.abort()
    expect(h.calls.detachProp).toBe(1) // abort always detaches
    expect(h.calls.releaseSit).toBe(1)
    expect(h.calls.finishReasons).toEqual(['abort'])
  })
})

describe('createActivityRunner — reach (sip arm IK toggle)', () => {
  it('toggles reach on during a reach sit step and off when the dwell ends', () => {
    const h = makeHarness({ personality: 'shy' })
    h.runner.start({
      id: 'drink',
      steps: [
        { kind: 'sit', targetId: 'chair', durationMs: 5000, reach: true },
        { kind: 'cleanup' }
      ]
    })
    h.arrive() // sit down → reach ON
    expect(h.calls.reach).toEqual([true])
    h.fireTimer() // dwell ends → reach OFF, releaseSit, next
    expect(h.calls.reach).toEqual([true, false])
  })
})

describe('createActivityRunner — cleanup personality branch', () => {
  it('shy = leaves the cup (no sink trip), just finishes', () => {
    const h = makeHarness({ personality: 'shy' })
    h.runner.start(COFFEE)
    h.arrive() // after goto machine
    h.fireTimer() // after pose
    h.arrive() // after goto chair
    h.arrive() // sit down
    const walksBefore = h.calls.walkTo.length
    h.fireTimer() // dwell over → cleanup (shy)
    // shy does NOT walk to the sink
    expect(h.calls.walkTo.length).toBe(walksBefore)
    expect(h.bubbleTexts()).toContain('잘 마셨다.')
    h.fireTimer() // short settle timer → finish
    expect(h.runner.isActive()).toBe(false)
    expect(h.calls.finish).toBe(1)
  })
})

describe('createActivityRunner — abort / interrupt', () => {
  it('abort releases held sit, clears bubble, finishes, and stale callbacks no-op', () => {
    const h = makeHarness()
    h.runner.start(COFFEE)
    const staleArrive = h.lastWalk().onArrive // captured before abort

    h.runner.abort()
    expect(h.runner.isActive()).toBe(false)
    expect(h.calls.releaseSit).toBe(1) // abort always releases (harmless if not sitting)
    expect(h.calls.finish).toBe(1)
    // bubble cleared on abort
    expect(h.bubbleTexts()).toContain('')

    const walksBefore = h.calls.walkTo.length
    staleArrive?.() // stale onArrive after abort
    expect(h.calls.walkTo.length).toBe(walksBefore) // guarded → no new step
  })

  it('abort() on an idle runner is a no-op', () => {
    const h = makeHarness()
    h.runner.abort()
    expect(h.calls.finish).toBe(0)
    expect(h.calls.releaseSit).toBe(0)
  })

  it('is not wedged after an abort mid-goto — a fresh start runs again', () => {
    const h = makeHarness()
    h.runner.start(COFFEE) // step0 goto pending (onArrive not fired)
    h.runner.abort()
    expect(h.runner.isActive()).toBe(false)
    // The interrupt path (e.g. a furniture click / face-camera) calls abort then
    // issues its own walk; later autonomy must be able to start an activity again.
    expect(h.runner.start(COFFEE)).toBe(true)
    expect(h.runner.isActive()).toBe(true)
  })
})

describe('createActivityRunner — priority (call response)', () => {
  it('isPriority reflects the active activity; furniture activities are not priority', () => {
    const h = makeHarness()
    expect(h.runner.isPriority()).toBe(false)
    h.runner.start(COFFEE) // no priority flag
    expect(h.runner.isPriority()).toBe(false)
    expect(h.runner.currentId()).toBe('brewCoffee')
    h.runner.abort()
    h.runner.start({ id: 'respondCall', priority: true, steps: [{ kind: 'sit', targetId: 'chair', durationMs: 5000 }] })
    expect(h.runner.isPriority()).toBe(true)
    expect(h.runner.currentId()).toBe('respondCall')
  })
})

describe('createActivityRunner — gating & validation', () => {
  it('start() returns false when already active', () => {
    const h = makeHarness()
    expect(h.runner.start(COFFEE)).toBe(true)
    expect(h.runner.start(COFFEE)).toBe(false)
  })

  it('start() returns false for an empty / invalid activity', () => {
    const h = makeHarness()
    expect(h.runner.start(null)).toBe(false)
    expect(h.runner.start({ steps: [] })).toBe(false)
    expect(h.runner.isActive()).toBe(false)
  })

  it('skips a goto whose target is missing', () => {
    const h = makeHarness()
    h.runner.start({ id: 'x', steps: [{ kind: 'goto', targetId: 'nope' }, { kind: 'pose', durationMs: 100 }] })
    // no walkTo (target missing) but the pose step still runs
    expect(h.calls.walkTo.length).toBe(0)
    expect(h.calls.playMotion.length).toBe(1)
  })

  it('skips a sit whose target lacks seat data', () => {
    const objects = { stool: { id: 'stool', x: 1, z: 1 } } // no sitOffset
    const h = makeHarness({ objects })
    h.runner.start({ id: 'x', steps: [{ kind: 'sit', targetId: 'stool', durationMs: 100 }] })
    expect(h.calls.walkTo.length).toBe(0)
    expect(h.runner.isActive()).toBe(false) // skipped → finished
  })
})
