// src/characterController.js
import * as THREE from 'three'

const STATE = { IDLE: 'idle', WALK: 'walk', SIT: 'sit', TALK: 'talk' }

// ── 이동 가능 범위 ─────────────────────────────────────
const BOUNDS = {
  minX: -3.5, maxX: 3.5,
  minZ: 0.5,  maxZ: 6.0,
}

let state = STATE.IDLE
let target = new THREE.Vector3()
let sitConfig = null
let mesh3D = null
let sitTimer = null
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

let idleTurn = {
  nextAt: 0,
  targetYaw: 0
}

const CAM_LOOK_ROT = Math.PI
const WALK_SPEED = 1.6
const ARRIVE_DIST = 0.22
const SIT_DURATION = 8000

export function walkTo({ x, z, sitOffset = null, sitRotY = 0, onArrive = null }) {
  if (sitTimer) {
    clearTimeout(sitTimer)
    sitTimer = null
  }

  if (mesh3D && state === STATE.SIT) {
    mesh3D.position.y = 0
  }

  const clampedX = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, x))
  const clampedZ = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, z))

  target.set(clampedX, 0, clampedZ)
  sitConfig = { offset: sitOffset, rotY: sitRotY, onArrive }
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

  const bodyYawTarget = idleTurn.targetYaw + lookYaw
  mesh.rotation.y += _shortAngle(bodyYawTarget, mesh.rotation.y) * 0.03
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

  mesh.rotation.y += _shortAngle(Math.atan2(nx, nz), mesh.rotation.y) * 0.18
  mesh.position.y = Math.abs(Math.sin(t * 6.2)) * 0.025
  mesh.rotation.z = Math.sin(t * 6.2) * 0.01
}

function _sit(mesh, t) {
  const baseY = sitConfig?.offset?.y ?? 0
  const lookYaw = _getLookYaw()
  const lookPitch = _getLookPitch()

  mesh.position.y = baseY + Math.sin(t * 0.9) * 0.003
  mesh.rotation.x = pose.tiltX * 0.5 + lookPitch * 0.6
  mesh.rotation.z = pose.tiltZ * 0.4
  mesh.rotation.y += _shortAngle(lookYaw, mesh.rotation.y) * 0.04

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
  mesh.rotation.y += _shortAngle(lookYaw, mesh.rotation.y) * 0.08

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
  if (!sitConfig) {
    setState(STATE.IDLE)
    return
  }

  const { offset, rotY, onArrive } = sitConfig

  if (offset) {
    mesh.position.set(target.x + offset.x, offset.y, target.z + offset.z)
    mesh.rotation.y = rotY ?? 0
    setState(STATE.SIT)

    if (sitTimer) clearTimeout(sitTimer)
    sitTimer = setTimeout(() => {
      if (state === STATE.SIT) {
        mesh.position.y = 0
        setState(STATE.IDLE)
        sitTimer = null
      }
    }, SIT_DURATION)
  } else {
    mesh.position.x = target.x
    mesh.position.z = target.z
    mesh.rotation.y = CAM_LOOK_ROT
    setState(STATE.IDLE)
  }

  onArrive?.()
  sitConfig = null
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

  const head = mesh.children?.find((c) => c.position && c.position.y > 1.3)
  if (!head) return

  head.scale.y = 1 - blink.value * 0.06
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
  return -lookTargetY * 0.08
}

function _shortAngle(tgt, cur) {
  let d = tgt - cur
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}