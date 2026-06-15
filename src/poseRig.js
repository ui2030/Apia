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

import { Quaternion, Euler, Vector3 } from 'three'

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
  // 손가락 — 5손가락 × 3마디 × 양손 = 30 role. 엄지 1마디=중수골(metacarpal/親指０).
  'lThumb1', 'lThumb2', 'lThumb3',
  'lIndex1', 'lIndex2', 'lIndex3',
  'lMiddle1', 'lMiddle2', 'lMiddle3',
  'lRing1', 'lRing2', 'lRing3',
  'lPinky1', 'lPinky2', 'lPinky3',
  'rThumb1', 'rThumb2', 'rThumb3',
  'rIndex1', 'rIndex2', 'rIndex3',
  'rMiddle1', 'rMiddle2', 'rMiddle3',
  'rRing1', 'rRing2', 'rRing3',
  'rPinky1', 'rPinky2', 'rPinky3',
  'lLeg', 'rLeg',
  'lKnee', 'rKnee',
  'lAnkle', 'rAnkle',
  'lToe', 'rToe', // 발끝(足先EX/つま先) — 변형 본만, IK 본(足ＩＫ) 아님.
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
  // PMX 표준 손가락 본 (전각 숫자 ０１２). 엄지는 親指０(중수골)·親指１·親指２.
  lThumb1: ['左親指０', '左親指0'], lThumb2: ['左親指１', '左親指1'], lThumb3: ['左親指２', '左親指2'],
  lIndex1: ['左人指１', '左人指1'], lIndex2: ['左人指２', '左人指2'], lIndex3: ['左人指３', '左人指3'],
  lMiddle1: ['左中指１', '左中指1'], lMiddle2: ['左中指２', '左中指2'], lMiddle3: ['左中指３', '左中指3'],
  lRing1: ['左薬指１', '左薬指1'], lRing2: ['左薬指２', '左薬指2'], lRing3: ['左薬指３', '左薬指3'],
  lPinky1: ['左小指１', '左小指1'], lPinky2: ['左小指２', '左小指2'], lPinky3: ['左小指３', '左小指3'],
  rThumb1: ['右親指０', '右親指0'], rThumb2: ['右親指１', '右親指1'], rThumb3: ['右親指２', '右親指2'],
  rIndex1: ['右人指１', '右人指1'], rIndex2: ['右人指２', '右人指2'], rIndex3: ['右人指３', '右人指3'],
  rMiddle1: ['右中指１', '右中指1'], rMiddle2: ['右中指２', '右中指2'], rMiddle3: ['右中指３', '右中指3'],
  rRing1: ['右薬指１', '右薬指1'], rRing2: ['右薬指２', '右薬指2'], rRing3: ['右薬指３', '右薬指3'],
  rPinky1: ['右小指１', '右小指1'], rPinky2: ['右小指２', '右小指2'], rPinky3: ['右小指３', '右小指3'],
  lLeg: ['左足D', '左足'],
  rLeg: ['右足D', '右足'],
  lKnee: ['左ひざD', '左ひざ'],
  rKnee: ['右ひざD', '右ひざ'],
  lAnkle: ['左足首D', '左足首'],
  rAnkle: ['右足首D', '右足首'],
  // 발끝 변형 본 — 足先EX(가시 발끝 마디) 우선, 없으면 つま先. つま先ＩＫ는
  // 제외(IK 타깃 본을 FK로 쓰면 안 됨 — codex MUST-FIX).
  lToe: ['左足先EX', '左つま先'],
  rToe: ['右足先EX', '右つま先'],
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
  // VRM humanoid 손가락 (three-vrm은 0.x/1.0 모두 1.0 정규화 이름으로 노출).
  // 엄지 1마디 = Metacarpal, 새끼는 Pinky가 아니라 'Little'.
  lThumb1: 'leftThumbMetacarpal', lThumb2: 'leftThumbProximal', lThumb3: 'leftThumbDistal',
  lIndex1: 'leftIndexProximal', lIndex2: 'leftIndexIntermediate', lIndex3: 'leftIndexDistal',
  lMiddle1: 'leftMiddleProximal', lMiddle2: 'leftMiddleIntermediate', lMiddle3: 'leftMiddleDistal',
  lRing1: 'leftRingProximal', lRing2: 'leftRingIntermediate', lRing3: 'leftRingDistal',
  lPinky1: 'leftLittleProximal', lPinky2: 'leftLittleIntermediate', lPinky3: 'leftLittleDistal',
  rThumb1: 'rightThumbMetacarpal', rThumb2: 'rightThumbProximal', rThumb3: 'rightThumbDistal',
  rIndex1: 'rightIndexProximal', rIndex2: 'rightIndexIntermediate', rIndex3: 'rightIndexDistal',
  rMiddle1: 'rightMiddleProximal', rMiddle2: 'rightMiddleIntermediate', rMiddle3: 'rightMiddleDistal',
  rRing1: 'rightRingProximal', rRing2: 'rightRingIntermediate', rRing3: 'rightRingDistal',
  rPinky1: 'rightLittleProximal', rPinky2: 'rightLittleIntermediate', rPinky3: 'rightLittleDistal',
  lLeg: 'leftUpperLeg',
  rLeg: 'rightUpperLeg',
  lKnee: 'leftLowerLeg',
  rKnee: 'rightLowerLeg',
  lAnkle: 'leftFoot',
  rAnkle: 'rightFoot',
  lToe: 'leftToes',
  rToe: 'rightToes',
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
  lToe: 8, rToe: 8,
}
// 손가락은 손목보다 가볍게 — 약간 더 빠른 응답(ω=12). 30개를 한 번에 채운다.
for (const hand of ['l', 'r']) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    for (const seg of [1, 2, 3]) ROLE_OMEGA[`${hand}${finger}${seg}`] = 12
  }
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
  // 손가락도 팔 체인의 일부 — 클립이 팔을 소유하면 손가락 절차 모션도 양보.
  // (granular 마스크는 rolesForBones가 이미 자동 처리하지만, legacy 통짜
  //  마스크 경로에서도 손모양 레이어가 클립 손가락 트랙과 싸우지 않게.)
  ...(() => {
    const s = []
    for (const hand of ['l', 'r'])
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'])
        for (const seg of [1, 2, 3]) s.push(`${hand}${finger}${seg}`)
    return s
  })(),
])
const TORSO_ROLES = new Set(['hip', 'lowerBody', 'spine', 'chest'])
const LEGS_ROLES = new Set([
  'lLeg', 'rLeg',
  'lKnee', 'rKnee',
  'lAnkle', 'rAnkle',
  'lToe', 'rToe',
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

// ── 팔 IK — 해석적 2본 IK + 폴 벡터로 손목을 월드 목표점에 도달시킨다 ──────
// FK 오일러로는 이 PMX 리그에서 "팔꿈치 내리고 전완만 입으로"가 불가(어깨 lift =
// 팔꿈치 abduction). IK는 손목을 목표(입)에 직접 맞춘다.
// _aimJointAtTarget = 관절의 현재 자식방향(월드)을 목표 방향으로 회전(본 roll축
// 가정 없음 → 모델 불문). applyArmIK는 이걸 코사인법칙으로 구한 팔꿈치점·손목목표에
// 적용 = 해석적 해(제약 없는 CCD의 과신전/역굽힘 방지). updateBody 뒤 호출해 clip/
// 절차 팔 위에 덮어쓴다.
const _ikBonePos = new Vector3()
const _ikEffPos = new Vector3()
const _ikCurDir = new Vector3()
const _ikTgtDir = new Vector3()
const _ikDelta = new Quaternion()
const _ikParentQ = new Quaternion()
const _ikBoneQ = new Quaternion()

function _aimJointAtTarget(joint, effector, target) {
  joint.getWorldPosition(_ikBonePos)
  effector.getWorldPosition(_ikEffPos)
  _ikCurDir.copy(_ikEffPos).sub(_ikBonePos)
  _ikTgtDir.copy(target).sub(_ikBonePos)
  if (_ikCurDir.lengthSq() < 1e-8 || _ikTgtDir.lengthSq() < 1e-8) return
  _ikCurDir.normalize()
  _ikTgtDir.normalize()
  _ikDelta.setFromUnitVectors(_ikCurDir, _ikTgtDir) // 월드 회전: effector 방향 → 목표 방향
  joint.getWorldQuaternion(_ikBoneQ)
  _ikBoneQ.premultiply(_ikDelta) // 새 월드 쿼터니언
  joint.parent.getWorldQuaternion(_ikParentQ)
  joint.quaternion.copy(_ikParentQ.invert().multiply(_ikBoneQ)) // 로컬로 변환
  joint.updateWorldMatrix(false, true) // 자식 월드 갱신(다음 관절이 최신 위치 보게)
}

// 해석적 2본 IK 보조 — 어깨/손목 월드, 길이, 폴(elbow 방향)로 팔꿈치 위치를 계산.
const _DOWN = new Vector3(0, -1, 0)
const _ikS = new Vector3()
const _ikE0 = new Vector3()
const _ikW = new Vector3()
const _ikAxis = new Vector3()
const _ikPole = new Vector3()
const _ikBend = new Vector3()
const _ikUpDir = new Vector3()
const _ikElbowPt = new Vector3()
const _ikTc = new Vector3()
const _ikAxisQ = new Quaternion()
const _ikTmpA = new Vector3()
const _ikTmpB = new Vector3()

/**
 * 어깨→팔꿈치→손목 2본 IK — **해석적 + 폴 벡터**. side 'l'|'r'. target 월드 좌표.
 * 제약 없는 CCD는 팔꿈치 과신전/역굽힘(인체 불가능) 양산 → 폴 벡터로 팔꿈치가
 * 항상 자연 방향(아래·앞)으로만 굽게 하고, 도달거리를 [|L1-L2|,L1+L2]로 clamp해
 * 팔이 펴진 채 꺾이는 것도 막는다(Codex/사용자 비판 리뷰 반영). poleDir = 팔꿈치가
 * 향할 월드 방향(없으면 아래). 결과: 손목≈target, 팔꿈치는 자연스러운 굽힘.
 */
export function applyArmIK(registry, side, target, poleDir = null) {
  const upper = registry?.roles?.get(side + 'Arm')?.bone
  const elbow = registry?.roles?.get(side + 'Elbow')?.bone
  const wrist = registry?.roles?.get(side + 'Wrist')?.bone
  if (!upper || !elbow || !wrist || !upper.parent || !elbow.parent) return

  upper.getWorldPosition(_ikS)
  elbow.getWorldPosition(_ikE0)
  wrist.getWorldPosition(_ikW)
  const L1 = _ikS.distanceTo(_ikE0)
  const L2 = _ikE0.distanceTo(_ikW)
  if (L1 < 1e-5 || L2 < 1e-5) return

  _ikAxis.copy(target).sub(_ikS)
  let d = _ikAxis.length()
  if (d < 1e-5) return
  _ikAxis.divideScalar(d) // 어깨→목표 단위벡터

  // 도달거리 clamp — 너무 멀면 펴고(과신전 위험), 너무 가까우면 과접힘.
  const maxR = L1 + L2 - 1e-3
  const minR = Math.abs(L1 - L2) + 1e-3
  if (d > maxR) d = maxR
  if (d < minR) d = minR
  _ikTc.copy(_ikS).addScaledVector(_ikAxis, d) // clamp된 손목 목표

  // 어깨각(코사인 법칙): 어깨에서 (어깨→목표)와 (어깨→팔꿈치) 사이 각.
  let cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)
  cosA = Math.min(1, Math.max(-1, cosA))
  const a = Math.acos(cosA)

  // 폴 — 팔꿈치가 향할 방향(자연스러운 굽힘). 기본 아래.
  _ikPole.copy(poleDir || _DOWN)
  if (_ikPole.lengthSq() < 1e-6) _ikPole.set(0, -1, 0)
  _ikPole.normalize()
  // 굽힘축 = axis ⊥ pole. 평행이면 대체축으로.
  _ikBend.crossVectors(_ikAxis, _ikPole)
  if (_ikBend.lengthSq() < 1e-6) {
    _ikBend.crossVectors(_ikAxis, _ikTmpA.set(0, 0, 1))
    if (_ikBend.lengthSq() < 1e-6) _ikBend.crossVectors(_ikAxis, _ikTmpB.set(1, 0, 0))
  }
  _ikBend.normalize()

  // 팔꿈치 위치 = 어깨 + (axis를 굽힘축 둘레로 a만큼 폴 쪽으로 회전) × L1.
  _ikAxisQ.setFromAxisAngle(_ikBend, a)
  _ikUpDir.copy(_ikAxis).applyQuaternion(_ikAxisQ)
  // 폴 쪽으로 굽었는지 확인 — 반대면 -a로(역굽힘 방지).
  if (_ikUpDir.dot(_ikPole) < _ikAxis.dot(_ikPole)) {
    _ikAxisQ.setFromAxisAngle(_ikBend, -a)
    _ikUpDir.copy(_ikAxis).applyQuaternion(_ikAxisQ)
  }
  _ikElbowPt.copy(_ikS).addScaledVector(_ikUpDir, L1)

  // 본 정렬: 위팔이 계산된 팔꿈치점을, 전완이 clamp된 손목 목표를 향하게.
  _aimJointAtTarget(upper, elbow, _ikElbowPt)
  upper.updateWorldMatrix(false, true)
  _aimJointAtTarget(elbow, wrist, _ikTc)
}

/**
 * 다리(hip→knee→ankle) 2본 IK — applyArmIK와 동일한 해석적 + 폴 벡터 해법.
 * side 'l'|'r', target=발목 월드 목표, poleDir=무릎이 향할 월드 방향(걷기 진행방향
 * = 무릎 앞 굽힘). hip(lLeg=左足D)·knee(lKnee=左ひざD)만 회전시키고 ankle은 호출자가
 * 따로 정렬(발바닥 평행 유지). 도달거리 clamp로 무릎 과신전·역굽힘 방지.
 * 무클립시 MMD 솔버가 꺼져 있으므로([[apia-walk-gait]]) 이 직접 해석 IK로 다리를 구동.
 */
export function applyLegIK(registry, side, target, poleDir = null) {
  const hip = registry?.roles?.get(side + 'Leg')?.bone
  const knee = registry?.roles?.get(side + 'Knee')?.bone
  const ankle = registry?.roles?.get(side + 'Ankle')?.bone
  if (!hip || !knee || !ankle || !hip.parent || !knee.parent) return false

  hip.getWorldPosition(_ikS)
  knee.getWorldPosition(_ikE0)
  ankle.getWorldPosition(_ikW)
  const L1 = _ikS.distanceTo(_ikE0)
  const L2 = _ikE0.distanceTo(_ikW)
  if (L1 < 1e-5 || L2 < 1e-5) return false

  _ikAxis.copy(target).sub(_ikS)
  let d = _ikAxis.length()
  if (d < 1e-5) return false
  _ikAxis.divideScalar(d)

  const maxR = L1 + L2 - 1e-3
  const minR = Math.abs(L1 - L2) + 1e-3
  if (d > maxR) d = maxR
  if (d < minR) d = minR
  _ikTc.copy(_ikS).addScaledVector(_ikAxis, d) // clamp된 발목 목표

  let cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)
  cosA = Math.min(1, Math.max(-1, cosA))
  const a = Math.acos(cosA)

  // 폴 — 무릎이 향할 방향(걷기 진행방향 앞). 기본 아래(서 있을 때).
  _ikPole.copy(poleDir || _DOWN)
  if (_ikPole.lengthSq() < 1e-6) _ikPole.set(0, 0, 1)
  _ikPole.normalize()
  _ikBend.crossVectors(_ikAxis, _ikPole)
  if (_ikBend.lengthSq() < 1e-6) {
    _ikBend.crossVectors(_ikAxis, _ikTmpA.set(0, 0, 1))
    if (_ikBend.lengthSq() < 1e-6) _ikBend.crossVectors(_ikAxis, _ikTmpB.set(1, 0, 0))
  }
  _ikBend.normalize()

  _ikAxisQ.setFromAxisAngle(_ikBend, a)
  _ikUpDir.copy(_ikAxis).applyQuaternion(_ikAxisQ)
  if (_ikUpDir.dot(_ikPole) < _ikAxis.dot(_ikPole)) {
    _ikAxisQ.setFromAxisAngle(_ikBend, -a)
    _ikUpDir.copy(_ikAxis).applyQuaternion(_ikAxisQ)
  }
  _ikElbowPt.copy(_ikS).addScaledVector(_ikUpDir, L1) // 무릎점

  _aimJointAtTarget(hip, knee, _ikElbowPt)
  hip.updateWorldMatrix(false, true)
  _aimJointAtTarget(knee, ankle, _ikTc)
  return true
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

// kind: 'nod' | 'surprise' (react) | 'lookaround' | 'lookdown' | 'headtilt' (idle gaze).
export function triggerImpulse(state, kind, t, intensity = 1) {
  if (!state) return
  const DUR = { nod: 0.7, surprise: 0.65, lookaround: 1.9, lookdown: 1.7, headtilt: 2.2 }
  if (!(kind in DUR)) return
  state.kind = kind
  state.t0 = t
  state.dur = DUR[kind]
  state.intensity = Math.max(0.4, Math.min(1.4, intensity))
  if (kind === 'lookaround' || kind === 'headtilt') state.dir = Math.random() < 0.5 ? -1 : 1
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
  } else if (state.kind === 'headtilt') {
    // 옆으로 갸웃 — "듣는/궁금한" 제스처. Z 롤, 살짝 기울였다 유지 후 복귀.
    const env = trapezoid(p)
    const dir = state.dir || 1
    add('impulse', 'head', 0, 0, 0.18 * dir * env * k)
    add('impulse', 'neck', 0, 0, 0.08 * dir * env * k)
  }
}

// ── Hand shapes (finger curl presets) ───────────────────────────────
//
// 손가락 굽힘을 마디별 각도(라디안)로 표현한다. applyPose가
// `bone.q = restQuat * eulerToQuat(delta)`로 쓰므로 이 굽힘은 모델이
// 원래 가진 휴식 손 자세 *위에 더해진다* — 즉 모델 상대적이고 가산적
// (codex MUST-FIX a). 펴진 T-pose 막대 손가락 모델은 자연스럽게 감기고,
// 이미 살짝 감긴 모델은 약간만 더 감긴다(relaxed 진폭을 작게 둔 이유).
//
// 굽힘 축/부호는 리그 관례마다 달라 *튜닝 레버*로 노출한다. 기본값은
// 추측이 아니라 실제 Kisaki PMX(481본)에서 실측한 값:
// 人指１을 각 로컬축±로 0.6rad 돌려 손끝이 손목 쪽(=굽힘)으로 가는 정도를
// 재면 z축이 0.0159로 x(0.011)·y(0.008)의 ~2배 — z가 주 굽힘축이고,
// 왼손은 z 음수, 오른손은 z 양수가 flexion(손바닥 쪽). 측정 스크립트:
// tests/gui/finger-axis-check.mjs. 엄지는 굽힘면이 달라 진폭을 작게 잡았다
// (엄지 전용 축 분리는 후속 폴리시 — relaxed에선 오차가 ~7° 이내).
const FINGER_CURL_AXIS = 'z'              // 'x'|'y'|'z' — 굽힘이 실릴 오일러 축
const FINGER_CURL_SIGN = { l: -1, r: 1 }  // 좌우 손이 손바닥 쪽으로 감기는 부호

// 발끝 plantarflexion(발끝이 바닥 쪽으로). 실측(tests/gui/toe-axis-check.mjs,
// Kisaki 足先EX): z축이 거의 순수 하향(lateral≈0.001), 왼발 z+ / 오른발 z-.
const TOE_CURL_AXIS = 'z'
const TOE_CURL_SIGN = { l: 1, r: -1 }

const HAND_SHAPES = {
  // 가볍게 쥔 자연스러운 휴식 손. 새끼로 갈수록 약간 더 감긴다(실제 손 경향).
  relaxed: {
    thumb: [0.04, 0.10, 0.12],
    index: [0.16, 0.20, 0.16],
    middle: [0.18, 0.22, 0.18],
    ring: [0.22, 0.26, 0.20],
    pinky: [0.26, 0.30, 0.24],
  },
  // 완전히 편 손(인사·강조). 휴식 굽힘조차 0 — rest 자세 그대로 노출.
  open: {
    thumb: [0, 0, 0], index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], pinky: [0, 0, 0],
  },
  // 검지로 가리키기 — 검지만 펴고 나머지는 감는다.
  point: {
    thumb: [0.15, 0.30, 0.30], index: [0, 0, 0],
    middle: [1.0, 1.2, 1.0], ring: [1.0, 1.2, 1.0], pinky: [1.0, 1.2, 1.0],
  },
  // 주먹.
  fist: {
    thumb: [0.25, 0.55, 0.60], index: [1.1, 1.3, 1.0],
    middle: [1.1, 1.3, 1.0], ring: [1.1, 1.3, 1.0], pinky: [1.1, 1.3, 1.0],
  },
}

// role 이름을 매 프레임 문자열 파싱하지 않도록 (hand, fingerKey, segIndex)를
// 모듈 로드 시 1회 전개한다 (codex MUST-FIX d — per-frame churn 방지).
const FINGER_ROLE_PARTS = (() => {
  const out = []
  const fingers = { Thumb: 'thumb', Index: 'index', Middle: 'middle', Ring: 'ring', Pinky: 'pinky' }
  for (const hand of ['l', 'r'])
    for (const [Fname, fkey] of Object.entries(fingers))
      for (const seg of [1, 2, 3])
        out.push({ role: `${hand}${Fname}${seg}`, hand, fkey, segIndex: seg - 1 })
  return out
})()

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
  handShape, // 손모양 프리셋 키('relaxed'|'open'|'point'|'fist'). 기본 relaxed.
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
    handShape: new Map(),
    toe: new Map(),
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
    // 무게중심 좌우 이동(hip sway) 진폭 축소 — 몸이 덜 흔들리게(사용자 피드백).
    const wsAmp = 0.011 * intensity
    add('weightShift', 'hip', 0, 0, ws * wsAmp)
    add('weightShift', 'lowerBody', 0, 0, ws * wsAmp * 0.7)
    add('weightShift', 'lAnkle', 0, 0, ws * wsAmp * 0.2)
    add('weightShift', 'rAnkle', 0, 0, -ws * wsAmp * 0.2)
  }

  // — Layer 2.5: toe settle. 발끝이 판자처럼 굳지 않게 숨결에 맞춰 아주 미세하게
  // (~1.4°) 움직인다. 걷기 중엔 main.js 게이트 오버레이가 toe-off를 담당하므로
  // 여기선 생략(이중 구동 방지). 앉기 자세에서도 생략.
  if (!isSit && state !== 'walk') {
    const toeAmp = 0.025 * intensity
    const toeOsc = Math.sin(t * breathOmega - 1.0) // 숨결과 위상차
    for (const [role, hand] of [['lToe', 'l'], ['rToe', 'r']]) {
      const v = toeOsc * toeAmp * (TOE_CURL_SIGN[hand] || 1)
      add('toe', role,
        TOE_CURL_AXIS === 'x' ? v : 0,
        TOE_CURL_AXIS === 'y' ? v : 0,
        TOE_CURL_AXIS === 'z' ? v : 0)
    }
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
  // 머리가 시선 체인을 이끌고, 목→가슴→척추로 점점 약하게 받아 상체가
  // 한 덩어리가 아니라 마디마디 따라 도는 layered look-at을 만든다. 루트(몸 전체)
  // yaw는 characterController에서 거의 죽였으므로(데드존), 화면 가장자리 추적의
  // 대부분을 이 본 체인이 담당한다. 가슴/척추는 작게 — breath·torso 클립과
  // 합쳐질 때 자세가 흐려지지 않도록(Codex).
  add('gaze', 'head', -ly * 0.10, lx * 0.17, 0)
  add('gaze', 'neck', -ly * 0.08, lx * 0.15, 0)
  add('gaze', 'chest', -ly * 0.02, lx * 0.04, 0)
  add('gaze', 'spine', 0, lx * 0.02, 0)

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

  // — Layer 10: hand shape (finger curl). Selectable preset (director 입력);
  // 기본 relaxed라 펴진 손가락이 막대처럼 뻣뻣해 보이지 않는다. 모델 휴식 손
  // 자세 위에 가산(applyPose가 restQuat*delta 합성). 클립이 팔/손가락을
  // 소유하면 해당 role은 stepPoseSpring/applyPose에서 마스킹돼 클립 손가락
  // 트랙과 싸우지 않는다. add()는 모델에 없는 손가락 role은 자동 무시.
  // 기본은 'open'(굽힘 0) — relaxed 절차 굽힘이 엄지/일부 마디에서 기괴하게
  // 비틀리는 문제(굽힘 축을 검지로만 실측)가 있어 기본 비활성. 모델 휴식 손
  // 자세를 그대로 쓴다. 클립/디렉터가 명시하면 그 프리셋을 쓴다. 제대로 된
  // 손 굽힘은 본별 굽힘축 도출 후 재활성(후속).
  const shape = HAND_SHAPES[handShape] || HAND_SHAPES.open
  for (const { role, hand, fkey, segIndex } of FINGER_ROLE_PARTS) {
    if (!registry.roles.has(role)) continue
    const mag = shape[fkey]?.[segIndex]
    if (!mag) continue
    const curl = mag * (FINGER_CURL_SIGN[hand] || 1)
    add(
      'handShape', role,
      FINGER_CURL_AXIS === 'x' ? curl : 0,
      FINGER_CURL_AXIS === 'y' ? curl : 0,
      FINGER_CURL_AXIS === 'z' ? curl : 0,
    )
  }

  return { summed, layers }
}
