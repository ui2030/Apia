// src/characterController.js
import { Vector3 } from 'three'
import { FURNITURE_DEFAULT } from './furnitureLayout.js'

// ── 가구 충돌(사물 통과 방지) ─────────────────────────────────────────
// 각 솔리드 가구를 footprint 원으로 근사한다. 평평한 것(러그·매트, h≈0)과
// 아주 작은 소품은 제외. 반지름은 (w+d)/4 — 코너 과·미차단의 절충.
const CHAR_RADIUS = 0.26
const DEFAULT_OBSTACLES = FURNITURE_DEFAULT
  .filter((f) => f.size && f.size.h > 0.2 && (f.size.w + f.size.d) > 0.7)
  .map((f) => ({ x: f.position.x, z: f.position.z, r: (f.size.w + f.size.d) / 4 }))
// 스테이지 모드(방 교체) — 절차적 가구가 숨겨지면 그 장애물로 길을 돌면 안
// 된다(Codex MUST-FIX). setStageNavigation이 BOUNDS/OBSTACLES를 통째로 교체.
let OBSTACLES = DEFAULT_OBSTACLES

function _insideObstacle(x, z) {
  for (const o of OBSTACLES) {
    if (Math.hypot(x - o.x, z - o.z) < o.r + CHAR_RADIUS) return true
  }
  return false
}

// 다음 위치를 모든 장애물 밖으로 밀어낸다(접선으로 미끄러짐).
function _resolveCollision(x, z) {
  let px = x, pz = z
  for (const o of OBSTACLES) {
    const dx = px - o.x, dz = pz - o.z
    const d = Math.hypot(dx, dz)
    const ring = o.r + CHAR_RADIUS
    if (d < ring && d > 1e-4) { px = o.x + (dx / d) * ring; pz = o.z + (dz / d) * ring }
  }
  return { x: px, z: pz }
}

// 타깃이 가구 안이면(걷기 목적지=가구 중심), 캐릭터 쪽 ring 위 "접근점"으로
// 옮겨 가구 앞에 서게 한다(가구를 뚫고 들어가지 않게 — Codex MUST-FIX).
function _approachTarget(tx, tz, fromX, fromZ) {
  let x = tx, z = tz
  for (const o of OBSTACLES) {
    const ring = o.r + CHAR_RADIUS + 0.06
    if (Math.hypot(x - o.x, z - o.z) < ring) {
      let dx = fromX - o.x, dz = fromZ - o.z
      const dl = Math.hypot(dx, dz) || 1
      x = o.x + (dx / dl) * ring
      z = o.z + (dz / dl) * ring
    }
  }
  return { x, z }
}

const STATE = { IDLE: 'idle', WALK: 'walk', SIT: 'sit', TALK: 'talk' }

// ── 이동 가능 범위 ─────────────────────────────────────
// Phase B: matches the room footprint declared in sceneRuntime.js
// (width 8, depth 6). 0.5 inset on every wall so the character never
// clips into a wall mesh; minZ also keeps a buffer so they don't push
// into the 4th wall (= the camera glass).
// Phase G — keep the character ON-SCREEN (사용자: 평소엔 화면 밖으로 안
// 나가게). Room is width9/depth9, one-point camera at z≈9.7 looking to z=0.
// The binding constraint is the FRONT: past z≈5.4 her feet drop below the
// frame, and near the front the frustum is narrow so x must stay tighter.
// minZ stays low enough to reach the bed/back furniture; the back of the
// room is small but fully in frame. Tuned by screenshot.
const DEFAULT_BOUNDS = Object.freeze({
  minX: -1.7, maxX: 1.7,
  minZ: 1.2,  maxZ: 5.5,
})
let BOUNDS = DEFAULT_BOUNDS

/**
 * 스테이지 모드 내비게이션 오버라이드. 스테이지가 절차적 방을 대체하면
 * 걷기 범위(walkBounds)와 장애물(obstacles: {x,z,r}[])을 스테이지에 맞게
 * 교체한다. null → 기본(절차적 방) 복원. 부분 지정 가능 — 미지정 필드는
 * 기본 유지, 단 obstacles 미지정 시 스테이지에선 빈 배열이 안전하므로
 * 호출자가 명시적으로 [] 를 넘기는 것을 권장.
 */
export function setStageNavigation(nav) {
  if (!nav) {
    BOUNDS = DEFAULT_BOUNDS
    OBSTACLES = DEFAULT_OBSTACLES
    return
  }
  BOUNDS = nav.walkBounds
    ? { ...DEFAULT_BOUNDS, ...nav.walkBounds }
    : DEFAULT_BOUNDS
  OBSTACLES = Array.isArray(nav.obstacles) ? nav.obstacles : DEFAULT_OBSTACLES
}

let state = STATE.IDLE
let target = new Vector3()
let moveConfig = null
let _prevWalkDist = Infinity
let _stuckFrames = 0
let activeSitPose = null
let mesh3D = null
let sitUntil = 0
// J단계 스마트 오브젝트 — 활동 시퀀서(activityRunner)가 마시기 같은 단계 동안
// 앉은 자세를 직접 통제할 수 있게 하는 "수동 앉기". held면 _sit의 sitUntil 자동
// 기상이 비활성화되고, releaseSit()으로만 일어선다(Codex MUST-FIX).
let sitHeld = false
let emotion = 'neutral'

let pose = {
  tiltX: 0,
  tiltZ: 0,
  swaySeed: Math.random() * 10,
  nextPoseAt: 0
}

let blink = {
  nextAt: 0,
  progress: 0,
  closing: false,
  value: 0
}

let lookTargetX = 0
let lookTargetY = 0
// F단계 — 시선 입력의 단일 관할. canvas mousemove와 전역 커서 IPC 피드가
// 같은 setLookTarget으로 들어오되, 전역 피드가 한 번이라도 도착하면 canvas
// 경로는 무시한다(벽지 모드에선 canvas 이벤트가 아예 없고, 오버레이
// 모드에선 둘 다 와서 이중 권한이 되기 때문). 무이동 타임스탬프도 여기
// 한 곳에서만 찍는다 (Codex MUST-FIX: 복귀 타이머 단일 관할).
let lastLookInputMs = 0
let globalCursorFeed = false
const LOOK_IDLE_RETURN_MS = 8000 // 커서 8s 무이동이면 시선을 중앙으로 복귀
const LOOK_IDLE_RETURN_RATE = 0.6 // 1/s 지수 감쇠 — 절차적 시선 방황이 승계

// Phase C: temporary "face the camera" override. While `faceCameraUntil > Date.now()`
// every state's body yaw and lookTargetY get nudged toward the user. Codex
// MUST-FIX: _onArrive/idleTurn must NOT touch mesh.rotation.y while this is active.
let faceCameraUntil = 0
let faceCameraApproachTarget = null
// camFacingYaw(아래)가 "사용자를 보는 yaw"의 단일 출처 — sit/_onArrive/걷기
// 오버라이드가 전부 이를 쓴다.
const FACE_CAMERA_PITCH_BIAS = -0.35 // negative `lookTargetY` looks up

// dummy 모델의 머리 메시 참조 캐시. main.js loadDummy()에서 setDummyBlinkTarget으로
// 주입한다. 캐시가 비어 있을 때만 한 번 getObjectByName으로 폴백 검색하므로,
// _applyBlink가 매 프레임 씬 그래프를 워킹하지 않는다.
let dummyBlinkTarget = null

let idleTurn = {
  nextAt: 0,
  targetYaw: 0
}

// "카메라(사용자)를 보는 yaw". 과거 상수 PI는 **반대 방향**이었다 — 호출 착석
// 실측(yaw 체인 프로브 + 스크린샷)에서 서 있는 카메라 정면 = yaw 0, PI = 창문
// 쪽(등짐)으로 확정. 주석끼리도 모순돼 있었음(한쪽은 PI=사용자, _onArrive는
// PI=away). 모델 래퍼 규약이 바뀔 수 있어 주입형으로 — main.js가 로드 시 세팅.
let camFacingYaw = 0
export function setCameraFacingYaw(rad) {
  camFacingYaw = Number.isFinite(rad) ? rad : 0
}
// Codex MUST-FIX (step 1 round 1): WALK_SPEED / SIT_DURATION are no longer
// constants. They derive from the active personality vector so a "shy"
// character walks slower and stays seated longer than an "active" one.
// Defaults reproduce the pre-Phase-H baseline (1.6 / 8000) when no vector
// is set yet (dummy model or first frame).
const ARRIVE_DIST = 0.22
let _personalityVector = null

// 앉기 높이 보정 — 서 있을 때의 골반(腰) world Y. main.js가 모델 로드 후
// 1회 측정해 주입한다. 앉을 때 루트를 (seatHeight + 여유 − 골반높이)로 내려
// 골반이 좌면 살짝 위에 놓이게 한다(=공중부양 버그 수정). 캐릭터마다 골반
// 높이가 달라도 측정값을 쓰므로 교체 시에도 맞는다.
let _seatedHipHeight = null
const SEAT_BUTT_MARGIN = 0.05 // 엉덩이 두께만큼 좌면 위로
export function setSeatedHipHeight(h) {
  _seatedHipHeight = Number.isFinite(h) && h > 0 ? h : null
}

function _vec() {
  return _personalityVector
}

function _walkSpeed() {
  const v = _vec()
  if (!v) return 1.6
  // 0.8 .. 2.2 range. Energy is the headline driver, movementRange adds a
  // tail. Clamped so an out-of-range slider can't make the character glide.
  return Math.max(0.8, Math.min(2.2, 1.0 + v.energy * 0.9 + v.movementRange * 0.3))
}

// 보행 다리 IK(main.js applyWalkLegs)가 no-slip 보폭을 몸 진행속도에 맞추는 데
// 필요. _walkSpeed와 같은 출처라 항상 일치.
export function getWalkSpeed() {
  return _walkSpeed()
}

function _sitDuration() {
  const v = _vec()
  if (!v) return 8000
  // fidgetiness ↑ → sit shorter. 4_500 .. 13_000 ms.
  return Math.round(Math.max(4500, Math.min(13000,
    13000 - v.fidgetiness * 8500
  )))
}

function _idleTurnInterval() {
  const v = _vec()
  if (!v) return [4, 9]
  // Codex MUST-FIX: fidgetiness ↑ should make the *interval* shorter (the
  // character glances around more often). Old draft had it inverted.
  // 2 .. 6 seconds min, +3 .. 7 random tail.
  const minSecs = Math.max(1.5, 6 - v.fidgetiness * 4)
  const tailSecs = Math.max(2, 7 - v.curiosity * 4)
  return [minSecs, tailSecs]
}

export function setPersonalityVector(vector) {
  // Stable ref accepted (recommended) or null to reset to defaults.
  _personalityVector = vector || null
}

export function getPersonalityVector() {
  return _personalityVector
}

/**
 * Phase A — pick a random spot inside BOUNDS that is at least `minDistance`
 * away from the current position, then walk to it. Used by world.js's free
 * roam path so the character doesn't trace a left/right line between fixed
 * furniture targets all day.
 *
 * Returns `false` if the character isn't placed yet (no mesh3D) or no
 * suitable spot was found in N tries (rare — BOUNDS are roomy).
 */
export function walkToRandomSpot({ minDistance = 1.2, onArrive = null } = {}) {
  if (!mesh3D) return false
  const cx = mesh3D.position.x
  const cz = mesh3D.position.z
  for (let i = 0; i < 16; i += 1) {
    const x = BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX)
    const z = BOUNDS.minZ + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ)
    // 가구 안 지점은 버린다 — 빈 바닥으로만 배회(통과·끼임 방지).
    if (Math.hypot(x - cx, z - cz) >= minDistance && !_insideObstacle(x, z)) {
      walkTo({ x, z, onArrive })
      return true
    }
  }
  return false
}

/**
 * Phase C — request the character to face the user for `durationMs`.
 * Honored by every state's body-yaw blend in this module. When
 * `approach = true`, also walk to a fixed spot near the 4th wall (low z)
 * so the character feels like it's coming closer to the monitor glass.
 */
export function requestFaceCamera({ durationMs = 8000, approach = true } = {}) {
  faceCameraUntil = Date.now() + Math.max(1000, durationMs)
  if (approach && mesh3D) {
    // Codex MUST-FIX (Phase C round 2): the camera sits at +z, so "approach"
    // must walk TOWARD higher z values, not lower. We park the character
    // near the front edge of the room (close to the aquarium glass) so it
    // reads as "she stepped up to the monitor to talk to you".
    const x = mesh3D.position.x * 0.5
    const z = Math.min(BOUNDS.maxZ - 0.3, 5.0)
    faceCameraApproachTarget = { x, z }
    walkTo({ x, z })
  } else {
    faceCameraApproachTarget = null
  }
}

export function isFacingCamera() {
  return _isFacingCameraActive()
}

function _isFacingCameraActive() {
  return faceCameraUntil > 0 && Date.now() < faceCameraUntil
}

export function walkTo({ x, z, sitOffset = null, sitRotY = 0, seatHeight = null, onArrive = null, holdSit = false, sitDurationMs = null }) {
  sitUntil = 0
  sitHeld = false

  if (mesh3D && state === STATE.SIT) {
    mesh3D.position.y = 0
  }

  activeSitPose = null

  let clampedX = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, x))
  let clampedZ = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, z))

  // 가구 안이 목적지면 그 앞 접근점으로(통과 방지). 앉기(offset)는 가구 자체에
  // 앉는 것이라 접근점 보정을 건너뛴다 — 의자/침대 위에 정확히 놓여야 함.
  if (!sitOffset) {
    const fromX = mesh3D ? mesh3D.position.x : clampedX
    const fromZ = mesh3D ? mesh3D.position.z : clampedZ
    const ap = _approachTarget(clampedX, clampedZ, fromX, fromZ)
    clampedX = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, ap.x))
    clampedZ = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, ap.z))
  }

  target.set(clampedX, 0, clampedZ)
  moveConfig = { offset: sitOffset, rotY: sitRotY, seatHeight, onArrive, holdSit, sitDurationMs }
  _prevWalkDist = Infinity
  _stuckFrames = 0
  setState(STATE.WALK)
}

export function setState(s) {
  state = s
}

export function getState() {
  return state
}

// J단계 스마트 오브젝트 — held(수동) 앉기를 풀고 일어선다. 활동 시퀀서가 마시기
// 단계를 끝냈거나, 인터럽트(호출 응답 등)로 활동을 중단할 때 호출. 앉아있지 않으면
// 무해한 no-op. mesh3D가 있으면 즉시 바닥 높이로 복귀.
export function releaseSit() {
  sitHeld = false
  if (state === STATE.SIT) {
    activeSitPose = null
    sitUntil = 0
    if (mesh3D) mesh3D.position.y = 0
    setState(STATE.IDLE)
  }
}

export function onMouseMove(x, y) {
  const nx = (x / window.innerWidth) * 2 - 1
  const ny = (y / window.innerHeight) * 2 - 1
  setLookTarget(nx, ny, { source: 'canvas' })
}

export function setLookTarget(nx, ny, { source = 'canvas' } = {}) {
  if (source === 'global') globalCursorFeed = true
  else if (globalCursorFeed) return
  lookTargetX = Math.max(-1, Math.min(1, nx))
  // 상하 반전 수정: 입력 ny는 화면 위가 음수(top=-1, bottom=+1)인데 본 pitch에
  // 그대로 먹이면 "마우스 위 → 시선 아래"가 됐다. 여기서 부호를 한 번 뒤집어
  // lookTargetY는 "위가 +"가 되게 통일한다(눈·머리·목·가슴·루트 pitch 전부 동조).
  // 좌우(nx)는 정상이라 그대로 둔다.
  lookTargetY = Math.max(-1, Math.min(1, -ny))
  lastLookInputMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function getLookTarget() {
  return { x: lookTargetX, y: lookTargetY }
}

// G단계 — PMX 깜빡임. blink.value는 모델 불문 매 프레임 계산되지만 적용은
// dummy(_applyBlink)와 VRM(updateBody)뿐이었다. expressionRuntime이 이 값을
// 읽어 まばたき 모프에 쓴다.
export function getBlinkValue() {
  return blink.value
}

export function setDummyBlinkTarget(node) {
  dummyBlinkTarget = node || null
}

export function clearDummyBlinkTarget() {
  dummyBlinkTarget = null
}

export function setEmotion(e) {
  emotion = e || 'neutral'
}

let currentMotion = {
  category: 'idle',
  name: 'idle_neutral',
  intensity: 1
}

export function applyMotion(motion) {
  if (!motion) return
  currentMotion = {
    category: motion.category || 'idle',
    name: motion.name || 'idle_neutral',
    intensity: Number.isFinite(motion.intensity) ? motion.intensity : 1
  }
}

export function getCurrentMotion() {
  return currentMotion
}

export function updateCharacter(mesh, t, dt) {
  mesh3D = mesh

  // 커서가 한참 안 움직이면 시선을 서서히 중앙으로 — 사용자를 빤히
  // 계속 쳐다보는 것보다 살아 있어 보인다. 복귀 후엔 saccade/자연 자세
  // 레이어가 미세 시선을 이어받는다.
  if (lastLookInputMs) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (nowMs - lastLookInputMs > LOOK_IDLE_RETURN_MS) {
      const k = Math.exp(-LOOK_IDLE_RETURN_RATE * Math.max(dt, 0))
      lookTargetX *= k
      lookTargetY *= k
    }
  }

  _updateBlink(t, dt)
  _updateNaturalPose(t)
  _updateIdleTurn(t)

  switch (state) {
    case STATE.IDLE:
      _idle(mesh, t)
      break
    case STATE.WALK:
      _walk(mesh, t, dt)
      break
    case STATE.SIT:
      _sit(mesh, t)
      break
    case STATE.TALK:
      _talk(mesh, t)
      break
  }

  _applyBlink(mesh)
}

function _idle(mesh, t) {
  const lookYaw = _getLookYaw()
  const lookPitch = _getLookPitch()
  const motionPower = currentMotion.intensity || 1

  mesh.position.y = Math.sin(t * 1.1) * (0.012 * motionPower)
  // 좌우 흔들림(roll)을 줄여 몸이 덜 흔들리게 — 사용자 피드백. 숨쉬는 상하
  // bob(position.y)은 유지.
  mesh.rotation.z = Math.sin(t * 0.7 + pose.swaySeed) * (0.006 * motionPower)

  mesh.rotation.x = pose.tiltX + Math.sin(t * 0.5) * 0.01 + lookPitch
  mesh.rotation.z += pose.tiltZ

  if (emotion === 'happy') {
    mesh.rotation.z += 0.04
    mesh.position.y += Math.sin(t * 2.0) * 0.005
  } else if (emotion === 'sad') {
    mesh.rotation.z -= 0.04
    mesh.rotation.x += 0.025
    mesh.position.y -= 0.01
  } else if (emotion === 'surprised') {
    mesh.rotation.x -= 0.02
    mesh.rotation.z += Math.sin(t * 2.5) * 0.01
  } else if (emotion === 'angry') {
    mesh.rotation.x += 0.015
    mesh.rotation.z += Math.sin(t * 1.8) * 0.008
  }

  if (currentMotion.name === 'idle_look_down_soft') {
    mesh.rotation.x += 0.03
  } else if (currentMotion.name === 'idle_shift_weight') {
    mesh.rotation.z += Math.sin(t * 1.1) * 0.02
  } else if (currentMotion.name === 'idle_look_around') {
    mesh.rotation.y += Math.sin(t * 0.4) * 0.05
  } else if (currentMotion.name === 'idle_small_fidget') {
    mesh.rotation.x += Math.sin(t * 1.8) * 0.01
    mesh.rotation.z += Math.sin(t * 1.3) * 0.01
  }

  // Codex MUST-FIX (Phase C): facing override beats idleTurn while active.
  // 규약 정합(환경 폴리시): 스탠딩 유휴 회전도 walk/sit/onArrive처럼 camFacingYaw
  // 기준으로. idleTurn.targetYaw는 작은 좌우 오프셋이라 "카메라 방향 중심으로
  // 갸웃거림"이 된다. camFacingYaw=0인 현재는 무변화지만 규약이 단일해진다.
  const bodyYawTarget = _isFacingCameraActive()
    ? camFacingYaw
    : camFacingYaw + idleTurn.targetYaw + lookYaw
  mesh.rotation.y += _shortAngle(bodyYawTarget, mesh.rotation.y) * 0.05
}

function _walk(mesh, t, dt) {
  const dx = target.x - mesh.position.x
  const dz = target.z - mesh.position.z
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist < ARRIVE_DIST) {
    _onArrive(mesh)
    return
  }

  const spd = _walkSpeed() * dt
  const nx = dx / dist
  const nz = dz / dist

  // 다음 위치를 가구 밖으로 밀어낸 뒤 벽 경계로 클램프 → 사물 통과 방지.
  const resolved = _resolveCollision(mesh.position.x + nx * spd, mesh.position.z + nz * spd)
  mesh.position.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, resolved.x))
  mesh.position.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, resolved.z))

  // 막힘 감지 — 충돌로 목적지에 못 다가가면 영원히 걷지 않게 도착 처리.
  const newDist = Math.hypot(target.x - mesh.position.x, target.z - mesh.position.z)
  if (newDist > _prevWalkDist - 0.002) _stuckFrames += 1
  else _stuckFrames = 0
  _prevWalkDist = newDist
  if (_stuckFrames > 45) { _onArrive(mesh); return }

  // Codex MUST-FIX (Phase A): the previous bob of 0.025 made the whole body
  // pogo-stick, which combined with a T-pose looked like the character was
  // jumping in place. Bone-level gait now drives the visible movement (see
  // `updateVRMBody`); the residual root bob is just the footfall impact.
  // Honor the facing override (Phase C): turn body toward camera instead of
  // the heading vector when active.
  const yawTarget = _isFacingCameraActive() ? camFacingYaw : Math.atan2(nx, nz)
  mesh.rotation.y += _shortAngle(yawTarget, mesh.rotation.y) * 0.18
  // 몸통 bob(상하)·sway(좌우)를 실제 발딛기 케이던스에 커플링한다. 하드코딩
  // 6.2rad/s는 gait(walkStepsPerSec)와 무관해 박자가 어긋나 보였다. 같은 t와
  // 같은 공식으로 cyc를 구하므로 main.js 다리 gait와 위상이 자동 일치.
  // bob은 발딛기마다(사이클당 2회, |sin|이라 위상 무관), sway는 사이클당 1회.
  // walkStepsPerSec 공식은 main.js와 동일(순환의존 회피 위해 복제 — 함께 수정).
  const _energy = _vec()?.energy ?? 0.5
  const _cyc = t * ((2.4 + (_energy - 0.5) * 0.8) / 2)
  mesh.position.y = Math.abs(Math.sin(Math.PI * 2 * _cyc)) * 0.008
  mesh.rotation.z = Math.sin(Math.PI * 2 * _cyc) * 0.01
}

function _sit(mesh, t) {
  // held(수동 앉기)면 자동 기상 안 함 — releaseSit()으로만 일어선다.
  if (!sitHeld && sitUntil > 0 && Date.now() >= sitUntil) {
    activeSitPose = null
    sitUntil = 0
    mesh.position.y = 0
    setState(STATE.IDLE)
    return
  }

  const sitPose = activeSitPose
  const baseY = sitPose?.y ?? 0
  const lookYaw = _getLookYaw()
  const lookPitch = _getLookPitch()

  if (sitPose) {
    mesh.position.x = sitPose.x
    mesh.position.z = sitPose.z
  }

  mesh.position.y = baseY + Math.sin(t * 0.9) * 0.003
  mesh.rotation.x = pose.tiltX * 0.5 + lookPitch * 0.6
  mesh.rotation.z = pose.tiltZ * 0.4
  // sitRotY는 카메라 기준 상대각(0=사용자 마주봄) — 모델 규약이 바뀌어도 가구
  // 선언은 그대로 유효하다.
  const sitYaw = _isFacingCameraActive()
    ? camFacingYaw
    : camFacingYaw + (sitPose?.rotY ?? 0) + lookYaw * 0.35
  mesh.rotation.y += _shortAngle(sitYaw, mesh.rotation.y) * 0.06

  if (emotion === 'sad') {
    mesh.rotation.x += 0.02
  }
}

function _talk(mesh, t) {
  const motionPower = currentMotion.intensity || 1
  const lookYaw = _getLookYaw()
  const lookPitch = _getLookPitch()

  mesh.position.y = Math.sin(t * 1.6) * (0.01 * motionPower)
  mesh.rotation.x = pose.tiltX + Math.sin(t * 4.5) * 0.015 + lookPitch
  mesh.rotation.z = pose.tiltZ + Math.sin(t * 1.7 + pose.swaySeed) * 0.01
  const talkYaw = _isFacingCameraActive() ? camFacingYaw : camFacingYaw + lookYaw
  mesh.rotation.y += _shortAngle(talkYaw, mesh.rotation.y) * 0.08

  if (emotion === 'happy') {
    mesh.rotation.z += 0.035
    mesh.position.y += Math.sin(t * 3.0) * 0.004
  } else if (emotion === 'sad') {
    mesh.rotation.x += 0.02
    mesh.rotation.z -= 0.03
  } else if (emotion === 'angry') {
    mesh.rotation.x += 0.025
    mesh.rotation.y += Math.sin(t * 5.2) * 0.01
  }

  if (currentMotion.name === 'talk_happy') {
    mesh.rotation.z += 0.03
    mesh.position.y += Math.sin(t * 3.2) * 0.004
  } else if (currentMotion.name === 'talk_explain') {
    mesh.rotation.y += Math.sin(t * 2.0) * 0.02
  } else if (currentMotion.name === 'talk_think') {
    mesh.rotation.x += 0.02
    mesh.rotation.z -= 0.02
  } else if (currentMotion.name === 'talk_big_nod') {
    mesh.rotation.x += Math.sin(t * 5.0) * 0.025
  }
}

function _onArrive(mesh) {
  if (!moveConfig) {
    setState(STATE.IDLE)
    return
  }

  const { offset, rotY, seatHeight, onArrive, holdSit, sitDurationMs } = moveConfig

  if (offset) {
    // 루트 Y: 좌면 높이를 알고 골반 높이를 측정했으면 골반이 좌면 살짝 위에
    // 놓이도록 계산(공중부양 수정, 캐릭터 무관). 둘 중 하나라도 없으면 예전
    // offset.y(레거시)로 폴백.
    const rootY = (Number.isFinite(seatHeight) && _seatedHipHeight != null)
      ? seatHeight + SEAT_BUTT_MARGIN - _seatedHipHeight
      : offset.y
    activeSitPose = {
      x: target.x + offset.x,
      y: rootY,
      z: target.z + offset.z,
      rotY: rotY ?? 0 // 카메라 기준 상대각(0=마주봄) — updateSit에서 camFacingYaw 합성
    }

    mesh.position.set(activeSitPose.x, activeSitPose.y, activeSitPose.z)
    mesh.rotation.y = camFacingYaw + activeSitPose.rotY // 상대각 규약(updateSit과 동일 합성)
    setState(STATE.SIT)
    // held 앉기(활동 시퀀서가 통제) → 자동 기상 끔. 아니면 명시 지속시간 또는
    // 성격 기반 기본 지속시간 후 자동 기상(Codex MUST-FIX: 마시기와 충돌 방지).
    if (holdSit) {
      sitHeld = true
      sitUntil = 0
    } else {
      sitHeld = false
      sitUntil = Date.now() + (Number.isFinite(sitDurationMs) ? sitDurationMs : _sitDuration())
    }
  } else {
    activeSitPose = null
    sitUntil = 0
    sitHeld = false
    mesh.position.x = target.x
    mesh.position.z = target.z
    // 도착 시 사용자 방향으로 — camFacingYaw(실측 0)로 통일(과거 PI 상수는
    // 반대라 도착 순간 등을 보였다가 idle 블렌드가 되돌리고 있었음).
    if (!_isFacingCameraActive()) {
      mesh.rotation.y = camFacingYaw
    }
    setState(STATE.IDLE)
  }

  onArrive?.()
  moveConfig = null
}

function _updateNaturalPose(t) {
  if (pose.nextPoseAt === 0 || t >= pose.nextPoseAt) {
    pose.nextPoseAt = t + 2.5 + Math.random() * 3.5
    pose.tiltX = (Math.random() - 0.5) * 0.025
    pose.tiltZ = (Math.random() - 0.5) * 0.03
    pose.swaySeed = Math.random() * 10
  }
}

function _updateBlink(t, dt) {
  if (blink.nextAt === 0) {
    blink.nextAt = t + 2 + Math.random() * 2.5
  }

  if (t >= blink.nextAt && blink.progress <= 0) {
    blink.progress = 0.001
    blink.closing = true
  }

  if (blink.progress > 0) {
    const speed = 8.0

    if (blink.closing) {
      blink.progress += dt * speed
      if (blink.progress >= 1) {
        blink.progress = 1
        blink.closing = false
      }
    } else {
      blink.progress -= dt * speed
      if (blink.progress <= 0) {
        blink.progress = 0
        blink.value = 0
        blink.nextAt = t + 2 + Math.random() * 3
      }
    }

    blink.value = Math.sin(blink.progress * Math.PI)
  } else {
    blink.value = 0
  }
}

function _applyBlink(mesh) {
  if (!mesh) return

  // VRM은 idleVRM(main.js)이 expressionManager로 깜빡임 처리, MMD는 모프 기반.
  // dummy 모델일 때만 동작. 캐시 우선, 없으면 한 번만 폴백 스캔하고 채워둔다.
  // (loadDummy가 항상 setDummyBlinkTarget을 부르지만 dev-only 진입 경로를 대비한 belt-and-suspenders.)
  if (!dummyBlinkTarget) {
    const found = mesh.getObjectByName?.('dummy-head')
    if (!found) return
    dummyBlinkTarget = found
  }

  dummyBlinkTarget.scale.y = 1 - blink.value * 0.06
}

function _updateIdleTurn(t) {
  if (state !== STATE.IDLE && state !== STATE.SIT) return

  if (idleTurn.nextAt === 0 || t >= idleTurn.nextAt) {
    // Codex MUST-FIX (step 1 round 1): fidgetiness/curiosity now drive how
    // often the character glances around. Range tightens as fidgetiness goes
    // up; default vector reproduces the old [4, 9] window.
    const [minSecs, tailSecs] = _idleTurnInterval()
    idleTurn.nextAt = t + minSecs + Math.random() * tailSecs
    // Active personalities look further; calm sticks closer to center.
    const v = _vec()
    const range = v ? 0.45 + v.movementRange * 0.5 : 0.7
    idleTurn.targetYaw = (Math.random() - 0.5) * range
  }
}

function _getLookYaw() {
  // 루트(몸 전체) yaw는 커서를 통째로 따라가지 않는다 — 그게 "몸통이 한 덩어리로
  // 도는" 뻣뻣함의 원인이었다. 일반적인 시선 추적은 눈·머리·목 본(poseRig gaze)이
  // 담당하고, 여기 루트는 화면 가장자리(|x|>0.65)를 한참 볼 때만 그쪽으로 아주
  // 조금 천천히 오리엔트한다. deadzone 안(|x|<=0.65)에선 0 → 몸통·다리는 정면 유지.
  // gazeStrength는 "가장자리에서 몸을 얼마나 트는지"로만 남긴다(최대 ~2.6~5°).
  const ax = Math.abs(lookTargetX)
  const DEAD = 0.65
  if (ax <= DEAD) return 0
  const v = _vec()
  const maxRoot = v ? 0.045 + v.gazeStrength * 0.045 : 0.06
  const beyond = (ax - DEAD) / (1 - DEAD) // 0..1
  return Math.sign(lookTargetX) * beyond * maxRoot
}

function _getLookPitch() {
  // While facing the camera, bias the look pitch upward so the character
  // appears to be looking up at the user's eye level rather than straight
  // ahead — that's the "peering through glass" feel.
  if (_isFacingCameraActive()) {
    return FACE_CAMERA_PITCH_BIAS * 0.08
  }
  // 루트(몸 전체) pitch는 거의 죽인다 — 루트가 기울면 캐릭터가 "넘어지는" 느낌이
  // 난다(Codex). 시선의 상하 추적은 눈·머리·목 본 pitch(poseRig gaze)가 맡고,
  // 여기 루트엔 ~1° 정도의 미세 동조만 남긴다.
  return -lookTargetY * 0.02
}

function _shortAngle(tgt, cur) {
  let d = tgt - cur
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
