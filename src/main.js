import {
  AnimationMixer,
  Box3,
  CapsuleGeometry,
  DoubleSide,
  FrontSide,
  Group,
  LoadingManager,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3
} from 'three'
import { createSceneRuntime } from './sceneRuntime.js'
import { updateCharacter, onMouseMove, walkTo, walkToRandomSpot, requestFaceCamera, setEmotion, applyMotion, getState, setState, getLookTarget, getCurrentMotion, setDummyBlinkTarget, clearDummyBlinkTarget } from './characterController.js'
import { initWorld, updateWorldLabels } from './world.js'
import { initChat } from './chat.js'
import { MotionManager } from './motionManager.js'
import { resolveMotionAsset, resolveMmdMotionAsset } from './motionAssets.js'
import {
  getVRMRuntime,
  getVRMUtils,
  getMmdRuntime,
  getMmdHelper,
  normalizeUrlToFetchable,
  loadOptionalJson,
  loadManifestByPath,
  loadManifestForModel
} from './modelRuntime.js'
import {
  playVRMAnimation as playVRMAnimationRaw,
  playMMDAnimation as playMMDAnimationRaw,
  clearVRMFadeHandlers
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
    if (!asset) return
    playMMDAnimation(asset.url, { loop: asset.loop })
      .catch((err) => console.warn('[playMotion] vmd clip failed', motion.name, err))
    return
  }
  if (type === 'vrm') {
    const asset = resolveMotionAsset(motion.name)
    if (!asset) return
    playVRMAnimation(asset.url, { loop: asset.loop, fadeIn: asset.fadeIn })
      .catch((err) => console.warn('[playMotion] vrma clip failed', motion.name, err))
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
const applyCameraDefault = _sceneRuntime.applyCameraDefault

let currentModel = null
let currentUserScale = 1
let autoBehaviorEnabled = true
let autoBehaviorTimer = null
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

function applyCharacterProfileBundle(bundle = null) {
  if (bundle) {
    motionManager.setCharacterProfile(bundle)
  } else {
    motionManager.clearCharacterProfile()
  }

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

        // `helper` is the modelRuntime singleton — no need to mirror it here,
        // consumers reach it via getMmdHelper().
        void helper
        applyCharacterScale()
        alignCharacterToGround()
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
  }

  // VRM에선 씬에 추가된 게 vrm.scene(=root)이고 obj는 wrapper.
  // 예전엔 obj를 remove해서 교체 후에도 구 모델이 씬에 남아있었음.
  scene.remove(currentModel.root)

  if (currentModel.type === 'vrm') {
    clearVRMFadeHandlers(currentModel)
    currentModel.mixer?.stopAllAction()
    getVRMUtils()?.deepDispose(currentModel.root)
  }

  // Phase H1: drop the MMD bone cache so the next model resolves its own
  // bones from scratch (PMX bone naming varies per author).
  _mmdBoneCache = null
  _mmdBoneCacheKey = null

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

// ── VRM 전신 프로시저럴 업데이트 (매 프레임) ─────────────────────────────────
// Layer 2: 숨결·흔들림·시선 추적·팔 생동감 / Layer 3 클립이 추가되면 이 위에 blend.
function updateVRMBody(t) {
  if (!currentModel || currentModel.type !== 'vrm') return
  const vrm = currentModel.obj
  const h = vrm.humanoid
  if (!h) return

  const look = getLookTarget()
  const lx = look.x          // -1 ~ 1 (마우스 좌우)
  const ly = look.y          // -1 ~ 1 (마우스 상하)
  const state = getState()
  const motion = getCurrentMotion()
  const intensity = Number.isFinite(motion?.intensity) ? motion.intensity : 1

  const breath = Math.sin(t * 0.55)          // 호흡 주기
  const sway   = Math.sin(t * 0.28)          // 느린 몸 흔들림
  const isTalk = state === 'talk'

  // ── 등뼈 / 가슴 ─────────────────────────────────
  const spine = h.getRawBoneNode('spine')
  if (spine) {
    spine.rotation.x = breath * 0.007 * intensity
    spine.rotation.z = sway  * 0.006 * intensity
  }
  const chest = h.getRawBoneNode('chest')
  if (chest) {
    chest.rotation.x = breath * 0.016 * intensity
    chest.rotation.z = sway  * 0.008 * intensity
  }
  const upper = h.getRawBoneNode('upperChest')
  if (upper) upper.rotation.x = breath * 0.008 * intensity

  // ── 목 + 고개 (시선 추적 분리) ──────────────────
  const neck = h.getRawBoneNode('neck')
  if (neck) {
    neck.rotation.y = lx * 0.14
    neck.rotation.x = -ly * 0.07
    neck.rotation.z = sway * 0.004
  }
  const head = h.getRawBoneNode('head')
  if (head) {
    head.rotation.y = lx * 0.10 + Math.sin(t * 0.50) * 0.018
    head.rotation.x = -ly * 0.05 + Math.sin(t * 0.45) * 0.008
    head.rotation.z = Math.sin(t * 0.32) * 0.009
  }

  // ── 눈 깜빡임 ────────────────────────────────────
  if (vrm.expressionManager) {
    const b = t % 4.0
    vrm.expressionManager.setValue('blink', b < 0.12 ? Math.sin((b / 0.12) * Math.PI) : 0)
  }

  // ── 팔 (A-포즈 기준 + 생동감) ────────────────────
  const breathArm = breath * 0.013 * intensity
  const talkSwayL =  isTalk ? Math.sin(t * 2.2)         * 0.05 * intensity : 0
  const talkSwayR =  isTalk ? Math.sin(t * 2.2 + 1.1)   * 0.05 * intensity : 0

  const lUA = h.getRawBoneNode('leftUpperArm')
  if (lUA) {
    lUA.rotation.z = 0.9 + breathArm
    lUA.rotation.x = sway * 0.014 * intensity + talkSwayL
  }
  const rUA = h.getRawBoneNode('rightUpperArm')
  if (rUA) {
    rUA.rotation.z = -0.9 - breathArm
    rUA.rotation.x = -sway * 0.014 * intensity - talkSwayR * 0.6
  }
  const lLA = h.getRawBoneNode('leftLowerArm')
  if (lLA) {
    lLA.rotation.z = 0.2
    lLA.rotation.x = isTalk ? Math.sin(t * 1.8)        * 0.035 * intensity : 0
  }
  const rLA = h.getRawBoneNode('rightLowerArm')
  if (rLA) {
    rLA.rotation.z = -0.2
    rLA.rotation.x = isTalk ? Math.sin(t * 1.8 + 1.3)  * 0.035 * intensity : 0
  }

  // ── 다리: 앉기 / 걷기 / 서기 ──────────────────────
  // Codex MUST-FIX (Phase A): walk gait는 같은 함수에서 절대값으로 합쳐서
  // sit/talk/rest pose와 충돌하지 않게. 매 프레임 sit→else 분기가 다리를
  // 0으로 리셋하던 게 T자 콩콩의 핵심 원인이었으니, walk가 가장 강한 신호.
  const lUL = h.getRawBoneNode('leftUpperLeg')
  const rUL = h.getRawBoneNode('rightUpperLeg')
  const lLL = h.getRawBoneNode('leftLowerLeg')
  const rLL = h.getRawBoneNode('rightLowerLeg')
  if (state === 'sit') {
    // Phase G — sit gets a subtle breathing bend on top of the fixed pose
    // so the silhouette doesn't read as a propped statue. Amplitudes stay
    // tiny (≤ 0.015 rad ≈ 0.9°) so a model's actual sit clip can override
    // these without fighting Phase A's absolute-write pattern.
    const sitBreath = breath * 0.012 * intensity
    if (lUL) lUL.rotation.x = -1.35 + sitBreath
    if (rUL) rUL.rotation.x = -1.35 + sitBreath
    if (lLL) lLL.rotation.x =  1.70 - sitBreath
    if (rLL) rLL.rotation.x =  1.70 - sitBreath
  } else if (state === 'walk') {
    // VRM0: leftUpperLeg.rotation.x positive = leg forward swing.
    // Conservative swing amplitude (Codex NICE-TO-HAVE round 1): some models
    // have different axis conventions; 0.35 rad ≈ 20° keeps the gait obvious
    // but never wraps around if the axis turns out reversed.
    const stride = t * 7.5
    const swing = 0.35 * intensity
    const phase = Math.sin(stride)
    if (lUL) lUL.rotation.x =  phase * swing
    if (rUL) rUL.rotation.x = -phase * swing
    // Knees only bend in one direction. Use the leading-leg half of the
    // gait so the trailing leg straightens, the leading leg flexes.
    if (lLL) lLL.rotation.x = Math.max(0,  Math.sin(stride + 0.4)) * 0.3
    if (rLL) rLL.rotation.x = Math.max(0, -Math.sin(stride + 0.4)) * 0.3
    // Arms swing opposite phase for natural walking. This OVERRIDES the
    // earlier breathArm + talkSway assignments above on purpose.
    if (lUA) {
      lUA.rotation.z = 0.9 + breathArm
      lUA.rotation.x = -phase * 0.32
    }
    if (rUA) {
      rUA.rotation.z = -0.9 - breathArm
      rUA.rotation.x =  phase * 0.32
    }
    // Phase G — natural walk extras layered on top of the breathing spine/
    // chest values set earlier. Each adds a small twice-per-stride signal:
    //   - spine roll = weight shift to the planted foot
    //   - chest counter-yaw = shoulders rotate opposite to the hips
    //   - head micro-yaw = head catches up to the body a beat late
    // OVERRIDE (not add) on spine/chest because the earlier breath values
    // here drown the gait signal; head uses += so mouse look-target stays.
    if (spine) {
      spine.rotation.z = phase * 0.045 * intensity
      spine.rotation.x = breath * 0.005 * intensity + Math.abs(phase) * 0.01 * intensity
    }
    if (chest) {
      chest.rotation.y = -phase * 0.06 * intensity
      chest.rotation.z = phase * 0.025 * intensity
    }
    if (head) {
      head.rotation.y += Math.sin(stride * 0.5) * 0.035 * intensity
    }
  } else {
    if (lUL) lUL.rotation.x = 0
    if (rUL) rUL.rotation.x = 0
    if (lLL) lLL.rotation.x = 0
    if (rLL) rLL.rotation.x = 0
  }
}

// ── PMX/MMD procedural body (Phase H1) ─────────────────────────────────────
// VRM has a humanoid bone API + an enforced A-pose rest. PMX bones are model-
// specific (often Japanese, sometimes English aliases) and ship in T-pose by
// default. We don't try to retarget here — just probe for the canonical
// bone names and apply the same sine-wave layer that updateVRMBody uses, so
// at minimum the legs/spine move in walk and a small breath shows in sit.
// Bones we can't find are silently skipped; a PMX with a fully Roman-only
// rig won't move at all, but it won't error either.
//
// This is a stopgap for users who keep their PMX models. Real BlueArchive-
// quality motion still needs `.vmd` clips — see vrma/README.md for the
// Mixamo→VMD route.
const _MMD_BONE_CANDIDATES = {
  spine:     ['上半身', 'Spine', 'spine'],
  chest:     ['上半身2', 'Chest', 'chest'],
  neck:      ['首', 'Neck', 'neck'],
  head:      ['頭', 'Head', 'head'],
  lArm:      ['左腕', 'L_Arm', 'arm_L', 'leftArm', 'LeftArm'],
  rArm:      ['右腕', 'R_Arm', 'arm_R', 'rightArm', 'RightArm'],
  lLeg:      ['左足', 'L_Leg', 'leg_L', 'leftLeg', 'LeftLeg'],
  rLeg:      ['右足', 'R_Leg', 'leg_R', 'rightLeg', 'RightLeg'],
  lKnee:     ['左ひざ', '左膝', 'L_Knee', 'knee_L', 'leftKnee', 'LeftKnee'],
  rKnee:     ['右ひざ', '右膝', 'R_Knee', 'knee_R', 'rightKnee', 'RightKnee'],
}

function _findMmdBone(mesh, candidates) {
  if (!mesh?.skeleton) return null
  const skel = mesh.skeleton
  for (const name of candidates) {
    const direct = skel.getBoneByName?.(name)
    if (direct) return direct
    const fallback = skel.bones?.find?.((b) => b.name === name)
    if (fallback) return fallback
  }
  return null
}

let _mmdBoneCache = null
let _mmdBoneCacheKey = null
function _getMmdBones(mesh) {
  if (_mmdBoneCacheKey === mesh && _mmdBoneCache) return _mmdBoneCache
  _mmdBoneCache = {}
  for (const [key, candidates] of Object.entries(_MMD_BONE_CANDIDATES)) {
    _mmdBoneCache[key] = _findMmdBone(mesh, candidates)
  }
  _mmdBoneCacheKey = mesh
  return _mmdBoneCache
}

function updateMMDBody(t) {
  if (!currentModel || currentModel.type !== 'mmd') return
  const mesh = currentModel.obj
  if (!mesh?.skeleton) return
  const bones = _getMmdBones(mesh)

  const look = getLookTarget()
  const lx = look.x
  const ly = look.y
  const state = getState()
  const motion = getCurrentMotion()
  const intensity = Number.isFinite(motion?.intensity) ? motion.intensity : 1

  const breath = Math.sin(t * 0.55)
  const sway = Math.sin(t * 0.28)
  const isTalk = state === 'talk'

  // Spine / chest breath (subtle — small models can over-amplify)
  if (bones.spine) {
    bones.spine.rotation.x = breath * 0.006 * intensity
    bones.spine.rotation.z = sway * 0.005 * intensity
  }
  if (bones.chest) {
    bones.chest.rotation.x = breath * 0.012 * intensity
  }

  // Look target (neck does most of the work, head adds micro motion)
  if (bones.neck) {
    bones.neck.rotation.y = lx * 0.12
    bones.neck.rotation.x = -ly * 0.06
  }
  if (bones.head) {
    bones.head.rotation.y = lx * 0.08 + Math.sin(t * 0.5) * 0.015
    bones.head.rotation.x = -ly * 0.04
  }

  // Arms — PMX rest is usually T-pose so we layer small motion only.
  // No forced A-pose drop here: model authors stretch arms differently and a
  // forced 0.9 rad rotation can fold the sleeves through the body.
  const talkSwayL = isTalk ? Math.sin(t * 2.2) * 0.05 * intensity : sway * 0.014 * intensity
  const talkSwayR = isTalk ? Math.sin(t * 2.2 + 1.1) * 0.05 * intensity : -sway * 0.014 * intensity
  if (bones.lArm) bones.lArm.rotation.x = talkSwayL
  if (bones.rArm) bones.rArm.rotation.x = talkSwayR

  // Legs — sit / walk / standing fallback
  if (state === 'sit') {
    const sitBreath = breath * 0.012 * intensity
    if (bones.lLeg) bones.lLeg.rotation.x = -1.35 + sitBreath
    if (bones.rLeg) bones.rLeg.rotation.x = -1.35 + sitBreath
    if (bones.lKnee) bones.lKnee.rotation.x = 1.70 - sitBreath
    if (bones.rKnee) bones.rKnee.rotation.x = 1.70 - sitBreath
  } else if (state === 'walk') {
    const stride = t * 7.5
    const swing = 0.35 * intensity
    const phase = Math.sin(stride)
    if (bones.lLeg) bones.lLeg.rotation.x = phase * swing
    if (bones.rLeg) bones.rLeg.rotation.x = -phase * swing
    if (bones.lKnee) bones.lKnee.rotation.x = Math.max(0, Math.sin(stride + 0.4)) * 0.3
    if (bones.rKnee) bones.rKnee.rotation.x = Math.max(0, -Math.sin(stride + 0.4)) * 0.3
    if (bones.lArm) bones.lArm.rotation.x = -phase * 0.30
    if (bones.rArm) bones.rArm.rotation.x = phase * 0.30
    // Spine weight-shift + chest counter-yaw (matches updateVRMBody pattern)
    if (bones.spine) {
      bones.spine.rotation.z = phase * 0.045 * intensity
      bones.spine.rotation.x = breath * 0.005 * intensity + Math.abs(phase) * 0.01 * intensity
    }
    if (bones.chest) {
      bones.chest.rotation.y = -phase * 0.06 * intensity
    }
    if (bones.head) {
      bones.head.rotation.y += Math.sin(stride * 0.5) * 0.035 * intensity
    }
  } else {
    if (bones.lLeg) bones.lLeg.rotation.x = 0
    if (bones.rLeg) bones.rLeg.rotation.x = 0
    if (bones.lKnee) bones.lKnee.rotation.x = 0
    if (bones.rKnee) bones.rKnee.rotation.x = 0
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
      updateVRMBody(t)
      lipsyncVRM()
      updateCharacter(root, t, delta)
    } else if (currentModel.type === 'mmd') {
      currentModel.mixer?.update(delta)
      getMmdHelper()?.update(delta)
      updateMMDBody(t)
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
