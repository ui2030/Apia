// M2 절약 게이트 — VLM은 호출당 돈이 든다. 화면이 사실상 안 변했으면 안 부르는
// 판정이 정확해야 한다. 여기 잠그는 건 순수 계산부(Electron 없이 돈다).
import { describe, it, expect } from 'vitest'
import { toGray, frameDiff, frameStats, isDeadFrame } from '../electron/services/screenCapture.js'

// BGRA 버퍼 생성기 — 픽셀마다 같은 값(그레이스케일이면 그 값 그대로 나온다).
function bgra(values) {
  const buf = new Uint8Array(values.length * 4)
  values.forEach((v, i) => {
    buf[i * 4] = v      // B
    buf[i * 4 + 1] = v  // G
    buf[i * 4 + 2] = v  // R
    buf[i * 4 + 3] = 255
  })
  return buf
}

describe('toGray', () => {
  it('BGRA를 픽셀당 1바이트로 줄인다(회색은 값 보존 — 가중치 합이 256)', () => {
    expect(Array.from(toGray(bgra([0, 128, 255])))).toEqual([0, 128, 255])
  })

  it('채널 가중치가 R보다 G에 크다(Rec.601)', () => {
    const green = new Uint8Array([0, 255, 0, 255])   // B=0 G=255 R=0
    const red = new Uint8Array([0, 0, 255, 255])     // B=0 G=0   R=255
    expect(toGray(green)[0]).toBeGreaterThan(toGray(red)[0])
  })
})

describe('frameDiff', () => {
  it('같은 프레임이면 0', () => {
    const a = new Uint8Array([10, 20, 30])
    expect(frameDiff(a, new Uint8Array([10, 20, 30]))).toBe(0)
  })

  it('평균 절대차를 낸다', () => {
    expect(frameDiff(new Uint8Array([0, 0]), new Uint8Array([10, 20]))).toBe(15)
  })

  it('첫 프레임(이전 없음)은 Infinity — 안전한 쪽(호출)으로 넘어간다', () => {
    expect(frameDiff(null, new Uint8Array([1]))).toBe(Infinity)
  })

  it('크기가 바뀌면(창 리사이즈) Infinity', () => {
    expect(frameDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(Infinity)
  })

  it('임계 6 기준으로 미세 변화는 통과, 뚜렷한 변화는 걸린다', () => {
    const base = new Uint8Array(100).fill(100)
    const jitter = new Uint8Array(100).fill(103) // 평균 3 — 노이즈 수준
    const moved = new Uint8Array(100).fill(140)  // 평균 40 — 장면 전환
    expect(frameDiff(base, jitter)).toBeLessThan(6)
    expect(frameDiff(base, moved)).toBeGreaterThan(6)
  })
})

describe('frameStats / isDeadFrame', () => {
  it('단색 프레임의 분산은 0', () => {
    const { mean, variance } = frameStats(new Uint8Array(50).fill(120))
    expect(mean).toBe(120)
    expect(variance).toBe(0)
  })

  it('검은 화면은 죽은 프레임 — 전용 전체화면 신호', () => {
    expect(isDeadFrame(new Uint8Array(100).fill(0))).toBe(true)
  })

  it('단색이지만 밝은 화면도 죽은 프레임(내용 없음)', () => {
    expect(isDeadFrame(new Uint8Array(100).fill(200))).toBe(true)
  })

  it('내용이 있는 화면은 살아 있다', () => {
    const gray = new Uint8Array(100)
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) % 256
    expect(isDeadFrame(gray)).toBe(false)
  })

  it('빈 버퍼는 죽은 프레임', () => {
    expect(isDeadFrame(new Uint8Array(0))).toBe(true)
  })
})
