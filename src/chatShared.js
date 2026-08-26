// src/chatShared.js — tiny pure helpers shared by both chat surfaces
// (chatRenderer.js = wallpaper window, chat.js = overlay). Pure functions only
// (no window.api) so they unit-test under vitest's node environment. The one
// DOM toucher (pollWhileVisible) takes `document` as an injectable argument.

// Map a raw backend/IPC error string to a short Korean user message. Kept in
// one place so both surfaces phrase timeouts / network / backend-down the same.
export function toUserMessage(raw) {
  const s = String(raw == null ? '' : raw)
  if (!s.trim()) return '알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해주세요.'
  if (/timed out|timeout|ETIMEDOUT|AbortError/i.test(s)) {
    return '응답이 너무 오래 걸려 시간이 초과됐어요. 잠시 후 다시 시도해주세요.'
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|no main window|오프라인|unavailable|백엔드/i.test(s)) {
    return '백엔드에 연결하지 못했어요. 백엔드가 실행 중인지 확인해주세요.'
  }
  if (/\[5\d\d\]|\b50[0-9]\b|internal server error/i.test(s)) {
    return '백엔드에서 오류가 발생했어요. 잠시 후 다시 시도해주세요.'
  }
  return '오류가 발생했어요: ' + s.slice(0, 120)
}

// Request-ID guard for streamed frames: a late delta from a previous request
// must never attach to the current bubble. A frame is active only when its
// requestId matches the one we're currently tracking (and that id is set).
export function isActiveFrame(frame, activeRequestId) {
  return !!frame && activeRequestId != null && frame.requestId === activeRequestId
}

// 발화 직렬화. 두 채팅 표면의 speak 함수는 activeAudio /
// abortSpeak / speechReturnState를 각각 단일 슬롯으로 들고 있어서, 발화 두 개가
// 겹치면 오디오가 동시에 울리고 복귀 상태가 'talk'로 덮여 망가진다. 채팅은
// 턴제라 안 드러나지만 자율 발화(리액션)는 반드시 겹친다.
//
// speak(task)는 앞 발화가 **완전히 끝난 뒤**(오디오 종료 + 상태 복원까지)에
// task를 시작시킨다. 이 큐가 책임지는 것은 순서뿐이다 — 지금 들리는 소리를
// 끊는 것(barge-in)은 호출측의 stopSpeakingNow(abortSpeak)가 진입부에서 하고,
// 그 덕에 큐가 긴 발화를 기다리지 않고 곧바로 다음으로 넘어간다.
//
// priority — 'user'(사용자에게 답하는 말)는 반드시 나가고 순서대로 큐잉된다.
// 'ambient'(관전 코멘트 같은 혼잣말)는 **대기 슬롯을 하나만 차지한다**: 자기가
// 기다리는 동안 더 새 ambient가 들어오면 낡은 쪽이 자기 차례에 스스로 빠진다.
// 관전은 25초마다 코멘트를 낼 수 있어서, 큐가 밀리면 이미 지나간 화면 얘기를
// 뒤늦게 떠드는 꼴이 되기 때문(M2 검수 확정 리스크).
export function createSpeechQueue() {
  let chain = Promise.resolve()
  let pendingAmbient = null

  return function speak(task, { priority = 'user' } = {}) {
    if (priority !== 'ambient') {
      // 사용자에게 답할 차례가 생기면 **대기 중이던 혼잣말은 버린다.** 큐는
      // FIFO라 이걸 안 지우면 "사용자 발화 → 낡은 관전 코멘트 → 새 사용자 답변"
      // 순으로 나가서, 말 걸었는데 딴소리가 먼저 나온다(Codex 사후검토 MUST-FIX).
      pendingAmbient = null
      const run = chain.then(task)
      chain = run.catch(() => {}) // 한 발화의 실패가 다음 발화를 막지 않게
      return run
    }
    const slot = {}
    pendingAmbient = slot // 앞서 대기 중이던 ambient는 이 순간 낡은 것이 된다
    const run = chain.then(() => {
      if (pendingAmbient !== slot) return undefined // 더 새 ambient에 밀렸음
      pendingAmbient = null
      return task()
    })
    chain = run.catch(() => {})
    return run
  }
}

// [SFX:x] — 말로 읽으면 밋밋해지는 비언어 발성(웃음·한숨…)을 별도 클립으로
// 빼기 위한 태그. 감정 태그가 백엔드에서 벗겨지는 것과 달리 이건 렌더러에서
// 처리한다 — 관전 코멘트는 SSE를 안 타므로 백엔드 계약을 건드릴 이유가 없다.
// 알 수 없는 종류는 태그만 지우고 무시한다(모르는 소리를 내지 않는다).
export const SFX_KINDS = Object.freeze({
  laugh: '후후',
  sigh: '하아…',
  wow: '우와',
  hmm: '음…',
  huh: '에?'
})

const SFX_RE = /\[SFX:\s*([a-zA-Z]+)\s*\]/g

/** '[SFX:laugh] 우와 대박!' → { text: '우와 대박!', sfx: 'laugh' }.
 *  태그는 항상 제거된다(TTS가 대괄호를 읽으면 안 됨). 첫 번째 유효 태그만 쓴다. */
export function parseSfx(raw) {
  const s = String(raw == null ? '' : raw)
  let sfx = null
  const text = s.replace(SFX_RE, (_m, kind) => {
    const k = String(kind).toLowerCase()
    if (!sfx && Object.prototype.hasOwnProperty.call(SFX_KINDS, k)) sfx = k
    return ''
  }).replace(/\s{2,}/g, ' ').trim()
  return { text, sfx }
}

// 보이는 동안에만 도는 폴링. 채팅 창은 닫아도 파괴가 아니라 hide라서(재열기를
// 즉시로 만드는 의도된 설계) 그냥 두면 안 보이는 창이 5초마다 백엔드를 계속
// 두드린다. document.hidden을 따라 인터벌을 끊고, 다시 보일 때 즉시 1회 실행
// 후 재개한다.
//
// start/stop은 양방향 멱등이다 — visibilitychange가 연달아 와도 인터벌이 쌓이지
// 않고, 이미 멈춘 상태에서 stop이 또 와도 무해하다.
export function pollWhileVisible(fn, intervalMs, doc = globalThis.document) {
  let id = null
  const start = () => {
    if (id !== null) return
    id = setInterval(fn, intervalMs)
    fn() // 재개 즉시 1회 — 숨어 있는 동안 놓친 상태를 바로 따라잡는다
  }
  const stop = () => {
    if (id === null) return
    clearInterval(id)
    id = null
  }
  doc?.addEventListener?.('visibilitychange', () => (doc.hidden ? stop() : start()))
  if (!doc?.hidden) start()
  return { stop, isRunning: () => id !== null }
}
