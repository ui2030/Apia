// src/adaptationStore.js
//
// #1 "너를 학습하는" 적응 레이어 1차 — 사용자의 **하루 리듬**을 누적 학습해
// 자율 행동의 활기(timeOfDayEnergy)를 사용자에게 맞춘다. 자주 함께하는 시간대엔
// 더 활발, 거의 없는 시간대엔 더 차분. "처음엔 어색(중립)해도 쓸수록 너에게 맞아
// 자연스러워진다"의 실제 구현([[apia-vision]]).
//
// 설계 원칙(안전 우선):
//  - 데이터가 충분히 쌓이기 전(MIN_DATA)엔 항상 중립(1.0) — 처음부터 엉뚱하게
//    치우치지 않는다.
//  - 바이어스는 **부드럽게**(±BIAS_RANGE) — 규칙(시간대·성격)을 덮어쓰지 않고
//    살짝 변조만. 학습이 빗나가도 행동이 망가지지 않는다.
//  - 매 상호작용마다 전 시간대를 미세 감쇠(DECAY) 후 현재 시간대 +1 → 루틴이
//    바뀌면 옛 패턴이 서서히 사라지고 최근 리듬을 따른다(타임스탬프 불필요).
//  - 순수 모듈(I/O 없음). 영속화는 호출자(main.js)가 serialize/load로 처리해
//    테스트가 쉽다.

const HOURS = 24
const MIN_DATA = 24       // 이만큼 상호작용이 쌓이기 전엔 중립
const DECAY = 0.997       // 상호작용 1건마다 전 시간대에 곱하는 감쇠(루틴 변화 추종)
const BIAS_RANGE = 0.18   // 최대 ±18% 변조(부드럽게)
const BIAS_GAIN = 0.12    // (시간대 활동/평균 - 1)에 곱하는 민감도

// 4단계 — 제스처 선호(밴딧-lite): 어떤 idle 제스처 뒤에 사용자가 관여(대화)했는지
// 누적해 pickIdleMotion을 가중. 신호가 약해(상관≠인과) gain·범위 모두 보수적.
const GEST_MIN = 12       // 총 보상 이만큼 전엔 중립(탐험)
const GEST_DECAY = 0.99   // 보상 1건마다 전 제스처값 감쇠(최근 선호 추종)
const GEST_GAIN = 0.3
const GEST_BIAS_LO = 0.75
const GEST_BIAS_HI = 1.25

// 4단계 — 페이스(곁/독립): 장기 상호작용 밀도로 사용자가 곁에 머물길(자주 관여) vs
// 독립적이길(드물게) 학습. closeness EMA(0.5 중립). 곁↑이면 walk↓·idle↑.
const PACE_MIN = 20
const PACE_ALPHA = 0.02
const PACE_WALK_LO = 0.7, PACE_WALK_HI = 1.3
const PACE_IDLE_LO = 0.7, PACE_IDLE_HI = 1.3

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

export function createAdaptation(initial = null) {
  const hours = new Array(HOURS).fill(0)
  let n = 0
  const gestureValue = Object.create(null)  // name -> 누적 선호값
  let gestRewards = 0
  let closeness = 0.5
  let paceN = 0
  if (initial && Array.isArray(initial.hours) && initial.hours.length === HOURS) {
    for (let i = 0; i < HOURS; i++) {
      const v = Number(initial.hours[i])
      hours[i] = Number.isFinite(v) && v >= 0 ? v : 0
    }
    n = Number.isFinite(initial.n) && initial.n >= 0 ? initial.n : 0
  }
  // 하위호환 — 아래 필드는 옛 저장본엔 없을 수 있다(없으면 기본=중립).
  if (initial && initial.gestureValue && typeof initial.gestureValue === 'object') {
    for (const k of Object.keys(initial.gestureValue)) {
      const v = Number(initial.gestureValue[k])
      if (Number.isFinite(v) && v >= 0) gestureValue[k] = v
    }
  }
  if (initial && Number.isFinite(initial.gestRewards) && initial.gestRewards >= 0) gestRewards = initial.gestRewards
  if (initial && Number.isFinite(initial.closeness)) closeness = clamp(initial.closeness, 0, 1)
  if (initial && Number.isFinite(initial.paceN) && initial.paceN >= 0) paceN = initial.paceN

  // 상호작용 1건 기록. hour 0..23 (보통 new Date().getHours()).
  function recordInteraction(hour) {
    const h = Number.isInteger(hour) ? ((hour % HOURS) + HOURS) % HOURS : 0
    for (let i = 0; i < HOURS; i++) hours[i] *= DECAY
    hours[h] += 1
    n += 1
  }

  // 이 시간대 활기 변조 계수. 데이터 부족/평균 0이면 1.0(중립).
  // 자주 쓰는 시간대 > 1(더 활발), 드문 시간대 < 1(더 차분).
  function getHourBias(hour) {
    if (n < MIN_DATA) return 1.0
    const h = Number.isInteger(hour) ? ((hour % HOURS) + HOURS) % HOURS : 0
    let sum = 0
    for (let i = 0; i < HOURS; i++) sum += hours[i]
    const mean = sum / HOURS
    if (mean <= 1e-6) return 1.0
    const ratio = hours[h] / mean
    return clamp(1 + (ratio - 1) * BIAS_GAIN, 1 - BIAS_RANGE, 1 + BIAS_RANGE)
  }

  // ── 4단계: 제스처 선호 ──────────────────────────────────────────────
  // 자율 idle 제스처가 재생된 뒤 일정 창 내에 사용자가 관여하면 호출(보상).
  function rewardGesture(name, r = 1) {
    if (typeof name !== 'string' || !name || !(r > 0)) return
    for (const k in gestureValue) gestureValue[k] *= GEST_DECAY
    gestureValue[name] = (gestureValue[name] || 0) + r
    gestRewards += 1
  }

  // 이 제스처의 선택 가중치 배수. 데이터 부족/미지 제스처면 1.0(중립=탐험 보장).
  function getGestureBias(name) {
    if (gestRewards < GEST_MIN) return 1.0
    if (!(name in gestureValue)) return 1.0
    const keys = Object.keys(gestureValue)
    if (keys.length === 0) return 1.0
    let sum = 0
    for (const k of keys) sum += gestureValue[k]
    const mean = sum / keys.length
    if (mean <= 1e-6) return 1.0
    const ratio = gestureValue[name] / mean
    return clamp(1 + (ratio - 1) * GEST_GAIN, GEST_BIAS_LO, GEST_BIAS_HI)
  }

  // ── 4단계: 페이스(곁/독립) ──────────────────────────────────────────
  // engaged=true: 사용자가 방금 관여(곁 선호 신호). false: 자율 행동 틱(독립 신호).
  function recordPace(engaged) {
    closeness += PACE_ALPHA * ((engaged ? 1 : 0) - closeness)
    paceN += 1
  }

  // walk/idle 배수. 곁↑(closeness>0.5)이면 walk↓·idle↑, 독립↑이면 반대. 부족 시 중립.
  function getPaceBias() {
    if (paceN < PACE_MIN) return { walkMul: 1, idleMul: 1 }
    const d = closeness - 0.5
    return {
      walkMul: clamp(1 - d * 0.6, PACE_WALK_LO, PACE_WALK_HI),
      idleMul: clamp(1 + d * 0.5, PACE_IDLE_LO, PACE_IDLE_HI)
    }
  }

  // 학습 성숙도(0..1) — UI/디버그용("얼마나 너를 파악했나").
  function maturity() { return clamp(n / (MIN_DATA * 8), 0, 1) }

  function serialize() {
    return { hours: hours.slice(), n, gestureValue: { ...gestureValue }, gestRewards, closeness, paceN }
  }

  return { recordInteraction, getHourBias, rewardGesture, getGestureBias, recordPace, getPaceBias, maturity, serialize }
}
