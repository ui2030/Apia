/**
 * Tests for src/presenceManager.js — J단계 user-presence state machine.
 *
 * Inputs are the raw main-process feeds only: system idle seconds (5s poll)
 * and powerMonitor suspend/resume/lock/unlock events. All transitions come out
 * of this one state machine (the idle poll and unlock events must never emit a
 * duplicate user-returned pair — Codex MUST-FIX). Clock is injected.
 */
import { describe, it, expect } from 'vitest'
import { createPresenceMonitor } from '../src/presenceManager.js'

function harness(opts = {}) {
  const events = []
  let t = 0
  const m = createPresenceMonitor({
    now: () => t,
    onTransition: (e) => events.push(e),
    ...opts
  })
  return { m, events, tick: (ms) => { t += ms }, time: () => t }
}

const MIN = 60000

describe('presenceManager — idle classification', () => {
  it('starts active and stays active for small idle values', () => {
    const { m, events } = harness()
    m.onIdle(3)
    m.onIdle(30)
    expect(m.getState()).toBe('active')
    expect(m.isPresent()).toBe(true)
    expect(events).toEqual([])
  })

  it('promotes to short-idle at 1min and away at 5min', () => {
    const { m, tick } = harness()
    tick(2 * MIN)
    m.onIdle(90)
    expect(m.getState()).toBe('short-idle')
    expect(m.isPresent()).toBe(true) // 잠깐 손 뗀 것 — 부재 아님
    tick(4 * MIN)
    m.onIdle(330)
    expect(m.getState()).toBe('away')
    expect(m.isPresent()).toBe(false)
  })

  it('ignores garbage idle input', () => {
    const { m } = harness()
    m.onIdle(-5)
    m.onIdle(NaN)
    m.onIdle(undefined)
    expect(m.getState()).toBe('active')
  })
})

describe('presenceManager — leave/return transitions', () => {
  it('emits user-left once when crossing into away', () => {
    const { m, events, tick } = harness()
    tick(6 * MIN)
    m.onIdle(310)
    m.onIdle(315) // still away — no duplicate
    expect(events.filter((e) => e.type === 'user-left')).toHaveLength(1)
  })

  it('emits user-returned with awayMs measured from when input stopped', () => {
    const { m, events, tick } = harness()
    tick(10 * MIN)
    m.onIdle(600) // idle for the full 10 min
    tick(5 * MIN)
    m.onIdle(1) // user came back
    const ret = events.find((e) => e.type === 'user-returned')
    expect(ret).toBeTruthy()
    // away started at t=0 (input stopped), returned at t=15min
    expect(ret.awayMs).toBe(15 * MIN)
    expect(m.getState()).toBe('active')
  })

  it('short-idle → active does not emit user-returned', () => {
    const { m, events, tick } = harness()
    tick(2 * MIN)
    m.onIdle(90)
    m.onIdle(1)
    expect(events).toEqual([])
  })
})

describe('presenceManager — greeting debounce', () => {
  it('greets on a return after a long absence', () => {
    const { m, events, tick } = harness()
    tick(10 * MIN); m.onIdle(600)
    tick(1 * MIN); m.onIdle(1)
    expect(events.find((e) => e.type === 'user-returned').greet).toBe(true)
  })

  it('does not greet twice within the debounce window', () => {
    const { m, events, tick } = harness()
    // first away/return — greeted
    tick(10 * MIN); m.onIdle(600)
    m.onIdle(1)
    // second away/return right after (away 6min, but last greet was just now)
    tick(6 * MIN); m.onIdle(360)
    m.onIdle(1)
    const rets = events.filter((e) => e.type === 'user-returned')
    expect(rets).toHaveLength(2)
    expect(rets[0].greet).toBe(true)
    expect(rets[1].greet).toBe(false)
  })

  it('greets again once the debounce window has passed', () => {
    const { m, events, tick } = harness()
    tick(10 * MIN); m.onIdle(600)
    m.onIdle(1)
    tick(20 * MIN) // well past the 10-min debounce
    m.onIdle(600) // away again (10min of that gap idle)
    m.onIdle(1)
    const rets = events.filter((e) => e.type === 'user-returned')
    expect(rets[1].greet).toBe(true)
  })
})

describe('presenceManager — lock/suspend events', () => {
  it('lock forces away immediately regardless of idle time', () => {
    const { m, events } = harness()
    m.onIdle(2) // active
    m.onEvent('lock-screen')
    expect(m.getState()).toBe('away')
    expect(events.filter((e) => e.type === 'user-left')).toHaveLength(1)
  })

  it('while locked, a small idle poll does NOT flip back to active', () => {
    const { m } = harness()
    m.onEvent('lock-screen')
    m.onIdle(2) // 잠금 화면에서 마우스 흔들어도 잠금 중엔 부재 유지
    expect(m.getState()).toBe('away')
  })

  it('unlock alone does not emit user-returned — the next input-confirming poll does (no double fire)', () => {
    const { m, events, tick } = harness()
    m.onEvent('lock-screen')
    tick(10 * MIN)
    m.onEvent('unlock-screen')
    expect(events.filter((e) => e.type === 'user-returned')).toHaveLength(0)
    m.onIdle(1) // real input observed after unlock
    const rets = events.filter((e) => e.type === 'user-returned')
    expect(rets).toHaveLength(1)
    expect(rets[0].awayMs).toBe(10 * MIN) // locked at t=0 → returned at t=10min
    expect(rets[0].greet).toBe(true)
  })

  it('suspend/resume behaves like lock/unlock', () => {
    const { m, events, tick } = harness()
    m.onEvent('suspend')
    expect(m.getState()).toBe('away')
    tick(30 * MIN)
    m.onEvent('resume')
    expect(m.getState()).toBe('away') // still needs input confirmation
    m.onIdle(0)
    expect(m.getState()).toBe('active')
    expect(events.filter((e) => e.type === 'user-returned')).toHaveLength(1)
  })

  it('awayMsNow reports elapsed absence while away and 0 when present', () => {
    const { m, tick } = harness()
    expect(m.awayMsNow()).toBe(0)
    m.onEvent('lock-screen')
    tick(7 * MIN)
    expect(m.awayMsNow()).toBe(7 * MIN)
    m.onEvent('unlock-screen')
    m.onIdle(1)
    expect(m.awayMsNow()).toBe(0)
  })
})

describe('presenceManager — onTransition safety', () => {
  it('a throwing onTransition callback never breaks the state machine', () => {
    let t = 0
    const m = createPresenceMonitor({
      now: () => t,
      onTransition: () => { throw new Error('listener bug') }
    })
    t = 10 * MIN
    m.onIdle(600)
    m.onIdle(1)
    expect(m.getState()).toBe('active') // state advanced despite the throw
  })
})
