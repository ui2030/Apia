import { describe, it, expect } from 'vitest'
import { createAdaptation } from '../src/adaptationStore.js'

describe('adaptationStore — 하루 리듬 학습', () => {
  it('데이터 부족 시 항상 중립(1.0)', () => {
    const a = createAdaptation()
    expect(a.getHourBias(14)).toBe(1.0)
    for (let i = 0; i < 10; i++) a.recordInteraction(14)
    expect(a.getHourBias(14)).toBe(1.0) // 아직 MIN_DATA(24) 미만
  })

  it('자주 쓰는 시간대는 활기↑, 드문 시간대는 활기↓', () => {
    const a = createAdaptation()
    // 14시에 집중 상호작용(>= MIN_DATA)
    for (let i = 0; i < 40; i++) a.recordInteraction(14)
    const peak = a.getHourBias(14)
    const cold = a.getHourBias(3) // 한 번도 없던 시간대
    expect(peak).toBeGreaterThan(1.0)
    expect(cold).toBeLessThan(1.0)
    expect(peak).toBeGreaterThan(cold)
  })

  it('바이어스는 ±18% 안으로 부드럽게 제한', () => {
    const a = createAdaptation()
    for (let i = 0; i < 200; i++) a.recordInteraction(9)
    const b = a.getHourBias(9)
    expect(b).toBeLessThanOrEqual(1.18 + 1e-9)
    expect(b).toBeGreaterThanOrEqual(0.82 - 1e-9)
  })

  it('루틴이 바뀌면 옛 패턴이 서서히 사라지고 새 시간대를 따른다', () => {
    const a = createAdaptation()
    for (let i = 0; i < 60; i++) a.recordInteraction(9)   // 옛 루틴: 아침
    for (let i = 0; i < 300; i++) a.recordInteraction(21) // 새 루틴: 밤(충분히 길게)
    expect(a.getHourBias(21)).toBeGreaterThan(a.getHourBias(9))
  })

  it('serialize/load 라운드트립', () => {
    const a = createAdaptation()
    for (let i = 0; i < 30; i++) a.recordInteraction(20)
    const snap = a.serialize()
    const b = createAdaptation(snap)
    expect(b.getHourBias(20)).toBeCloseTo(a.getHourBias(20), 6)
  })

  it('잘못된 hour/저장값도 안전(크래시 없음, 중립 폴백)', () => {
    const a = createAdaptation({ hours: 'bad', n: -5 })
    expect(a.getHourBias(99)).toBe(1.0)
    expect(() => a.recordInteraction(undefined)).not.toThrow()
    expect(() => a.recordInteraction(-7)).not.toThrow()
  })
})

describe('adaptationStore — 제스처 선호(4단계)', () => {
  it('데이터 부족/미지 제스처는 중립(1.0=탐험 보장)', () => {
    const a = createAdaptation()
    expect(a.getGestureBias('idle_wave')).toBe(1.0)
    for (let i = 0; i < 5; i++) a.rewardGesture('idle_wave')
    expect(a.getGestureBias('idle_wave')).toBe(1.0) // 아직 GEST_MIN(12) 미만
  })

  it('자주 보상된 제스처는 가중↑, 안 받은 제스처(미지)는 중립', () => {
    const a = createAdaptation()
    for (let i = 0; i < 20; i++) a.rewardGesture('idle_wave')
    for (let i = 0; i < 2; i++) a.rewardGesture('idle_ponder')
    expect(a.getGestureBias('idle_wave')).toBeGreaterThan(1.0)
    expect(a.getGestureBias('idle_ponder')).toBeLessThan(1.0)
    expect(a.getGestureBias('idle_never')).toBe(1.0) // 미지 = 중립
  })

  it('제스처 가중은 [0.75,1.25] 안으로 보수적 제한', () => {
    const a = createAdaptation()
    for (let i = 0; i < 100; i++) a.rewardGesture('idle_wave')
    for (let i = 0; i < 100; i++) a.rewardGesture('idle_sway_relax')
    const b = a.getGestureBias('idle_wave')
    expect(b).toBeLessThanOrEqual(1.25 + 1e-9)
    expect(b).toBeGreaterThanOrEqual(0.75 - 1e-9)
  })

  it('rewardGesture 잘못된 입력 안전', () => {
    const a = createAdaptation()
    expect(() => a.rewardGesture(null)).not.toThrow()
    expect(() => a.rewardGesture('', 0)).not.toThrow()
    expect(() => a.rewardGesture('x', -1)).not.toThrow()
  })
})

describe('adaptationStore — 페이스 곁/독립(4단계)', () => {
  it('데이터 부족 시 중립 배수', () => {
    const a = createAdaptation()
    expect(a.getPaceBias()).toEqual({ walkMul: 1, idleMul: 1 })
  })

  it('자주 관여(곁)면 walk↓·idle↑, 드물면(독립) walk↑·idle↓', () => {
    const close = createAdaptation()
    for (let i = 0; i < 200; i++) close.recordPace(true)
    const indep = createAdaptation()
    for (let i = 0; i < 200; i++) indep.recordPace(false)
    expect(close.getPaceBias().walkMul).toBeLessThan(1.0)
    expect(close.getPaceBias().idleMul).toBeGreaterThan(1.0)
    expect(indep.getPaceBias().walkMul).toBeGreaterThan(1.0)
    expect(indep.getPaceBias().idleMul).toBeLessThan(1.0)
  })

  it('페이스 배수도 바운드 안', () => {
    const a = createAdaptation()
    for (let i = 0; i < 500; i++) a.recordPace(true)
    const p = a.getPaceBias()
    expect(p.walkMul).toBeGreaterThanOrEqual(0.7 - 1e-9)
    expect(p.idleMul).toBeLessThanOrEqual(1.3 + 1e-9)
  })
})

describe('adaptationStore — serialize 하위호환(4단계 필드 포함)', () => {
  it('신규 필드 라운드트립 + 옛 저장본(필드 없음) 안전', () => {
    const a = createAdaptation()
    for (let i = 0; i < 20; i++) { a.rewardGesture('idle_wave'); a.recordPace(true) }
    const snap = a.serialize()
    const b = createAdaptation(snap)
    expect(b.getGestureBias('idle_wave')).toBeCloseTo(a.getGestureBias('idle_wave'), 6)
    expect(b.getPaceBias()).toEqual(a.getPaceBias())
    // 옛 저장본(하루리듬만)도 크래시 없이 중립
    const old = createAdaptation({ hours: new Array(24).fill(1), n: 30 })
    expect(old.getGestureBias('idle_wave')).toBe(1.0)
    expect(old.getPaceBias()).toEqual({ walkMul: 1, idleMul: 1 })
  })
})
