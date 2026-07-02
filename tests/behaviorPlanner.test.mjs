/**
 * Tests for src/behaviorPlanner.js — J단계 행동 일관성(슬롯 반복 약화 + 걷기 후
 * 머무름 의도). 순수/주입식이라 결정론으로 검증한다.
 */
import { describe, it, expect } from 'vitest'
import { pickBehaviorSlot, createLingerIntent, timeOfDayEnergyCurve } from '../src/behaviorPlanner.js'

describe('pickBehaviorSlot — probability shape', () => {
  it('maps the rng range onto idle → walk → furniture in order', () => {
    // idle 0.3, walk 0.4, furniture max(0.06, 0.3)=0.3 → total 1.0
    const opts = { idleBias: 0.3, walkShare: 0.4 }
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.0 })).toBe('idle')
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.29 })).toBe('idle')
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.31 })).toBe('walk')
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.69 })).toBe('walk')
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.71 })).toBe('furniture')
    expect(pickBehaviorSlot({ ...opts, rng: () => 0.999 })).toBe('furniture')
  })

  it('keeps a minimum furniture slot even when idle+walk fill the budget', () => {
    // idle 0.5 + walk 0.5 → furniture still ≥0.06 of total mass
    let furniture = 0
    for (let i = 0; i < 100; i++) {
      const r = (i + 0.5) / 100
      if (pickBehaviorSlot({ idleBias: 0.5, walkShare: 0.5, rng: () => r }) === 'furniture') furniture++
    }
    expect(furniture).toBeGreaterThan(0)
  })

  it('halves the previous slot mass (weak repeat avoidance, not a ban)', () => {
    // 균일 rng 스윕으로 슬롯 비율을 센다.
    const count = (lastSlot) => {
      const c = { idle: 0, walk: 0, furniture: 0 }
      for (let i = 0; i < 1000; i++) {
        const r = (i + 0.5) / 1000
        c[pickBehaviorSlot({ idleBias: 0.3, walkShare: 0.4, lastSlot, rng: () => r })]++
      }
      return c
    }
    const base = count(null)
    const afterWalk = count('walk')
    expect(afterWalk.walk).toBeLessThan(base.walk * 0.7) // 확실히 줄었고
    expect(afterWalk.walk).toBeGreaterThan(0) // 금지는 아니다
    const afterIdle = count('idle')
    expect(afterIdle.idle).toBeLessThan(base.idle * 0.7)
    expect(afterIdle.idle).toBeGreaterThan(0)
  })

  it('survives garbage inputs with a sane default', () => {
    expect(['idle', 'walk', 'furniture']).toContain(pickBehaviorSlot({ idleBias: NaN, walkShare: -3, rng: () => 0.5 }))
    expect(pickBehaviorSlot()).toMatch(/^(idle|walk|furniture)$/)
  })
})

describe('timeOfDayEnergyCurve — 크로노타입 시프트', () => {
  it('balanced (shift 0) keeps the engine base curve', () => {
    expect(timeOfDayEnergyCurve(3)).toBe(0.55) // 깊은 밤
    expect(timeOfDayEnergyCurve(8)).toBe(1.12) // 아침
    expect(timeOfDayEnergyCurve(13)).toBe(1.0) // 낮
    expect(timeOfDayEnergyCurve(19)).toBe(0.9) // 저녁
    expect(timeOfDayEnergyCurve(23)).toBe(0.65) // 늦은 밤
  })

  it('morning person (+2) is lively earlier and calm earlier', () => {
    expect(timeOfDayEnergyCurve(5, 2)).toBe(1.12) // 5시부터 이미 아침 활기
    expect(timeOfDayEnergyCurve(21, 2)).toBe(0.65) // 21시엔 벌써 늦은 밤 모드
  })

  it('evening person (−3) is slow in the morning and lively at night', () => {
    expect(timeOfDayEnergyCurve(8, -3)).toBe(0.55) // 8시에도 아직 깊은 밤 느낌
    expect(timeOfDayEnergyCurve(23, -3)).toBe(0.9) // 23시에도 저녁 수준 활기
  })

  it('wraps around midnight and survives garbage input', () => {
    expect(timeOfDayEnergyCurve(23, 2)).toBe(timeOfDayEnergyCurve(1)) // 23+2=25→1
    expect(timeOfDayEnergyCurve(NaN)).toBe(1.0) // 기본 12시 취급
    expect(timeOfDayEnergyCurve(8, NaN)).toBe(1.12) // shift 무효 → 0
  })
})

describe('createLingerIntent — walk → look-around chaining', () => {
  it('consume() is true exactly once inside the window', () => {
    let t = 0
    const li = createLingerIntent({ now: () => t, windowMs: 45000 })
    expect(li.consume()).toBe(false) // 무장 전
    li.armAfterWalk()
    t += 10000
    expect(li.isArmed()).toBe(true)
    expect(li.consume()).toBe(true) // 도착 후 첫 틱
    expect(li.consume()).toBe(false) // 1회성
  })

  it('expires quietly past the window (interrupted walks do not force a linger)', () => {
    let t = 0
    const li = createLingerIntent({ now: () => t, windowMs: 45000 })
    li.armAfterWalk()
    t += 46000
    expect(li.isArmed()).toBe(false)
    expect(li.consume()).toBe(false)
  })

  it('re-arming refreshes the window', () => {
    let t = 0
    const li = createLingerIntent({ now: () => t, windowMs: 45000 })
    li.armAfterWalk()
    t += 40000
    li.armAfterWalk() // 새 걷기 시작
    t += 40000 // 첫 무장 기준으론 만료지만 재무장 기준으론 유효
    expect(li.consume()).toBe(true)
  })
})
