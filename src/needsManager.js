// src/needsManager.js
//
// J단계 거주형 비서 — 욕구 + 성격 유틸리티 AI.
//
// 내부 욕구(목마름·피로·심심함·안락함·돌봄)가 시간에 따라 천천히 차오르고(성격이
// 속도를 가중), 각 스마트 오브젝트 활동은 자기가 어떤 욕구를 얼마나 채우는지
// (needFill) 선언한다. 매 결정 시 "욕구 × 활동이 채우는 양"으로 점수를 매겨
// 가장 높은 활동을 고른다(임계 미만이면 아무것도 안 하고 기존 idle/walk로 폴백).
// LLM이 아니라 거의 공짜 계산이라 상시 구동 가능 — LLM 디렉터는 그 위에 색만 입힘.
//
// 설계(Codex 검토 반영):
//  - 정상 완료에만 satisfy(욕구 차감). abort/인터럽트는 욕구를 채우지 않는다.
//  - 쿨다운/히스테리시스로 한 사물 고착 방지(방금 한 활동은 점수 큰 패널티).
//  - tick dt를 상한(절전/장시간 정지 후 욕구가 만렙으로 튀는 것 방지).
//  - 동점 부근은 약간의 무작위로 골라 단조로움 회피(argmax + epsilon).
//  - now/rng 주입으로 결정론적 테스트.

export const NEED_KEYS = ['thirst', 'tiredness', 'boredom', 'comfort', 'care', 'hygiene']

// 분당 상승량(0..1). 목마름·심심함이 빠르고 피로·돌봄·위생은 느리다.
const BASE_RISE_PER_MIN = {
  thirst: 1 / 45,
  tiredness: 1 / 150,
  boredom: 1 / 35,
  comfort: 1 / 80,
  care: 1 / 200,
  hygiene: 1 / 120
}

// 성격별 상승 가중(없는 키는 1). active=잘 심심해함·덜 안락 추구, shy=안락·돌봄↑,
// calm=중립.
const PERSONALITY_RISE = {
  active: { boredom: 1.4, tiredness: 1.2, comfort: 0.8 },
  shy: { comfort: 1.3, care: 1.3, boredom: 0.8 },
  calm: {}
}

const MAX_TICK_MS = 60000 // 한 틱 최대 1분치(절전 복귀 점프 방지)
const COOLDOWN_MS = 90000 // 같은 활동 재발동 억제 구간
const COOLDOWN_PENALTY = 0.15
const SCORE_THRESHOLD = 0.32 // 이 미만이면 활동 안 함(idle/walk로 폴백)
const EPSILON_BAND = 0.97 // 최고점의 이 비율 이상만 동점 취급(진짜 근소차만 무작위)

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function createNeedsManager({ now = () => Date.now(), rng = Math.random, getPersonality = () => 'calm', initial = null } = {}) {
  const needs = {}
  for (const k of NEED_KEYS) needs[k] = initial && Number.isFinite(initial[k]) ? clamp01(initial[k]) : 0
  const lastCompletedAt = new Map() // activityId → ms
  let lastTickAt = now()

  function riseMult(key) {
    const p = PERSONALITY_RISE[getPersonality?.()] || {}
    return p[key] || 1
  }

  // 시간 경과만큼 욕구를 올린다. dt 상한 적용.
  function tick(nowMs = now()) {
    let dt = nowMs - lastTickAt
    lastTickAt = nowMs
    if (!(dt > 0)) return
    if (dt > MAX_TICK_MS) dt = MAX_TICK_MS
    const minutes = dt / 60000
    for (const k of NEED_KEYS) {
      needs[k] = clamp01(needs[k] + BASE_RISE_PER_MIN[k] * riseMult(k) * minutes)
    }
  }

  function scoreActivity(activity, nowMs) {
    const fill = activity?.needFill || {}
    let score = 0
    for (const k of NEED_KEYS) {
      if (fill[k]) score += needs[k] * fill[k]
    }
    const last = lastCompletedAt.get(activity?.id)
    if (last != null && nowMs - last < COOLDOWN_MS) score *= COOLDOWN_PENALTY
    return score
  }

  // 후보 활동 중 점수 최고를 고른다(임계 미만이면 null). 동점 부근은 무작위.
  // ctx.directiveFocus가 활동 focus와 맞으면 약간 가산(LLM 디렉터의 약한 색칠).
  function chooseActivity(activities = [], ctx = {}) {
    const nowMs = now()
    const scored = []
    for (const a of activities) {
      if (!a || !a.needFill) continue
      let s = scoreActivity(a, nowMs)
      if (ctx.directiveFocus && a.focus && ctx.directiveFocus === a.focus) s *= 1.15
      if (s > 0) scored.push({ a, s })
    }
    if (!scored.length) return null
    let max = 0
    for (const e of scored) if (e.s > max) max = e.s
    if (max < SCORE_THRESHOLD) return null
    const top = scored.filter((e) => e.s >= max * EPSILON_BAND)
    const pick = top[Math.floor(rng() * top.length)] || top[0]
    return pick.a
  }

  // 정상 완료 시에만 호출 — 채워준 욕구를 차감하고 쿨다운 기록.
  function satisfy(activity, nowMs = now()) {
    const fill = activity?.needFill || {}
    for (const k of NEED_KEYS) {
      if (fill[k]) needs[k] = clamp01(needs[k] - fill[k])
    }
    if (activity?.id) lastCompletedAt.set(activity.id, nowMs)
  }

  function snapshot() {
    return { ...needs }
  }

  // 테스트/디버그용 — 욕구 직접 설정.
  function setNeed(key, value) {
    if (NEED_KEYS.includes(key)) needs[key] = clamp01(value)
  }

  return { tick, chooseActivity, satisfy, snapshot, setNeed, NEED_KEYS }
}

export default createNeedsManager
