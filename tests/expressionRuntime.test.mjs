// 자율 미세표정(J단계) — 소유권 안전 계약과 brow flick / micro-smile 동작.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setExpressionEmotion,
  resetExpression,
  updateExpression,
  computeHoldMs,
} from '../src/expressionRuntime.js'

describe('expressionRuntime — computeHoldMs (감정 유지시간 변조)', () => {
  const mid = () => 0.5 // 지터 중립(1.0배)
  it('감정 종류별로 기준 유지시간이 다르다 (surprised 짧고 sad 길다)', () => {
    expect(computeHoldMs('surprised', mid)).toBeLessThan(computeHoldMs('happy', mid))
    expect(computeHoldMs('happy', mid)).toBeLessThan(computeHoldMs('sad', mid))
  })
  it('알 수 없는 감정은 기본값(6000)로 폴백', () => {
    expect(computeHoldMs('bogus', mid)).toBe(6000)
  })
  it('지터가 ±18% 범위로 값을 흔든다 (고정 6초 아님)', () => {
    const lo = computeHoldMs('happy', () => 0) // -18%
    const hi = computeHoldMs('happy', () => 1) // +18%
    expect(lo).toBe(Math.round(6500 * 0.82))
    expect(hi).toBe(Math.round(6500 * 1.18))
    expect(lo).not.toBe(hi)
  })
})

// 표정 모프 + *건드리면 안 되는* 의상/뚫림방지 모프를 섞은 가짜 모델.
function makeModel(extraMorphs = []) {
  const names = ['まばたき', '笑い', 'にこり', 'にっこり', '困る', '怒り',
    '眉上移動', 'びっくり', '貫通対策', 'ON_スカート', ...extraMorphs]
  const morphs = {}
  names.forEach((n, i) => { morphs[n] = i })
  const influences = new Array(names.length).fill(0)
  return {
    model: { type: 'mmd', obj: { morphTargetInfluences: influences }, morphs },
    influences, morphs,
  }
}

function step(model, seconds, dt = 1 / 60, personality = { expressiveness: 0.6 }) {
  const frames = Math.round(seconds / dt)
  for (let i = 0; i < frames; i += 1) updateExpression(model, dt, 0, personality)
}

describe('expressionRuntime — autonomous micro-expression ownership safety', () => {
  beforeEach(() => resetExpression())

  it('never touches costume / anti-clip morphs (貫通対策, ON_xxx)', () => {
    const { model, influences, morphs } = makeModel()
    // 모델 제작자가 켜둔 뚫림방지/의상 토글을 1.0으로 고정.
    influences[morphs['貫通対策']] = 1.0
    influences[morphs['ON_スカート']] = 1.0
    setExpressionEmotion('happy')
    step(model, 5)
    // 자율/감정 어느 패스도 이 모프들을 덮어쓰지 않는다.
    expect(influences[morphs['貫通対策']]).toBe(1.0)
    expect(influences[morphs['ON_スカート']]).toBe(1.0)
  })

  it('brow flick raises 眉上移動 within a few seconds (neutral)', () => {
    const { model, influences, morphs } = makeModel()
    let maxBrow = 0
    const dt = 1 / 60
    for (let i = 0; i < Math.round(3 / dt); i += 1) {
      updateExpression(model, dt, 0, { expressiveness: 0.6 })
      maxBrow = Math.max(maxBrow, influences[morphs['眉上移動']])
    }
    expect(maxBrow).toBeGreaterThan(0.05)
    expect(maxBrow).toBeLessThanOrEqual(1.0)
  })

  it('micro-smile keeps にこり faintly positive in neutral but small', () => {
    const { model, influences, morphs } = makeModel()
    let maxSmile = 0
    const dt = 1 / 60
    for (let i = 0; i < Math.round(6 / dt); i += 1) {
      updateExpression(model, dt, 0, { expressiveness: 0.5 })
      maxSmile = Math.max(maxSmile, influences[morphs['にこり']])
    }
    expect(maxSmile).toBeGreaterThan(0)
    expect(maxSmile).toBeLessThan(0.2) // 옅은 미소지 활짝 웃음 아님
  })

  it('suppresses autonomous micro-smile while angry', () => {
    const { model, influences, morphs } = makeModel()
    setExpressionEmotion('angry')
    let maxSmile = 0
    const dt = 1 / 60
    for (let i = 0; i < Math.round(3 / dt); i += 1) {
      updateExpression(model, dt, 0, { expressiveness: 0.8 })
      maxSmile = Math.max(maxSmile, influences[morphs['にこり']])
    }
    // angry 프리셋은 にこり를 안 쓰고 자율 미소도 꺼지므로 ~0.
    expect(maxSmile).toBeLessThan(0.02)
  })

  it('blink still works and is reduced by 笑い (eye-smile)', () => {
    const { model, influences, morphs } = makeModel()
    updateExpression(model, 1 / 60, 1.0, { expressiveness: 0.5 })
    expect(influences[morphs['まばたき']]).toBeGreaterThan(0.5) // 깜빡임 적용
  })
})
