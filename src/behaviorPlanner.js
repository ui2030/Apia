// src/behaviorPlanner.js
//
// J단계(행동 일관성) — 자율 행동 슬롯 선택 + 걷기 후 머무름 의도.
//
// 기존 스케줄러는 매 틱 독립 Math.random으로 idle/walk/furniture를 굴려서
// ① 같은 종류 행동이 연달아 나오고 ② 걷기가 "목적 없이 이동만 하고 끝"이었다.
// 여기서는:
//  - pickBehaviorSlot: 직전 슬롯의 확률 질량을 절반으로 약화(완전 금지가 아니라
//    약한 회피 — 자연스러움 우선, 고착도 단조로움도 피한다).
//  - createLingerIntent: 걷기를 시작하면 무장(arm)되고, 도착 후 첫 idle 틱이
//    1회 소비해 "둘러보는" 제스처로 잇는다 = 걸어간 데 의도가 생긴다.
// 전부 순수/주입식(now·rng)이라 결정론 테스트 가능.

const FURNITURE_MIN = 0.06 // 가구 슬롯 최소 질량(항상 도달 가능)

export function pickBehaviorSlot({ idleBias = 0.28, walkShare = 0.36, lastSlot = null, repeatDamp = 0.5, rng = Math.random } = {}) {
  const nz = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d)
  const damp = Number.isFinite(repeatDamp) ? Math.min(1, Math.max(0, repeatDamp)) : 0.5
  let wIdle = nz(idleBias, 0.28)
  let wWalk = nz(walkShare, 0.36)
  let wFurn = Math.max(FURNITURE_MIN, 1 - wIdle - wWalk)
  if (lastSlot === 'idle') wIdle *= damp
  else if (lastSlot === 'walk') wWalk *= damp
  else if (lastSlot === 'furniture') wFurn *= damp
  const total = wIdle + wWalk + wFurn
  if (!(total > 0)) return 'idle'
  const r = rng() * total
  if (r < wIdle) return 'idle'
  if (r < wIdle + wWalk) return 'walk'
  return 'furniture'
}

// 걷기 후 머무름 의도. armAfterWalk()로 무장, consume()은 유효 창 안에서 1회만
// true(그 틱은 "도착해서 둘러보기"). 창을 넘기면 조용히 만료 — 도착 전에 다른
// 행동(대화·활동)이 끼어들었으면 억지로 잇지 않는다.
export function createLingerIntent({ now = () => Date.now(), windowMs = 45000 } = {}) {
  let until = 0

  function armAfterWalk() {
    until = now() + windowMs
  }

  function consume() {
    const armed = until > 0 && now() < until
    until = 0
    return armed
  }

  function isArmed() {
    return until > 0 && now() < until
  }

  return { armAfterWalk, consume, isArmed }
}
