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

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

export function createAdaptation(initial = null) {
  const hours = new Array(HOURS).fill(0)
  let n = 0
  if (initial && Array.isArray(initial.hours) && initial.hours.length === HOURS) {
    for (let i = 0; i < HOURS; i++) {
      const v = Number(initial.hours[i])
      hours[i] = Number.isFinite(v) && v >= 0 ? v : 0
    }
    n = Number.isFinite(initial.n) && initial.n >= 0 ? initial.n : 0
  }

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

  // 학습 성숙도(0..1) — UI/디버그용("얼마나 너를 파악했나").
  function maturity() { return clamp(n / (MIN_DATA * 8), 0, 1) }

  function serialize() { return { hours: hours.slice(), n } }

  return { recordInteraction, getHourBias, maturity, serialize }
}
