// src/behaviorDirector.js
//
// J단계(행동 지능) — LLM 행동 디렉터.
//
// 역할: 매 behavior-tick을 micromanage하지 않는다. 느린 주기로 LLM에게 "지금
// 캐릭터의 무드/의도"를 물어 정규화된 directive를 받고, 그것을 규칙기반 행동
// (성격×시간대×사용자상태) **위에 한 겹 더 약하게 곱연쇄**해 변조한다. 디렉터는
// 행동을 *대체*하지 않고 *변조*만 하므로, 백엔드가 죽거나 응답이 깨져도 앱은
// 규칙기반으로 매끄럽게 계속 돈다(directive=null).
//
// 이 모듈은 전부 순수/주입식이라 단위테스트 가능하다. 실제 LLM 호출은 runner에
// 주입하는 async `call`로 분리(타임아웃·single-flight·최소간격·백오프는 runner가
// 관할). 백엔드 프롬프트 품질 튜닝은 다음 슬라이스.
//
// 설계는 Codex 2-depth 사전검토 합의: 변조 모델·전용 호출(채팅 history 분리)·
// 약한 계수(±0.25, 4겹 곱연쇄 바닥/천장 고착 회피)·정규화본만 저장·note는
// 디버그 전용(행동 로직·사용자 노출 금지)·실패 전부 directive=null.

const MOODS = new Set(['playful', 'focused', 'calm', 'restless', 'sleepy'])
const FOCI = new Set(['user', 'room', 'self'])

// 2단계(디렉터 연동) — 디렉터 mood를 idle 제스처 flavor로 연결한다. motionManager의
// GESTURE_FLAVORS 키와 일치해야 한다(energetic/engaged/quiet/fidgety). 이 매핑으로
// LLM이 읽은 무드가 "어떤 제스처가 나오나"를 실제로 좌우한다(AI 생성분 포함).
const MOOD_TO_GESTURE = {
  playful: 'energetic',
  focused: 'engaged',
  calm: 'quiet',
  sleepy: 'quiet',
  restless: 'fidgety'
}

const TTL_MIN_SEC = 120
const TTL_MAX_SEC = 600
const NOTE_MAX = 80

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

// 프롬프트에 넣을 컴팩트 컨텍스트. 순수. (실제 직렬화/프롬프트는 호출측에서)
// presence는 물리적 존재(시스템 유휴 기반) — attentiveness(대화 최근성)와 다른
// 축이다. away=자리에 없음이지 무관심이 아니다(프롬프트에도 명시).
const PRESENCES = new Set(['active', 'short-idle', 'away'])
// 활동 id는 앱이 정의하는 값이지만 프롬프트에 나가는 것이라 안전한 모양만 통과.
const SAFE_ID = /^[a-zA-Z0-9_-]{1,32}$/
const MAX_ACTIVITIES = 8
const MAX_NEEDS = 3

function safeId(v) {
  return typeof v === 'string' && SAFE_ID.test(v) ? v : null
}

// 욕구 스냅샷 → 압력 큰 순 상위 MAX_NEEDS개만, 0..1 clamp + 소수 2자리.
function topNeeds(needs) {
  if (!needs || typeof needs !== 'object') return {}
  const entries = []
  for (const [k, v] of Object.entries(needs)) {
    if (Number.isFinite(v)) entries.push([k, Number(clamp(v, 0, 1).toFixed(2))])
  }
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_NEEDS))
}

export function buildDirectorContext({ hour, personality, attentiveness, idleStreakMs, presence, awayMs, needs, activities, currentActivity, lastActivity } = {}) {
  return {
    hour: Number.isFinite(hour) ? Math.floor(clamp(hour, 0, 23)) : null,
    personality: typeof personality === 'string' ? personality : 'calm',
    attentiveness: Number.isFinite(attentiveness) ? Number(clamp(attentiveness, -1, 1).toFixed(2)) : 0,
    idleMinutes: Number.isFinite(idleStreakMs) ? Math.max(0, Math.round(idleStreakMs / 60000)) : 0,
    presence: PRESENCES.has(presence) ? presence : 'active',
    awayMinutes: Number.isFinite(awayMs) ? Math.max(0, Math.round(awayMs / 60000)) : 0,
    needs: topNeeds(needs),
    activities: Array.isArray(activities) ? activities.map(safeId).filter(Boolean).slice(0, MAX_ACTIVITIES) : [],
    currentActivity: safeId(currentActivity),
    lastActivity: safeId(lastActivity)
  }
}

// LLM 원시 출력(문자열 or 객체) → 정규화 directive 또는 null. 화이트리스트+clamp.
// 원본 JSON은 저장하지 않는다(정규화본만). mood/focus/activityBias 중 하나도
// 쓸 게 없으면 null(무의미한 directive 거부).
export function parseDirective(raw, now = Date.now()) {
  let obj = raw
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const mood = MOODS.has(obj.mood) ? obj.mood : null
  const focus = FOCI.has(obj.focus) ? obj.focus : null
  const hasBias = Number.isFinite(obj.activityBias)
  // 활동 제안(선택) — 안전한 id 모양만. 소비측(chooseActivity)이 정확 일치로만
  // 쓰므로 방에 없는 id는 그냥 무해하게 무시된다.
  const activityHint = safeId(typeof obj.activityHint === 'string' ? obj.activityHint.trim() : null)
  if (!mood && !focus && !hasBias && !activityHint) return null // 쓸 차원이 하나도 없음

  const activityBias = hasBias ? clamp(obj.activityBias, -1, 1) : 0
  const ttlSec = Number.isFinite(obj.ttlSec) ? clamp(obj.ttlSec, TTL_MIN_SEC, TTL_MAX_SEC) : 300
  const note = typeof obj.note === 'string' ? obj.note.slice(0, NOTE_MAX) : ''

  return { mood, focus, activityBias, activityHint, note, expiresAt: now + ttlSec * 1000 }
}

export function directiveActive(directive, now = Date.now()) {
  return !!directive && Number.isFinite(directive.expiresAt) && directive.expiresAt > now
}

// directive를 behaviorConfig에 약하게 곱연쇄(±0.25). 시간대·attentiveness 변조
// 뒤에 적용한다고 가정. 만료/없음이면 config 그대로. 새 객체 반환(변형 금지).
// 기존 clamp(walk 0.15~0.6, idle 0.12~0.5)·합 0.94 캡 유지.
export function applyDirective(config, directive, now = Date.now()) {
  if (!config || !directiveActive(directive, now)) return config

  let walkShare = Number.isFinite(config.walkShare) ? config.walkShare : 0.36
  let inPlaceIdleBias = Number.isFinite(config.inPlaceIdleBias) ? config.inPlaceIdleBias : 0.28

  const a = directive.activityBias // -1..1
  walkShare *= (1 + a * 0.25)        // 탐색↑ → 더 돌아다님
  inPlaceIdleBias *= (1 - a * 0.25)  // 탐색↑ → 제자리↓

  // 무드 약한 가중(강제 지속 아님).
  if (directive.mood === 'restless' || directive.mood === 'playful') {
    walkShare *= 1.12
  } else if (directive.mood === 'sleepy' || directive.mood === 'calm') {
    walkShare *= 0.9
    inPlaceIdleBias *= 1.1
  }

  walkShare = clamp(walkShare, 0.15, 0.6)
  inPlaceIdleBias = clamp(inPlaceIdleBias, 0.12, 0.5)
  const sum = walkShare + inPlaceIdleBias
  if (sum > 0.94) { const s = 0.94 / sum; walkShare *= s; inPlaceIdleBias *= s }

  // 디렉터 mood → idle 제스처 flavor(런타임화). focus:'user'는 사용자 주의가
  // 우선이라 항상 engaged(main.js attentiveness 폴백과 같은 우선순위). 그 외엔
  // mood→flavor 매핑, 매핑도 없으면 기존 config.idleMood 유지.
  const idleMood = directive.focus === 'user'
    ? 'engaged'
    : (MOOD_TO_GESTURE[directive.mood] || config.idleMood)

  return { ...config, walkShare, inPlaceIdleBias, idleMood, directiveMood: directive.mood }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('director-timeout')), timeoutMs)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

function backoffMs(streak, base, max) {
  return Math.min(max, base * Math.pow(2, Math.min(streak - 1, 6)))
}

// 느린 주기 LLM 호출 runner. single-flight + 최소간격(성공) + 지수 백오프(실패) +
// 타임아웃. `call(context)`는 주입(테스트 mock 가능). 모든 실패는 흡수 →
// 기존 directive 유지/만료. now/rng 주입으로 결정론 테스트.
export function createDirectorRunner({
  call,
  now = () => Date.now(),
  minIntervalMs = 240000, // ~4분
  jitterMs = 90000,       // 0~1.5분 지터(동시 만료/몰림 방지)
  backoffBaseMs = 60000,  // 실패 시 1분부터 2배씩
  maxBackoffMs = 1800000, // 최대 30분
  timeoutMs = 8000,
  rng = Math.random
} = {}) {
  let directive = null
  let inFlight = false
  let nextAllowedAt = 0
  let failStreak = 0

  async function maybeRun(context) {
    const t = now()
    if (inFlight || t < nextAllowedAt || typeof call !== 'function') return current(t)
    inFlight = true
    try {
      const raw = await withTimeout(call(context), timeoutMs)
      const parsed = parseDirective(raw, now())
      if (parsed) {
        directive = parsed
        failStreak = 0
        nextAllowedAt = now() + minIntervalMs + Math.floor(rng() * jitterMs)
      } else {
        failStreak += 1
        nextAllowedAt = now() + backoffMs(failStreak, backoffBaseMs, maxBackoffMs)
      }
    } catch {
      failStreak += 1
      nextAllowedAt = now() + backoffMs(failStreak, backoffBaseMs, maxBackoffMs)
    } finally {
      inFlight = false
    }
    return current(now())
  }

  function current(t = now()) {
    return directiveActive(directive, t) ? directive : null
  }

  function reset() {
    directive = null
    inFlight = false
    nextAllowedAt = 0
    failStreak = 0
  }

  return { maybeRun, current, reset }
}
