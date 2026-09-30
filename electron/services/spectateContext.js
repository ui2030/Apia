// 관전 → 채팅 연결. 관전 모드가 **이미 본** 화면 정보를 채팅 요청에 싣는 규칙이
// 여기 한 곳에 있다(새 캡처·새 비전 호출은 하지 않는다 — 재사용만).
//
// 왜 필요한가: 관전(비전)과 채팅(텍스트)이 분리돼 있어서, 창을 보는 중에
// "제목 맞춰봐"라고 물으면 채팅 뇌는 화면을 한 번도 못 본 상태로 답을 지어냈다.
//
// attachReferenceCards(services/courseware.js)와 같은 계약:
//   - 관전 중이 아니면 body를 **그대로** 돌려준다(키 자체가 안 붙음 = 백엔드
//     프롬프트가 기존과 바이트 동일).
//   - 개수·길이는 여기서 자르고, 백엔드도 신뢰 경계라 한 번 더 자른다.

const MAX_OBSERVATIONS = 3   // "최근 1~3건" — 그 이상은 프롬프트만 불린다
const TEXT_MAX = 200
const WINDOW_MAX = 120

// 관찰 문장은 VLM이 사용자 화면을 읽어 쓴 것, 창 제목은 아무 프로그램이나 정할 수
// 있는 것 — 둘 다 신뢰 경계 바깥이다. 개행·탭을 접어 한 줄에 가둔다(개행이 살아
// 있으면 관찰 한 건이 섹션을 빠져나가 상위 지시문 행세를 할 수 있다).
// 남는 제어문자는 백엔드의 _flatten_field가 한 번 더 지운다.
function flatten(text) {
  return String(text ?? '').trim().split(/\s+/).join(' ')
}

/**
 * 관찰 한 건을 링버퍼에 넣는다(최신이 앞). 입력 배열은 건드리지 않는다.
 * 빈 문장은 무시 — 관측 없이 지나간 tick은 기억할 것이 없다.
 *
 * 세대(gen) 검사가 핵심이다: 창을 바꾸면 버퍼를 비우지만, **비우기 전에 떠 있던
 * tick**이 몇 초 뒤 돌아와 관찰을 남기면 새 창의 빈 버퍼에 옛 창 설명이 들어간다
 * (= 채팅이 엉뚱한 창을 자신 있게 설명한다). 관찰은 자기가 돌던 세대를 달고 오고,
 * 지금 세대와 다르면 버린다.
 *
 * @param {Array<{text:string, at:number}>} notes
 * @param {{text:string, gen:number}} note  관전이 낸 summary(없으면 comment) + tick의 세대
 * @param {number} currentGen  지금 보고 있는 소스의 세대
 * @param {number} at          관찰 시각(ms)
 */
function noteObservation(notes, note, currentGen, at) {
  if (!note || note.gen !== currentGen) return notes || []
  const clean = flatten(note.text).slice(0, TEXT_MAX)
  if (!clean) return notes || []
  return [{ text: clean, at }, ...(notes || [])].slice(0, MAX_OBSERVATIONS)
}

/**
 * 관전 중일 때만 body에 spectate를 붙인다.
 * @param {object} body
 * @param {{active:boolean, window:string, notes:Array}} state
 * @param {number} [at] 요청 시각 — 관찰 경과초(age_sec)의 기준
 */
function attachSpectateContext(body, { active, window, notes } = {}, at = Date.now()) {
  if (!active) return body
  const title = flatten(window).slice(0, WINDOW_MAX)
  const observations = (notes || []).slice(0, MAX_OBSERVATIONS).map((n) => ({
    text: n.text,
    // 절대시각이 아니라 경과초를 보낸다 — 두 프로세스의 시계·타임존을 맞출
    // 필요가 없고, 모델이 바로 쓸 수 있는 형태다.
    age_sec: Math.max(0, Math.round((at - n.at) / 1000))
  }))
  // 창을 고르기만 하고 아직 한 번도 못 본 상태 = 실을 게 없다(= 미관전과 같다).
  if (!title && observations.length === 0) return body
  return { ...body, spectate: { window: title, observations } }
}

module.exports = { attachSpectateContext, noteObservation, MAX_OBSERVATIONS }
