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

  const fingerprint = computeFingerprint(roles)

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

function computeFingerprint(roles) {
  const lArm = roles.get('lArm')
  const rArm = roles.get('rArm')
  const head = roles.get('head')
  const chest = roles.get('chest')
  const lShoulder = roles.get('lShoulder')

  const lZ = lArm ? Math.abs(lArm.restEuler.z) : 0
  const rZ = rArm ? Math.abs(rArm.restEuler.z) : 0
  const armAbductionBaked = (lZ + rZ) * 0.5

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
  return {
    armAbductionBaked,
    // ≥1rad of baked Z rotation on the upper arms means the model already
    // hangs them downward (A-pose / standing). ≤0.3rad means a true T-pose
    // and the per-frame layer should add a corrective abduction.
    isAPose: armAbductionBaked >= 1.0,
    needsAbductionCorrection: armAbductionBaked < 0.3,
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
  const skip = new Set()
  if (clipMask.arms) for (const r of ARMS_ROLES) skip.add(r)
  if (clipMask.torso) {
    for (const r of TORSO_ROLES) skip.add(r)
    for (const r of LEGS_ROLES) skip.add(r) // sit pose / walk both live here
  }
  return skip
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

  // — Layer 5: fidget. Asymmetric tiny motion on shoulders + wrists,
  // scaled by the personality fidgetiness vector.
  const fidgetAmp = 0.008 * fidget * intensity
  add('fidget', 'lShoulder', 0, 0, Math.sin(t * 0.83 + 0.2) * fidgetAmp)
  add('fidget', 'rShoulder', 0, 0, -Math.sin(t * 0.71 + 1.1) * fidgetAmp)
  add('fidget', 'lWrist', Math.sin(t * 1.2 + 0.4) * fidgetAmp * 0.8, 0, 0)
  add('fidget', 'rWrist', Math.sin(t * 1.1 + 1.5) * fidgetAmp * 0.8, 0, 0)

  // — Layer 6: abduction correction. ONLY for T-pose models. Kisaki and
  // most A-pose PMX have armAbductionBaked ≥ 1rad → fingerprint.isAPose
  // → no correction (the bug we were fixing).
  // Skipped if a clip owns the arms — the clip's pose is authoritative.
  if (fingerprint.needsAbductionCorrection && !clipMask?.arms) {
    add('abductionCorrection', 'lArm', 0, 0, -1.0)
    add('abductionCorrection', 'rArm', 0, 0, 1.0)
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
