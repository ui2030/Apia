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

// 시간대 기초 활기 곡선(엔진 공통 모양) + 캐릭터 크로노타입 시프트.
// shift(+)는 아침형(곡선을 앞당김 — 일찍 활기, 일찍 차분), shift(−)는 저녁형.
// 곡선 모양 자체는 엔진 소유, "언제 활기찬가"는 캐릭터 프로필 소유(dailyRhythm).
// 위에 adaptationStore의 학습된 hour bias가 곱연쇄된다(프로필=사전값, 학습=보정).
export function timeOfDayEnergyCurve(hour, shift = 0) {
  const base = Number.isFinite(hour) ? Math.floor(hour) : 12
  const s = Number.isFinite(shift) ? Math.round(shift) : 0
  const h = ((base + s) % 24 + 24) % 24
  if (h < 6) return 0.55 // 깊은 밤 — 느긋
  if (h < 11) return 1.12 // 아침 — 활기
  if (h < 17) return 1.0 // 낮 — 평소
  if (h < 22) return 0.9 // 저녁 — 살짝 차분
  return 0.65 // 늦은 밤
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
