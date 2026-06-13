// src/poseRig.js
// Data-driven body pose system. Replaces the part-by-part hardcoded sine
// blocks in main.js (updateMMDBody / updateVRMBody / _applyArmPose / etc.).
//
// Design (see commit Step 2 of /goal):
//   buildBoneRegistry  — once per model load. Walks the rig, picks one bone
//                        per humanoid role, snapshots restQuat + restEuler,
//                        derives a fingerprint (A-pose vs T-pose, head
//                        rest tilt, etc.). Future writes are *additive*
//                        over the snapshot, so model-specific posture
//                        (e.g. Kisaki's slight head tilt at restEuler
//                        [0.028, -0.071, 0.002]) survives.
//   computePoseTargets — every frame, all roles in one pass. Returns
//                        `{summed, layers}`. `summed` is the additive
//                        per-role euler delta; `layers` is the same data
//                        split by purpose (breath / gaze / saccade / ...)
//                        so a future .vmd idle clip mixer can mask
//                        specific layers without touching others.
//   stepPoseSpring     — critically-damped second-order filter per role
//                        per axis. dt is clamped to 1/30s so an Electron
//                        hitch can't overshoot the head/eyes.
//   applyPose          — bone.quaternion = restQuat * eulerToQuat(spring).
//                        Never overwrites; never destroys the model's
//                        rest posture.
//
// No part-by-part functions outside this file.

import { Quaternion, Euler } from 'three'

// ── Bone role table — single source of truth ─────────────────────────
// Every role is *optional* per model. The registry only stores roles
// whose candidate bones actually exist on this rig.

const HUMANOID_ROLES = [
  'hip', 'lowerBody', 'spine', 'chest',
  'neck', 'head',
  'eyes', 'lEye', 'rEye',
  'lShoulder', 'rShoulder',
  'lArm', 'rArm',
  'lElbow', 'rElbow',
  'lArmTwist', 'rArmTwist',
  'lHandTwist', 'rHandTwist',
  'lWrist', 'rWrist',
  'lLeg', 'rLeg',
  'lKnee', 'rKnee',
  'lAnkle', 'rAnkle',
]

// PMX 일본어 본 이름. 순서 = 우선순위 (예: D-bone이 있으면 D-bone 우선).
const MMD_CANDIDATES = {
  hip: ['腰'],
  lowerBody: ['下半身'],
  spine: ['上半身'],
  chest: ['上半身2', '上半身3'],
  neck: ['首'],
  head: ['頭'],
  eyes: ['両目'],
  lEye: ['左目'],
  rEye: ['右目'],
  lShoulder: ['左肩C', '左肩', '左肩P'],
  rShoulder: ['右肩C', '右肩', '右肩P'],
  lArm: ['左腕'],
  rArm: ['右腕'],
  lArmTwist: ['左腕捩'],
  rArmTwist: ['右腕捩'],
  lElbow: ['左ひじ', '左ヒジ', '左肘'],
  rElbow: ['右ひじ', '右ヒジ', '右肘'],
  lHandTwist: ['左手捩'],
  rHandTwist: ['右手捩'],
  lWrist: ['左手首'],
  rWrist: ['右手首'],
  lLeg: ['左足D', '左足'],
  rLeg: ['右足D', '右足'],
  lKnee: ['左ひざD', '左ひざ'],
  rKnee: ['右ひざD', '右ひざ'],
  lAnkle: ['左足首D', '左足首'],
  rAnkle: ['右足首D', '右足首'],
}

// VRM humanoid normalized bone names (three-vrm).
const VRM_NORMALIZED = {
  hip: 'hips',
  lowerBody: 'spine',
  spine: 'spine',
  chest: 'chest',
  neck: 'neck',
  head: 'head',
  lEye: 'leftEye',
  rEye: 'rightEye',
  // VRM has no combined 両目 — gaze is written to lEye + rEye both.
  lShoulder: 'leftShoulder',
  rShoulder: 'rightShoulder',
  lArm: 'leftUpperArm',
  rArm: 'rightUpperArm',
  lElbow: 'leftLowerArm',
  rElbow: 'rightLowerArm',
  lWrist: 'leftHand',
  rWrist: 'rightHand',
  lLeg: 'leftUpperLeg',
  rLeg: 'rightUpperLeg',
  lKnee: 'leftLowerLeg',
  rKnee: 'rightLowerLeg',
  lAnkle: 'leftFoot',
  rAnkle: 'rightFoot',
}

// ── Registry build ───────────────────────────────────────────────────

/**
 * Walk a loaded mesh / VRM and resolve every humanoid role to a bone
 * (when present), snapshot its rest pose, and derive a fingerprint
 * describing the model's resting posture so per-frame code can decide
 * whether to *correct* (T-pose models) or *preserve* (A-pose models)
 * baked-in orientations.
 *
 * @param {THREE.SkinnedMesh|object} meshOrRoot - PMX SkinnedMesh OR VRM root scene
 * @param {'mmd'|'vrm'} type
 * @param {object|null} vrmInstance - three-vrm VRM object (for type='vrm')
 * @returns {{ roles: Map<string, {bone, restQuat, restEuler}>, fingerprint: object, type }}
 */
export function buildBoneRegistry(meshOrRoot, type, vrmInstance = null) {
  const roles = new Map()

  if (type === 'mmd') {
    const mesh = meshOrRoot
    const bones = mesh.skeleton?.bones || []
    const byName = new Map(bones.map((b) => [b.name, b]))
    for (const role of HUMANOID_ROLES) {
      const candidates = MMD_CANDIDATES[role]
      if (!candidates) continue
      for (const name of candidates) {
        const bone = byName.get(name)
        if (bone) {
          roles.set(role, {
            bone,
            restQuat: bone.quaternion.clone(),
            restEuler: { x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z },
          })
          break
        }
      }
    }
  } else if (type === 'vrm' && vrmInstance) {
    const humanoid = vrmInstance.humanoid
    if (!humanoid) {
      console.warn('[poseRig] VRM has no humanoid; pose system will no-op')
    } else {
      for (const role of HUMANOID_ROLES) {
        const vrmName = VRM_NORMALIZED[role]
        if (!vrmName) continue
        const bone = humanoid.getNormalizedBoneNode?.(vrmName) || humanoid.getBoneNode?.(vrmName)
        if (bone) {
          roles.set(role, {
            bone,
            restQuat: bone.quaternion.clone(),
            restEuler: { x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z },
          })
        }
      }
    }
  }

  const fingerprint = computeFingerprint(roles, type)

  console.info('[poseRig] registry built', {
    type,
    rolesFound: Array.from(roles.keys()),
    rolesMissing: HUMANOID_ROLES.filter((r) => !roles.has(r)),
    fingerprint: {
      armAbductionBaked: fingerprint.armAbductionBaked,
      isAPose: fingerprint.isAPose,
      hasEyeBone: fingerprint.hasEyeBone,
      hasCombinedEyes: fingerprint.hasCombinedEyes,
      headRestTilt: fingerprint.headRestTilt,
    },
  })

  return { roles, fingerprint, type }
}

function computeFingerprint(roles, type) {
  const lArm = roles.get('lArm')
  const rArm = roles.get('rArm')
  const head = roles.get('head')
  const chest = roles.get('chest')
  const lShoulder = roles.get('lShoulder')

  const lZ = lArm ? Math.abs(lArm.restEuler.z) : 0
  const rZ = rArm ? Math.abs(rArm.restEuler.z) : 0
  const armAbductionBaked = (lZ + rZ) * 0.5

  // Blender(mmd_tools)제 PMX — 예: Kisaki — 는 A자세를 rest *회전*이 아니라
  // 본 *배치*(기하)에만 굽는다. restEuler.z가 0이라 위 지표로는 T자세로
  // 보이지만, 팔꿈치 본의 로컬 오프셋 방향을 재면 진짜 처짐 각이 나온다:
  // Kisaki lElbow pos (0.77, -0.70) → 42° 처짐. 이 각을 빼지 않고 고정
  // -1.0rad(57°)을 더 내리면 42+57=99° — 수직을 지나 손이 등 뒤로 들어간다
  // (사용자가 보고한 "손이 등 뒤" 버그의 실제 원인).
  // VRM은 normalized rig 가정이 달라 기존 동작(고정 1.0)을 유지한다.
  let armGeometryAngle = null
  if (type === 'mmd') {
    const angles = []
    for (const role of ['lElbow', 'rElbow']) {
      const p = roles.get(role)?.bone?.position
      if (!p) continue
      const horiz = Math.abs(p.x)
      const drop = -p.y
      if (horiz > 1e-6 || Math.abs(drop) > 1e-6) {
        angles.push(Math.atan2(Math.max(0, drop), horiz))
      }
    }
    if (angles.length) {
      armGeometryAngle = angles.reduce((a, b) => a + b, 0) / angles.length
    }
  }

  // 0.3 < x < 1.0 is the ambiguous band — neither full T-pose nor full
  // A-pose. We log a warning so a user reporting "arms look off" can
  // tell us the value, and we can tune per-model overrides later.
  if (armAbductionBaked > 0.3 && armAbductionBaked < 1.0) {
    console.warn(
      `[poseRig] ambiguous arm rest pose (armAbductionBaked=${armAbductionBaked.toFixed(2)}rad). ` +
      `Neither clean A-pose (>=1.0) nor clean T-pose (<=0.3). ` +
      `Arms may sit at an in-between angle. ` +
      `Workaround: drop a model-specific .vmd idle clip that explicitly poses the arms.`
    )
  }
  const needsAbductionCorrection = armAbductionBaked < 0.3

  // 휴식 시 팔이 수평에서 ~85°(거의 수직, 약간 바깥) 처지도록 모자란
  // 만큼만 보정한다. 기하 측정이 없으면(테스트 픽스처, VRM) 기존 고정
  // 1.0rad을 유지.
  const TARGET_HANG = 1.48
  let armHangCorrection = 0
  if (needsAbductionCorrection) {
    armHangCorrection = armGeometryAngle === null
      ? 1.0
      : Math.min(Math.max(TARGET_HANG - armGeometryAngle, 0), TARGET_HANG)
  }

  return {
    armAbductionBaked,
    armGeometryAngle,
    armHangCorrection,
    // ≥1rad of baked Z rotation on the upper arms means the model already
    // hangs them downward (A-pose / standing). ≤0.3rad means a true T-pose
    // and the per-frame layer should add a corrective abduction.
    isAPose: armAbductionBaked >= 1.0,
    needsAbductionCorrection,
    headRestTilt: head?.restEuler || null,
    shoulderRestTilt: lShoulder?.restEuler || null,
    chestRestTilt: chest?.restEuler || null,
    hasCombinedEyes: roles.has('eyes'),
    hasEyeBone: roles.has('eyes') || (roles.has('lEye') && roles.has('rEye')),
  }
}

// ── Pose spring ─────────────────────────────────────────────────────

// Per-role critically-damped natural frequency (rad/s, internal). Higher
// = snappier response. Eyes are snappiest (saccade), body slowest.
const ROLE_OMEGA = {
  eyes: 18, lEye: 18, rEye: 18,
  head: 14, neck: 10,
  hip: 6, lowerBody: 6, spine: 7, chest: 8,
  lShoulder: 7, rShoulder: 7,
  lArm: 6, rArm: 6,
  lElbow: 8, rElbow: 8,
  lArmTwist: 5, rArmTwist: 5,
  lHandTwist: 5, rHandTwist: 5,
  lWrist: 10, rWrist: 10,
  lLeg: 5, rLeg: 5,
  lKnee: 5, rKnee: 5,
  lAnkle: 5, rAnkle: 5,
}
const DEFAULT_OMEGA = 6

// Cap dt so Electron tab-switch / hitch can't push the spring into an
// overshoot the user would actually see.
const MAX_DT = 1 / 30

/**
 * @param {ReturnType<typeof buildBoneRegistry>} registry
 * @returns {Map<string, {current: {x,y,z}, velocity: {x,y,z}}>}
 */
export function createPoseSpring(registry) {
  const state = new Map()
  for (const role of registry.roles.keys()) {
    state.set(role, {
      current: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })
  }
  return state
}

// Role groups for clipMask routing. arms covers shoulder→twist→wrist
// because a .vmd that owns the arm pose owns the whole chain; torso
// covers the central column the breath layer otherwise drives. When a
// mask is active, those roles are *skipped* in applyPose — the clip's
// quaternion stays untouched. The spring state is *decayed toward zero*
// (slower than the normal step) so a resume after clip end lands near
// rest pose without snapping.
const ARMS_ROLES = new Set([
  'lShoulder', 'rShoulder',
  'lArm', 'rArm',
  'lElbow', 'rElbow',
  'lArmTwist', 'rArmTwist',
  'lHandTwist', 'rHandTwist',
  'lWrist', 'rWrist',
])
const TORSO_ROLES = new Set(['hip', 'lowerBody', 'spine', 'chest'])
const LEGS_ROLES = new Set([
  'lLeg', 'rLeg',
  'lKnee', 'rKnee',
  'lAnkle', 'rAnkle',
])

function maskedRoleSet(clipMask) {
  if (!clipMask) return null
  // Granular (track-based): the clip masks exactly the roles whose bones it
  // animates. Everything else keeps running procedurally — a talk clip that
  // only touches the arms no longer freezes the legs/idle.
  if (clipMask.roles) return clipMask.roles
  // Legacy whole-group mask (kept for compatibility / non-granular callers).
  const skip = new Set()
  if (clipMask.arms) for (const r of ARMS_ROLES) skip.add(r)
  if (clipMask.torso) {
    for (const r of TORSO_ROLES) skip.add(r)
    for (const r of LEGS_ROLES) skip.add(r) // sit pose / walk both live here
  }
  return skip
}

/** Locomotion roles — used by main.js to decide if a clip blocks walking. */
export const LOCOMOTION_ROLES = new Set([...LEGS_ROLES, 'hip', 'lowerBody'])

/**
 * Map a set of raw bone names (from a clip's tracks) to the humanoid roles
 * this model actually has. Uses the registry's live bone→role binding so we
 * don't duplicate the PMX/VRM name tables. Names with no matching role (hair,
 * skirt, fingers, IK…) are ignored.
 */
export function rolesForBones(registry, boneNames) {
  const nameToRole = new Map()
  for (const [role, entry] of registry.roles) {
    const name = entry?.bone?.name
    if (name) nameToRole.set(name, role)
  }
  const roles = new Set()
  for (const n of boneNames) {
    const r = nameToRole.get(n)
    if (r) roles.add(r)
  }
  return roles
}

/**
 * Step every role's spring toward its target euler delta. Critically-
 * damped: x'' = -2ω·x' - ω²·(x - target). No overshoot.
 *
 * When `clipMask` masks a role, the spring continues to decay toward 0
 * (so resuming procedural lands cleanly), but `applyPose` will skip
 * writing it. The clip's quaternion is preserved.
 *
 * @param {Map} springState
 * @param {Map<string, {x,y,z}>} targets - summed per-role delta
 * @param {number} dt - seconds since last step
 * @param {{arms?:boolean,torso?:boolean}|null} clipMask
 */
export function stepPoseSpring(springState, targets, dt, clipMask = null) {
  const clampedDt = Math.min(dt, MAX_DT)
  const skip = maskedRoleSet(clipMask)
  for (const [role, st] of springState) {
    if (skip?.has(role)) {
      // Decay toward zero — when clip ends and applyPose starts writing
      // this role again, current is already near the rest pose so the
      // procedural resume doesn't snap.
      const omega = (ROLE_OMEGA[role] ?? DEFAULT_OMEGA) * 0.5
      const omega2 = omega * omega
      const twoOmega = 2 * omega
      st.velocity.x += -(twoOmega * st.velocity.x + omega2 * st.current.x) * clampedDt
      st.velocity.y += -(twoOmega * st.velocity.y + omega2 * st.current.y) * clampedDt
      st.velocity.z += -(twoOmega * st.velocity.z + omega2 * st.current.z) * clampedDt
      st.current.x += st.velocity.x * clampedDt
      st.current.y += st.velocity.y * clampedDt
      st.current.z += st.velocity.z * clampedDt
      continue
    }
    const target = targets.get(role)
    const tx = target?.x ?? 0
    const ty = target?.y ?? 0
    const tz = target?.z ?? 0
    const omega = ROLE_OMEGA[role] ?? DEFAULT_OMEGA
    const omega2 = omega * omega
    const twoOmega = 2 * omega

    const accelX = -(twoOmega * st.velocity.x + omega2 * (st.current.x - tx))
    const accelY = -(twoOmega * st.velocity.y + omega2 * (st.current.y - ty))
    const accelZ = -(twoOmega * st.velocity.z + omega2 * (st.current.z - tz))

    st.velocity.x += accelX * clampedDt
    st.velocity.y += accelY * clampedDt
    st.velocity.z += accelZ * clampedDt

    st.current.x += st.velocity.x * clampedDt
    st.current.y += st.velocity.y * clampedDt
    st.current.z += st.velocity.z * clampedDt
  }
}

// ── Apply ───────────────────────────────────────────────────────────

const _applyEuler = new Euler(0, 0, 0, 'XYZ')
const _applyQuat = new Quaternion()

/**
 * Write `bone.quaternion = restQuat * eulerToQuat(spring.current)` for
 * every registered role. Restores rest pose first → model-specific
 * baked rotations (head tilt, A-pose abduction, etc.) survive.
 *
 * When `clipMask` masks a role, skip the write entirely. The mixer's
 * quaternion from this frame's mixer.update + helper.update stays as
 * the bone's final pose — clip authority preserved.
 *
 * @param {{arms?:boolean,torso?:boolean}|null} clipMask
 */
export function applyPose(registry, springState, clipMask = null) {
  const skip = maskedRoleSet(clipMask)
  for (const [role, st] of springState) {
    if (skip?.has(role)) continue
    const entry = registry.roles.get(role)
    if (!entry) continue
    _applyEuler.set(st.current.x, st.current.y, st.current.z)
    _applyQuat.setFromEuler(_applyEuler)
    entry.bone.quaternion.copy(entry.restQuat).multiply(_applyQuat)
  }
}

// ── Clip arm-hang composition (A-2) ─────────────────────────────────
//
// When a clip OWNS an arm (granular mask), the procedural abduction layer is
// skipped — so a clip that only carries a small gesture delta would leave the
// arm at the model's bind pose (often a T-pose) instead of hanging. Instead of
// baking the hang into every clip (model-specific → breaks on other rigs), we
// compose the SAME per-model hang the procedural layer uses on top of the
// clip's gesture output, here, every frame.
//
// Math (Codex): target = rest * hang * gesture. The mixer left
// qClip = rest * gesture, so gesture = restᐟ * qClip and
// target = rest * hang * restᐟ * qClip → bone.q.premultiply(rest*hang*restᐟ).
// Run AFTER helper.update() but BEFORE inertialization/applyPose so the
// transition smoother + displayed-pose cache see the hang-composed result.
const _hangEuler = new Euler(0, 0, 0, 'XYZ')
const _hangQ = new Quaternion()
const _hangRestInv = new Quaternion()
const _hangM = new Quaternion()

export function applyClipArmHangCorrection(registry, clipMask) {
  const fp = registry?.fingerprint
  if (!fp?.needsAbductionCorrection) return
  if (!clipMask?.roles) return // granular only — legacy mask path is separate
  const hang = fp.armHangCorrection
  if (!(hang > 0.001)) return
  for (const [role, sign] of [['lArm', -1], ['rArm', 1]]) {
    if (!clipMask.roles.has(role)) continue // clip doesn't own this arm → procedural handles it
    const entry = registry.roles.get(role)
    if (!entry) continue
    _hangEuler.set(0, 0, sign * hang)
    _hangQ.setFromEuler(_hangEuler)
    // M = rest * hang * rest⁻¹
    _hangRestInv.copy(entry.restQuat).invert()
    _hangM.copy(entry.restQuat).multiply(_hangQ).multiply(_hangRestInv)
    entry.bone.quaternion.premultiply(_hangM)
  }
}

// ── Saccade — Poisson micro-shifts, Codex spec ──────────────────────
//
// Mean inter-arrival ≈ 600ms with a 180ms refractory floor; magnitudes
// follow a long-tail mix (most 0.5-4°, occasional 5-10°, rare 10-15°);
// 60ms ballistic onset with smoothstep ease — that 60ms is what we
// experience as the "instant flick" of an eye saccade.

const SACCADE_REFRACTORY = 0.18
const SACCADE_MEAN = 0.6
const SACCADE_DURATION = 0.06

/**
 * Per-character saccade state. We allow multiple characters to share
 * the same RNG by keying off the model's poseRig object — callers
 * supply their own state slot.
 */
export function createSaccadeState() {
  return {
    nextAt: 0,
    onset: 0,
    target: { x: 0, y: 0 },
    current: { x: 0, y: 0 },
  }
}

/**
 * Sample a saccade offset for the current frame.
 *
 * @param {ReturnType<typeof createSaccadeState>} state
 * @param {number} t - elapsed seconds (model time)
 * @returns {{x:number, y:number}} radian offset in eye-local axes
 */
export function sampleSaccade(state, t) {
  if (t >= state.nextAt) {
    const r = Math.random()
    let magDeg
    if (r < 0.85) magDeg = 0.5 + Math.random() * 3.5
    else if (r < 0.99) magDeg = 5 + Math.random() * 5
    else magDeg = 10 + Math.random() * 5
    const mag = (magDeg * Math.PI) / 180
    const angle = Math.random() * Math.PI * 2
    state.target.x = Math.cos(angle) * mag
    state.target.y = Math.sin(angle) * mag
    state.onset = t
    const expSample = -Math.log(Math.max(0.001, Math.random())) * SACCADE_MEAN
    state.nextAt = t + SACCADE_REFRACTORY + expSample
  }
  const k = Math.min(1, Math.max(0, (t - state.onset) / SACCADE_DURATION))
  const ease = k * k * (3 - 2 * k)
  state.current.x = state.target.x * ease
  state.current.y = state.target.y * ease
  return state.current
}

// ── Head react impulses (A-3) ───────────────────────────────────────
//
// Nods / surprise head-jerks can't be clips: the procedural gaze layer always
// owns head/neck (never masked). So react head motions are transient impulses
// added into the head/neck target and smoothed by the same spring. A short
// time-curve plays out and clears itself.

export function createImpulseState() {
  return { kind: null, t0: 0, dur: 0 }
}

// kind: 'nod' | 'surprise' (react) | 'lookaround' | 'lookdown' (idle gaze).
export function triggerImpulse(state, kind, t, intensity = 1) {
  if (!state) return
  const DUR = { nod: 0.7, surprise: 0.65, lookaround: 1.9, lookdown: 1.7 }
  if (!(kind in DUR)) return
  state.kind = kind
  state.t0 = t
  state.dur = DUR[kind]
  state.intensity = Math.max(0.4, Math.min(1.4, intensity))
  if (kind === 'lookaround') state.dir = Math.random() < 0.5 ? -1 : 1
}

// rise → hold → fall (a soft trapezoid) for look impulses that "turn, look,
// return" instead of a single pulse.
function trapezoid(p) {
  if (p < 0.18) return p / 0.18
  if (p > 0.78) return Math.max(0, (1 - p) / 0.22)
  return 1
}

function addImpulseLayer(state, t, add) {
  if (!state?.kind) return
  const p = (t - state.t0) / state.dur
  if (p < 0 || p >= 1) { state.kind = null; return }
  const k = state.intensity ?? 1
  if (state.kind === 'nod') {
    const arch = Math.sin(Math.PI * p) // down then back
    add('impulse', 'head', 0.34 * arch * k, 0, 0)
    add('impulse', 'neck', 0.13 * arch * k, 0, 0)
    add('impulse', 'chest', 0.04 * arch * k, 0, 0)
  } else if (state.kind === 'surprise') {
    // up-jerk then settle. Bigger amplitude so the lagging spring still jolts.
    const env = Math.sin(Math.PI * Math.min(1, p * 1.6)) * (1 - p * 0.85)
    add('impulse', 'head', -0.48 * env * k, 0, 0)
    add('impulse', 'neck', -0.18 * env * k, 0, 0)
    add('impulse', 'chest', -0.05 * env * k, 0, 0)
  } else if (state.kind === 'lookaround') {
    const env = trapezoid(p)
    const dir = state.dir || 1
    add('impulse', 'neck', 0, 0.24 * dir * env * k, 0)
    add('impulse', 'head', 0, 0.15 * dir * env * k, 0)
  } else if (state.kind === 'lookdown') {
    const env = trapezoid(p)
    add('impulse', 'head', 0.20 * env * k, 0, 0)
    add('impulse', 'neck', 0.09 * env * k, 0, 0)
  }
}

// ── Pose target composition ─────────────────────────────────────────

/**
 * Compute additive euler delta for every registered role. Returns a
 * `{summed, layers}` pair: `summed` is what the spring filter consumes;
 * `layers` is the same data partitioned by purpose so a future motion-
 * clip mixer can mask layers independently (e.g. let a .vmd idle clip
 * own arms/torso while procedural keeps breath + gaze + saccade).
 *
 * @param {object} args
 * @param {ReturnType<typeof buildBoneRegistry>} args.registry
 * @param {ReturnType<typeof createSaccadeState>} args.saccadeState
 * @param {number} args.t  - model time (seconds)
 * @param {{x:number,y:number}} args.look - mouse-tracked gaze target (-1..1)
 * @param {string} args.state - 'idle' | 'talk' | 'walk' | 'sit'
 * @param {{intensity?:number}|null} args.motion - current motion settings
 * @param {object} args.personality - { energy, expressiveness, fidgetiness, ... }
 */
export function computePoseTargets({
  registry,
  saccadeState,
  impulseState, // A-3 — transient head react impulses (nod/surprise)
  t,
  look,
  state,
  motion,
  personality,
  clipMask, // Step 5 of /goal — { arms: bool, torso: bool } skips procedural
            // layers when a .vmd/.vrma/.fbx clip is driving the rig directly.
            // breath/gaze/saccade always run; only owned layers are masked.
}) {
  const fingerprint = registry.fingerprint
  const intensity = Number.isFinite(motion?.intensity) ? motion.intensity : 1
  const expr = personality?.expressiveness ?? 0.5
  const energy = personality?.energy ?? 0.5
  const fidget = personality?.fidgetiness ?? 0.5
  const isTalk = state === 'talk'
  const isSit = state === 'sit'

  // Per-layer accumulators — kept around for future masking.
  const layers = {
    breath: new Map(),
    weightShift: new Map(),
    gaze: new Map(),
    saccade: new Map(),
    fidget: new Map(),
    abductionCorrection: new Map(),
    talk: new Map(),
    idleSubtle: new Map(),
    statePose: new Map(),
    impulse: new Map(),
  }
  const summed = new Map()

  function add(layerName, role, dx, dy, dz) {
    if (!registry.roles.has(role)) return
    const layer = layers[layerName]
    const cur = layer.get(role) || { x: 0, y: 0, z: 0 }
    cur.x += dx || 0
    cur.y += dy || 0
    cur.z += dz || 0
    layer.set(role, cur)
    const sum = summed.get(role) || { x: 0, y: 0, z: 0 }
    sum.x += dx || 0
    sum.y += dy || 0
    sum.z += dz || 0
    summed.set(role, sum)
  }

  // — Layer 1: breath. Slow 0.20-0.27 Hz oscillator. Chest leads the spine
  // with a small phase lag; shoulders + neck + head get progressively
  // smaller amplitudes so the chest "rolls" instead of pulsing as a block.
  const breathFreqHz = 0.22 + energy * 0.05
  const breathOmega = breathFreqHz * 2 * Math.PI
  const breath = Math.sin(t * breathOmega)
  const breathLagged = Math.sin(t * breathOmega - 0.4)
  const breathHead = Math.sin(t * breathOmega - 0.7)
  const breathAmp = 0.012 * intensity * (0.7 + expr * 0.5)

  add('breath', 'spine', breath * breathAmp * 0.6, 0, 0)
  add('breath', 'chest', breathLagged * breathAmp * 1.0, 0, 0)
  add('breath', 'lShoulder', breathLagged * breathAmp * 0.4, 0, 0)
  add('breath', 'rShoulder', breathLagged * breathAmp * 0.4, 0, 0)
  add('breath', 'neck', breathHead * breathAmp * 0.3, 0, 0)
  add('breath', 'head', breathHead * breathAmp * 0.2, 0, 0)

  // — Layer 2: weight shift. Slower (0.15 Hz), out of phase with breath
  // so the body doesn't pulse and lean on the same beat. Hip lateral +
  // ankle counter so the feet don't slide.
  if (!isSit) {
    const wsOmega = 0.15 * 2 * Math.PI
    const ws = Math.sin(t * wsOmega + 1.5)
    const wsAmp = 0.018 * intensity
    add('weightShift', 'hip', 0, 0, ws * wsAmp)
    add('weightShift', 'lowerBody', 0, 0, ws * wsAmp * 0.7)
    add('weightShift', 'lAnkle', 0, 0, ws * wsAmp * 0.2)
    add('weightShift', 'rAnkle', 0, 0, -ws * wsAmp * 0.2)
  }

  // — Layer 3: gaze. Eyes get the full target; the head/neck share
  // progressively less. The spring's slower ω for head/neck (vs eyes)
  // naturally produces the eye-leads-head lag without an explicit delay
  // buffer.
  //
  // 付与親 caveat (Codex round 2): PMX 両目 is a *control* bone whose
  // rotation propagates to 左目/右目 via grant-parent inside the helper's
  // update — but our update order is helper.update → procedural write,
  // so writing 両目 only takes effect on the *next* frame's helper pass.
  // To avoid a one-frame lag (and to be robust on models that don't ship
  // 両目 at all), write the leaf eye bones directly whenever they exist
  // and only fall back to 両目 if leaves are missing.
  const lx = look?.x || 0
  const ly = look?.y || 0
  const hasLeafEyes = registry.roles.has('lEye') && registry.roles.has('rEye')
  if (hasLeafEyes) {
    add('gaze', 'lEye', -ly * 0.40, lx * 0.50, 0)
    add('gaze', 'rEye', -ly * 0.40, lx * 0.50, 0)
  } else if (fingerprint.hasCombinedEyes) {
    add('gaze', 'eyes', -ly * 0.40, lx * 0.50, 0)
  }
  add('gaze', 'neck', -ly * 0.10, lx * 0.20, 0)
  add('gaze', 'head', -ly * 0.05, lx * 0.10, 0)

  // — Layer 4: saccade. Eye-only, Poisson timing, ballistic onset.
  if (saccadeState) {
    const s = sampleSaccade(saccadeState, t)
    if (hasLeafEyes) {
      add('saccade', 'lEye', -s.y, s.x, 0)
      add('saccade', 'rEye', -s.y, s.x, 0)
    } else if (fingerprint.hasCombinedEyes) {
      add('saccade', 'eyes', -s.y, s.x, 0)
    }
  }

  // — Layer 4.5: head react impulse (nod/surprise). Head/neck are never
  // masked, so this rides on top of gaze through the same spring.
  addImpulseLayer(impulseState, t, add)

  // — Layer 5: fidget. Asymmetric tiny motion on shoulders + wrists,
  // scaled by the personality fidgetiness vector.
  const fidgetAmp = 0.008 * fidget * intensity
  add('fidget', 'lShoulder', 0, 0, Math.sin(t * 0.83 + 0.2) * fidgetAmp)
  add('fidget', 'rShoulder', 0, 0, -Math.sin(t * 0.71 + 1.1) * fidgetAmp)
  add('fidget', 'lWrist', Math.sin(t * 1.2 + 0.4) * fidgetAmp * 0.8, 0, 0)
  add('fidget', 'rWrist', Math.sin(t * 1.1 + 1.5) * fidgetAmp * 0.8, 0, 0)

  // — Layer 6: abduction correction. ONLY for models whose rest rotation
  // doesn't already hang the arms. The amount is per-model: fingerprint
  // measures the hang already baked into the bone GEOMETRY (elbow offset
  // direction) and adds only the shortfall to ~85°. A fixed -1.0 here
  // used to over-rotate geometry-A-pose models (Kisaki: 42° baked + 57°
  // fixed = 99° → hands drifted behind the back at rest).
  // Skipped if a clip owns the arms — the clip's pose is authoritative.
  if (fingerprint.needsAbductionCorrection && !clipMask?.arms) {
    const hang = fingerprint.armHangCorrection ?? 1.0
    if (hang > 0.001) {
      add('abductionCorrection', 'lArm', 0, 0, -hang)
      add('abductionCorrection', 'rArm', 0, 0, hang)
    }
  }

  // — Layer 7: talk gesture. Kicks in only on talk state.
  if (isTalk && !clipMask?.arms) {
    const talkAmp = 0.05 * expr * intensity
    add('talk', 'lArm', Math.sin(t * 2.2 + 0.5) * talkAmp, 0, 0)
    add('talk', 'rArm', Math.sin(t * 2.0 + 1.7) * talkAmp * 0.85, 0, 0)
    add('talk', 'lElbow', Math.sin(t * 1.8 + 0.3) * talkAmp * 1.4, 0, 0)
    add('talk', 'rElbow', Math.sin(t * 1.7 + 1.1) * talkAmp * 1.4, 0, 0)
    add('talk', 'lArmTwist', Math.sin(t * 1.5 + 0.8) * talkAmp * 0.5, 0, 0)
    add('talk', 'rArmTwist', Math.sin(t * 1.5 + 2.1) * talkAmp * 0.5, 0, 0)
  }

  // — Layer 8: idle subtle. Tiny elbow + twist when not talking.
  if (!isTalk && !clipMask?.arms) {
    const idleAmp = 0.005 * intensity * (0.5 + fidget * 0.5)
    add('idleSubtle', 'lElbow', Math.sin(t * 0.6) * idleAmp, 0, 0)
    add('idleSubtle', 'rElbow', Math.sin(t * 0.6 + 0.8) * idleAmp, 0, 0)
    add('idleSubtle', 'lArmTwist', Math.sin(t * 1.0 + 0.3) * idleAmp * 0.5, 0, 0)
    add('idleSubtle', 'rArmTwist', Math.sin(t * 1.0 + 1.5) * idleAmp * 0.5, 0, 0)
  }

  // — Layer 9: state-specific pose. Sit folds the knees + hips.
  if (isSit && !clipMask?.torso) {
    const sitBreath = breath * 0.012 * intensity
    add('statePose', 'lLeg', -1.35 + sitBreath, 0, 0)
    add('statePose', 'rLeg', -1.35 + sitBreath, 0, 0)
    add('statePose', 'lKnee', 1.55, 0, 0)
    add('statePose', 'rKnee', 1.55, 0, 0)
  }

  return { summed, layers }
}
