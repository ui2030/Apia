/**
 * Animation playback layer extracted from src/main.js.
 *
 * Owns the lazy VRM-animation runtime import + the race-guard tokens for
 * VRMA and VMD playback. Caller (main.js) keeps owning the model state and
 * passes it in via a stable `ctx = { getCurrentModel: () => currentModel }`
 * — see the docstring on each play function for what they expect.
 *
 * Race-guard pattern (preserved from the original): every play call bumps
 * a module-owned token. The loader callback re-checks both the token and
 * `ctx.getCurrentModel() === model` before mutating mixer/helper state.
 * Earlier work (REGRESSION_NOTES "Async model loaders must resolve only
 * after the model is really ready") established this; the comments inline
 * cite the exact invariants.
 *
 * What's deliberately NOT in here:
 *   - playMotion dispatch (lives in main.js — it owns manifest resolution)
 *   - currentModel state (lives in main.js)
 *   - the procedural updateVRMBody/lipsync layers (separate concern)
 */
import { AnimationClip, LoopOnce, LoopRepeat, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three'
import { getMmdRuntime, getMmdHelper, stabilizeMmdPhysics, normalizeUrlToFetchable } from './modelRuntime.js'
import { markInertialTransition, findPoseAwareStart } from './inertialization.js'
import { rolesForBones } from './poseRig.js'

// Step 5+/goal A-1 (granular clipMask): pull the bone names a clip actually
// keyframes so the procedural layer can mask exactly those roles (and keep
// running on the rest). Handles MMD (".bones[左腕].quaternion") and
// three/VRM ("左腕.quaternion") track-name shapes.
function clipBoneNames(clip) {
  const names = new Set()
  for (const tr of (clip?.tracks || [])) {
    const m = tr.name.match(/\.bones\[([^\]]+)\]\./)
    if (m) { names.add(m[1]); continue }
    const dot = tr.name.indexOf('.')
    if (dot > 0) names.add(tr.name.slice(0, dot))
  }
  return names
}

// Set model._clipRoles from a clip's tracks (MMD path). main.js turns this
// into a granular clipMask; null/empty falls back to the legacy whole-group
// mask there. Cleared on release.
function setClipRoles(model, clip) {
  const reg = model?.poseRig?.registry
  if (!reg) return
  const roles = rolesForBones(reg, clipBoneNames(clip))
  model._clipRoles = roles.size ? roles : null
}

let _vrmAnimRuntime = null
let _fbxLoader = null
let _vrmaSequenceToken = 0
let _vmdSequenceToken = 0
let _fbxSequenceToken = 0

/**
 * Lazy-loads `@pixiv/three-vrm-animation` + GLTFLoader. Cached once per
 * process. Co-located with the animation module on purpose: the lazy
 * runtime is consumed only here, so cohesion beats family-resemblance to
 * modelRuntime.js's other lazy importers.
 */
async function getVRMAnimRuntime() {
  if (!_vrmAnimRuntime) {
    const [animMod, gltfMod] = await Promise.all([
      import('@pixiv/three-vrm-animation'),
      import('three/examples/jsm/loaders/GLTFLoader.js')
    ])
    _vrmAnimRuntime = { ...animMod, GLTFLoader: gltfMod.GLTFLoader }
  }
  return _vrmAnimRuntime
}

/**
 * Drains the per-model Set of 'finished' listeners hung off the model's
 * `_pendingFadeOutHandlers` property. Pure: the model is self-describing.
 * Called by main.js's clearModel() before disposing, and by playVRMAnimation
 * before installing the next non-loop action.
 */
export function clearVRMFadeHandlers(model) {
  const set = model?._pendingFadeOutHandlers
  if (!set || !model.mixer) return
  for (const h of set) model.mixer.removeEventListener('finished', h)
  set.clear()
}

// ── 클립 → 절차적 레이어 핸드오프 (C단계) ──────────────────────────────
//
// 공통 패턴: action을 fade로 내리고, fade가 *끝난* 시점에 — 그 사이 새
// 클립이 같은 슬롯을 차지하지 않았으면 — 클립 소유권 플래그를 끈다.
// 플래그를 fade 시작에 끄면 절차적 applyPose가 즉시 본을 덮어써서
// fade가 보이지 않고 자세가 톡 튄다. fade가 끝나면 mixer의 weight 0
// action은 본을 더 안 건드리므로(PropertyMixer가 bind 값으로 수렴)
// restQuat*spring을 쓰는 절차적 쪽과 연속적으로 이어진다.
function scheduleGuardedRelease(model, ctx, { action, fade, isCurrent, onRelease }) {
  if (!action) return false
  try { action.fadeOut(fade) } catch {}
  setTimeout(() => {
    try {
      if (ctx.getCurrentModel() !== model) return
      if (!isCurrent()) return
      action.stop()
      onRelease()
    } catch {}
  }, fade * 1000 + 80)
  return true
}

/**
 * 활성 클립(VMD/VRMA/FBX 중 무엇이든)을 절차적 레이어로 핸드오프한다.
 * 걷기 시작 등 "클립이 본을 놓아야 하는" 모든 지점의 단일 진입점.
 *
 * 주의(Codex MUST-FIX): 플래그는 true인데 action 참조가 아직 없으면
 * 로더가 비행 중인 것이다 — 그 슬롯은 건드리지 않고 false를 유지한
 * pending도 잡지 않는다. 클립이 착지하면 다음 프레임 호출이 잡는다.
 */
export function releaseActiveClips(model, ctx, { fade = 0.45 } = {}) {
  if (!model || model._clipReleasePending) return false
  const slots = [
    { action: model._activeVmdAction, flag: '_vmdClipActive', ref: '_activeVmdAction' },
    { action: model._activeVrmaAction, flag: '_vrmaClipActive', ref: '_activeVrmaAction' },
    { action: model._activeFbxAction, flag: '_fbxClipActive', ref: '_activeFbxAction' },
  ]
  let any = false
  for (const slot of slots) {
    const action = slot.action
    if (!action) continue
    any = scheduleGuardedRelease(model, ctx, {
      action,
      fade,
      isCurrent: () => model[slot.ref] === action,
      onRelease: () => {
        model[slot.flag] = false
        model[slot.ref] = null
        model._clipRoles = null // A-1: clip no longer owns any bones
        // MMD는 mixer가 남아 있으면 물리가 동결 자세를 따라간다 —
        // 무클립 모드로 복원 (stashMmdMixer 주석 참조)
        if (slot.flag === '_vmdClipActive') {
          model._clipMorphNames = null // 표정/입 소유권 반납
          stashMmdMixer(model)
        }
      },
    }) || any
  }
  if (any) {
    model._clipReleasePending = true
    setTimeout(() => { model._clipReleasePending = false }, fade * 1000 + 120)
  }
  return any
}

/**
 * C단계 후속 — VMD 클립 해제 시 helper의 mixer를 빼서 보관한다.
 *
 * helper-소유 mixer가 남아 있으면 _animateMesh가 매 프레임
 * _restoreBones → mixer.update → _saveBones를 돌리는데, 활성 액션이
 * 없으면 이 사이클은 고정점이라 backupBones가 클립 마지막 자세에
 * 동결되고 물리(치마/꼬리)가 화면의 절차적 자세 대신 그 동결 자세를
 * 따라간다 — 걷기 핸드오프 후 치마가 엉켜 영영 회복되지 않던 원인.
 *
 * (기각된 대안: 매 프레임 최종 자세를 backupBones에 동기화 — IK/Grant가
 * 이미 풀린 자세 위에 다시 적용돼 누적 발산, 다리가 수평으로 날아갔다.
 * _saveBones 주석의 "Grant 2회 적용 금지" 경고 그대로.)
 *
 * mixer를 item에서 제거하면 _animateMesh가 애니메이션 블록(restore/save,
 * IK/Grant)을 통째로 건너뛰고 물리가 절차적 본을 직접 읽는다 — 클립을 한
 * 번도 안 튼 무클립 모드와 동일한, 검증된 상태. mixer는 model에 보관해
 * 다음 클립 때 재부착한다(크로스페이드 인프라 유지).
 * 주의: null 대입이 아니라 undefined 대입 — helper._syncDuration은
 * undefined만 거르므로 null이면 add/remove 중 mixer._actions에서 크래시
 * (Codex MUST-FIX).
 */
function stashMmdMixer(model) {
  const helper = getMmdHelper()
  const item = helper?.objects?.get?.(model.obj) ?? helper?.objects?.[model.obj?.uuid]
  if (!item?.mixer) return
  model._stashedMmdMixer = item.mixer
  item.mixer = undefined
  delete item.backupBones
}

/**
 * Plays a `.vrma` clip on the currently-loaded VRM model.
 *
 * ctx.getCurrentModel() is consulted at every await boundary. If the active
 * model has changed (or the same model has been replaced by a later play
 * call with a fresher token), the in-flight call silently no-ops and
 * resolves null.
 */
export async function playVRMAnimation(url, { loop = false, fadeIn = 0.3 } = {}, ctx) {
  const initialModel = ctx.getCurrentModel()
  if (!initialModel || initialModel.type !== 'vrm') return null
  if (!initialModel.mixer) return null

  // Capture both the model and a fresh token. Mutations happen only via
  // `model` (the captured reference), never via ctx.getCurrentModel(), so
  // we always touch the model the caller asked us to.
  const model = initialModel
  const myToken = ++_vrmaSequenceToken

  try {
    const { VRMAnimationLoaderPlugin, createVRMAnimationClip, GLTFLoader } = await getVRMAnimRuntime()

    if (ctx.getCurrentModel() !== model || myToken !== _vrmaSequenceToken) return null

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))

    return new Promise((resolve) => {
      loader.load(
        normalizeUrlToFetchable(url),
        (gltf) => {
          if (ctx.getCurrentModel() !== model || myToken !== _vrmaSequenceToken || !model.mixer) {
            resolve(null); return
          }

          const vrmAnim = gltf.userData.vrmAnimations?.[0]
          if (!vrmAnim) { resolve(null); return }

          const clip = createVRMAnimationClip(vrmAnim, model.obj)
          // 새 action 들어가기 전에 이전 finish 리스너 정리. stopAllAction 자체는
          // 리스너를 떼지 않으므로 손수 해줘야 누적되지 않는다.
          clearVRMFadeHandlers(model)
          model.mixer.stopAllAction()
          // Step 6: a fresh VRMA clip takes ownership back from any
          // previously-running FBX clip — the procedural fallback can
          // resume layering on top of VRMA (it was always designed that
          // way). Only FBX needs the procedural layer disabled.
          model._fbxClipActive = false
          model._activeFbxAction = null
          const action = model.mixer.clipAction(clip)
          model._activeVrmaAction = action
          action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity)
          if (fadeIn > 0) action.fadeIn(fadeIn)

          if (!loop) {
            // non-loop이 끝났을 때 A-pose로 snap되지 않게 한다:
            // 마지막 프레임에서 멈춰두고(`clampWhenFinished`), fadeOut으로 weight를
            // 0으로 내려보내면 mixer가 더 이상 bone을 overwrite하지 않는다 →
            // 매 프레임 도는 updateVRMBody(절차적 layer)가 자연스럽게 take over.
            action.clampWhenFinished = true
            const onFinished = (e) => {
              if (e.action !== action) return
              model.mixer?.removeEventListener('finished', onFinished)
              model._pendingFadeOutHandlers?.delete(onFinished)
              // C단계: 클립이 끝나면 (fade 완료 후) 팔/몸통 소유권을
              // 절차적 레이어에 돌려준다 — 안 돌려주면 _vrmaClipActive가
              // 영원히 남아 호흡/제스처가 차단된 채 굳는다.
              scheduleGuardedRelease(model, ctx, {
                action,
                fade: 0.35,
                isCurrent: () => model._activeVrmaAction === action,
                onRelease: () => {
                  model._vrmaClipActive = false
                  model._activeVrmaAction = null
                },
              })
            }
            ;(model._pendingFadeOutHandlers ||= new Set()).add(onFinished)
            model.mixer.addEventListener('finished', onFinished)
          }

          action.play()
          resolve(action)
        },
        undefined,
        (err) => {
          console.warn('[VRMA] 로드 실패', url, err)
          resolve(null)
        }
      )
    })
  } catch (err) {
    console.warn('[VRMA] 런타임 로드 실패', err)
    return null
  }
}

// ── Step 6 — FBX (Mixamo) → VRM playback ─────────────────────────────────
//
// Mixamo ships humanoid clips on a fixed rig (`mixamorig:*` bones, hips
// translated in centimeters). VRM models declare a humanoid bone API that
// lets us map "leftUpperArm" to whatever the model actually named the bone.
// The retargeter:
//   1. Normalizes track names: `mixamorig:LeftArm.quaternion` →
//      `<modelLeftUpperArmBoneName>.quaternion`.
//   2. Drops position tracks on every bone except hips (skin handles those).
//   3. Scales hips position by 0.01 (cm → m) so a Mixamo "walk forward"
//      doesn't teleport the character 178 m on the first frame.
//   4. Tries common Mixamo prefix variants (Codex MUST-FIX round 1):
//      `mixamorig:`, `mixamorig1:`, `Mixamorig:`, none at all.
//
// What this does NOT do (named deferrals): rest-pose axis correction for
// T-pose vs A-pose, hand/finger retargeting, MMD .fbx routing. The result
// is good enough for "the character is clearly walking now" but the user
// may see arms reach unnaturally high — that polish lives in a future pass.

const MIXAMO_TO_VRM = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes',
}

// Codex NICE-TO-HAVE (step 6 round 2): some converters strip the colon,
// leaving names like `mixamorigHips`. Accept both forms.
const MIXAMO_PREFIX_VARIANTS = [
  'mixamorig:', 'mixamorig1:', 'mixamorig2:', 'Mixamorig:',
  'mixamorig',  'mixamorig1',  'mixamorig2',  'Mixamorig',
  '',
]

function stripMixamoPrefix(rawName) {
  for (const prefix of MIXAMO_PREFIX_VARIANTS) {
    if (!prefix) continue
    if (rawName.startsWith(prefix)) return rawName.slice(prefix.length)
  }
  return rawName
}

async function getFBXLoader() {
  if (!_fbxLoader) {
    const mod = await import('three/examples/jsm/loaders/FBXLoader.js')
    _fbxLoader = new mod.FBXLoader()
  }
  return _fbxLoader
}

function retargetMixamoToVRM(rawClip, vrm) {
  if (!vrm?.humanoid) return null
  const tracks = []
  const HIPS_SCALE = 0.01 // Mixamo cm → VRM m
  for (const track of rawClip.tracks) {
    const dot = track.name.indexOf('.')
    if (dot < 0) continue
    const rawBoneName = track.name.slice(0, dot)
    const prop = track.name.slice(dot + 1) // `quaternion` or `position`

    const mixamoBone = stripMixamoPrefix(rawBoneName)
    const vrmKey = MIXAMO_TO_VRM[mixamoBone]
    if (!vrmKey) continue

    const boneNode = vrm.humanoid.getRawBoneNode?.(vrmKey)
    if (!boneNode) continue

    if (prop === 'quaternion') {
      // Step 6 round 3 — rest pose axis correction. Mixamo records each
      // bone's keyframe rotation in *its own* local space, where the rest
      // pose is roughly T-pose with identity quaternions. The VRM has
      // already been pushed into A-pose by setupVRMRestPose, so a raw
      // copy makes the arms swing from the wrong baseline. Left-multiply
      // by the VRM bone's rest quaternion so the clip's delta rotates
      // *from* the A-pose anchor.
      const restQuat = boneNode.quaternion // local rest, ref
      const inVals = track.values
      const outVals = new Float32Array(inVals.length)
      const tq = new Quaternion()
      const out = new Quaternion()
      for (let i = 0; i + 3 < inVals.length; i += 4) {
        tq.set(inVals[i], inVals[i + 1], inVals[i + 2], inVals[i + 3])
        out.copy(restQuat).multiply(tq)
        outVals[i]     = out.x
        outVals[i + 1] = out.y
        outVals[i + 2] = out.z
        outVals[i + 3] = out.w
      }
      tracks.push(new QuaternionKeyframeTrack(
        `${boneNode.name}.quaternion`,
        Array.from(track.times),
        Array.from(outVals)
      ))
    } else if (prop === 'position' && vrmKey === 'hips') {
      // Codex MUST-FIX (step 6 round 2): take the first-frame Mixamo hips
      // as the source origin and rewrite every frame as a delta from it
      // BEFORE the cm→m scale. Plain absolute * 0.01 would jump the
      // character by Mixamo's recorded hip height (often ~1m at scale).
      // After the delta, add the VRM's own hips rest position so the
      // model lands where its skeleton expects (not at world origin).
      const values = Array.from(track.values)
      const restPos = boneNode.position
      const sx = values[0], sy = values[1], sz = values[2]
      const out = new Array(values.length)
      for (let i = 0; i + 2 < values.length; i += 3) {
        out[i]     = (values[i]     - sx) * HIPS_SCALE + restPos.x
        out[i + 1] = (values[i + 1] - sy) * HIPS_SCALE + restPos.y
        out[i + 2] = (values[i + 2] - sz) * HIPS_SCALE + restPos.z
      }
      tracks.push(new VectorKeyframeTrack(
        `${boneNode.name}.position`,
        Array.from(track.times),
        out
      ))
    }
    // every other position track silently dropped (skin handles them)
  }
  if (tracks.length === 0) return null
  return new AnimationClip(rawClip.name || 'mixamo', rawClip.duration, tracks)
}

/**
 * Plays a `.fbx` clip on the currently-loaded VRM model.
 * MMD models are skipped silently — Mixamo rig isn't PMX-compatible.
 *
 * Race-guard pattern matches playVRMAnimation: ctx.getCurrentModel() +
 * sequence token re-checked at every await + loader callback. Failure
 * returns null; caller falls back to procedural layer.
 */
export async function playFBXAnimation(url, { loop = false, fadeIn = 0.3 } = {}, ctx) {
  const initialModel = ctx.getCurrentModel()
  if (!initialModel || initialModel.type !== 'vrm') return null
  if (!initialModel.mixer) return null
  if (!initialModel.obj?.humanoid) return null

  const model = initialModel
  const myToken = ++_fbxSequenceToken

  try {
    const loader = await getFBXLoader()
    if (ctx.getCurrentModel() !== model || myToken !== _fbxSequenceToken) return null

    return new Promise((resolve) => {
      loader.load(
        normalizeUrlToFetchable(url),
        (fbx) => {
          if (ctx.getCurrentModel() !== model || myToken !== _fbxSequenceToken || !model.mixer) {
            resolve(null); return
          }
          const rawClip = fbx.animations?.[0]
          if (!rawClip) {
            console.warn('[FBX] no animation track in', url)
            resolve(null); return
          }
          const clip = retargetMixamoToVRM(rawClip, model.obj)
          if (!clip) {
            console.warn('[FBX] retarget produced 0 tracks for', url,
              '— bone naming may not match Mixamo conventions')
            resolve(null); return
          }

          clearVRMFadeHandlers(model)
          model.mixer.stopAllAction()
          const action = model.mixer.clipAction(clip)
          action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity)
          if (fadeIn > 0) action.fadeIn(fadeIn)

          // Codex MUST-FIX (step 6 round 2): the procedural updateVRMBody
          // writes absolute rotations onto the same bones every frame,
          // which steamrolls anything the clip produces. Mark the model
          // so the animate loop in main.js can skip updateVRMBody while
          // a clip is owning the rig. Cleared on finish for non-loop
          // and on next play/clearModel for loop.
          model._fbxClipActive = true
          model._activeFbxAction = action

          if (!loop) {
            action.clampWhenFinished = true
            const onFinished = (e) => {
              if (e.action !== action) return
              model.mixer?.removeEventListener('finished', onFinished)
              model._pendingFadeOutHandlers?.delete(onFinished)
              // Clip is done — yield back to procedural layer (after fade,
              // guarded — same pattern as VRMA/VMD).
              scheduleGuardedRelease(model, ctx, {
                action,
                fade: 0.35,
                isCurrent: () => model._activeFbxAction === action,
                onRelease: () => {
                  model._fbxClipActive = false
                  model._activeFbxAction = null
                },
              })
            }
            ;(model._pendingFadeOutHandlers ||= new Set()).add(onFinished)
            model.mixer.addEventListener('finished', onFinished)
          }

          action.play()
          resolve(action)
        },
        undefined,
        (err) => {
          console.warn('[FBX] 로드 실패', url, err)
          resolve(null)
        }
      )
    })
  } catch (err) {
    console.warn('[FBX] 런타임 로드 실패', err)
    return null
  }
}

/**
 * Plays a `.vmd` clip on the currently-loaded MMD model.
 *
 * VRMA와 같은 motion-name 키로 들어오지만 MMDAnimationHelper의 자체 mixer +
 * IK가 처리한다. VRMA처럼 절차적 레이어로 cross-fade하지 않는다 — MMD엔
 * 절차적 레이어가 따로 없고, non-loop 끝나면 clampWhenFinished로 마지막
 * 프레임에 머무는 게 가장 자연스럽다.
 */
export async function playMMDAnimation(url, { loop = false } = {}, ctx) {
  const initialModel = ctx.getCurrentModel()
  if (!initialModel || initialModel.type !== 'mmd') return null

  const model = initialModel
  const myToken = ++_vmdSequenceToken

  try {
    const { MMDLoader } = await getMmdRuntime()
    const helper = getMmdHelper()
    if (ctx.getCurrentModel() !== model || myToken !== _vmdSequenceToken) return null
    if (!helper) return null

    const loader = new MMDLoader()

    return new Promise((resolve) => {
      loader.loadAnimation(
        url,
        model.obj,
        (clip) => {
          if (ctx.getCurrentModel() !== model || myToken !== _vmdSequenceToken) { resolve(null); return }

          // Strip ROOT + IK bone position tracks (Step 5 of /goal hotfix).
          //
          // Some .vmd idle clips keyframe POSITION on the central spine
          // (センター/グルーブ/腰/全ての親) and the foot IK targets
          // (左足ＩＫ/右足ＩＫ/etc.). Under MMDAnimationHelper's mixer
          // those translations physically walk the character across the
          // room. Apia keeps the character where the user placed them.
          //
          // We strip *only* root + IK position tracks — NOT every bone.
          // Hair/skirt/clothing bones have legitimate position offsets
          // that the physics simulator + bind pose depend on; stripping
          // those collapses the model.
          //
          // Codex MUST-FIX round 2: PMX rigs ship with EITHER full-width
          // (`ＩＫ`) OR half-width (`IK`) bone names depending on the
          // model author. The canonical set lives in half-width form and
          // we normalize every track's bone name before comparing.
          const normalizeBoneName = (n) => n.replace(/[ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
          )
          const ROOT_BONES = new Set(
            [
              'センター', 'グルーブ', '腰', '全ての親',
              '左足IK', '右足IK', '左つま先IK', '右つま先IK',
              '左足IK親', '右足IK親',
            ].map(normalizeBoneName)
          )
          const beforeCount = clip.tracks.length
          clip.tracks = clip.tracks.filter((tr) => {
            if (!tr.name.endsWith('.position')) return true
            const m = tr.name.match(/(?:^|\.)bones\[([^\]]+)\]\.position$/)
            const boneName = m ? m[1] : tr.name.replace(/\.position$/, '')
            return !ROOT_BONES.has(normalizeBoneName(boneName))
          })
          if (clip.tracks.length !== beforeCount) {
            console.info('[VMD] stripped root+IK position tracks', {
              url: url.split('/').pop(),
              before: beforeCount,
              after: clip.tracks.length,
              dropped: beforeCount - clip.tracks.length,
            })
          }

          // 클립이 연기하는 모프(표정·입 트랙) 수집 — 재생 중엔 표정/립싱크
          // 런타임이 이 모프들을 양보한다(연기 클립의 표정이 절차 표정에
          // 덮여 죽지 않게; 고품질 연기 VMD 도입의 전제).
          {
            const clipMorphs = new Set()
            for (const tr of clip.tracks) {
              const mm = tr.name.match(/\.morphTargetInfluences\[([^\]]+)\]$/)
              if (mm) clipMorphs.add(mm[1])
            }
            model._clipMorphNames = clipMorphs.size ? clipMorphs : null
            if (clipMorphs.size) {
              console.info('[VMD] clip owns morph tracks:', clipMorphs.size, [...clipMorphs].slice(0, 8).join(','))
            }
          }

          // 물리 보존 + 크로스페이드 (B단계 — 옷 폭발/손 자세 잔존의 본 수정).
          //
          // 예전 경로는 클립을 바꿀 때마다 helper.remove → helper.add로
          // MMDPhysics + ammo world를 통째로 재생성했다. 그 재생성마다
          // RigidBody.reset()이 스케일이 섞인 좌표계에서 실행돼 옷/꼬리
          // 물리가 폭발했고(스케일 분석은 modelRuntime.stabilizeMmdPhysics
          // 참조), 파괴된 ammo world는 해제 API가 없어 그대로 누적됐다.
          // 게다가 mixer가 매번 새로 만들어져 클립 간 블렌딩이 0이었다 —
          // 이전 모션의 마지막 팔 자세가 다음 모션 위로 스냅되는 원인.
          //
          // 새 경로: mesh는 로드 때 한 번만 helper에 등록된 상태를 유지하고,
          //   - 첫 클립: helper._setupMeshAnimation으로 helper 소유 mixer만
          //     생성 (physics는 건드리지 않음; three 버전 고정이라 private
          //     호출 허용 — REGRESSION_NOTES에 기록)
          //   - 이후 클립: 같은 mixer 위에서 fadeIn/fadeOut 크로스페이드.
          //     물리 객체가 살아있으니 본이 연속적으로 움직이고 슬램이 없다.
          // F단계: 불연속 흡수의 주역이 inertialization으로 넘어가면서
          // 크로스페이드는 0.45→0.25로 축소(미추적 본 — 손가락/어깨/다리 —
          // 의 잔여 블렌딩용). Codex 권고로 보수적 축소; smoothness-check가
          // 물리 포함 회귀를 감시한다.
          const FADE_SEC = 0.25
          // 포즈 인지 전환 — loop 클립만: 새 클립 앞 절반에서 현재 자세와
          // 최근접 프레임을 찾아 거기서 시작한다. non-loop은 시작점을 밀면
          // finished가 조기 발화해 제외 (Codex MUST-FIX).
          const seekT = loop ? findPoseAwareStart(clip, model.obj) : 0
          const item = helper.objects?.get?.(model.obj) ?? helper.objects?.[model.obj.uuid]
          let action = null

          // 클립 해제 때 빼둔 mixer가 있으면 재부착 — 아래 !item.mixer
          // 분기가 _setupMeshAnimation으로 mixer를 새로 만들어 누수되는
          // 것을 막고 크로스페이드 인프라를 유지한다 (stashMmdMixer 참조)
          if (item && !item.mixer && model._stashedMmdMixer) {
            item.mixer = model._stashedMmdMixer
            model._stashedMmdMixer = null
          }

          if (!item) {
            // 등록 안 된 mesh (정상 흐름에선 없음) — 마지막 수단으로 full add.
            helper.add(model.obj, { animation: clip, physics: true, warmup: 0 })
            stabilizeMmdPhysics(model.obj)
            const fresh = helper.objects?.get?.(model.obj)
            action = fresh?.mixer?.clipAction?.(clip) ?? null
            if (action) markInertialTransition(model)
          } else if (!item.mixer) {
            // 첫 클립: mixer + loop 리스너 생성. _setupMeshAnimation은 클립을
            // weight 1로 즉시 play()하므로, 멈췄다가 fadeIn으로 다시 건다.
            // (private API 가드 — three 버전이 바뀌어 사라지면 옛 경로로 폴백)
            if (typeof helper._setupMeshAnimation !== 'function') {
              console.warn('[VMD] helper._setupMeshAnimation missing — falling back to remove+add')
              try { helper.remove(model.obj) } catch {}
              helper.add(model.obj, { animation: clip, physics: true, warmup: 0 })
              stabilizeMmdPhysics(model.obj)
            } else {
              helper._setupMeshAnimation(model.obj, clip)
            }
            action = item.mixer?.clipAction?.(clip) ?? null
            if (action) {
              action.stop()
              action.reset().fadeIn(FADE_SEC).play()
              if (seekT > 0) action.time = seekT
              // 절차적 자세 → 첫 클립도 전환이다 — 표시 자세 캐시 기준으로
              // 다음 프레임에 offset 실측 (inertialization.js 참조)
              markInertialTransition(model)
            }
          } else {
            const mixer = item.mixer
            const prevAction = model._activeVmdAction ?? null
            const prevClip = model._activeVmdClip ?? null
            action = mixer.clipAction(clip)
            action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1)
            if (prevAction && prevAction !== action) prevAction.fadeOut(FADE_SEC)
            action.fadeIn(FADE_SEC).play()
            if (seekT > 0) action.time = seekT
            markInertialTransition(model)
            if (prevClip && prevClip !== clip) {
              // 페이드가 끝난 뒤 옛 클립을 mixer 캐시에서 내린다. 그 사이에
              // 같은 클립이 다시 활성화됐거나 모델이 교체됐으면 건너뜀.
              setTimeout(() => {
                if (model._activeVmdClip === prevClip) return
                if (ctx.getCurrentModel() !== model) return
                try {
                  prevAction?.stop?.()
                  mixer.uncacheClip(prevClip)
                } catch {}
              }, FADE_SEC * 1000 + 250)
            }
          }

          model._activeVmdAction = action
          model._activeVmdClip = clip
          setClipRoles(model, clip) // A-1: granular mask = only the bones this clip keys

          if (action) {
            if (!loop) {
              action.setLoop(LoopOnce, Infinity)
              action.clampWhenFinished = true
              // C단계: non-loop 클립이 끝나면 (fade 완료 후) 소유권을
              // 절차적 레이어로 돌려준다. 이게 없으면 _vmdClipActive가
              // 영원히 남아 마지막 프레임에 굳는다. main.js가 플래그를
              // 켜고, 여기서 끈다 — FBX 경로와 같은 분담.
              const liveMixer = (helper.objects?.get?.(model.obj))?.mixer
              if (liveMixer) {
                const onFinished = (e) => {
                  if (e.action !== action) return
                  liveMixer.removeEventListener('finished', onFinished)
                  scheduleGuardedRelease(model, ctx, {
                    action,
                    fade: 0.5,
                    isCurrent: () => model._activeVmdAction === action,
                    onRelease: () => {
                      model._vmdClipActive = false
                      model._activeVmdAction = null
                      model._clipRoles = null // A-1
                      model._clipMorphNames = null // 표정/입 양보 해제
                      stashMmdMixer(model)
                    },
                  })
                }
                liveMixer.addEventListener('finished', onFinished)
              }
            } else {
              action.setLoop(LoopRepeat, Infinity)
            }
          }

          resolve(clip)
        },
        undefined,
        (err) => {
          console.warn('[VMD] 로드 실패', url, err)
          resolve(null)
        }
      )
    })
  } catch (err) {
    console.warn('[VMD] 런타임 로드 실패', err)
    return null
  }
}
