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
const WALK_SPEED = 1.6
const ARRIVE_DIST = 0.22
const SIT_DURATION = 8000

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

  lookTargetX = Math.max(-1, Math.min(1, nx))
  lookTargetY = Math.max(-1, Math.min(1, ny))
}

export function getLookTarget() {
  return { x: lookTargetX, y: lookTargetY }
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

  const spd = WALK_SPEED * dt
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
    sitUntil = Date.now() + SIT_DURATION
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
    idleTurn.nextAt = t + 4 + Math.random() * 5
    idleTurn.targetYaw = (Math.random() - 0.5) * 0.7
  }
}

function _getLookYaw() {
  return lookTargetX * 0.18
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
