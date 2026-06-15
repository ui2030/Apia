import { describe, it, expect } from 'vitest'
import { createTouchClassifier, TOUCH_THRESHOLDS } from '../src/touchInteraction.js'

function mk() {
  const calls = { tap: 0, pet: 0, grab: 0 }
  const c = createTouchClassifier({
    onTap: () => calls.tap++,
    onPet: () => calls.pet++,
    onGrab: () => calls.grab++
  })
  return { c, calls }
}

describe('touchInteraction 분류기', () => {
  it('작은 이동·짧은 시간 = tap (캐릭터 위)', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'move', x: 103, y: 101, t: 50, onChar: true })
    c.feed({ type: 'up', x: 103, y: 101, t: 120, onChar: true })
    expect(calls).toEqual({ tap: 1, pet: 0, grab: 0 })
  })

  it('캐릭터 밖에서 시작하면 무시', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 0, y: 0, t: 0, onChar: false })
    c.feed({ type: 'up', x: 0, y: 0, t: 100, onChar: false })
    expect(calls).toEqual({ tap: 0, pet: 0, grab: 0 })
  })

  it('느린 큰 누적 이동(캐릭터 위) = pet, up에서 tap 안 남(배타)', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    // 작은 변위(제자리 근처)지만 왕복으로 누적 경로 > PET_PATH
    c.feed({ type: 'move', x: 120, y: 100, t: 100, onChar: true })
    c.feed({ type: 'move', x: 100, y: 100, t: 200, onChar: true })
    c.feed({ type: 'move', x: 120, y: 100, t: 300, onChar: true })
    c.feed({ type: 'up', x: 100, y: 100, t: 400, onChar: true })
    expect(calls.pet).toBeGreaterThanOrEqual(1)
    expect(calls.tap).toBe(0) // pet 확정이면 tap 안 남
    expect(calls.grab).toBe(0)
  })

  it('pet 반응은 throttle 간격으로 억제', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    // 빠른 연속 스트로크(throttle 800ms보다 짧은 간격으로 왕복) → 첫 1회만
    for (let i = 0; i < 6; i++) {
      c.feed({ type: 'move', x: (i % 2 ? 100 : 120), y: 100, t: 50 + i * 50, onChar: true })
    }
    expect(calls.pet).toBe(1)
    // throttle(800ms) 지난 뒤 한 번 더
    c.feed({ type: 'move', x: 120, y: 100, t: 1200, onChar: true })
    c.feed({ type: 'move', x: 100, y: 100, t: 1260, onChar: true })
    expect(calls.pet).toBe(2)
  })

  it('시작점에서 큰 변위 = grab, sticky(이후 pet/tap 없음)', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'move', x: 100 + TOUCH_THRESHOLDS.GRAB_DISP + 5, y: 100, t: 100, onChar: true })
    c.feed({ type: 'move', x: 400, y: 100, t: 200, onChar: true }) // 계속 끌어도 grab 1회
    c.feed({ type: 'up', x: 400, y: 100, t: 300, onChar: true })
    expect(calls).toEqual({ tap: 0, pet: 0, grab: 1 })
  })

  it('pet 도중 멀리 끌면 grab으로 승격(pet 후 grab)', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'move', x: 130, y: 100, t: 100, onChar: true }) // path 30
    c.feed({ type: 'move', x: 100, y: 100, t: 200, onChar: true }) // path 60>40 → pet
    c.feed({ type: 'move', x: 300, y: 100, t: 300, onChar: true }) // 변위>GRAB → grab
    c.feed({ type: 'up', x: 300, y: 100, t: 400, onChar: true })
    expect(calls.pet).toBeGreaterThanOrEqual(1)
    expect(calls.grab).toBe(1)
    expect(calls.tap).toBe(0)
  })

  it('up의 raycast가 false여도(손가락 살짝 벗어남) tap 인정', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'up', x: 102, y: 101, t: 100, onChar: false }) // up은 onChar=false
    expect(calls.tap).toBe(1)
  })

  it('느린 탭(시간 초과)은 tap 아님', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'up', x: 101, y: 100, t: 900, onChar: true }) // 400ms 초과
    expect(calls.tap).toBe(0)
  })

  it('cancel은 어떤 반응도 내지 않음', () => {
    const { c, calls } = mk()
    c.feed({ type: 'down', x: 100, y: 100, t: 0, onChar: true })
    c.feed({ type: 'cancel', x: 100, y: 100, t: 100, onChar: true })
    expect(calls).toEqual({ tap: 0, pet: 0, grab: 0 })
  })
})
