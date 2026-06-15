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
