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
