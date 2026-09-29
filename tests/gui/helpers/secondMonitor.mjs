// GUI 하네스를 **보조 모니터**에 띄우기 위한 설정 시드.
//
// 검증용으로 창을 열 때마다 사용자 작업 화면 위에 올라오면 방해가 된다.
// windowAnchor는 "이 좌표를 포함하는 디스플레이"로 메인 오버레이를 복원하는
// 값이라(services/windowBoundsPolicy.js), 보조 모니터 안의 아무 점이나 주면 된다.
//
// 앵커가 어느 디스플레이에도 안 닿으면 정책이 주 모니터로 되돌리므로, 보조
// 모니터가 없는 머신(CI 등)에서도 안전하게 동작한다 — 실패가 아니라 폴백.

// electron 없이 화면 목록을 못 읽으므로 좌표는 빌드 머신 기준 고정값이다.
// 다른 장비에서 돌릴 땐 아래 한 줄만 고치면 된다(없으면 주 모니터로 폴백).
export const SECOND_MONITOR_ANCHOR = { x: -3700, y: -400 }

export const SECOND_MONITOR_SEED = { windowAnchor: SECOND_MONITOR_ANCHOR }
