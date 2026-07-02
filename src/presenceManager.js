// src/presenceManager.js
//
// J단계(행동 지능) — 사용자 존재 인지 상태기계.
//
// 입력은 두 갈래뿐이다: 메인 프로세스가 5s 주기로 밀어주는 시스템 유휴초
// (powerMonitor.getSystemIdleTime)와 절전/잠금 이벤트. 여기서 활성/잠깐 자리비움/
// 부재를 분류하고, 전이(자리 뜸·복귀)를 onTransition으로 알린다. 복귀 인사 여부
// (greet)도 여기서 디바운스해 내보낸다 — 호출측은 게이트(모델·idle·립싱크)만 확인.
//
// 설계(Codex 사전검토 반영):
//  - 전이는 전부 이 상태기계 한 곳에서만 나온다(유휴 폴링과 잠금 해제 이벤트가
//    이중으로 복귀를 쏘지 않는다). unlock/resume은 잠금 플래그만 내리고, 복귀
//    판정은 다음 유휴 폴링(실제 입력으로 유휴초가 리셋된 것)이 확정한다.
//  - 잠금/절전은 유휴초와 무관하게 즉시 '부재'로 취급(화면이 안 보이는 상태).
//  - now 주입으로 결정론적 테스트.

const STATES = ['active', 'short-idle', 'away']

export function createPresenceMonitor({
  now = () => Date.now(),
  shortIdleMs = 60000, // 1분 — 잠깐 손 뗌
  awayThresholdMs = 300000, // 5분 — 자리 비움
  greetMinAwayMs = 300000, // 이보다 짧게 비웠다 오면 인사 안 함
  greetDebounceMs = 600000, // 인사 최소 간격 10분
  onTransition = null
} = {}) {
  let state = 'active'
  let awayStartedAt = 0
  let lastGreetAt = 0
  let locked = false
  let suspended = false

  function classify(idleMs) {
    if (locked || suspended) return 'away'
    if (idleMs >= awayThresholdMs) return 'away'
    if (idleMs >= shortIdleMs) return 'short-idle'
    return 'active'
  }

  function emit(evt) {
    try { onTransition?.(evt) } catch {}
  }

  function setState(next, idleMs, t) {
    if (next === state) return
    const prev = state
    state = next
    if (next === 'away') {
      // 잠금/절전은 지금부터, 유휴 승격은 입력이 끊긴 시점부터 부재로 센다.
      awayStartedAt = locked || suspended ? t : t - idleMs
      emit({ type: 'user-left', at: t })
    } else if (prev === 'away') {
      const awayMs = Math.max(0, t - awayStartedAt)
      let greet = false
      if (awayMs >= greetMinAwayMs && t - lastGreetAt >= greetDebounceMs) {
        greet = true
        lastGreetAt = t
      }
      emit({ type: 'user-returned', awayMs, greet, at: t })
    }
  }

  // 시스템 유휴초 폴링 입력(초 단위, 메인 프로세스 피드).
  function onIdle(idleSec) {
    if (!Number.isFinite(idleSec) || idleSec < 0) return
    const t = now()
    const idleMs = idleSec * 1000
    setState(classify(idleMs), idleMs, t)
  }

  // powerMonitor 이벤트 입력.
  function onEvent(name) {
    const t = now()
    if (name === 'lock-screen') {
      locked = true
      setState('away', 0, t)
    } else if (name === 'suspend') {
      suspended = true
      setState('away', 0, t)
    } else if (name === 'unlock-screen') {
      locked = false // 복귀 전이는 다음 유휴 폴링이 확정(이중 발화 방지)
    } else if (name === 'resume') {
      suspended = false
    }
  }

  function getState() {
    return state
  }

  function isPresent() {
    return state !== 'away'
  }

  function awayMsNow(t = now()) {
    return state === 'away' ? Math.max(0, t - awayStartedAt) : 0
  }

  return { onIdle, onEvent, getState, isPresent, awayMsNow, STATES }
}

export default createPresenceMonitor
