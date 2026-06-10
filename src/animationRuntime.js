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
import { getMmdRuntime, getMmdHelper, normalizeUrlToFetchable } from './modelRuntime.js'

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
          const action = model.mixer.clipAction(clip)
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
              action.fadeOut(0.35)
              model.mixer?.removeEventListener('finished', onFinished)
              model._pendingFadeOutHandlers?.delete(onFinished)
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

          if (!loop) {
            action.clampWhenFinished = true
            const onFinished = (e) => {
              if (e.action !== action) return
              action.fadeOut(0.35)
              model.mixer?.removeEventListener('finished', onFinished)
              model._pendingFadeOutHandlers?.delete(onFinished)
              // Clip is done — yield back to procedural layer.
              model._fbxClipActive = false
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

          // helper.add는 같은 mesh에 호출돼도 누적될 수 있다. remove 먼저 호출해서
          // 이전 animation / mixer state를 깔끔히 비우고 새 clip을 단다.
          // Codex MUST-FIX (생동감): physics: true so hair/skirt rigid
          // bodies keep swinging while the animation track plays. The
          // initial helper.add (in main.js after MMDLoader.load) already
          // turned physics on; re-adding with `physics:false` was killing
          // the simulator the moment any clip played.
          try { helper.remove(model.obj) } catch {}
          helper.add(model.obj, { animation: clip, physics: true })

          if (!loop) {
            // MMDAnimationHelper가 mesh별로 내부 mixer를 만든다. helper.objects는
            // three.js 버전마다 Map이거나 객체일 수 있어 양쪽 다 시도한다.
            const item = helper.objects?.get?.(model.obj) ?? helper.objects?.[model.obj.uuid]
            const mixer = item?.mixer
            const action = mixer?.clipAction?.(clip)
            if (action) {
              action.setLoop(LoopOnce, Infinity)
              action.clampWhenFinished = true
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
