import {
  AnimationMixer,
  Box3,
  CapsuleGeometry,
  DoubleSide,
  Euler,
  FrontSide,
  Group,
  LoadingManager,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three'
import { createSceneRuntime } from './sceneRuntime.js'
import { updateCharacter, onMouseMove, walkTo, walkToRandomSpot, requestFaceCamera, setEmotion, applyMotion, getState, setState, getLookTarget, getCurrentMotion, setDummyBlinkTarget, clearDummyBlinkTarget, setPersonalityVector } from './characterController.js'
import { initWorld, updateWorldLabels } from './world.js'
import { initChat, setCharacterRaycaster } from './chat.js'
import { MotionManager } from './motionManager.js'
import { resolveMotionAsset, resolveMmdMotionAsset } from './motionAssets.js'
import {
  buildBoneRegistry,
  createPoseSpring,
  createSaccadeState,
  stepPoseSpring,
  applyPose,
  computePoseTargets
} from './poseRig.js'
import {
  getVRMRuntime,
  getVRMUtils,
  getMmdRuntime,
  getMmdHelper,
  getAmmoRuntime,
  stabilizeMmdPhysics,
  normalizeUrlToFetchable,
  loadOptionalJson,
  loadManifestByPath,
  loadManifestForModel
} from './modelRuntime.js'
import {
  playVRMAnimation as playVRMAnimationRaw,
  playMMDAnimation as playMMDAnimationRaw,
  playFBXAnimation as playFBXAnimationRaw,
  clearVRMFadeHandlers,
  releaseActiveClips
} from './animationRuntime.js'

// Stable ctx passed to every animation call. Per codex review: don't rebuild
// it per call site — the animation module only ever needs to read the live
// model identity, so one closure is enough.
const animationCtx = { getCurrentModel: () => currentModel }

// playVRMAnimation/playMMDAnimation are re-exported as thin wrappers so the
// existing playMotion dispatch logic above doesn't need to know about ctx.
export function playVRMAnimation(url, opts) {
  return playVRMAnimationRaw(url, opts, animationCtx)
}

export function playMMDAnimation(url, opts) {
  return playMMDAnimationRaw(url, opts, animationCtx)
}

export function playFBXAnimation(url, opts) {
  return playFBXAnimationRaw(url, opts, animationCtx)
}

// Motion pipeline: procedural (applyMotion) + clip. 활성 모델 타입에 따라 VRMA/VMD
// 중 적절한 매니페스트에서 클립을 픽업한다. 클립이 없으면 절차적 레이어만 도는데,
// MMD엔 절차적 레이어가 따로 없으므로 클립 없을 땐 정적 pose로 유지된다 (이전 동작 유지).
// playVRMAnimation / playMMDAnimation 모두 hoisted async로 아래에 선언.
function playMotion(motion) {
  if (!motion) return
  applyMotion(motion)

  // 절차적 layer는 dummy/null 포함 모든 경우 위에서 처리. clip 재생은 type별로 분기:
  // mmd → VMD, vrm → VRMA, 그 외(dummy/null/unknown)는 명시적으로 no-op.
  const type = currentModel?.type
  if (type === 'mmd') {
    const asset = resolveMmdMotionAsset(motion.name)
    if (!asset) {
      // No .vmd matched — procedural owns the rig until next motion call.
      if (currentModel) currentModel._vmdClipActive = false
      return
    }
    if (currentModel) currentModel._vmdClipActive = true
    playMMDAnimation(asset.url, { loop: asset.loop })
      .catch((err) => {
        if (currentModel) currentModel._vmdClipActive = false
        console.warn('[playMotion] vmd clip failed', motion.name, err)
      })
    return
  }
  if (type === 'vrm') {
    const asset = resolveMotionAsset(motion.name)
    if (!asset) {
      if (currentModel) currentModel._vrmaClipActive = false
      return
    }
    // Step 6: resolveMotionAsset now returns `kind: 'vrma' | 'fbx'`. FBX
    // clips run through the Mixamo retargeter; VRMA is the native VRM
    // animation format and plays directly. Same race-guard pattern, same
    // fadeIn semantics; only the loader changes.
    if (asset.kind === 'fbx') {
      playFBXAnimation(asset.url, { loop: asset.loop, fadeIn: asset.fadeIn })
        .catch((err) => console.warn('[playMotion] fbx clip failed', motion.name, err))
    } else {
      // Step 5 of /goal — VRMA clips also need the clipMask treatment so
      // the procedural arm/torso layers don't fight the mixer's clip track.
      if (currentModel) currentModel._vrmaClipActive = true
      playVRMAnimation(asset.url, { loop: asset.loop, fadeIn: asset.fadeIn })
        .catch((err) => {
          if (currentModel) currentModel._vrmaClipActive = false
          console.warn('[playMotion] vrma clip failed', motion.name, err)
        })
    }
    return
  }
  // dummy / null / 미지원 type — 절차적 layer만 돌리고 종료.
}

window.__applyMotion = playMotion

// Scene aggregate is constructed once at module load. The handles below
// (scene/camera/renderer/clock + applyCameraDefault) are pulled out for
// the existing call sites; everything boot-time used to live here is
// now in src/sceneRuntime.js.
const _sceneRuntime = createSceneRuntime({
  canvasEl: document.getElementById('vrm-canvas')
})
const scene = _sceneRuntime.scene
const camera = _sceneRuntime.camera
const renderer = _sceneRuntime.renderer
const clock = _sceneRuntime.clock
const CAM_DEFAULT = _sceneRuntime.CAM_DEFAULT
// E2E diagnostic hatch — surface the scene for tests/gui/* scripts that
// need to walk the skeleton without coupling to the renderer's module
// boundary. Renderer's sandbox blocks process.env access, so we always
// expose; it's just the Three.js scene graph, no secrets.
if (typeof window !== 'undefined') {
  window.__apiaScene = scene
  // Camera too — vmd-check.mjs orbits it (front/side/back) per motion so
  // clipping that only shows from behind isn't missed. Same hatch rationale.
  window.__apiaCamera = camera
}
const applyCameraDefault = _sceneRuntime.applyCameraDefault

let currentModel = null
let currentUserScale = 1
let autoBehaviorEnabled = true
let autoBehaviorTimer = null
// E2E hatch (same rationale as __apiaScene) — vmd-check orbits the camera
// around a standing character; auto free-roam walks her behind furniture
// mid-screenshot, so the test switches roaming off right after launch.
if (typeof window !== 'undefined') {
  window.__setAutoBehavior = (on) => {
    autoBehaviorEnabled = on !== false
    if (autoBehaviorEnabled) scheduleAutoBehavior()
    else clearAutoBehaviorTimer()
  }
  // transition-check.mjs가 걷기 핸드오프(클립 → 절차적 gait)를 강제로
  // 트리거하고, 클립 소유권 플래그가 풀리는지 단언할 수 있게 한다.
  window.__walkTo = (minDistance = 1.4) => walkToRandomSpot({ minDistance })
  window.__clipFlags = () => ({
    vmd: currentModel?._vmdClipActive ?? null,
    vrma: currentModel?._vrmaClipActive ?? null,
    fbx: currentModel?._fbxClipActive ?? null,
    state: getState?.() ?? null,
  })
}
let worldManager = null
const lipsync = { active: false, phase: 0 }
// VRM/MMD runtimes are owned by modelRuntime.js — the cached promises and
// the singleton MMD helper / VRMUtils handle live there. clearModel and the
// animate loop read them back via getVRMUtils() / getMmdHelper().
let activeModelLoadToken = 0
const motionManager = new MotionManager({
  personality: 'calm'
})

function getAutoBehaviorConfig() {
  return motionManager.getBehaviorConfig?.() || {
    autoBehaviorMinMs: 9000,
    autoBehaviorMaxMs: 16000,
    chairBias: 0.45
  }
}

// Codex MUST-FIX (step 1 round 2): tracking the active character id so the
// IPC broadcast for persona slider edits can ignore stale messages aimed at
// a previously-active character.
let currentCharacterId = null

function applyCharacterProfileBundle(bundle = null) {
  if (bundle) {
    motionManager.setCharacterProfile(bundle)
    currentCharacterId = bundle.characterId || null
  } else {
    motionManager.clearCharacterProfile()
    currentCharacterId = null
  }
  // Codex MUST-FIX (step 1): characterController must see the new vector
  // every time the profile (including dummy/clear path) changes, otherwise
  // a previous character's walk speed / sit duration / look strength bleeds
  // into the next one.
  setPersonalityVector(motionManager.getPersonalityVector?.() || null)

  scheduleAutoBehavior()
}

function clearAutoBehaviorTimer() {
  if (!autoBehaviorTimer) return
  clearTimeout(autoBehaviorTimer)
  autoBehaviorTimer = null
}

function scheduleAutoBehavior() {
  clearAutoBehaviorTimer()

  if (!autoBehaviorEnabled) return

  const behaviorConfig = getAutoBehaviorConfig()
  const minDelay = Math.max(2000, Math.round(behaviorConfig.autoBehaviorMinMs ?? 9000))
  const maxDelay = Math.max(minDelay + 500, Math.round(behaviorConfig.autoBehaviorMaxMs ?? 16000))
  const delayMs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay))

  autoBehaviorTimer = setTimeout(() => {
    autoBehaviorTimer = null

    if (autoBehaviorEnabled && !lipsync.active && getState?.() === 'idle') {
      // Phase A: weighted mix of furniture interactions and free roam so the
      // character actually uses the (x,z) plane instead of bouncing between
      // the same chair/point pair. ~50% free walk, the rest goes to the
      // world manager's existing furniture picker.
      const roll = Math.random()
      let handled = false
      if (roll < 0.5) {
        handled = walkToRandomSpot({ minDistance: 1.4 }) === true
      }
      if (!handled) {
        handled =
          worldManager?.triggerAutoBehavior?.({
            chairBias: behaviorConfig.chairBias,
            // Phase D: every default piece in furnitureLayout is now a
            // visible mesh in sceneRuntime, so decoration-only pieces (rug)
            // can still ride the click path. autoBehavior:false on the rug
            // keeps it out of *random* picks; this flag only opens the gate.
            includeDecor: true
          }) === true
      }
      if (!handled) {
        const idleMotion = motionManager.pickIdleMotion()
        playMotion(idleMotion)
      }
    }

    scheduleAutoBehavior()
  }, delayMs)
}

async function loadCharacterProfileBundle(character) {
  if (!character) return null

  const [generated, user, interpretations] = await Promise.all([
    loadOptionalJson(character.profileGeneratedPath, 'profile.generated'),
    loadOptionalJson(character.profileUserPath, 'profile.user'),
    loadOptionalJson(character.interpretationsPath, 'interpretations')
  ])

  if (!generated && !user && !interpretations) {
    return null
  }

  return {
    generated,
    user,
    interpretations,
    characterId: character.id
  }
}

function alignCharacterToGround() {
  if (!currentModel?.root) return

  const box = new Box3().setFromObject(currentModel.root)
  if (box.isEmpty()) return

  const bottomY = box.min.y
  currentModel.root.position.y -= bottomY
}

function frameCharacterCamera() {
  // Phase B (Codex MUST-FIX): the room sets the framing now — the camera
  // sits at the "aquarium glass" looking into the box at a fixed angle. If
  // we kept rewriting CAM_DEFAULT every time a model loads, a tall VRM
  // would punch the camera further back and the fishbowl effect would
  // collapse on every character swap.
  //
  // We still need to *re-apply* the existing CAM_DEFAULT so a previously
  // tweaked debug camera or test seam snaps back to the room view.
  if (!currentModel?.root) return
  applyCameraDefault()
}

// Manifest loaders live in modelRuntime.js and return the parsed manifest
// directly. The texture-basename map used by MMD is plucked off the
// manifest at the loadModel call site and passed explicitly into the MMD
// loader — no global state involved. Earlier this went through
// `window.__textureMap`, which made it impossible to tell who was writing
// vs reading the map (and made tests with multiple loaders unsafe).

async function loadVRMRuntimeModel(url, loadToken) {
  const { GLTFLoader, VRMLoaderPlugin, VRMUtils } = await getVRMRuntime()
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm
        if (!vrm) {
          console.error('[VRM] missing vrm payload')
          if (loadToken === activeModelLoadToken) {
            loadDummy()
          }
          resolve(false)
          return
        }

        VRMUtils.rotateVRM0(vrm)

        if (loadToken !== activeModelLoadToken) {
          try {
            VRMUtils.deepDispose(vrm.scene)
          } catch {}
          resolve(false)
          return
        }

        clearModel()
        scene.add(vrm.scene)

        currentModel = {
          type: 'vrm',
          obj: vrm,
          root: vrm.scene,
          mixer: new AnimationMixer(vrm.scene),
          baseScale: 1,
          sourcePath: url
        }

        setupVRMRestPose(vrm)
        // Pose rig (Step 2 of /goal) — replaces every per-part updateVRMBody
        // block. Snapshots rest pose so the model's posture survives.
        {
          const registry = buildBoneRegistry(vrm.scene, 'vrm', vrm)
          currentModel.poseRig = {
            registry,
            spring: createPoseSpring(registry),
            saccade: createSaccadeState(),
          }
        }
        applyCharacterScale()
        alignCharacterToGround()
        frameCharacterCamera()
        showBubble('새 캐릭터로 바꿨어요! 안녕하세요 👋', 3000)
        resolve(true)
      },
      undefined,
      (error) => {
        console.error('[VRM]', error)
        if (loadToken === activeModelLoadToken) {
          loadDummy()
        }
        resolve(false)
      }
    )
  })
}

async function loadMMDRuntimeModel(url, loadToken, textureMap = null) {
  const { MMDLoader, helper } = await getMmdRuntime()
  // 생동감 round 2 — preload ammo.js (bundled with three) so that
  // helper.add({physics:true}) inside the loader callback doesn't throw
  // "Import ammo.js" and freeze every hair/skirt/tail bone. Cached
  // promise; only the first PMX load pays the wasm fetch cost.
  try {
    await getAmmoRuntime()
  } catch (err) {
    console.warn('[Apia MMD] ammo.js load failed; physics will be skipped', err)
  }
  // Codex NICE-TO-HAVE: ammo fetch can take 100ms+ on first PMX load.
  // If the user switched characters during that wait, abandon now
  // instead of fetching the (stale) PMX + textures.
  if (loadToken !== activeModelLoadToken) {
    return false
  }
  // Per-load LoadingManager — MMDLoader defaults to THREE.DefaultLoadingManager,
  // which is shared process-wide. Setting setURLModifier on that would leak
  // into any subsequent loader (or stomp an in-flight one) — exactly the
  // textureMap aliasing the old window.__textureMap global produced. A fresh
  // LoadingManager per call keeps each load's resolver isolated.
  const manager = new LoadingManager()
  const loader = new MMDLoader(manager)

  // textureMap is passed in by loadModel; it's the manifest's
  // textureBasenameMap (or null if absent). The closure captures it so
  // each MMD load has its own map without globals.
  manager.setURLModifier((resourceUrl) => {
    const fileName = String(resourceUrl).split('/').pop()?.toLowerCase()

    if (!textureMap || !fileName) return resourceUrl

    const candidates = textureMap[fileName]

    if (Array.isArray(candidates) && candidates.length > 0) {
      console.log('[텍스처 복구]', fileName, '→', candidates[0])
      return candidates[0]
    }

    return resourceUrl
  })

  return new Promise((resolve) => {
    loader.load(
      url,
      (mesh) => {
        const box = new Box3().setFromObject(mesh)
        const size = new Vector3()
        const center = new Vector3()

        box.getSize(size)
        box.getCenter(center)

        mesh.position.sub(center)

        const normalizedScale = size.y > 0 ? 1.6 / size.y : 1
        mesh.scale.setScalar(normalizedScale)

        const box2 = new Box3().setFromObject(mesh)
        const size2 = new Vector3()
        box2.getSize(size2)

        mesh.position.y += size2.y / 2
        mesh.castShadow = true

        if (loadToken !== activeModelLoadToken) {
          resolve(false)
          return
        }

        clearModel()
        scene.add(mesh)

        currentModel = {
          type: 'mmd',
          obj: mesh,
          root: mesh,
          mixer: new AnimationMixer(mesh),
          morphs: mesh.morphTargetDictionary || {},
          baseScale: normalizedScale,
          sourcePath: url
        }
        // Pose rig (Step 2 of /goal). Snapshots the rest quaternion for
        // every humanoid bone *before* helper.add({physics:true}) runs
        // below. That's fine for humanoid roles (head/arms/torso/legs)
        // because MMDPhysics only mutates the rigid-body bones (hair,
        // skirt, tail, etc.) which aren't in HUMANOID_ROLES. If we ever
        // add hair/skirt roles, this needs to move below the helper.add
        // call so the snapshot reflects the settled physics pose.
        {
          const registry = buildBoneRegistry(mesh, 'mmd')
          currentModel.poseRig = {
            registry,
            spring: createPoseSpring(registry),
            saccade: createSaccadeState(),
          }
          // E2E hatch — vmd-check 계열 진단이 모델의 rest 지문(armAbduction
          // 등)을 읽어 팔 보정값을 검증할 수 있게 한다. __apiaScene과 동일한
          // 근거의 읽기 전용 창구.
          if (typeof window !== 'undefined') {
            window.__apiaPoseInfo = () => ({
              fingerprint: registry.fingerprint,
              restEuler: Object.fromEntries(
                Array.from(registry.roles.entries()).map(([role, entry]) => [
                  role,
                  {
                    x: +entry.restEuler.x.toFixed(4),
                    y: +entry.restEuler.y.toFixed(4),
                    z: +entry.restEuler.z.toFixed(4),
                  },
                ])
              ),
            })
          }
        }

        // 모델 제작자가 넣어둔 뚫림 방지(貫通対策) 모프는 항상 켠다.
        // MMD에서는 사용자가 수동으로 켜는 표준 장치(몸을 옷 안쪽으로
        // 살짝 수축시키는 정점 모프)인데, Apia가 안 켜고 있어서 일부
        // 자세에서 몸이 옷을 뚫고 나왔다. VMD 모프 트랙은 자신이 키한
        // 모프만 쓰므로 이 값은 재생 중에도 유지된다.
        {
          const morphDict = mesh.morphTargetDictionary || {}
          for (const [morphName, morphIdx] of Object.entries(morphDict)) {
            if (morphName.includes('貫通対策')) {
              mesh.morphTargetInfluences[morphIdx] = 1.0
              console.info('[Apia MMD] anti-clipping morph enabled:', morphName)
            }
          }
        }

        // Codex MUST-FIX (생동감): turn the MMD physics simulator on so
        // hair/skirt/ribbons (rigid bodies + joints baked into the PMX)
        // actually swing. helper.add without an animation just registers
        // the mesh + enables physics; playMMDAnimation later remove/adds
        // with the same `physics:true` so the animation track joins the
        // already-active simulation. Diagnostic logs the rigid body /
        // constraint counts so a user reporting "hair still fixed" can
        // tell whether the model itself shipped without physics data.
        try {
          // warmup: 0 — the helper's built-in warmup runs before the
          // scale-safe reset patch is installed, so its 60 cycles would
          // settle the cloth from wrong-space positions. The real settle
          // happens in stabilizeMmdPhysics() below, after the final
          // scale/ground transform is applied.
          helper?.add?.(mesh, { physics: true, warmup: 0 })
          const physicsBody = mesh.geometry?.userData?.MMD
          const rigidBodyCount = physicsBody?.rigidBodies?.length ?? 0
          const constraintCount = physicsBody?.constraints?.length ?? 0
          const morphNames = Object.keys(mesh.morphTargetDictionary || {})
          console.info('[Apia MMD physics + morphs]', {
            rigidBodyCount,
            constraintCount,
            physicsEnabled: rigidBodyCount > 0,
            morphCount: morphNames.length,
            morphSample: morphNames.slice(0, 32),
          })
          if (rigidBodyCount === 0) {
            console.warn('[Apia MMD] model ships with no rigid bodies — hair/clothes will not sway')
          }
        } catch (err) {
          console.warn('[Apia MMD] physics enable failed', err)
        }
        void helper
        applyCharacterScale()
        alignCharacterToGround()
        // Settle skirt/tail/hair in the simulator's own (unscaled) space,
        // AFTER the final user-scale + ground alignment so reset() snaps
        // bodies to the transform the render loop will actually use.
        try { stabilizeMmdPhysics(mesh) } catch (err) {
          console.warn('[Apia MMD] physics stabilize failed', err)
        }
        frameCharacterCamera()
        showBubble('안녕하세요! 모델을 불러왔어요 🎀', 3000)
        resolve(true)
      },
      undefined,
      (error) => {
        console.error('[MMD]', error)
        if (loadToken === activeModelLoadToken) {
          loadDummy()
        }
        resolve(false)
      }
    )
  })
}

// VRMA/VMD playback now lives in src/animationRuntime.js. The exported
// playVRMAnimation/playMMDAnimation wrappers near the top of this file
// pass `animationCtx` (which reads currentModel) into the extracted
// module. The fade-handler cleanup is imported as `clearVRMFadeHandlers`
// and called from clearModel below.

export async function loadModel(url, options = {}) {
  if (!url) {
    activeModelLoadToken += 1
    loadDummy()
    return
  }

  const loadToken = ++activeModelLoadToken
  const normalizedUrl = normalizeUrlToFetchable(url)
  const ext = String(normalizedUrl).split('?')[0].split('.').pop().toLowerCase()

  if (ext === 'pmx' || ext === 'pmd') {
    // Pluck the texture-basename map off the manifest and thread it into
    // the MMD loader so its URL resolver can rewrite missing texture paths.
    // The byPath / forModel split preserves the original null-vs-{}
    // asymmetry — practically equivalent in the resolver, but matches
    // existing behavior exactly.
    const manifest = options.manifestPath
      ? await loadManifestByPath(options.manifestPath)
      : await loadManifestForModel(normalizedUrl)

    const textureMap = options.manifestPath
      ? (manifest?.textureBasenameMap || null)
      : (manifest?.textureBasenameMap || {})

    await loadMMDRuntimeModel(normalizedUrl, loadToken, textureMap)
    return
  }

  if (ext === 'vrm') {
    await loadVRMRuntimeModel(normalizedUrl, loadToken)
  } else {
    console.warn('[Model] 미지원:', ext)
    loadDummy()
  }
}

export function loadDummy() {
  activeModelLoadToken += 1
  clearModel()

  const g = new Group()

  const mk = (geo, color, pos, side = FrontSide) => {
    const m = new Mesh(
      geo,
      new MeshLambertMaterial({ color, side })
    )
    m.position.set(...pos)
    m.castShadow = true
    return m
  }

  g.add(mk(new CapsuleGeometry(0.18, 0.45, 8, 16), 0x7c3aed, [0, 0.9, 0]))
  const dummyHead = mk(new SphereGeometry(0.2, 16, 16), 0xfde68a, [0, 1.55, 0])
  // characterController._applyBlink가 dummy 전용 눈 깜빡임을 스캔할 때 쓰는 마커.
  dummyHead.name = 'dummy-head'
  g.add(dummyHead)
  setDummyBlinkTarget(dummyHead)
  g.add(mk(new SphereGeometry(0.035, 8, 8), 0x1e1b4b, [-0.07, 1.58, 0.18]))
  g.add(mk(new SphereGeometry(0.035, 8, 8), 0x1e1b4b, [0.07, 1.58, 0.18]))
  g.add(mk(
    new SphereGeometry(0.21, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    0x5b21b6,
    [0, 1.55, 0],
    DoubleSide
  ))

  const mouth = mk(new PlaneGeometry(0.08, 0.04), 0x92400e, [0, 1.48, 0.195])
  mouth.name = 'mouth'
  g.add(mouth)

  scene.add(g)

  currentModel = {
    type: 'dummy',
    obj: g,
    root: g,
    mouth,
    baseScale: 1,
    sourcePath: 'dummy'
  }

  applyCharacterScale()
  alignCharacterToGround()
  frameCharacterCamera()
}

function clearModel() {
  if (!currentModel) return

  clearDummyBlinkTarget()

  if (currentModel.type === 'mmd') {
    try { getMmdHelper()?.remove(currentModel.obj) } catch {}
    // 클립 해제 때 보관해둔 mixer까지 명시적으로 놓아준다
    currentModel._stashedMmdMixer = null
  }

  // VRM에선 씬에 추가된 게 vrm.scene(=root)이고 obj는 wrapper.
  // 예전엔 obj를 remove해서 교체 후에도 구 모델이 씬에 남아있었음.
  scene.remove(currentModel.root)

  if (currentModel.type === 'vrm') {
    clearVRMFadeHandlers(currentModel)
    currentModel.mixer?.stopAllAction()
    // Step 6: any in-flight FBX clip is gone with the model.
    currentModel._fbxClipActive = false
    getVRMUtils()?.deepDispose(currentModel.root)
  }

  // Step 2 of /goal: bone cache is gone — poseRig (per-model registry)
  // owns role resolution now.
  currentModel = null
}

function applyCharacterScale() {
  if (!currentModel?.root) return

  const base = Number.isFinite(currentModel.baseScale) ? currentModel.baseScale : 1
  const user = Number.isFinite(currentUserScale) ? currentUserScale : 1
  const clampedUser = Math.min(Math.max(user, 0.3), 2.0)

  currentModel.root.scale.setScalar(base * clampedUser)
}

export function startSpeaking() {
  lipsync.active = true
  lipsync.phase = 0
}

export function stopSpeaking() {
  lipsync.active = false
}

export function applyEmotion(emotion) {
  if (currentModel?.type !== 'vrm') return

  const expr = {
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    surprised: 'surprised'
  }[emotion]

  if (!expr) return

  currentModel.obj.expressionManager?.setValue(expr, 1.0)
  setTimeout(() => currentModel.obj.expressionManager?.setValue(expr, 0), 1500)
}

export function showBubble(text, duration = 3000) {
  const b = document.getElementById('speech-bubble')
  if (!b) return

  b.textContent = text
  b.classList.add('visible')
  clearTimeout(b._t)
  b._t = setTimeout(() => b.classList.remove('visible'), duration)
}

function updateBubblePosition() {
  const b = document.getElementById('speech-bubble')
  if (!b || !b.classList.contains('visible') || !currentModel) return

  const headPos = new Vector3()
  currentModel.root.getWorldPosition(headPos)
  headPos.y += 1.9
  headPos.project(camera)

  const sx = (headPos.x * 0.5 + 0.5) * window.innerWidth
  const sy = (-headPos.y * 0.5 + 0.5) * window.innerHeight

  b.style.left = Math.max(10, Math.min(window.innerWidth - 250, sx - b.offsetWidth / 2)) + 'px'
  b.style.top = Math.max(10, sy - b.offsetHeight - 10) + 'px'
}

// ── VRM rest pose (T → A, 모델 로드 후 1회 호출) ────────────────────────────
// VRM0 기준. leftUpperArm +Z, rightUpperArm -Z 로 팔을 약 52° 내림.
// 모델마다 bone axis가 다를 수 있으므로 값 조정이 필요하면 여기서.
function setupVRMRestPose(vrm) {
  const h = vrm.humanoid
  if (!h) return

  const set = (name, rx, ry, rz) => {
    const node = h.getRawBoneNode(name)
    if (!node) return
    if (rx !== undefined) node.rotation.x = rx
    if (ry !== undefined) node.rotation.y = ry
    if (rz !== undefined) node.rotation.z = rz
  }

  set('leftUpperArm',  0, 0,  0.9)   // 팔 내리기 ~52°
  set('rightUpperArm', 0, 0, -0.9)
  set('leftLowerArm',  0, 0,  0.2)   // 팔꿈치 자연스러운 각도
  set('rightLowerArm', 0, 0, -0.2)
  set('leftHand',      0, 0,  0.08)  // 손목 살짝
  set('rightHand',     0, 0, -0.08)
  set('leftUpperLeg',  0, 0,  0.06)  // 다리 어깨너비 스탠스
  set('rightUpperLeg', 0, 0, -0.06)
}

// ── Unified body update — Step 2 of /goal ─────────────────────────────────
// One function for VRM + MMD, driven by the data-driven poseRig in
// src/poseRig.js. The old part-by-part updateVRMBody (148 lines) and
// updateMMDBody (186 lines) are gone — every humanoid bone is now
// resolved through a registry, every per-frame target is computed in
// computePoseTargets, and every write goes through `quaternion = restQuat
// * eulerDelta` so model-specific rest posture (e.g. Kisaki's head tilt
// at restEuler [0.028, -0.071, 0.002]) survives.
//
// `state === 'walk'` still wants a stride-driven leg gait. We layer that
// here as a hand-written overlay because the gait is naturally
// *positional* (phase tracks foot plant), not breath-like. It is
// computed in the same { x, y, z } per-role accumulator the spring then
// filters, so the visible motion still goes through critically-damped
// smoothing.
function updateBody(t, delta) {
  if (!currentModel?.poseRig) return
  const { registry, spring, saccade } = currentModel.poseRig
  if (!registry || !spring) return

  const look = getLookTarget()
  const state = getState()
  const motion = getCurrentMotion()
  const personality = motionManager.getPersonalityVector?.() || {
    energy: 0.5,
    expressiveness: 0.5,
    fidgetiness: 0.5,
  }

  // .vmd / .vrma / .fbx clip active → that clip owns arms + torso. Breath,
  // gaze and saccade still ride on top because they touch chest/neck/head/
  // eyes which the spring blends against the clip's mixer output without
  // fighting the clip's pose.
  const clipMask = (
    currentModel._vmdClipActive ||
    currentModel._fbxClipActive ||
    currentModel._vrmaClipActive
  )
    ? { arms: true, torso: true }
    : null
  // TODO (split when first arm-only clip lands): granular mask
  // `{ arms, torso, legs }` so a partial-body clip can let procedural
  // continue on the bones it doesn't own. Trigger: any motion in
  // resolveMotionAsset / resolveMmdMotionAsset that targets only arm
  // bones (no torso/leg tracks).

  // Root-position lock used to live here as a per-frame mesh.skeleton
  // walk to copy restPos into 3 root bones. Codex round 2 pointed out
  // it was incomplete (missing 全ての親 + IK + IK親 + half-width/full-
  // width variants) and now redundant with the track-strip in
  // animationRuntime's playMMDAnimation. Removed to avoid two sources
  // of truth.

  const { summed } = computePoseTargets({
    registry,
    saccadeState: saccade,
    t,
    look,
    state,
    motion,
    personality,
    clipMask,
  })

  // C단계 — 걷기가 시작됐는데 클립이 아직 본을 소유 중이면 클립을
  // 절차적 걷기로 핸드오프한다. 안 그러면 루프 idle 클립이 다리를 계속
  // 쥐고 있어 캐릭터가 idle 자세로 미끄러진다. clipMask는 이 프레임의
  // 캡처값이라 이번 프레임 gait는 건너뛴다(의도) — fade(0.45s)가 끝나면
  // 플래그가 풀리고 다음 프레임부터 다리가 움직인다. 호출은 매 프레임
  // 일어나도 releaseActiveClips 내부의 pending 가드가 1회로 합친다.
  if (state === 'walk' && clipMask) {
    releaseActiveClips(currentModel, animationCtx)
  }

  // — Walk gait overlay. Procedural sine on top of the summed map so the
  // spring filter is the only consumer. Same stride math the old
  // updateVRMBody used; this is the one part of the body where layered
  // breath isn't the right model. Foot/hip phase drives everything else.
  if (state === 'walk' && !clipMask) {
    const intensity = Number.isFinite(motion?.intensity) ? motion.intensity : 1
    const energyBoost = (personality.energy ?? 0.5) - 0.5
    const stride = t * (6.5 + energyBoost * 2)
    const range = (personality.movementRange ?? 0.5) - 0.5
    const swing = 0.35 * intensity * (1 + range * 0.4)
    const phase = Math.sin(stride)
    const kneePhase = Math.sin(stride + 0.4)
    const kneeAmp = 0.30 * intensity * (1 + range * 0.4)
    const armWalkAmp = 0.30 * intensity * (1 + energyBoost * 0.4)
    function bump(role, dx, dy, dz) {
      if (!registry.roles.has(role)) return
      const cur = summed.get(role) || { x: 0, y: 0, z: 0 }
      cur.x += dx || 0
      cur.y += dy || 0
      cur.z += dz || 0
      summed.set(role, cur)
    }
    bump('lLeg', phase * swing, 0, 0)
    bump('rLeg', -phase * swing, 0, 0)
    bump('lKnee', Math.max(0, kneePhase) * kneeAmp, 0, 0)
    bump('rKnee', Math.max(0, -kneePhase) * kneeAmp, 0, 0)
    bump('lArm', -phase * armWalkAmp, 0, 0)
    bump('rArm', phase * armWalkAmp, 0, 0)
    bump('spine', Math.abs(phase) * 0.01 * intensity, 0, phase * 0.045 * intensity)
    bump('chest', 0, -phase * 0.06 * intensity, 0)
    bump('head', 0, Math.sin(stride * 0.5) * 0.035 * intensity, 0)
  }

  stepPoseSpring(spring, summed, delta, clipMask)
  applyPose(registry, spring, clipMask)

  // VRM-only: blink expression. PMX blink rides on the morph map and is
  // driven by lipsyncMMD/lipsyncVRM downstream.
  if (currentModel.type === 'vrm') {
    const vrm = currentModel.obj
    if (vrm?.expressionManager) {
      const b = t % 4.0
      vrm.expressionManager.setValue('blink', b < 0.12 ? Math.sin((b / 0.12) * Math.PI) : 0)
    }
  }
}

function lipsyncVRM() {
  const em = currentModel.obj.expressionManager
  if (!em) return

  if (lipsync.active) {
    lipsync.phase += 0.25
    em.setValue('aa', Math.abs(Math.sin(lipsync.phase)) * 0.7)
    em.setValue('ih', Math.abs(Math.sin(lipsync.phase * 1.3)) * 0.3)
  } else {
    em.setValue('aa', 0)
    em.setValue('ih', 0)
  }
}

function lipsyncMMD() {
  const mesh = currentModel.obj
  if (!mesh.morphTargetInfluences) return

  for (const n of ['あ', 'a', 'mouth_a', 'A', 'mouth', 'Ah']) {
    const i = currentModel.morphs[n]
    if (i !== undefined) {
      lipsync.phase += 0.2
      mesh.morphTargetInfluences[i] = lipsync.active
        ? Math.abs(Math.sin(lipsync.phase)) * 0.8
        : 0
      break
    }
  }
}

function animate() {
  requestAnimationFrame(animate)

  const delta = clock.getDelta()
  const t = clock.getElapsedTime()

  if (currentModel) {
    const root = currentModel.root

    if (currentModel.type === 'vrm') {
      currentModel.obj.update(delta)
      currentModel.mixer?.update(delta)
      // Step 6: while a Mixamo FBX clip is driving the rig (set by
      // playFBXAnimation), skip the procedural body layer. The clip's
      // keyframes own spine/arms/legs/hips; running updateVRMBody after
      // mixer.update() would overwrite them every frame and the user
      // sees the procedural "T-pose with arm sway" instead of the clip.
      // Step 5 of /goal: updateBody now uses clipMask to defer arm/torso
      // bones to whatever the active clip (.vmd/.vrma/.fbx) wrote, while
      // still running breath/gaze/saccade. So we no longer skip the call
      // when an FBX clip is active — the mask handles the conflict.
      updateBody(t, delta)
      lipsyncVRM()
      updateCharacter(root, t, delta)
    } else if (currentModel.type === 'mmd') {
      currentModel.mixer?.update(delta)
      getMmdHelper()?.update(delta)
      updateBody(t, delta)
      updateCharacter(root, t, delta)
      lipsyncMMD()
    } else {
      updateCharacter(root, t, delta)

      if (currentModel.mouth) {
        currentModel.mouth.scale.y = lipsync.active
          ? 1 + Math.abs(Math.sin((lipsync.phase += 0.2))) * 3
          : 1
      }
    }
  }

  updateBubblePosition()
  updateWorldLabels(camera)
  renderer.render(scene, camera)
}

function initCameraControls() {
  const camBtn = document.getElementById('cam-btn')
  const camPanel = document.getElementById('cam-panel')
  const sliderY = document.getElementById('cam-y')
  const sliderZ = document.getElementById('cam-z')
  const sliderX = document.getElementById('cam-x')
  const sliderFov = document.getElementById('cam-fov')
  const resetBtn = document.getElementById('cam-reset')

  if (!camBtn) return

  camBtn.addEventListener('click', () => camPanel.classList.toggle('visible'))

  function applySliders() {
    camera.position.set(+sliderX.value, +sliderY.value, +sliderZ.value)
    camera.fov = +sliderFov.value
    camera.lookAt(CAM_DEFAULT.target)
    camera.updateProjectionMatrix()
  }

  ;[sliderY, sliderZ, sliderX, sliderFov].forEach((s) => s?.addEventListener('input', applySliders))

  resetBtn?.addEventListener('click', () => {
    sliderY.value = CAM_DEFAULT.pos.y
    sliderZ.value = CAM_DEFAULT.pos.z
    sliderX.value = CAM_DEFAULT.pos.x
    sliderFov.value = CAM_DEFAULT.fov
    applyCameraDefault()
  })
}

async function tryLoadActiveCharacterFromRegistry() {
  if (!window.api || typeof window.api.getActiveCharacter !== 'function') return false

  try {
    const active = await window.api.getActiveCharacter()
    const character = active?.character

    if (!character?.modelManifestPath) {
      applyCharacterProfileBundle(null)
      return false
    }

    const profileBundle = await loadCharacterProfileBundle(character)
    applyCharacterProfileBundle(profileBundle)

    const manifest = await loadManifestByPath(character.modelManifestPath)
    if (!manifest) return false

    const entryUrl = manifest.entryFileUrl || manifest.entryAbsoluteWebPath || null
    if (!entryUrl) return false

    await loadModel(entryUrl, { manifestPath: character.modelManifestPath })
    return true
  } catch (err) {
    console.warn('[레지스트리 캐릭터 로드 실패]', err)
    applyCharacterProfileBundle(null)
    return false
  }
}

animate()
loadDummy()
initCameraControls()

window.addEventListener('mousemove', (e) => onMouseMove(e.clientX, e.clientY))

if (window.api) {
  window.api.getSettings().then(async (s) => {
    currentUserScale = (s.charScale || 100) / 100
    autoBehaviorEnabled = s.autoBehavior !== false
    scheduleAutoBehavior()
    // backend lazy init을 백그라운드로 떼어내기. fire-and-forget — 백엔드 미기동/
    // timeout 등은 별도 checkBackend 경로가 잡고, 여기서는 UX에 영향 주지 않는다.
    window.api.warmup?.().catch(() => {})

    const loadedFromRegistry = await tryLoadActiveCharacterFromRegistry()
    if (loadedFromRegistry) return

    applyCharacterProfileBundle(null)

    if (s.activeModel && s.activeModel !== 'dummy') {
      const m = (s.models || []).find((model) => model.id === s.activeModel)
      if (m?.path) {
        await loadModel(m.path)
      }
    }
  }).catch(() => {})

  // Step 1: settings UI slider edits arrive via this broadcast. motionManager
  // patches the active profile + refreshes the cached vector; the next
  // frame of updateVRMBody / updateMMDBody picks up the new amplitudes
  // automatically — no character reload needed.
  // Codex MUST-FIX (round 2): verify the broadcast targets the *currently
  // active* character. A user dragging slider A then quickly switching to
  // character B could otherwise have A's late IPC reply rewrite B's vector.
  window.api.onCharacterPersonalityUpdated?.(({ characterId, overrides }) => {
    if (!overrides || typeof overrides !== 'object') return
    if (characterId && currentCharacterId && characterId !== currentCharacterId) return
    motionManager.setPersonalityOverrides?.(overrides)
    setPersonalityVector(motionManager.getPersonalityVector?.() || null)
  })

  window.api.onSettingsApplied(async (s) => {
    currentUserScale = (s.charScale || 100) / 100
    autoBehaviorEnabled = s.autoBehavior !== false
    scheduleAutoBehavior()

    const loadedFromRegistry = await tryLoadActiveCharacterFromRegistry()
    if (loadedFromRegistry) return

    applyCharacterProfileBundle(null)

    const selectedId = s.activeModel
    const selectedModel = (s.models || []).find((m) => m.id === selectedId)
    const selectedPath = selectedModel?.path || null

    const currentPath =
      currentModel?.type === 'dummy'
        ? 'dummy'
        : currentModel?.sourcePath || null

    const nextPath = selectedId === 'dummy' ? 'dummy' : selectedPath

    if (nextPath !== currentPath) {
      if (selectedId === 'dummy') {
        loadDummy()
      } else if (selectedPath) {
        await loadModel(selectedPath)
      }
    } else {
      applyCharacterScale()
      alignCharacterToGround()
    }
  })
}

initWorld({ scene, camera, renderer, showBubble, onWalkTo: walkTo })
  .then((manager) => {
    worldManager = manager
  })
  .catch((error) => {
    console.error('[WORLD_INIT_ERROR]', error)
    worldManager = null
  })

initChat({
  showBubble,
  startSpeaking,
  stopSpeaking,
  applyEmotion: (emotion) => {
    setEmotion(emotion)
    const reactMotion = motionManager.pickReactMotion({ emotion })
    playMotion(reactMotion)
  },
  getTalkMotion: ({ emotion, text }) => {
    return motionManager.pickTalkMotion({ emotion, text })
  },
  getIdleMotion: () => {
    return motionManager.pickIdleMotion()
  }
})

// Step 3 — click on the character to open the chat panel.
// Only registered when wallpaper mode is OFF (overlay mode). In wallpaper
// mode the OS routes clicks to the desktop, so the chat.js raycast path
// is intentionally dormant; trays + Ctrl+Alt+A are the supported entry
// points there. Codex MUST-FIX: raycast against `currentModel.root`
// (VRM .obj is a wrapper, not a hierarchy with geometry; root is the
// canonical group every model type adds to the scene).
const _raycaster = new Raycaster()
const _rayMouse = new Vector2()
function characterRaycast(clientX, clientY) {
  if (!currentModel?.root || !camera) return false
  _rayMouse.x = (clientX / window.innerWidth) * 2 - 1
  _rayMouse.y = -(clientY / window.innerHeight) * 2 + 1
  _raycaster.setFromCamera(_rayMouse, camera)
  const hits = _raycaster.intersectObject(currentModel.root, true)
  return hits.length > 0
}

function updateCharacterClickability(settings) {
  const wallpaperOn = settings?.useWallpaperMode !== false
  setCharacterRaycaster(wallpaperOn ? null : characterRaycast)
}

if (window.api?.getSettings) {
  window.api.getSettings().then(updateCharacterClickability).catch(() => {})
}
window.api?.onSettingsApplied?.((s) => updateCharacterClickability(s))

// Phase F2: listen for character actions forwarded from the standalone chat
// window. Each action is a plain object — main process already validated it
// against an allowlist, so this side just routes by name. Codex MUST-FIX:
// `lipsync-start` enters talk state via setState('talk') + saves the prior
// state, `lipsync-stop` restores. Otherwise the body stays in idle pose
// while the mouth animates, and Phase A walk gait keeps overwriting the
// talk-arm sway.
let _preLipsyncState = null
window.api?.onCharacterAction?.((payload) => {
  if (!payload || typeof payload !== 'object') return
  switch (payload.action) {
    case 'emotion': {
      const emotion = payload.value || 'neutral'
      setEmotion(emotion)
      const reactMotion = motionManager.pickReactMotion({ emotion })
      playMotion(reactMotion)
      break
    }
    case 'bubble':
      if (typeof payload.text === 'string') showBubble(payload.text, 4000)
      break
    case 'face-camera':
      requestFaceCamera({ durationMs: payload.durationMs || 12000, approach: true })
      break
    case 'lipsync-start': {
      // Codex MUST-FIX (F2 round 1): save prior state and switch to 'talk' so
      // updateVRMBody's talk branch (arm sway + breath) actually fires; just
      // toggling lipsync.active animates the mouth but leaves the body in
      // idle pose.
      const prior = getState?.()
      if (prior && prior !== 'talk') _preLipsyncState = prior
      setState('talk')
      startSpeaking()
      break
    }
    case 'lipsync-stop':
      stopSpeaking()
      // Restore the state the character was in before talking. If it was
      // walking/sitting we go back there; otherwise idle.
      if (_preLipsyncState) {
        setState(_preLipsyncState)
        _preLipsyncState = null
      } else {
        setState('idle')
      }
      break
    case 'show-main-chat': {
      // Wallpaper-off path: chatWindow yielded, surface the panel inside the
      // main overlay so the user can keep typing without going through tray.
      const panel = document.getElementById('chat-panel')
      const toggle = document.getElementById('chat-toggle')
      if (panel) panel.classList.add('visible')
      if (toggle) toggle.style.display = ''
      break
    }
    default:
      break
  }
})

// window.api가 있으면 getSettings().then 경로에서 이미 scheduleAutoBehavior()를 부른다.
// 예전엔 여기서도 무조건 불러서 중복 스케줄링(이전 타이머 즉시 취소 후 재스케줄)이 발생했다.
// dev 환경(Electron 아닌 순수 vite) 등 api가 없을 때만 폴백으로 한 번 스케줄.
if (!window.api) {
  scheduleAutoBehavior()
}
