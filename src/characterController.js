// src/characterController.js
import { Vector3 } from 'three'

const STATE = { IDLE: 'idle', WALK: 'walk', SIT: 'sit', TALK: 'talk' }

// ── 이동 가능 범위 ─────────────────────────────────────
// Phase B: matches the room footprint declared in sceneRuntime.js
// (width 8, depth 6). 0.5 inset on every wall so the character never
// clips into a wall mesh; minZ also keeps a buffer so they don't push
// into the 4th wall (= the camera glass).
const BOUNDS = {
  minX: -3.5, maxX: 3.5,
  minZ: 0.7,  maxZ: 5.5,
}

let state = STATE.IDLE
let target = new Vector3()
let moveConfig = null
let activeSitPose = null
let mesh3D = null
let sitUntil = 0
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
// Match the existing CAM_LOOK_ROT below — that's what sit/_onArrive already
// use as "facing the user". Treating it as the source of truth means we
// don't have to guess each model's forward axis again here.
const FACE_CAMERA_PITCH_BIAS = -0.35 // negative `lookTargetY` looks up

// dummy 모델의 머리 메시 참조 캐시. main.js loadDummy()에서 setDummyBlinkTarget으로
// 주입한다. 캐시가 비어 있을 때만 한 번 getObjectByName으로 폴백 검색하므로,
// _applyBlink가 매 프레임 씬 그래프를 워킹하지 않는다.
let dummyBlinkTarget = null

let idleTurn = {
  nextAt: 0,
  targetYaw: 0
}

const CAM_LOOK_ROT = Math.PI
// Codex MUST-FIX (step 1 round 1): WALK_SPEED / SIT_DURATION are no longer
// constants. They derive from the active personality vector so a "shy"
// character walks slower and stays seated longer than an "active" one.
// Defaults reproduce the pre-Phase-H baseline (1.6 / 8000) when no vector
// is set yet (dummy model or first frame).
const ARRIVE_DIST = 0.22
let _personalityVector = null

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
  for (let i = 0; i < 8; i += 1) {
    const x = BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX)
    const z = BOUNDS.minZ + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ)
    if (Math.hypot(x - cx, z - cz) >= minDistance) {
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

export function walkTo({ x, z, sitOffset = null, sitRotY = 0, onArrive = null }) {
  sitUntil = 0

  if (mesh3D && state === STATE.SIT) {
    mesh3D.position.y = 0
  }

  activeSitPose = null

  const clampedX = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, x))
  const clampedZ = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, z))

  target.set(clampedX, 0, clampedZ)
  moveConfig = { offset: sitOffset, rotY: sitRotY, onArrive }
  setState(STATE.WALK)
}

export function setState(s) {
  state = s
}

export function getState() {
  return state
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
  lookTargetY = Math.max(-1, Math.min(1, ny))
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
  mesh.rotation.z = Math.sin(t * 0.7 + pose.swaySeed) * (0.012 * motionPower)

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
  const bodyYawTarget = _isFacingCameraActive()
    ? CAM_LOOK_ROT
    : idleTurn.targetYaw + lookYaw
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

  mesh.position.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, mesh.position.x + nx * spd))
  mesh.position.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, mesh.position.z + nz * spd))

  // Codex MUST-FIX (Phase A): the previous bob of 0.025 made the whole body
  // pogo-stick, which combined with a T-pose looked like the character was
  // jumping in place. Bone-level gait now drives the visible movement (see
  // `updateVRMBody`); the residual root bob is just the footfall impact.
  // Honor the facing override (Phase C): turn body toward camera instead of
  // the heading vector when active.
  const yawTarget = _isFacingCameraActive() ? CAM_LOOK_ROT : Math.atan2(nx, nz)
  mesh.rotation.y += _shortAngle(yawTarget, mesh.rotation.y) * 0.18
  mesh.position.y = Math.abs(Math.sin(t * 6.2)) * 0.008
  mesh.rotation.z = Math.sin(t * 6.2) * 0.01
}

function _sit(mesh, t) {
  if (sitUntil > 0 && Date.now() >= sitUntil) {
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
  const sitYaw = _isFacingCameraActive()
    ? CAM_LOOK_ROT
    : (sitPose?.rotY ?? CAM_LOOK_ROT) + lookYaw * 0.35
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
  const talkYaw = _isFacingCameraActive() ? CAM_LOOK_ROT : lookYaw
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

  const { offset, rotY, onArrive } = moveConfig

  if (offset) {
    activeSitPose = {
      x: target.x + offset.x,
      y: offset.y,
      z: target.z + offset.z,
      rotY: rotY ?? CAM_LOOK_ROT
    }

    mesh.position.set(activeSitPose.x, activeSitPose.y, activeSitPose.z)
    mesh.rotation.y = activeSitPose.rotY
    setState(STATE.SIT)
    sitUntil = Date.now() + _sitDuration()
  } else {
    activeSitPose = null
    sitUntil = 0
    mesh.position.x = target.x
    mesh.position.z = target.z
    // Codex MUST-FIX (Phase C): when facing override is active, don't snap
    // back to CAM_LOOK_ROT (=PI, away from user) on arrival — keep facing
    // the camera so the idle/sit blend below picks up the override cleanly.
    if (!_isFacingCameraActive()) {
      mesh.rotation.y = CAM_LOOK_ROT
    }
    setState(STATE.IDLE)
  }

  onArrive?.()
  moveConfig = null
}

function _updateNaturalPose(t) {
  if (pose.nextPoseAt === 0 || t >= pose.nextPoseAt) {
    pose.nextPoseAt = t + 2.5 + Math.random() * 3.5
    pose.tiltX = (Math.random() - 0.5) * 0.04
    pose.tiltZ = (Math.random() - 0.5) * 0.05
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
  const v = _vec()
  // gazeStrength tunes how committedly the character tracks the cursor.
  // Default (0.45) hits the old 0.18 baseline within 0.005.
  const strength = v ? 0.10 + v.gazeStrength * 0.18 : 0.18
  return lookTargetX * strength
}

function _getLookPitch() {
  // While facing the camera, bias the look pitch upward so the character
  // appears to be looking up at the user's eye level rather than straight
  // ahead — that's the "peering through glass" feel.
  if (_isFacingCameraActive()) {
    return FACE_CAMERA_PITCH_BIAS * 0.08
  }
  return -lookTargetY * 0.08
}

function _shortAngle(tgt, cur) {
  let d = tgt - cur
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}
