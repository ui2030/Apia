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

describe('expressionRuntime — 모프명 별칭 어댑터 (모델 불문)', () => {
  it('비표준(영문) 모프명 모델도 별칭으로 표정이 나오고, 관리 밖 모프는 보존', () => {
    const names = ['blink', 'smile', 'joy', 'grin', 'surprised', 'brow_up', 'angry', '貫通対策']
    const morphs = {}; names.forEach((n, i) => { morphs[n] = i })
    const influences = new Array(names.length).fill(0)
    const model = { type: 'mmd', obj: { morphTargetInfluences: influences }, morphs }
    resetExpression()
    setExpressionEmotion('happy')
    for (let i = 0; i < 30; i++) updateExpression(model, 1 / 60, 0, { expressiveness: 0.5 })
    expect(influences[morphs.smile]).toBeGreaterThan(0.2) // 笑い→smile 별칭 해석
    expect(influences[morphs['貫通対策']]).toBe(0)        // 관리 대상 밖 불가침
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

describe('expressionRuntime — 클립 소유 모프 양보 (연기 VMD 표정 보존)', () => {
  it('재생 중인 클립이 연기하는 모프는 절차 표정이 덮지 않는다', () => {
    const { model, influences, morphs } = makeModel()
    model._vmdClipActive = true
    model._clipMorphNames = new Set(['笑い']) // 클립이 미소를 연기 중
    influences[morphs['笑い']] = 0.9 // 클립(mixer)이 쓴 값이라 가정
    resetExpression()
    setExpressionEmotion('happy') // 프리셋도 笑い를 올리려 함
    step(model, 0.5)
    expect(influences[morphs['笑い']]).toBe(0.9) // 클립 값 보존(양보)
    expect(influences[morphs['にっこり']]).toBeGreaterThan(0.2) // 비소유 모프는 정상 구동
  })

  it('클립이 깜빡임(まばたき)을 연기하면 절차 깜빡임이 양보한다', () => {
    const { model, influences, morphs } = makeModel()
    model._vmdClipActive = true
    model._clipMorphNames = new Set(['まばたき'])
    influences[morphs['まばたき']] = 0.7 // 클립이 연출한 깜빡임 타이밍
    resetExpression()
    updateExpression(model, 1 / 60, 1.0, { expressiveness: 0.5 }) // 절차 blink=1.0 요청
    expect(influences[morphs['まばたき']]).toBe(0.7) // 덮지 않음
  })

  it('클립 반납 순간 화면 값에서 이어받아 팝이 없다 (내부 가중 시드)', () => {
    const { model, influences, morphs } = makeModel()
    resetExpression()
    setExpressionEmotion('neutral') // 목표 0 — 내부 가중은 0으로 수렴 중
    model._vmdClipActive = true
    model._clipMorphNames = new Set(['笑い'])
    influences[morphs['笑い']] = 0.9 // 클립이 그린 미소
    step(model, 0.5)
    expect(influences[morphs['笑い']]).toBe(0.9) // 소유 중엔 보존
    model._vmdClipActive = false // 클립 반납
    updateExpression(model, 1 / 60, 0, { expressiveness: 0 })
    const after = influences[morphs['笑い']]
    expect(after).toBeGreaterThan(0.8) // 0.9 근처에서 한 스텝 감쇠 시작
    expect(after).toBeLessThan(0.9) // 숨은 내부값(0)으로 점프하지 않음
  })

  it('클립이 끝나면(_vmdClipActive=false) 즉시 소유권이 절차 표정으로 복귀', () => {
    const { model, influences, morphs } = makeModel()
    model._vmdClipActive = false
    model._clipMorphNames = new Set(['まばたき']) // 잔존 목록은 무시돼야 함
    resetExpression()
    updateExpression(model, 1 / 60, 1.0, { expressiveness: 0.5 })
    expect(influences[morphs['まばたき']]).toBeCloseTo(1.0, 5)
  })
})

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
