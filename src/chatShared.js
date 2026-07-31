// src/chatShared.js — tiny pure helpers shared by both chat surfaces
// (chatRenderer.js = wallpaper window, chat.js = overlay). Pure functions only
// (no DOM, no window.api) so they unit-test under vitest's node environment.

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
// ponytail: 낡은 대기 항목을 버리는 정책(최신 1개만 유지)은 넣지 않았다.
// "실행 중"과 "대기 중"을 구분하는 상태가 더 필요한데, 현재 호출자(채팅 1개,
// 창 1개)는 발화를 연달아 쌓지 않는다. 자율 리액션 드라이버가 붙어 큐가 실제로
// 밀리면 그때 추가한다.
export function createSpeechQueue() {
  let chain = Promise.resolve()
  return function speak(task) {
    const run = chain.then(task)
    chain = run.catch(() => {}) // 한 발화의 실패가 다음 발화를 막지 않게
    return run
  }
}
