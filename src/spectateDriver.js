// src/spectateDriver.js — M2 관전 모드의 판단부.
//
// 역할: main 프로세스가 캡처+VLM 호출을 하고 raw JSON을 돌려주면, 그걸 검증하고
// "지금 말할 가치가 있나"를 결정한다. 전부 순수/주입식이라 단위테스트가 여기 걸린다.
// 실제 캡처·네트워크는 electron 쪽, 실제 발화·표정은 src/main.js 쪽.
//
// 침묵이 기본이라는 것이 이 모듈의 설계 전제다. 관전 코멘트는 25초마다 기회가
// 오지만 대부분은 말하지 않아야 한다 — 계속 떠드는 동반자는 15분이면 끄게 된다.
// 그래서 게이트가 세 겹이다: ① 흥미도 임계 ② 직전 코멘트와 중복 ③ 발화 간 최소 간격.

const EMOTIONS = new Set(['happy', 'sad', 'angry', 'surprised', 'neutral', 'relaxed'])

const COMMENT_MAX = 60      // 말풍선·TTS 모두 짧아야 한다. 초과분은 자른다.
const SUMMARY_MAX = 120
const OBSERVATION_TTL_MS = 60000 // runner의 current() 계약용 — 신선도 판단은 호출측이 식별자로

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * VLM raw 출력 → 정규화 관측 또는 null. parseDirective와 같은 계약:
 * 화이트리스트 + clamp, 쓸 게 없으면 null, 원본은 보관하지 않는다.
 */
export function parseSpectate(raw, now = Date.now()) {
  let obj = raw
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const interest = Number.isFinite(obj.interest) ? clamp(obj.interest, 0, 1) : 0
  const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, SUMMARY_MAX) : ''
  const comment = typeof obj.comment === 'string' ? obj.comment.trim().slice(0, COMMENT_MAX) : ''
  const emotion = EMOTIONS.has(obj.emotion) ? obj.emotion : 'neutral'

  // 주목 좌표는 없어도 된다(그냥 안 쳐다볼 뿐) — 없으면 null로 두고 시선은 유지.
  const fx = obj.focus?.x
  const fy = obj.focus?.y
  const focus = (Number.isFinite(fx) && Number.isFinite(fy))
    ? { x: clamp(fx, -1, 1), y: clamp(fy, -1, 1) }
    : null

  // summary도 comment도 없으면 관측 자체가 무의미.
  if (!summary && !comment) return null

  return { summary, comment, emotion, interest, focus, expiresAt: now + OBSERVATION_TTL_MS }
}

// 비교용 정규화 — 구두점/공백/조사 차이로 "같은 말"을 다르게 세지 않게.
function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/[\s.,!?~…"'`·]/g, '')
}

/** 두 문자열이 사실상 같은 말인가. 짧은 코멘트라 부분집합 판정이면 충분하다. */
export function isDuplicateComment(candidate, previous) {
  const a = normalizeForCompare(candidate)
  const b = normalizeForCompare(previous)
  if (!a || !b) return false
  if (a === b) return true
  // 한쪽이 다른 쪽을 통째로 품으면 중복 취급(어미만 바꾼 재탕 차단).
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 6 && long.includes(short)
}

/**
 * 침묵 게이트 + 단기 기억 링버퍼.
 *
 * memory_service(임베딩 의미검색)를 쓰지 않는다: 관전 연속성에 필요한 건 의미
 * 유사도가 아니라 **직전 순서**이고, 임베딩 왕복은 지연만 더한다.
 *
 * @param {object} opts
 * @param {number} opts.minInterest    이 미만이면 말하지 않는다.
 * @param {number} opts.recentSize     프롬프트에 실어 보낼 직전 코멘트 개수.
 * @param {number} opts.minGapMs       발화 사이 최소 간격(연속 수다 방지).
 */
export function createCommentGate({
  minInterest = 0.55,
  recentSize = 4,
  minGapMs = 45000,
  now = () => Date.now()
} = {}) {
  const recent = []
  let lastSummary = ''
  let lastSpokeAt = null // 0은 유효한 시각이라 falsy 체크를 쓰면 안 된다

  return {
    /** 프롬프트에 실을 컴팩트 컨텍스트. */
    context() {
      return { recent: recent.slice(), lastSummary }
    },
    recent: () => recent.slice(),
    lastSummary: () => lastSummary,

    /**
     * 관측을 받아 발화 여부를 결정한다. summary는 발화하지 않아도 항상 갱신
     * (다음 프롬프트가 "직전과 뭐가 달라졌나"를 알아야 하므로).
     * @returns {{speak:false, reason:string} | {speak:true, comment:string, emotion:string, focus:object|null}}
     */
    consider(observation) {
      if (!observation) return { speak: false, reason: 'no-observation' }
      if (observation.summary) lastSummary = observation.summary

      if (!observation.comment) return { speak: false, reason: 'no-comment' }
      if (observation.interest < minInterest) return { speak: false, reason: 'low-interest' }

      const t = now()
      if (lastSpokeAt !== null && t - lastSpokeAt < minGapMs) return { speak: false, reason: 'too-soon' }

      for (const prev of recent) {
        if (isDuplicateComment(observation.comment, prev)) {
          return { speak: false, reason: 'duplicate' }
        }
      }

      recent.push(observation.comment)
      while (recent.length > recentSize) recent.shift()
      lastSpokeAt = t
      return {
        speak: true,
        comment: observation.comment,
        emotion: observation.emotion,
        focus: observation.focus
      }
    },

    reset() {
      recent.length = 0
      lastSummary = ''
      lastSpokeAt = null
    }
  }
}

/**
 * main의 spectate:tick 결과가 "VLM을 안 부른 정상 tick"인가.
 * createDirectorRunner의 isSkipResult로 주입한다 — 이걸 실패로 세면 백오프가
 * 걸려 관전이 점점 느려지다 멈춘다(화면이 안 변하는 건 아주 흔한 정상 상태다).
 */
export function isSpectateSkip(result) {
  const status = result?.status
  return status === 'paused' || status === 'no-source' ||
    status === 'no-change' || status === 'dead-frame' || status === 'no-vision'
}

/** tick 결과에서 VLM raw를 꺼낸다(러너의 parse 앞단). */
export function spectateRawOf(result) {
  return result && result.status === 'ok' ? result.raw : null
}
