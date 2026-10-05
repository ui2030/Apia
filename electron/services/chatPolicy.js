/**
 * 채팅 응답자 관련 작은 규칙 두 개 (발주서 16).
 *
 *   chatTimeoutFor — 대기 상한이 실제 응답자를 따라간다. auto는 이제 교사가
 *     막히면 로컬로 폴백하므로 느린 쪽으로 친다. 스트리밍이라 긴 상한은 체감되지
 *     않고, 잘리는 쪽(30s)이 훨씬 나쁘다.
 *   createFallbackNotice — 교사(DeepSeek) 대신 로컬이 답했다는 안내를 **하루 1회**만.
 *     매 턴 반복하면 소음이고, 아예 안 하면 갑자기 말투가 바뀐 이유가 숨는다.
 */

// Local LLM은 첫 호출에 모델 로딩만 ~47s가 걸릴 수 있다. claude_code는 CLI
// 기동 비용이 붙는다. auto는 교사 폴백 시 로컬로 간다.
const SLOW_CHAT_MODES = new Set(['auto', 'local', 'claude_code'])
const chatTimeoutFor = (mode) => (SLOW_CHAT_MODES.has(mode) ? 180000 : 30000)

const FALLBACK_NOTICES = {
  budget: '오늘 교사 예산을 다 써서 로컬로 답해요',
  error: '교사에 연결하지 못해서 로컬로 답해요',
  partial: '교사 연결이 끊겨 답이 중간에 잘렸어요'
}

// ponytail: 날짜는 메모리에만 — 앱을 다시 켜면 그날 한 번 더 안내한다.
// 재시작 넘어 1회가 필요해지면 settings에 날짜 한 칸을 둔다.
function createFallbackNotice(now = () => new Date()) {
  let shownDay = null
  return (frame) => {
    // 교사 답이 중간에 끊긴 경우 — 잘린 답을 정상인 척 두지 않는다. 사고마다 안내.
    if (frame?.fallback === 'partial') return FALLBACK_NOTICES.partial
    if (frame?.fallback !== 'local') return null
    const day = now().toDateString()
    if (shownDay === day) return null
    shownDay = day
    return FALLBACK_NOTICES[frame.fallback_reason] || FALLBACK_NOTICES.error
  }
}

module.exports = { chatTimeoutFor, createFallbackNotice, FALLBACK_NOTICES }
