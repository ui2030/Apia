// src/touchInteraction.js
//
// 5단계(직접 상호작용) — 포인터 제스처 분류기(순수). 캐릭터 위 down→move→up
// 시퀀스를 tap / pet(쓰다듬기) / grab(드래그-잡기)로 배타 분류한다. DOM/타이머에
// 의존하지 않게 시각(t)·캐릭터명중(onChar)을 이벤트로 주입받아 결정론 테스트 가능.
//
// 배타 우선순위(Codex MUST-FIX): grab > pet > tap. 한 제스처(down..up)에서 grab/pet로
// 확정되면 up에서 tap을 내지 않는다. grab은 sticky(한 번 잡으면 끝까지 grab).
// tap은 down이 캐릭터 위였고(작은 이동·짧은 시간) up의 raycast 결과엔 의존하지
// 않는다(손가락이 살짝 벗어나도 탭 인정 — Codex 엣지).

export const TOUCH_THRESHOLDS = {
  TAP_MAX_MOVE: 8,      // px — 이보다 적게 움직이면 탭 후보
  TAP_MAX_MS: 1500,     // ms — 정지 누름 탭 인정 상한(이보다 더 오래 누르면 탭 아님)
  PET_PATH: 40,         // px — 캐릭터 위 누적 경로가 이를 넘으면 쓰다듬기
  PET_THROTTLE_MS: 800, // ms — 연속 쓰다듬기 반응 최소 간격
  GRAB_DISP: 120        // px — 시작점에서 변위가 이를 넘으면 잡기/드래그
}

export function createTouchClassifier({ onTap, onPet, onGrab, thresholds } = {}) {
  const T = { ...TOUCH_THRESHOLDS, ...(thresholds || {}) }
  let active = false
  let startX = 0, startY = 0, startT = 0
  let lastX = 0, lastY = 0
  let path = 0
  let kind = 'none' // 'none' | 'pet' | 'grab'
  let lastPetT = -Infinity

  function reset() { active = false; path = 0; kind = 'none'; lastPetT = -Infinity }

  // ev: { type: 'down'|'move'|'up'|'cancel', x, y, t, onChar }
  function feed(ev) {
    if (!ev || typeof ev.type !== 'string') return
    const x = Number(ev.x) || 0, y = Number(ev.y) || 0, t = Number(ev.t) || 0
    if (ev.type === 'down') {
      if (!ev.onChar) { reset(); return } // 캐릭터 밖에서 시작한 제스처는 무시
      active = true
      startX = lastX = x; startY = lastY = y; startT = t
      path = 0; kind = 'none'; lastPetT = -Infinity
      return
    }
    if (ev.type === 'move') {
      if (!active) return
      path += Math.hypot(x - lastX, y - lastY)
      lastX = x; lastY = y
      const disp = Math.hypot(x - startX, y - startY)
      if (disp > T.GRAB_DISP) {            // grab은 sticky·최우선
        if (kind !== 'grab') { kind = 'grab'; onGrab && onGrab() }
        return
      }
      if (kind !== 'grab' && ev.onChar && path > T.PET_PATH) {
        kind = 'pet'
        if (t - lastPetT >= T.PET_THROTTLE_MS) { lastPetT = t; onPet && onPet() }
      }
      return
    }
    if (ev.type === 'up' || ev.type === 'cancel') {
      if (active && kind === 'none' && ev.type === 'up') {
        const dur = t - startT
        if (path <= T.TAP_MAX_MOVE && dur <= T.TAP_MAX_MS) onTap && onTap()
      }
      reset()
      return
    }
  }

  return { feed, reset, isActive: () => active }
}
