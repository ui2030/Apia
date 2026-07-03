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
import { updateCharacter, onMouseMove, setLookTarget, walkTo, walkToRandomSpot, requestFaceCamera, setEmotion, applyMotion, getState, setState, getLookTarget, getCurrentMotion, getBlinkValue, setDummyBlinkTarget, clearDummyBlinkTarget, setPersonalityVector, setSeatedHipHeight, releaseSit, getWalkSpeed, setStageNavigation } from './characterController.js'
import { applyInertialization, recordDisplayedPose, setInertializationEnabled } from './inertialization.js'
import { setExpressionEmotion, updateExpression, resetExpression } from './expressionRuntime.js'
import { playTimeline, stopTimeline, updateMouthMMD, updateMouthVRM } from './lipsyncRuntime.js'
import { initWorld, updateWorldLabels } from './world.js'
import { initChat, setCharacterRaycaster, setChatOpen } from './chat.js'
import { MotionManager } from './motionManager.js'
import { createDirectorRunner, applyDirective, buildDirectorContext } from './behaviorDirector.js'
import { createActivityRunner } from './activityRunner.js'
import { createPropManager } from './propManager.js'
import { createNeedsManager } from './needsManager.js'
import { createAdaptation } from './adaptationStore.js'
import { createPresenceMonitor } from './presenceManager.js'
import { pickBehaviorSlot, createLingerIntent, timeOfDayEnergyCurve } from './behaviorPlanner.js'
import { resolveMotionAsset, resolveMmdMotionAsset } from './motionAssets.js'
import {
  buildBoneRegistry,
  createPoseSpring,
  createSaccadeState,
  stepPoseSpring,
  applyPose,
  computePoseTargets,
  applyClipArmHangCorrection,
  applyArmIK,
  applyLegIK,
  createImpulseState,
  triggerImpulse,
  LOCOMOTION_ROLES
} from './poseRig.js'

// A clip only needs to be handed off to procedural walking if it actually
// owns locomotion bones (legs/hip). An arms-only talk clip can keep playing
// while the legs walk procedurally. Legacy whole-group masks (torso) include
// legs, so they still trigger the handoff.
function clipMaskBlocksLocomotion(clipMask) {
  if (!clipMask) return false
  if (clipMask.roles) {
    for (const r of clipMask.roles) if (LOCOMOTION_ROLES.has(r)) return true
    return false
  }
  return clipMask.torso === true // legacy mask folds legs into torso
}
import {
  getVRMRuntime,
  getVRMUtils,
  getMmdRuntime,
  getMmdHelper,
  getAmmoRuntime,
  stabilizeMmdPhysics,
  getDynamicPhysicsBones,
  capturePhysicsBoneRest,
  syncHiddenMaterialVisibility,
  applyAuthorTailLift,
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

  // A-3 — head motion (nod/surprise) can't be a clip (procedural gaze owns
  // head/neck), so fire a transient procedural impulse. Covers nods/surprise in
  // BOTH talk and react names; arm clips (if any) still play underneath.
  if (currentModel?.poseRig?.impulse) {
    const n = motion.name || ''
    let kind = null
    let intensity = motion.intensity ?? 1
    if (/look_around/.test(n)) { kind = 'lookaround'; if (/soft/.test(n)) intensity *= 0.7 }
    else if (/look_down/.test(n)) kind = 'lookdown'
    else if (/head_tilt|(^|_)tilt(_|$)/.test(n)) { kind = 'headtilt'; if (/soft|small/.test(n)) intensity *= 0.7 }
    else if (/surpris/.test(n)) { kind = 'surprise'; intensity *= /small/.test(n) ? 0.62 : 1 }
    else if (/nod/.test(n)) { kind = 'nod'; intensity *= /big/.test(n) ? 1.25 : /small/.test(n) ? 0.65 : 1 }
    else if (n === 'react_happy') { kind = 'nod'; intensity *= 0.7 } // a happy little bob
    else if (n === 'react_neutral') { kind = 'nod'; intensity *= 0.4 } // 평범한 답에도 미세한 끄덕 인정
    if (kind) triggerImpulse(currentModel.poseRig.impulse, kind, clock.getElapsedTime(), intensity)
  }

  // 절차적 layer는 dummy/null 포함 모든 경우 위에서 처리. clip 재생은 type별로 분기:
  // mmd → VMD, vrm → VRMA, 그 외(dummy/null/unknown)는 명시적으로 no-op.
  const type = currentModel?.type
  if (type === 'mmd') {
    const asset = resolveMmdMotionAsset(motion.name)
    // 새 모션 시작 시 이전 클립이 걸어둔 손모양을 청소(정체성 가드 — 디렉터가
    // 소품 가리키기 등으로 직접 세팅한 손모양은 안 건드림). 새 클립이 루프면
    // 릴리즈가 안 와서 이전 클립의 open/fist가 눌러앉는 것 방지(Codex MUST-FIX).
    if (currentModel?._clipHandShape) {
      if (currentModel.poseRig?.handShape === currentModel._clipHandShape) {
        currentModel.poseRig.handShape = 'relaxed'
      }
      currentModel._clipHandShape = null
    }
    if (!asset) {
      // No .vmd matched — hand any running clip back to the procedural layer
      // (fade out) so switching from a pose clip to a procedural idle doesn't
      // leave the old clip fighting the procedural write.
      if (currentModel?._vmdClipActive) releaseActiveClips(currentModel, animationCtx)
      if (currentModel) currentModel._vmdClipActive = false
      return
    }
    if (currentModel) {
      currentModel._vmdClipActive = true
      // one-shot 연기 클립 존중 게이트용 — 스케줄러가 클립 종료까지 새 자율
      // 행동을 얹지 않게 loop 여부를 기록(_vmdClipActive가 꺼지면 무의미).
      currentModel._activeClipLoop = asset.loop
      // 매니페스트 handShape — 클립 동안 손모양 프리셋(흔들기=편 손 등).
      // 릴리즈(scheduleGuardedRelease)와 다음 playMotion 시작에서 원복.
      if (asset.handShape && currentModel.poseRig) {
        currentModel.poseRig.handShape = asset.handShape
        currentModel._clipHandShape = asset.handShape
      }
    }
    // 실패 정리 — playMMDAnimation은 로드 실패/추월(race) 시 reject가 아니라
    // null resolve라 .catch만으론 optimistic 플래그·손모양이 눌러앉는다(Codex
    // MUST-FIX). 토큰으로 "그 사이 새 playMotion이 왔으면 손 대지 않음"을 보장
    // (추월 null은 새 재생이 이미 자기 상태를 세팅했으므로 건드리면 안 됨).
    // 모델 참조도 캡처 — currentModel은 가변이라, 모델 교체 후 옛 재생의 stale
    // null이 (per-model 시퀀스가 우연히 같으면) 새 모델 상태를 지울 수 있다(Codex).
    const playModel = currentModel
    const playToken = playModel ? (playModel._vmdPlaySeq = (playModel._vmdPlaySeq || 0) + 1) : 0
    const cleanupFailedPlay = () => {
      if (!playModel || playModel !== currentModel || playModel._vmdPlaySeq !== playToken) return
      playModel._vmdClipActive = false
      if (playModel._clipHandShape) { // 손모양 원복(정체성 가드)
        if (playModel.poseRig?.handShape === playModel._clipHandShape) {
          playModel.poseRig.handShape = 'relaxed'
        }
        playModel._clipHandShape = null
      }
    }
    playMMDAnimation(asset.url, { loop: asset.loop })
      .then((clip) => { if (!clip) cleanupFailedPlay() })
      .catch((err) => {
        cleanupFailedPlay()
        console.warn('[playMotion] vmd clip failed', motion.name, err)
      })
    return
  }
  if (type === 'vrm') {
    const asset = resolveMotionAsset(motion.name)
    if (!asset) {
      if (currentModel?._vrmaClipActive || currentModel?._fbxClipActive) releaseActiveClips(currentModel, animationCtx)
      if (currentModel) { currentModel._vrmaClipActive = false; currentModel._fbxClipActive = false }
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
// 애니 외곽선 렌더(OutlineEffect 래핑). renderer.render 대신 사용.
const outlineRender = _sceneRuntime.outlineRender || ((sc, cam) => renderer.render(sc, cam))
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
  // Phase F — room-check.mjs awaits this so a screenshot isn't taken while
  // furniture GLBs are still popping in.
  window.__apiaFurnitureReady = _sceneRuntime.furnitureReady ?? Promise.resolve()
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
  // 결정론적 직선 보행 — 보행/접지 진단(walk-check 등)이 정해진 경로로 검증.
  window.__walkToXZ = (x, z) => walkTo({ x, z })
  // #1 적응 학습 진단 — 시간대 변조 계수·성숙도 확인. hour 인자로 특정 시간 테스트.
  window.__adaptInfo = (hour = new Date().getHours()) => ({
    maturity: +adaptation.maturity().toFixed(3),
    hourBias: +adaptation.getHourBias(hour).toFixed(3),
    // 4단계 — 제스처 선호·페이스 학습 상태(라이브 검증용).
    gestureBias: (name) => +adaptation.getGestureBias(name).toFixed(3),
    paceBias: adaptation.getPaceBias(),
    serialized: adaptation.serialize(),
  })
  window.__recordInteractionAt = (hour) => adaptation.recordInteraction(hour)
  // 4단계 디버그 — 제스처 보상/페이스 직접 주입(하니스·수동 검증).
  window.__rewardGesture = (name, r) => { adaptation.rewardGesture(name, r); saveAdaptation() }
  window.__recordPace = (engaged) => { adaptation.recordPace(!!engaged); saveAdaptation() }
  window.__clipFlags = () => ({
    vmd: currentModel?._vmdClipActive ?? null,
    vrma: currentModel?._vrmaClipActive ?? null,
    fbx: currentModel?._fbxClipActive ?? null,
    clipRoles: currentModel?._clipRoles ? Array.from(currentModel._clipRoles) : null,
    state: getState?.() ?? null,
  })
  // F단계 E2E — smoothness-check가 시선 반응을 단언하고(__setLookTarget),
  // inertialization on/off 비교 측정을 한다(__setInertialization).
  window.__setLookTarget = (x, y) => setLookTarget(x, y, { source: 'global' })
  window.__setInertialization = (on) => setInertializationEnabled(on)
  // G단계 E2E — expression-check가 감정→모프 연동을 단언한다.
  window.__applyEmotion = (e) => applyEmotion(e)
  // H단계 E2E — lipsync-check가 합성 타임라인으로 입모양 연동을 단언한다.
  window.__lipsyncPlay = (tl, off) => {
    startSpeaking()
    return playTimeline(tl, off)
  }
  window.__lipsyncStop = () => stopSpeaking()
  // J단계 거주형 비서 E2E — 스마트 오브젝트/소품/욕구를 결정론적으로 구동해
  // GUI 스크린샷으로 자가 검증한다(자율 발동을 끄고 강제 트리거).
  window.__startActivity = (id) => {
    const obj = (worldManager?.getActivityObjects?.() || []).find((o) => o.activity?.id === id)
    if (!obj) return false
    return activityRunner.start(obj.activity) === true
  }
  window.__abortActivity = () => interruptActivity(true)
  window.__activityActive = () => activityRunner.isActive()
  window.__activityInfo = () => ({ active: activityRunner.isActive(), priority: activityRunner.isPriority(), id: activityRunner.currentId(), state: getState?.() })
  window.__respondToCall = () => respondToCall()
  window.__attachProp = (kind, hand = 'right') => propManager.attach({ kind, hand })
  window.__detachProp = () => propManager.detach()
  window.__heldPropState = () => propManager.state()
  window.__setReach = (on) => propManager.setReach(on)
  window.__needs = () => needsManager.snapshot()
  window.__setNeed = (k, v) => needsManager.setNeed(k, v)
  window.__listActivities = () => (worldManager?.getActivityObjects?.() || []).map((o) => o.activity?.id)
  window.__playMotion = (category, name, intensity = 1) => playMotion({ category, name, intensity })
  window.__currentMotion = () => getCurrentMotion()
  window.__clothMonitorTick = () => { clothMonitorTick(); return clothRideStreak }
  window.__reseatPhysics = () => {
    if (currentModel?.type !== 'mmd') return false
    try { return stabilizeMmdPhysics(currentModel.obj, { warmupCycles: 30, reseatBones: true }) } catch { return false }
  }
  window.__boneWorldPos = (role = 'lWrist') => {
    const b = currentModel?.poseRig?.registry?.roles?.get?.(role)?.bone
    if (!b) return null
    b.updateWorldMatrix(true, false)
    const v = new (b.position.constructor)()
    b.getWorldPosition(v)
    return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) }
  }
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

// J단계(상황 인지) — 시간대별 활기 계수. 곡선 모양은 엔진(behaviorPlanner),
// "언제 활기찬가"는 캐릭터 프로필(dailyRhythm 크로노타입 시프트)이 정한다.
// hour 인자는 테스트용.
function timeOfDayEnergy(hour = new Date().getHours()) {
  return timeOfDayEnergyCurve(hour, motionManager.getDailyRhythm?.()?.energyHourShift || 0)
}

// J단계(상황 인지) — 대화 최근성. lastInteractionAt은 "사용자 입력 시점"이 아니라
// "캐릭터가 마지막으로 응답/발화한 시점"(발화는 항상 사용자 입력에 뒤따르므로 근사).
// 사용자가 읽기만 하는 동안 갱신 안 되는 것은 이 정의에서 정상.
let lastInteractionAt = 0 // ms; 0 = 아직 대화 없음

// #1 적응 학습 — 사용자의 하루 리듬을 누적해 시간대 활기를 사용자에 맞춘다.
// localStorage 영속(렌더러). 데이터 쌓이기 전엔 중립이라 안전.
// J단계 — 학습·욕구는 캐릭터별 키로 분리한다(캐릭터마다 관계가 따로 쌓인다).
// 예전 단일 키(apia-adaptation)는 per-char 키가 비어 있을 때 시드로만 읽는다.
const ADAPT_KEY_PREFIX = 'apia-adaptation:'
const LEGACY_ADAPT_KEY = 'apia-adaptation'
function loadAdaptationData(key) {
  try {
    const s = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_ADAPT_KEY)
    return s ? JSON.parse(s) : null
  } catch { return null }
}
let adaptKey = ADAPT_KEY_PREFIX + 'default'
let adaptation = createAdaptation(loadAdaptationData(adaptKey))
let _adaptSaveAt = 0
function saveAdaptation(force = false) {
  try {
    const now = Date.now()
    if (!force && now - _adaptSaveAt < 5000) return // 쓰기 스로틀(force면 즉시=유실 방지)
    _adaptSaveAt = now
    localStorage.setItem(adaptKey, JSON.stringify(adaptation.serialize()))
  } catch {}
}

// J단계 — 욕구 영속(캐릭터별). savedAt을 같이 저장해 다음 시작 때 오프라인
// 경과분을 상한부로 반영한다(needsManager.applyOfflineRise).
const NEEDS_KEY_PREFIX = 'apia-needs:'
let needsKey = NEEDS_KEY_PREFIX + 'default'
let _needsSaveAt = 0
function saveNeeds(force = false) {
  try {
    const now = Date.now()
    if (!force && now - _needsSaveAt < 5000) return
    _needsSaveAt = now
    localStorage.setItem(needsKey, JSON.stringify({ needs: needsManager.snapshot(), savedAt: now }))
  } catch {}
}
function loadNeedsData() {
  let saved = null
  try {
    const s = localStorage.getItem(needsKey)
    saved = s ? JSON.parse(s) : null
  } catch {}
  needsManager.load(saved?.needs || null)
  if (Number.isFinite(saved?.savedAt)) needsManager.applyOfflineRise(Date.now() - saved.savedAt)
}

// 캐릭터 교체 시 학습·욕구 스코프 전환. Codex MUST-FIX 두 가지 순서 보장:
//  1) 저장은 항상 "현재" 키로 쓰므로 flush는 키를 바꾸기 전에(옛 캐릭터 몫으로).
//  2) 로드는 새 프로필 적용 *후*에 — loadNeedsData의 오프라인 보정이 성격 가중
//     (getPersonality)을 쓰므로, 먼저 부르면 옛 캐릭터 성격으로 계산된다.
// 그래서 flush와 load를 분리해 applyCharacterProfileBundle이 프로필 적용을
// 사이에 끼운다.
function flushLearningScope() {
  try { saveAdaptation(true); saveNeeds(true) } catch {}
}
function loadLearningScope(charId) {
  const scope = charId || 'default'
  adaptKey = ADAPT_KEY_PREFIX + scope
  adaptation = createAdaptation(loadAdaptationData(adaptKey))
  needsKey = NEEDS_KEY_PREFIX + scope
  loadNeedsData()
}

// 4단계 적응 — 제스처 선호. 자율 idle 제스처가 *실제로 재생*된 것만 기록(Codex
// MUST-FIX: pickIdleMotion 호출이 아니라 playMotion된 자율 제스처만). 일정 창 내
// 사용자가 관여하면 그 제스처에 보상 = "이 제스처 뒤 사용자가 다가옴" 선호 학습.
const GESTURE_REWARD_WINDOW_MS = 45000
const USER_ENGAGED_RECENT_MS = 90000
let lastAutoGesture = null
let lastAutoGestureAt = 0
let lastUserEngagedAt = 0 // 엄격 user-initiated 시점(페이스·보상 신호 전용, markInteraction과 분리)
function noteAutoGesture(name) {
  if (typeof name === 'string' && name) { lastAutoGesture = name; lastAutoGestureAt = Date.now() }
}
// 실제 사용자 입력 경로에서만 호출(onUserCall = 채팅 전송·열기·STT). markInteraction은
// 캐릭터 발화/감정에서도 불려 user-initiated가 아니므로 여기 쓰지 않는다(Codex).
function onUserEngaged() {
  lastUserEngagedAt = Date.now()
  if (lastAutoGesture && Date.now() - lastAutoGestureAt < GESTURE_REWARD_WINDOW_MS) {
    // force-save: 보상은 드물고 종료 직전 유실되면 학습이 사라지므로 즉시 영속(Codex).
    try { adaptation.rewardGesture(lastAutoGesture); saveAdaptation(true) } catch {}
    lastAutoGesture = null // 제스처당 1회만 보상
  }
}

function markInteraction() {
  lastInteractionAt = Date.now()
  // #1 — 이 시간대에 사용자와 함께함을 학습(자율 행동 활기 변조에 반영).
  try { adaptation.recordInteraction(new Date().getHours()); saveAdaptation() } catch {}
  // J단계 — 사용자와의 상호작용(발화·감정 반응)은 진행 중인 자율 활동보다
  // 우선한다. 자율 활동은 중단하되, 호출 응답(priority)은 보존한다(force=false).
  interruptActivity()
  // 대화가 이어지는 동안 호출 응답 hold를 연장(조용해질 때까지 컴퓨터 앞 유지).
  if (activityRunner.isActive() && activityRunner.isPriority()) {
    callIdleDeadline = Date.now() + CALL_HOLD_MS
  }
}

// 대화 최근성 → 주의도 [-1,1]. +1 방금 대화(집중), 0 중립, -1 오래 무관심(독립/지루).
function interactionRecencyFactor(now = Date.now()) {
  if (!lastInteractionAt) return 0
  const elapsed = now - lastInteractionAt
  if (elapsed < 30000) return 1
  if (elapsed < 90000) return 1 - (elapsed - 30000) / 60000 // 30s→90s: 1→0
  if (elapsed < 180000) return -((elapsed - 90000) / 90000) // 90s→180s: 0→-1
  return -1
}

function getAutoBehaviorConfig() {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const base = motionManager.getBehaviorConfig?.() || {}
  const baseMin = Number.isFinite(base.autoBehaviorMinMs) ? base.autoBehaviorMinMs : 9000
  const baseMax = Number.isFinite(base.autoBehaviorMaxMs) ? base.autoBehaviorMaxMs : 16000
  const baseWalk = Number.isFinite(base.walkShare) ? base.walkShare : 0.36
  const baseIdle = Number.isFinite(base.inPlaceIdleBias) ? base.inPlaceIdleBias : 0.28
  const chairBias = Number.isFinite(base.chairBias) ? base.chairBias : 0.45

  // base는 성격 로직이 재사용하므로 절대 변형 말고 새 객체로 변조 반환.
  // 1) 시간대 인지(활기 e): e↑(아침)=walk↑·간격 짧게, e↓(밤)=제자리/정적↑·느긋.
  //    #1 적응: 학습된 하루 리듬으로 변조(자주 함께한 시간대↑, 드문 시간대↓).
  //    데이터 부족 시 getHourBias=1.0이라 기존 규칙 그대로(안전).
  const e = timeOfDayEnergy() * adaptation.getHourBias(new Date().getHours())
  let walkShare = baseWalk * e
  let inPlaceIdleBias = baseIdle / clamp(e, 0.6, 1.3)

  // 2) 사용자 상태 인지(주의도 att): 방금 대화=곁에 머묾(walk↓ idle↑),
  //    오래 무관심=독립적으로 돌아다님(walk↑ idle↓). 시간대 위에 곱연쇄.
  const att = interactionRecencyFactor()
  walkShare *= (1 - att * 0.35)
  inPlaceIdleBias *= (1 + att * 0.30)

  // 2.5) 4단계 적응 — 학습된 페이스(곁/독립). 자주 곁에 있길 원하면 walk↓·idle↑,
  //      독립적이면 반대. 데이터 부족 시 {1,1}(중립=무회귀).
  const pace = adaptation.getPaceBias()
  walkShare *= pace.walkMul
  inPlaceIdleBias *= pace.idleMul

  // 3) 최종 clamp + 합 0.94 캡(가구/폴백 슬롯 항상 보존).
  walkShare = clamp(walkShare, 0.15, 0.6)
  inPlaceIdleBias = clamp(inPlaceIdleBias, 0.12, 0.5)
  const sum = walkShare + inPlaceIdleBias
  if (sum > 0.94) { const s = 0.94 / sum; walkShare *= s; inPlaceIdleBias *= s }

  const minDelay = Math.max(2000, Math.round(baseMin * (2 - e)))
  const maxDelay = Math.max(minDelay + 500, Math.round(baseMax * (2 - e)))
  const cfg = { autoBehaviorMinMs: minDelay, autoBehaviorMaxMs: maxDelay, chairBias, inPlaceIdleBias, walkShare, attentiveness: att }
  // J단계 — LLM 디렉터가 활성 directive를 갖고 있으면 규칙 위에 약하게 변조한다.
  // directive 없음/만료/백엔드 없음이면 cfg 그대로(규칙기반). 절대 앱을 막지 않음.
  return applyDirective(cfg, behaviorDirector.current(), Date.now())
}

// J단계 — LLM 행동 디렉터. 전용 IPC(window.api.directorDecide)가 있을 때만 LLM에
// 묻고(채팅 history와 분리), 없으면 call 미주입 → directive 항상 null → 규칙기반.
// 백엔드 프롬프트/IPC는 다음 슬라이스. runner가 single-flight·최소간격·백오프·
// 타임아웃을 관할하므로 여기선 느린 틱에서 fire-and-forget로 maybeRun만 부른다.
const behaviorDirector = createDirectorRunner({
  call: typeof window !== 'undefined' && window.api?.directorDecide
    ? (ctx) => window.api.directorDecide(ctx)
    : null
})

function runBehaviorDirector() {
  const ctx = buildDirectorContext({
    hour: new Date().getHours(),
    personality: motionManager.getPersonality?.(),
    attentiveness: interactionRecencyFactor(),
    idleStreakMs: lastInteractionAt ? Date.now() - lastInteractionAt : 0,
    // J단계 — 물리적 존재(유휴 기반). attentiveness(대화 최근성)와 다른 축.
    presence: presence.getState(),
    awayMs: presence.awayMsNow(),
    // J단계 — 디렉터가 캐릭터의 내부 상태(욕구)와 방의 어포던스를 보고
    // activityHint로 활동을 제안할 수 있게 한다(가산만, 강제 아님).
    needs: needsManager.snapshot(),
    activities: (worldManager?.getActivityObjects?.() || []).map((o) => o.activity?.id).filter(Boolean),
    currentActivity: activityRunner.isActive() ? activityRunner.currentId() : null,
    lastActivity: lastActivityId
  })
  // fire-and-forget — 실패는 runner가 흡수, directive는 다음 틱에 반영.
  Promise.resolve(behaviorDirector.maybeRun(ctx)).catch(() => {})
}

// J단계 거주형 비서 — 손 소품(컵·유리잔·책) 매니저. 렌더 루프가 updateCharacter
// 뒤에 sync()를 불러 손에 고정한다.
const propManager = createPropManager({ scene, getCurrentModel: () => currentModel })

// J단계 거주형 비서 — 욕구+성격 유틸리티 AI. 시간에 따라 욕구가 차오르고, 활동이
// 채워준다(정상 완료 시에만). 성격으로 상승 속도 가중.
const needsManager = createNeedsManager({
  getPersonality: () => motionManager.getPersonality?.(),
  // 프로필 구동 — 캐릭터별 욕구 상승 성향(페르소나 파생+프로필 명시 오버라이드).
  getRiseTendency: () => motionManager.getNeedsTendency?.() || null
})
// 시작 스코프('default')의 저장분 복원 + 꺼져 있던 시간만큼 욕구 반영.
loadNeedsData()

// J단계 스마트 오브젝트 — 활동 시퀀서(커피 한 잔 등 사물 행동 사슬). 기존 원시
// 동작 + 소품에만 의존. 정상 완료(complete) 시에만 욕구를 충족하고, abort면 안 함.
const activityRunner = createActivityRunner({
  walkTo,
  releaseSit,
  playMotion,
  pickPose: (opts) => motionManager.pickIdleMotion?.(opts),
  showBubble,
  getObjectById: (id) => worldManager?.getObjectById?.(id) || null,
  getPersonality: () => motionManager.getPersonality?.(),
  attachProp: (spec) => propManager.attach(spec),
  detachProp: () => propManager.detach(),
  setReach: (on) => propManager.setReach(on),
  onFinish: (reason, activity) => {
    // 만족은 드물고 유실되면 "방금 마신 커피"가 되살아나므로 즉시 영속.
    if (reason === 'complete' && activity) {
      needsManager.satisfy(activity)
      saveNeeds(true)
      lastActivityId = activity.id || null // 디렉터 컨텍스트용(직전 완료 활동)
    }
    scheduleAutoBehavior()
  }
})

// J단계 — 디렉터 컨텍스트용 직전 완료 활동.
let lastActivityId = null

// ④ 행동 일관성 — 직전 자율 슬롯(약한 반복 회피)과 걷기 후 머무름 의도.
let lastBehaviorSlot = null
const lingerIntent = createLingerIntent()

// 옷 매무새 자가 회복 — 치맛자락이 머리카락/꼬리 물리에 걸려 말려 올라간 채
// 스스로 못 내려오는 상태(실측: 옷자락 패널이 트윈테일에 감김)를 감지해
// 재안착한다. 모델 불문: 본 이름이 아니라 동적 물리 본들의 "루트 대비 rest
// 높이" 기준선을 첫 안정 틱에 캡처하고, 서있는 유휴 중 다수 본이 기준선보다
// 크게 떠 있는 상태가 연속 틱으로 지속되면 stabilizeMmdPhysics로 재안착.
// (엉킴 유발 자체는 patchRealtimePhysicsStep의 정속화가 크게 줄인다.)
const CLOTH_RIDE_DEVIATION = 0.15 // 본당 "떠 있음" 판정 편차(월드 단위 ≈ 15cm)
const CLOTH_RIDE_MIN_BONES = 6 // 이만큼 이상 동시에 떠 있어야 엉킴으로 간주
const CLOTH_RIDE_STREAK = 2 // 연속 틱(~20s) 지속 시에만 개입(일시 출렁임 무시)
let clothRest = null // { scale, rels: Map(bone → rest relY) }
let clothRideStreak = 0
const _clothVec = new Vector3()

function clothMonitorTick() {
  if (currentModel?.type !== 'mmd' || !currentModel.obj?.skeleton) return
  // VMD 클립이 포즈를 소유 중이면 reset+warmup을 얹지 않는다(로드 재안착과
  // 동일한 안전 게이트, Codex MUST-FIX). 다음 클립 없는 유휴 틱에 회복.
  if (currentModel._vmdClipActive) return
  const mesh = currentModel.obj
  const bones = getDynamicPhysicsBones(mesh)
  if (!bones.length) return
  mesh.getWorldPosition(_clothVec)
  const rootY = _clothVec.y
  const scale = mesh.scale?.x || 1
  // 기준선 캡처(첫 안정 틱) — 스케일이 바뀌면 기준선도 무효라 재캡처.
  if (!clothRest || Math.abs(scale - clothRest.scale) > scale * 0.01) {
    const rels = new Map()
    for (const b of bones) {
      b.getWorldPosition(_clothVec)
      rels.set(b, _clothVec.y - rootY)
    }
    clothRest = { scale, rels }
    clothRideStreak = 0
    return
  }
  let deviant = 0
  for (const b of bones) {
    const rest = clothRest.rels.get(b)
    if (rest === undefined) continue
    b.getWorldPosition(_clothVec)
    if (_clothVec.y - rootY - rest > CLOTH_RIDE_DEVIATION) deviant++
  }
  if (deviant >= CLOTH_RIDE_MIN_BONES) {
    clothRideStreak++
    if (clothRideStreak >= CLOTH_RIDE_STREAK) {
      clothRideStreak = 0
      console.info('[Apia cloth] 매무새 자가 회복 — 떠 있는 물리 본', deviant, '개, 재안착')
      try { stabilizeMmdPhysics(mesh, { warmupCycles: 30, reseatBones: true }) } catch {}
    }
  } else {
    clothRideStreak = 0
  }
}

// J단계 — 사용자 존재 인지. 메인 프로세스의 유휴초 폴링(5s)+절전/잠금 이벤트를
// presenceManager 상태기계에 넣고, 전이에 반응한다. 복귀 인사·recordPace 스킵·
// 디렉터 컨텍스트·잠금 중 자율행동 정지가 이 상태를 읽는다.
const presence = createPresenceMonitor({ onTransition: handlePresenceTransition })
// 잠금/절전 자율행동 정지. Codex MUST-FIX: 잠금과 절전은 독립 사건이라 플래그를
// 분리한다 — 잠금→절전→resume 순서에서 resume이 (아직 잠금인데) 정지를 풀면
// 잠금 화면 뒤에서 행동이 돌고 욕구 보정 구간도 끊긴다.
let pauseLocked = false
let pauseSuspended = false
let powerPausedAt = 0 // 정지 시작 시각(0=정상). 두 플래그가 다 풀려야 끝난다.
let pauseResumeTimer = null
const RESUME_GRACE_MS = 8000 // 재개 유예 — 복귀 확정(유휴 폴링)·인사 기회 먼저

function startPowerPause() {
  clearTimeout(pauseResumeTimer)
  pauseResumeTimer = null
  if (!powerPausedAt) powerPausedAt = Date.now()
  clearAutoBehaviorTimer()
}

function maybeEndPowerPause() {
  if (pauseLocked || pauseSuspended) return // 아직 다른 쪽이 정지 중
  if (powerPausedAt) {
    // Codex MUST-FIX: 정지 동안 needs tick이 안 돌았으므로 경과분을 상한부 반영.
    needsManager.applyOfflineRise(Date.now() - powerPausedAt)
    powerPausedAt = 0
  }
  // Codex MUST-FIX: 즉시 재예약하면 복귀 확정(다음 유휴 폴링, ≤5s) 전에 활동이
  // 시작돼 인사를 no-activity 게이트로 막을 수 있다. 한 유예를 두고 재개한다 —
  // 입력 없이 잠금이 풀린 경우에도 유예 뒤엔 자율 생활 재개(영구 동결 방지).
  clearTimeout(pauseResumeTimer)
  pauseResumeTimer = setTimeout(() => {
    pauseResumeTimer = null
    scheduleAutoBehavior()
  }, RESUME_GRACE_MS)
}

function handlePresenceTransition(evt) {
  if (evt.type !== 'user-returned' || !evt.greet) return
  // Codex MUST-FIX 게이트: 모델 로드됨·idle·립싱크 없음·활동 없음일 때만.
  // 인사는 반드시 playMotion(관성 보간 경로) — 새 관절 수학 금지.
  if (!currentModel) return
  if (lipsync.active) return
  if (activityRunner.isActive()) return
  if (getState?.() !== 'idle') return
  const react = motionManager.pickReactMotion({ emotion: 'happy' })
  playMotion(react)
  applyEmotion('happy')
}

function handlePresenceIdleFeed(idleSec) {
  presence.onIdle(idleSec)
}

function handlePresenceEventFeed(name) {
  presence.onEvent(name)
  // 화면이 안 보이는 동안 자율 행동 정지(전력·CPU 절약). 욕구는 재개 때 보정.
  if (name === 'lock-screen') { pauseLocked = true; startPowerPause() }
  else if (name === 'suspend') { pauseSuspended = true; startPowerPause() }
  else if (name === 'unlock-screen') { pauseLocked = false; maybeEndPowerPause() }
  else if (name === 'resume') { pauseSuspended = false; maybeEndPowerPause() }
}

window.api?.onPresenceIdle?.(({ idleSec } = {}) => handlePresenceIdleFeed(idleSec))
window.api?.onPresenceEvent?.(({ name } = {}) => handlePresenceEventFeed(name))

// 디버그/E2E — 실제 IPC 피드와 완전히 같은 핸들러로 주입(잠금 정지 경로 포함,
// 상태 직접 변조 금지).
window.__presenceDebug = {
  idle: handlePresenceIdleFeed,
  event: handlePresenceEventFeed,
  state: () => presence.getState()
}

// 종료 직전 학습·욕구 flush(스로틀에 걸려 안 쓰인 마지막 몇 초 유실 방지).
// 벽지모드 Electron에선 beforeunload가 항상 보장되진 않아 pagehide도 겸한다(Codex).
const flushPersistence = () => { try { saveAdaptation(true); saveNeeds(true) } catch {} }
window.addEventListener('beforeunload', flushPersistence)
window.addEventListener('pagehide', flushPersistence)

// 인터럽트 — 진행 중인 활동을 중단한다. 기본은 "최우선(호출 응답) 활동은 건드리지
// 않음": markInteraction(그녀가 말함)·onCharacterAction은 호출 응답 중이면 그녀를
// 컴퓨터 앞에서 끌어내면 안 되므로 force=false로 priority를 보존한다. 사용자가
// 명시적으로 다른 곳을 지시(가구 클릭·다른 활동·모델 교체)할 때만 force=true.
function interruptActivity(force = false) {
  if (activityRunner.isActive() && (force || !activityRunner.isPriority())) {
    activityRunner.abort()
  }
}

// ── 호출 응답 = 최우선 인터럽트 (비전의 "궁극") ──────────────────────────
// 사용자가 부르면(채팅 전송) 하던 자율 행동을 멈추고 자기 컴퓨터(deskChair)로 와
// 앉아 "불렀어?". 성격이 타이밍을 표현(활발=즉시, 수줍/차분="잠깐만!" 후). 응답은
// priority 활동이라 대화 중(markInteraction/감정) 끌려나가지 않고, 대화가 끝나고
// 일정 시간 유휴면 자율 생활로 복귀한다(Codex MUST-FIX: 지연·hold·복구 처리).
const CALL_HOLD_MS = 15000
const CALL_MAX_MS = 120000 // 하드 캡 — lipsync.active가 고착돼도 결국 풀리게(워치독)
let callIdleDeadline = 0
let callStartedAt = 0

function respondToCall() {
  callIdleDeadline = Date.now() + CALL_HOLD_MS
  // 이미 응답 중 + 실제로 자리에 앉음 → 재경로 없이 유지(메시지 연타 방어).
  // 아직 못 앉았으면(걸어가다 stuck 등) 아래에서 force-restart로 복구.
  if (activityRunner.isActive() && activityRunner.isPriority() && getState?.() === 'sit') {
    requestFaceCamera({ durationMs: 14000, approach: false })
    return
  }
  interruptActivity(true) // 자율(또는 미착석 stuck 호출) 강제 중단
  callStartedAt = Date.now()
  const personality = motionManager.getPersonality?.() || 'calm'
  const eager = personality === 'active'
  const steps = []
  if (!eager) steps.push({ kind: 'pose', durationMs: 1100, bubble: '잠깐만!' })
  // 긴 dwell(실질 무한) — 실제 종료는 유휴 데드라인(endCallResponseIfIdle)이 관할.
  steps.push({ kind: 'sit', targetId: 'deskChair', durationMs: 600000, bubble: '불렀어?' })
  activityRunner.start({ id: 'respondCall', priority: true, needFill: {}, steps })
  requestFaceCamera({ durationMs: 14000, approach: false })
}

// 호출 응답을 유휴 시 종료 — 대화(lipsync) 중이면 데드라인 연장, 조용해지고
// 데드라인 지나면 자율 생활 재개. 행동 틱마다 호출.
// 마시기/읽기 단계 — 소품 든 팔을 2본 IK로 입까지 가져온다(FK 한계 보완, 모델 불문).
// 목표 = 머리 본 월드 + 오프셋(입 높이·살짝 앞). 렌더 루프 updateBody 뒤 호출.
const _mouthTarget = new Vector3()
const _reachFwd = new Vector3()
const _reachPole = new Vector3()
function maybeReachPropToMouth() {
  if (!propManager.isReaching()) return
  const reachArm = propManager.heldArmRole?.()
  const reg = currentModel?.poseRig?.registry
  if (!reachArm || !reg) return
  const head = reg.roles?.get?.('head')?.bone
  if (!head) return
  head.getWorldPosition(_mouthTarget)
  // 컵/잔=입, 책=읽기 위치(가슴~얼굴 아래·더 앞). 책을 입으로 보내지 않게(Codex).
  const kind = propManager.state()?.kind
  const down = kind === 'book' ? 0.22 : 0.10
  const fwd = kind === 'book' ? 0.16 : 0.06
  _mouthTarget.y -= down
  // 앞 방향 = 사용자(카메라) 쪽. 캐릭터가 어디를 향하든 견고(마시기/읽기=마주봄).
  _reachFwd.set(0, 0, 1)
  if (camera) {
    _reachFwd.copy(camera.position).sub(_mouthTarget)
    _reachFwd.y = 0
    if (_reachFwd.lengthSq() > 1e-6) _reachFwd.normalize()
    else _reachFwd.set(0, 0, 1)
  }
  _mouthTarget.addScaledVector(_reachFwd, fwd)
  // 폴 — 팔꿈치가 향할 방향: 아래 + 사용자쪽 살짝 + 드는 손 바깥쪽(자연스러운 굽힘,
  // 절대 뒤로 안 꺾이게). 왼손=캐릭터 왼쪽(카메라 마주봄 기준 화면 오른쪽).
  const outX = reachArm === 'lArm' ? 1 : -1
  _reachPole.set(outX * 0.35, -1, 0).addScaledVector(_reachFwd, 0.35).normalize()
  applyArmIK(reg, reachArm === 'lArm' ? 'l' : 'r', _mouthTarget, _reachPole)
}

function endCallResponseIfIdle() {
  if (!activityRunner.isActive() || activityRunner.currentId() !== 'respondCall') return
  const now = Date.now()
  // 워치독 — lipsync.active가 고착돼도 하드 캡을 넘으면 종료(Codex NICE-TO-HAVE).
  if (callStartedAt && now - callStartedAt > CALL_MAX_MS) { interruptActivity(true); return }
  if (lipsync.active) {
    callIdleDeadline = now + CALL_HOLD_MS
    return
  }
  if (now >= callIdleDeadline) interruptActivity(true)
}

// J단계 거주형 비서 — 자율 활동 발동 판정(욕구 유틸리티 AI). 욕구를 시간만큼
// 올리고(tick), 방의 활동 사물 중 "욕구×채움" 점수가 가장 높은 걸 고른다(임계
// 미만이면 null → 기존 idle/walk 폴백). 디렉터 focus가 활동 focus와 맞으면 약간
// 가산. 거의 공짜 계산이라 매 틱 호출.
function maybeStartActivity() {
  if (activityRunner.isActive()) return false
  needsManager.tick()
  saveNeeds() // 스로틀(5s) 걸린 영속 — 틱마다 불러도 싸다
  const activities = (worldManager?.getActivityObjects?.() || [])
    .map((o) => o.activity)
    .filter(Boolean)
  if (!activities.length) return false

  const directive = behaviorDirector.current?.()
  const pick = needsManager.chooseActivity(activities, {
    directiveFocus: directive?.focus || null,
    activityHint: directive?.activityHint || null
  })
  if (!pick) return false
  return activityRunner.start(pick) === true
}

// Codex MUST-FIX (step 1 round 2): tracking the active character id so the
// IPC broadcast for persona slider edits can ignore stale messages aimed at
// a previously-active character.
let currentCharacterId = null

function applyCharacterProfileBundle(bundle = null) {
  // J단계 — 캐릭터가 바뀌면 학습(적응)·욕구를 그 캐릭터의 저장분으로 전환.
  // 순서(Codex MUST-FIX): 옛 활동 중단 → 옛 키로 flush → 새 프로필 적용 →
  // 새 스코프 로드(오프라인 욕구 보정이 새 캐릭터 성격 가중을 쓰도록).
  const nextId = bundle?.characterId || null
  const scopeChanged = nextId !== currentCharacterId
  if (scopeChanged) {
    try { interruptActivity(true) } catch {}
    flushLearningScope()
  }
  if (bundle) {
    motionManager.setCharacterProfile(bundle)
    currentCharacterId = bundle.characterId || null
  } else {
    motionManager.clearCharacterProfile()
    currentCharacterId = null
  }
  if (scopeChanged) loadLearningScope(nextId)
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
  // 잠금/절전 정지 중엔 재예약 금지(활동 onFinish 등 다른 경로의 재예약 차단).
  if (powerPausedAt) return

  const behaviorConfig = getAutoBehaviorConfig()
  const minDelay = Math.max(2000, Math.round(behaviorConfig.autoBehaviorMinMs ?? 9000))
  const maxDelay = Math.max(minDelay + 500, Math.round(behaviorConfig.autoBehaviorMaxMs ?? 16000))
  const delayMs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay))

  autoBehaviorTimer = setTimeout(() => {
    autoBehaviorTimer = null

    // 호출 응답이 유휴(대화 끝나고 일정 시간)면 종료하고 자율 생활 재개.
    endCallResponseIfIdle()

    // 활동(커피 등)이 진행 중이면 새 자율 행동을 시작하지 않는다 — pose 단계에선
    // state가 idle이라 가드 없이는 활동 위에 다른 행동이 겹친다(Codex MUST-FIX).
    if (autoBehaviorEnabled && !lipsync.active && !activityRunner.isActive() && getState?.() === 'idle') {
      // J단계 — 느린 LLM 디렉터 리프레시(maybeRun이 ~4분 간격·single-flight로
      // 자체 스로틀). fire-and-forget이라 이번 틱은 직전 directive로 동작.
      runBehaviorDirector()

      // 옷 매무새 자가 회복 — 서있는 유휴 틱에서만(앉기/걷기/활동 중 제외는
      // 이 가드가 보장). 느린 주기(9~16s)라 비용 무시 가능.
      try { clothMonitorTick() } catch {}

      // 4단계 적응 — 페이스 샘플(자율 idle 틱마다 1회). 이 순간 사용자가 최근(90s)
      // *직접 입력*했는가를 표로 던져 장기 곁/독립 성향을 학습한다. tick 단위 균형
      // 샘플이라 입력-true/틱-false 비대칭(독립 쏠림)을 피하고, lastUserEngagedAt
      // 기반이라 캐릭터 발화/감정은 안 섞인다(Codex — 엄격 user-initiated).
      // J단계 — 사용자가 자리에 없는 틱은 표본에서 뺀다. 부재는 "독립 선호"
      // 신호가 아니라 그냥 부재다(Codex — 이걸 안 빼면 closeness가 아래로 쏠림).
      if (presence.isPresent()) {
        const userRecent = lastUserEngagedAt > 0 && (Date.now() - lastUserEngagedAt < USER_ENGAGED_RECENT_MS)
        try { adaptation.recordPace(userRecent); saveAdaptation() } catch {}
      }

      // 진행 중인 one-shot 연기 클립(기지개·초조 등 8~13s)은 끝까지 존중 —
      // 그 위에 새 자율 행동을 얹지 않는다(연기 중간 전환은 관성 보간이 있어도
      // 어색). 클립이 끝나면 _vmdClipActive가 꺼져 다음 틱이 정상 진행.
      if (currentModel?._vmdClipActive && currentModel._activeClipLoop === false) {
        scheduleAutoBehavior()
        return
      }

      // J단계 스마트 오브젝트 — 별도 저확률 "활동" 슬롯. 일반 가구 폴백에 숨기지
      // 않고 독립 확률로 둬 사물 행동 빈도를 따로 튜닝(Codex NICE-TO-HAVE).
      // 디렉터 focus:'self'(혼자 시간) + 차분/밤이면 약간 더 자주. 활동이 시작되면
      // 이번 틱은 여기서 끝(아래 idle/walk/furniture 롤 건너뜀).
      if (maybeStartActivity()) {
        scheduleAutoBehavior()
        return
      }

      // Phase A/J: personality-weighted mix of in-place idle gestures, free
      // roam, and furniture interactions. Order matters — the in-place idle
      // slot goes first so the standing idle vocabulary (pose clips, head
      // tilt, look around) actually surfaces instead of being an unreachable
      // fallback. The split is no longer flat: getBehaviorConfig derives
      // inPlaceIdleBias / walkShare from personality (low mobility or high
      // fidget → more standing gestures; high mobility → more roaming), so an
      // active character roams and a shy/restless one emotes in place
      // (행동 지능). Defensive clamp keeps furniture's slot ≥0 even if the
      // config is later externalized.
      const safe = (v, d) => (Number.isFinite(v) ? Math.min(0.6, Math.max(0, v)) : d)
      const idleBias = safe(behaviorConfig.inPlaceIdleBias, 0.28)
      const walkShare = safe(behaviorConfig.walkShare, 0.36)
      // 방금 대화했으면(attentiveness 높음) "듣는 듯한" 제스처 선호. 디렉터가
      // 명시적으로 무드를 지시(config.idleMood)하면 그가 우선.
      const idleMood = behaviorConfig.idleMood || (behaviorConfig.attentiveness > 0.4 ? 'engaged' : undefined)
      // 4단계 적응 — 학습된 제스처 선호로 가중. 데이터 부족/미지 제스처는 1.0(탐험).
      const gestureBias = (m) => adaptation.getGestureBias(m)
      // 클립 전용 연기 어휘 가용성 — 현재 모델 타입에 맞는 클립 파일이 실제로
      // 있을 때만 후보에 포함(재배포 금지 팩 미보유 설치본 보호).
      const clipAvail = (m) => (currentModel?.type === 'mmd' ? !!resolveMmdMotionAsset(m) : !!resolveMotionAsset(m))
      let handled = false
      let slotDone = null

      // ④ 행동 일관성 — 걷기 도착 후 첫 틱은 "둘러보는" 조용한 제스처로 잇는다
      // (의도 연쇄: 걸어간 자리에 목적이 생긴다). 1회성 소비, 45s 넘기면 만료.
      if (lingerIntent.consume()) {
        const linger = motionManager.pickIdleMotion({ mood: 'quiet', bias: gestureBias, isClipAvailable: clipAvail })
        if (linger) {
          playMotion(linger)
          noteAutoGesture(linger.name)
          handled = true
          slotDone = 'idle'
        }
      }

      // ④ 행동 일관성 — 직전 슬롯의 확률 질량을 절반으로 약화해 같은 종류가
      // 연달아 나오는 걸 줄인다(완전 금지 아님 — 고착도 단조로움도 회피).
      const slot = handled ? null : pickBehaviorSlot({ idleBias, walkShare, lastSlot: lastBehaviorSlot })
      if (!handled && slot === 'idle') {
        const idleGesture = motionManager.pickIdleMotion({ mood: idleMood, bias: gestureBias, isClipAvailable: clipAvail })
        if (idleGesture) {
          playMotion(idleGesture)
          noteAutoGesture(idleGesture.name) // 자율 재생된 제스처만 보상 후보(Codex)
          handled = true
          slotDone = 'idle'
        }
      } else if (!handled && slot === 'walk') {
        handled = walkToRandomSpot({ minDistance: 1.4 }) === true
        if (handled) {
          slotDone = 'walk'
          lingerIntent.armAfterWalk() // 도착 후 첫 idle 틱이 둘러보기로 잇는다
        }
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
        if (handled) slotDone = 'furniture'
      }
      if (!handled) {
        const idleMotion = motionManager.pickIdleMotion({ mood: idleMood, bias: gestureBias, isClipAvailable: clipAvail })
        playMotion(idleMotion)
        noteAutoGesture(idleMotion.name)
        slotDone = 'idle'
      }
      if (slotDone) lastBehaviorSlot = slotDone
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

// 앉기 공중부양 수정 — 서 있을 때의 골반(腰/下半身) world Y를 1회 측정해
// 컨트롤러에 주입한다. 캐릭터마다 골반 높이가 달라도 앉을 때 좌면에 맞춰
// 루트를 내릴 수 있다. 모델이 씬에 배치된 직후 호출.
function measureSeatedHipHeight(registry) {
  const entry = registry?.roles?.get('hip') || registry?.roles?.get('lowerBody')
  const bone = entry?.bone
  if (!bone) { setSeatedHipHeight(null); return } // 더미/측정불가 → 이전 값 잔존 금지
  bone.updateWorldMatrix(true, false)
  const v = new Vector3()
  bone.getWorldPosition(v)
  setSeatedHipHeight(v.y > 0.05 ? v.y : null)
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
            impulse: createImpulseState(),
          }
        }
        applyCharacterScale()
        alignCharacterToGround()
        measureSeatedHipHeight(currentModel.poseRig?.registry) // 앉기 높이용 골반 측정
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
      async (mesh) => {
        // 주의: async 콜백의 reject는 loader의 onError로 가지 않는다 —
        // await 구간은 아래에서 자체 try/catch로 감싼다 (Codex MUST-FIX)
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
            impulse: createImpulseState(),
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
          // 매무새 고치기 기준 스냅샷 — 어떤 포즈/시뮬도 닿기 전의 바인드
          // 로컬(자연 드레이프)을 떠 둔다. reseatBones가 이걸로 복원한다.
          capturePhysicsBoneRest(mesh)
          // warmup: 0 — the helper's built-in warmup runs before the
          // scale-safe reset patch is installed, so its 60 cycles would
          // settle the cloth from wrong-space positions. The real settle
          // happens in stabilizeMmdPhysics() below, after the final
          // scale/ground transform is applied.
          // unitStep 1/120: 기본 1/65는 60Hz 초과 화면에서 옷 물리가 계단·배속
          // (patchRealtimePhysicsStep 참조)으로 보인다. 120Hz 스텝이면 어떤
          // 주사율에서도 부드럽고, maxStepNum 4로 30fps까지 정속 커버.
          helper?.add?.(mesh, { physics: true, warmup: 0, unitStep: 1 / 120, maxStepNum: 4 })
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
        // 꼬리 올림(제작자 본 모프 ★Up_しっぽ) — three.js가 버리는 본
        // 모프를 PMX 재파싱으로 직접 적용. 아래 stabilizeMmdPhysics의
        // 정착 warmup이 "들린 꼬리" 기준으로 돌도록 반드시 그 전에.
        try {
          const lifted = await applyAuthorTailLift(mesh, url)
          if (lifted > 0) console.info('[Apia MMD] author tail-lift applied:', lifted)
        } catch (err) {
          console.warn('[Apia MMD] tail-lift failed (모델은 정상 동작, 꼬리만 미보정)', err)
        }
        // await 동안 다른 모델 로드가 시작됐을 수 있다 — 이 mesh의 정리는
        // 새 로드의 clearModel이 책임지므로 여기선 손대지 않고 빠진다
        if (loadToken !== activeModelLoadToken) {
          resolve(false)
          return
        }
        applyCharacterScale()
        alignCharacterToGround()
        measureSeatedHipHeight(currentModel.poseRig?.registry) // 앉기 높이용 골반 측정
        // Settle skirt/tail/hair in the simulator's own (unscaled) space,
        // AFTER the final user-scale + ground alignment so reset() snaps
        // bodies to the transform the render loop will actually use.
        try { stabilizeMmdPhysics(mesh) } catch (err) {
          console.warn('[Apia MMD] physics stabilize failed', err)
        }
        // 로드 후 첫 프레임들의 포즈 점프(바인드→절차 포즈)가 옷자락을 허벅지
        // 콜라이더 위로 걷어 올려 그대로 굳는다(실측: 로드 4s 후 이미 말려
        // 올라감, 일반 reset은 엉킨 본 위치를 보존해 못 고침). 포즈가 정착한
        // 직후 바인드 드레이프 기준으로 1회 매무새를 고쳐 준다.
        {
          const settledMesh = mesh
          const settleToken = loadToken
          setTimeout(() => {
            if (settleToken !== activeModelLoadToken) return
            // 클립/립싱크/활동이 이미 돌고 있으면 그 위에 reset+warmup을 얹지
            // 않는다(Codex MUST-FIX) — 그런 상태의 엉킴은 이후 서있는 유휴 틱의
            // clothMonitorTick이 안전한 시점에 회복한다.
            if (getState?.() !== 'idle' || lipsync.active || activityRunner.isActive() || currentModel?._vmdClipActive) return
            if (currentModel?.obj !== settledMesh) return
            try { stabilizeMmdPhysics(settledMesh, { warmupCycles: 45, reseatBones: true }) } catch {}
          }, 1200)
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
  measureSeatedHipHeight(currentModel?.poseRig?.registry) // 더미엔 hip 없음 → 초기화
  frameCharacterCamera()
}

// L단계(안정성) — three.js GPU 리소스 명시 해제. JS GC는 WebGL geometry/texture를
// 회수하지 못하므로 모델 교체 시 직접 dispose해야 VRAM이 누수되지 않는다. 같은
// 리소스가 여러 material/슬롯에서 참조될 수 있어 Set으로 중복 dispose를 막는다(Codex).
function disposeObject3D(root) {
  if (!root) return
  const seenGeo = new Set()
  const seenMat = new Set()
  const seenTex = new Set()
  const seenSkel = new Set()
  const disposeTexture = (v) => {
    if (v && v.isTexture && !seenTex.has(v)) { seenTex.add(v); v.dispose() }
  }
  root.traverse((o) => {
    if (o.geometry && !seenGeo.has(o.geometry)) { seenGeo.add(o.geometry); o.geometry.dispose?.() }
    // SkinnedMesh의 skeleton은 본 텍스처(boneTexture)를 들고 있어 별도 해제 필요(Codex).
    if (o.skeleton && !seenSkel.has(o.skeleton)) { seenSkel.add(o.skeleton); o.skeleton.dispose?.() }
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
    for (const m of mats) {
      if (!m || seenMat.has(m)) continue
      seenMat.add(m)
      for (const k of Object.keys(m)) disposeTexture(m[k])
      if (m.uniforms) for (const u of Object.keys(m.uniforms)) disposeTexture(m.uniforms[u]?.value)
      m.dispose?.()
    }
  })
}

function clearModel() {
  if (!currentModel) return

  // J단계 — 모델 교체/해제 시 진행 중 활동 강제 중단 + 손 소품 분리(Codex MUST-FIX:
  // 모든 라이프사이클 종료 경로에서 소품 정리, 구 본을 따라가지 않게).
  interruptActivity(true)
  propManager.detach()

  clearDummyBlinkTarget()
  // 이전 모델의 감정 target/스무딩 상태가 다음 모델로 새지 않게
  resetExpression()

  // 매무새 감시 기준선은 구 모델의 Bone 객체를 키로 잡고 있다 — 같은 스케일의
  // 새 모델이면 재캡처가 안 돼 감시가 죽으므로 교체/해제 시 반드시 리셋(Codex).
  clothRest = null
  clothRideStreak = 0

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
  } else {
    // L단계(안정성) — VRM 외(MMD/PMX·더미)는 deepDispose가 없어 교체할 때마다
    // geometry/material/texture가 GPU에 누수됐다. 명시적으로 해제한다.
    disposeObject3D(currentModel.root)
  }
  // 모델 교체 시 렌더러의 렌더리스트 캐시도 비워 구 모델 참조가 남지 않게(Codex).
  renderer.renderLists?.dispose?.()

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
  markInteraction() // J단계 — 발화 = 방금 대화함(주의도 갱신)
}

export function stopSpeaking() {
  lipsync.active = false
  // H단계 — 비짐 타임라인도 함께 종료. 입 모프는 lipsyncRuntime의 스무딩이
  // 전 모음을 0으로 수렴시킨다.
  stopTimeline()
}

// G단계 — 모델 불문 감정→표정 진입점. MMD는 expressionRuntime(모프 스무딩
// + 6s hold 후 자동 중립), VRM은 기존 1.5s 펄스 유지. neutral은 명시 지원
// (Codex MUST-FIX) — E2E 감쇠 검증과 수동 중립 복귀가 이걸 의지한다.
const VRM_EMOTION_EXPRS = ['happy', 'sad', 'angry', 'surprised']
export function applyEmotion(emotion) {
  if (currentModel?.type === 'mmd') {
    setExpressionEmotion(emotion)
    return
  }
  if (currentModel?.type !== 'vrm') return

  const em = currentModel.obj.expressionManager
  if (!em) return
  if (emotion === 'neutral' || !VRM_EMOTION_EXPRS.includes(emotion)) {
    for (const e of VRM_EMOTION_EXPRS) em.setValue(e, 0)
    return
  }
  em.setValue(emotion, 1.0)
  // 단일 감정만 활성 — 이전 감정(예: happy)을 0으로 내려 happy+surprised 동시
  // 블렌드(휘플래시 머시)를 막는다. 여기 도달 시 emotion은 VRM_EMOTION_EXPRS 보장.
  for (const e of VRM_EMOTION_EXPRS) if (e !== emotion) em.setValue(e, 0)
  // 모델 캡처 — 1.5s 사이 모델이 교체되면 새 모델을 건드리지 않는다
  const model = currentModel
  setTimeout(() => {
    if (currentModel === model) model.obj.expressionManager?.setValue(emotion, 0)
  }, 1500)
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
// * eulerDelta` so model-specific rest posture (e.g. a model's head tilt
// at restEuler [0.028, -0.071, 0.002]) survives.
//
// `state === 'walk'` still wants a stride-driven leg gait. We layer that
// here as a hand-written overlay because the gait is naturally
// *positional* (phase tracks foot plant), not breath-like. It is
// computed in the same { x, y, z } per-role accumulator the spring then
// filters, so the visible motion still goes through critically-damped
// smoothing.

// 보행 사이클 카운트(부동소수) — 한 사이클 = 좌우 한 걸음씩(2 steps). 다리·팔
// 스윙이 같은 사이클을 공유하도록 t 기반 단일 출처(누적기 없이 완벽 동기).
// 정수부 = 완료 사이클 수, 소수부 = 현 사이클 진행도(0..1).
function walkStepsPerSec(personality) {
  return 2.4 + ((personality?.energy ?? 0.5) - 0.5) * 0.8
}
function gaitCycleCount(t, personality) {
  return t * (walkStepsPerSec(personality) / 2)
}
// 걷는 동안 상체 idle 클립에서 떼내어 보행 오버레이가 이기게 할 role들.
const WALK_FREED_ROLES = [
  'lArm', 'rArm', 'lElbow', 'rElbow', 'lArmTwist', 'rArmTwist',
  'lHand', 'rHand', 'spine', 'chest', 'upperChest', 'neck', 'head',
]
// 보행 중 다리 gait가 소유하는 role — 상체 클립이 키해도 보행이 이기게 떼낸다
// (applyPose가 다리 FK rest를 쓰고, applyWalkLegs가 그 위에 IK로 덮어쓴다=blend 기준).
const LEG_IK_OWNED_ROLES = [
  'lLeg', 'rLeg', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle', 'lToe', 'rToe',
]

// ── 보행 다리 IK(발 월드 고정 = no-slip) ──────────────────────────────
// 무클립시 MMD CCD 솔버가 꺼지므로([[apia-walk-gait]]) poseRig.applyLegIK(해석적
// 2본)로 hip/knee를 직접 풀고 ankle을 발바닥-평행으로 정렬한다. 디딘(stance) 발은
// 월드 좌표에 동결 → 몸이 그 위를 지나가도 발이 안 끌린다. **updateCharacter(루트
// 이동) 뒤** 호출(Codex MUST-FIX). FK rest↔IK는 weight slerp로 pop 방지.
const GAIT_STANCE = 0.62      // 사이클 중 발이 땅에 붙어있는 비율
const FOOT_LIFT_WORLD = 0.06  // 스윙 발 들어올림(월드)
const ANKLE_ROLL = 0.15       // 발목 heel-toe 롤 최대 pitch(rad, ~9°)
const _wlFwd = new Vector3(), _wlLat = new Vector3(), _wlRootPos = new Vector3()
const _wlRootQ = new Quaternion(), _wlTarget = new Vector3(), _wlNext = new Vector3()
const _wlFkHip = new Quaternion(), _wlFkKnee = new Quaternion(), _wlFkAnkle = new Quaternion()
const _wlIkHip = new Quaternion(), _wlIkKnee = new Quaternion()
const _wlParentWQ = new Quaternion(), _wlDesiredWQ = new Quaternion(), _wlAnkleLocal = new Quaternion(), _wlPitchQ = new Quaternion()
const _smoothstep = (s) => s * s * (3 - 2 * s)

function _captureLegRest(model, registry, root) {
  const la = registry.roles.get('lAnkle')?.bone
  const ra = registry.roles.get('rAnkle')?.bone
  if (!la || !ra) { model._walkLegs = { unsupported: true }; return }
  const lw = la.getWorldPosition(new Vector3())
  const rw = ra.getWorldPosition(new Vector3())
  root.getWorldQuaternion(_wlRootQ)
  const rootInv = _wlRootQ.clone().invert()
  // 루트 기준 발 방향(평행 유지용) = inverse(rootWQ) * ankleWQ.
  const flat = (a) => rootInv.clone().multiply(a.getWorldQuaternion(new Quaternion()))
  model._walkLegs = {
    groundY: Math.min(lw.y, rw.y),
    halfWidth: Math.hypot(lw.x - rw.x, lw.z - rw.z) / 2,
    flatL: flat(la), flatR: flat(ra),
    weight: 0, lastState: 'idle', // 모델별 상태(전역 아님 — 교체 시 새 모델이 자기 것)
    l: { plant: lw.clone(), from: lw.clone(), prevU: 0 },
    r: { plant: rw.clone(), from: rw.clone(), prevU: 0.5 },
  }
}

function applyWalkLegs(model, t, delta) {
  if (!model?.poseRig?.registry) return
  const { registry } = model.poseRig
  const root = model.root
  const state = getState()
  const la = registry.roles.get('lAnkle')?.bone
  const ra = registry.roles.get('rAnkle')?.bone
  // rest 기준(발 높이·간격·평행방향)은 1회 캡처 — 가능하면 서 있을 때(정확). 드물게
  // 로드 직후 바로 walk면 근사 캡처(영영 멈추지 않게). plant/from은 아래서 진입 시 재초기화.
  if (!model._walkLegs) _captureLegRest(model, registry, root)
  const wl = model._walkLegs
  if (!wl || wl.unsupported) return

  const personality = motionManager.getPersonalityVector?.() || { energy: 0.5 }
  const cyc = gaitCycleCount(t, personality)

  // 비보행→보행 진입: plant/from을 **현재 발목 월드**로 초기화(첫 스텝이 실제 발
  // 위치에서 시작 → 스냅 방지, Codex MUST-FIX). prevU=현재 위상으로 맞춰 진입
  // 프레임에 잘못된 touchdown이 안 잡히게 한다.
  if (state === 'walk' && wl.lastState !== 'walk' && la && ra) {
    root.updateWorldMatrix(true, false)
    la.updateWorldMatrix(true, false); ra.updateWorldMatrix(true, false)
    la.getWorldPosition(wl.l.plant); wl.l.from.copy(wl.l.plant); wl.l.prevU = cyc - Math.floor(cyc)
    ra.getWorldPosition(wl.r.plant); wl.r.from.copy(wl.r.plant); wl.r.prevU = (cyc + 0.5) - Math.floor(cyc + 0.5)
  }
  wl.lastState = state

  const wTarget = state === 'walk' ? 1 : 0
  wl.weight += (wTarget - wl.weight) * Math.min(1, delta * 6)
  if (wl.weight < 0.002) return // 안 걸을 땐 다리 안 건드림(FK rest 유지)
  const w = wl.weight

  // 루트 자신만 갱신(자식 서브트리 전체 재계산 금지 — 치마/머리 MMD 물리가 쓴
  // 본 결과를 로컬에서 덮어쓰면 옷 물리가 깨진다, 직접 확인). 다리 체인 본은
  // 아래 루프에서 본별로 갱신한다.
  root.updateWorldMatrix(true, false)
  root.getWorldPosition(_wlRootPos)
  root.getWorldQuaternion(_wlRootQ)
  const yaw = root.rotation.y
  _wlFwd.set(Math.sin(yaw), 0, Math.cos(yaw)) // 진행방향
  _wlLat.set(Math.cos(yaw), 0, -Math.sin(yaw)) // 오른쪽

  const cyclePeriod = 2 / walkStepsPerSec(personality)
  const stepAhead = 0.31 * getWalkSpeed() * cyclePeriod

  for (const [side, off, sign, st, flat] of [
    ['l', 0, -1, wl.l, wl.flatL],
    ['r', 0.5, 1, wl.r, wl.flatR],
  ]) {
    const u = (cyc + off) - Math.floor(cyc + off)
    const stance = u < GAIT_STANCE
    const wasStance = st.prevU < GAIT_STANCE
    _wlNext.copy(_wlRootPos).addScaledVector(_wlFwd, stepAhead).addScaledVector(_wlLat, sign * wl.halfWidth)
    _wlNext.y = wl.groundY
    if (stance) {
      if (!wasStance) st.plant.copy(_wlNext) // touchdown: 디딜 지점 동결
      _wlTarget.copy(st.plant)               // 월드 고정 → no-slip
    } else {
      if (wasStance) st.from.copy(st.plant)  // lift-off: 떠난 자리 기억
      const s = _smoothstep((u - GAIT_STANCE) / (1 - GAIT_STANCE))
      _wlTarget.lerpVectors(st.from, _wlNext, s)
      _wlTarget.y = wl.groundY + Math.sin(s * Math.PI) * FOOT_LIFT_WORLD
    }
    st.prevU = u

    const hip = registry.roles.get(side + 'Leg')?.bone
    const knee = registry.roles.get(side + 'Knee')?.bone
    const ankle = registry.roles.get(side + 'Ankle')?.bone
    if (!hip || !knee || !ankle) continue
    // 다리 체인만 월드행렬 갱신(조상=척추/골반, 치마 가지 안 건드림). 루트가
    // 막 이동했으니 IK가 읽는 hip/knee/ankle 월드를 현재 루트 기준으로 맞춘다.
    hip.updateWorldMatrix(true, false)
    knee.updateWorldMatrix(true, false)
    ankle.updateWorldMatrix(true, false)
    // FK(applyPose 결과) 저장 → IK 풀고 weight로 slerp(무릎 pop·진입 스냅 방지).
    _wlFkHip.copy(hip.quaternion); _wlFkKnee.copy(knee.quaternion); _wlFkAnkle.copy(ankle.quaternion)
    if (!applyLegIK(registry, side, _wlTarget, _wlFwd)) continue
    _wlIkHip.copy(hip.quaternion); _wlIkKnee.copy(knee.quaternion)
    hip.quaternion.copy(_wlFkHip).slerp(_wlIkHip, w)
    knee.quaternion.copy(_wlFkKnee).slerp(_wlIkKnee, w)
    knee.updateWorldMatrix(true, false)
    // 발바닥 평행 + heel-toe 롤: 위상 u로 발목 pitch를 더해 뒤꿈치 착지→발끝
    // 밀기(평발 미끄럼 제거). _ap: heel(u=0)=+1 → mid-stance=0 → toe-off(u=stance)=−1,
    // 스윙은 −1→+1 복귀(사이클 경계 연속). _wlLat(오른쪽)축 +angle은 발끝을 아래로
    // (right×fwd=down) 회전시키므로 부호 반전: heel=toe up(−), toe-off=toe down(+).
    // 소각(≤~9°)에 w 가중이라 과회전/스냅 없음.
    const _ap = u < GAIT_STANCE
      ? (1 - 2 * (u / GAIT_STANCE))
      : (-1 + 2 * ((u - GAIT_STANCE) / (1 - GAIT_STANCE)))
    ankle.parent.getWorldQuaternion(_wlParentWQ)
    _wlPitchQ.setFromAxisAngle(_wlLat, -_ap * ANKLE_ROLL)
    _wlDesiredWQ.copy(_wlRootQ).multiply(flat)
    _wlDesiredWQ.premultiply(_wlPitchQ)
    _wlAnkleLocal.copy(_wlParentWQ).invert().multiply(_wlDesiredWQ)
    ankle.quaternion.copy(_wlFkAnkle).slerp(_wlAnkleLocal, w)
    ankle.updateWorldMatrix(true, false)
  }
}

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
  // A-1 (granular clipMask): a clip masks ONLY the roles whose bones it
  // actually keyframes (model._clipRoles, set by animationRuntime). An
  // arms-only talk clip no longer freezes the legs/idle. Falls back to the
  // legacy whole-group mask when roles couldn't be resolved (e.g. VRM/FBX
  // bone-name mismatch) so those paths don't regress.
  const clipActive = (
    currentModel._vmdClipActive ||
    currentModel._fbxClipActive ||
    currentModel._vrmaClipActive
  )
  const clipMask = clipActive
    ? (currentModel._clipRoles && currentModel._clipRoles.size
        ? { roles: currentModel._clipRoles }
        : { arms: true, torso: true })
    : null

  // 걷는 동안엔 상체 idle 제스처 클립(머리 갸웃·손 모으기 등)이 팔/몸통을 쥐고
  // 있어도 보행 팔 스윙·다리 gait가 이기도록 그 role을 마스크에서 떼낸다. 클립
  // 수명은 불변(국소·가역적, Codex 권고). granular roles 마스크에만 적용 — 레거시
  // {arms,torso} 마스크는 그대로 둔다(VRM/FBX 본 이름 불일치 폴백).
  // 주의: 무클립 상태에선 MMD helper의 IK/Grant 솔버가 꺼져 있어(animationRuntime
  // stashMmdMixer) 다리는 발 IK가 아니라 FK(左足D 직접 회전)로 구동된다.
  let effClipMask = clipMask
  if (state === 'walk' && clipMask?.roles) {
    const roles = new Set(clipMask.roles)
    for (const r of WALK_FREED_ROLES) roles.delete(r)
    for (const r of LEG_IK_OWNED_ROLES) roles.delete(r) // 다리도 보행 gait가 소유
    effClipMask = roles.size ? { roles } : null
  }
  // 앉는 동안엔 다리를 클립에서 떼내 statePose의 앉기 접힘(무릎 1.55)이 이긴다.
  // idle_curious처럼 다리 0회전 키(서서 무게이동용 소유권 이전)를 가진 클립이
  // 활동 sit 단계의 pose로 뽑히면, 다리 마스크가 앉기 접힘을 펴버려 의자에 앉은
  // 채 다리가 뻣뻣하게 뻗었다(실경로: activityRunner sit → pickPose engaged).
  // 상체는 클립이 계속 연기(앉아서 갸웃 = 의도 동작). 걷기 분기와 같은 패턴.
  if (state === 'sit' && clipMask?.roles) {
    const roles = new Set(effClipMask?.roles ?? clipMask.roles)
    for (const r of LEG_IK_OWNED_ROLES) roles.delete(r)
    effClipMask = roles.size ? { roles } : null
  }

  // Root-position lock used to live here as a per-frame mesh.skeleton
  // walk to copy restPos into 3 root bones. Codex round 2 pointed out
  // it was incomplete (missing 全ての親 + IK + IK親 + half-width/full-
  // width variants) and now redundant with the track-strip in
  // animationRuntime's playMMDAnimation. Removed to avoid two sources
  // of truth.

  const { summed } = computePoseTargets({
    registry,
    saccadeState: saccade,
    impulseState: currentModel.poseRig?.impulse,
    t,
    look,
    state,
    motion,
    personality,
    // 손모양 — 행동 디렉터가 currentModel.poseRig.handShape를 세팅하면 그걸,
    // 없으면 'relaxed'(자연스러운 휴식 손). 후속 단계에서 디렉터가 가리키기/
    // 주먹 등을 상황에 맞춰 바꾼다.
    handShape: currentModel.poseRig?.handShape || 'relaxed',
    clipMask: effClipMask,
  })

  // C단계 — 걷기가 시작됐는데 클립이 아직 본을 소유 중이면 클립을
  // 절차적 걷기로 핸드오프한다. 안 그러면 루프 idle 클립이 다리를 계속
  // 쥐고 있어 캐릭터가 idle 자세로 미끄러진다. clipMask는 이 프레임의
  // 캡처값이라 이번 프레임 gait는 건너뛴다(의도) — fade(0.45s)가 끝나면
  // 플래그가 풀리고 다음 프레임부터 다리가 움직인다. 호출은 매 프레임
  // 일어나도 releaseActiveClips 내부의 pending 가드가 1회로 합친다.
  if (state === 'walk' && clipMaskBlocksLocomotion(clipMask)) {
    releaseActiveClips(currentModel, animationCtx)
  }

  // — Walk gait overlay (상체). 걷는 동안 항상 실행(클립 유무 무관): 예전엔
  // `!clipMask` 가드 때문에 상체 idle 클립이 떠 있으면 gait가 통째로 스킵돼
  // 캐릭터가 얼어붙어 미끄러졌다. effClipMask(위)가 걷는 동안 팔/몸통을 클립에서
  // 떼내 이 오버레이가 본에 닿게 한다. **다리는 여기서 안 건드린다** — applyWalkLegs
  // (발 IK, updateCharacter 뒤)가 발을 월드에 고정해 구동한다. 팔·몸통은 발과 같은
  // 보행 사이클(gaitCycleCount)을 공유해 어긋나지 않는다.
  if (state === 'walk') {
    const intensity = Number.isFinite(motion?.intensity) ? motion.intensity : 1
    const range = (personality.movementRange ?? 0.5) - 0.5
    // 발 IK와 동일한 보행 사이클 공유 → 팔·다리·발이 어긋나지 않는다.
    const cyc = gaitCycleCount(t, personality)
    const twoPi = Math.PI * 2
    // 왼쪽 기준 위상: cyc=0에서 왼다리/왼발 앞(+). 팔은 같은쪽 다리와 반대.
    const legPhase = Math.cos(twoPi * cyc) // 왼다리 cyc0에서 앞(+), 팔은 반대
    const armWalkAmp = 0.36 * intensity * (1 + range * 0.4)
    function bump(role, dx, dy, dz) {
      if (!registry.roles.has(role)) return
      const cur = summed.get(role) || { x: 0, y: 0, z: 0 }
      cur.x += dx || 0
      cur.y += dy || 0
      cur.z += dz || 0
      summed.set(role, cur)
    }
    // 다리는 applyWalkLegs(발 IK, updateCharacter 뒤)가 소유 — 발을 월드에 고정해
    // 미끄러짐을 없앤다. 여기서 FK 다리 bump를 하면 IK와 충돌하므로 안 한다.
    // 팔 스윙 — 같은쪽 다리와 반대 위상(왼다리 앞 → 왼팔 뒤). 모델 불문.
    bump('lArm', -legPhase * armWalkAmp, 0, 0)
    bump('rArm', legPhase * armWalkAmp, 0, 0)
    // 몸통/머리 미세 동작(머리는 사이클의 절반 주기로 좌우).
    bump('spine', Math.abs(legPhase) * 0.01 * intensity, 0, legPhase * 0.035 * intensity)
    bump('chest', 0, -legPhase * 0.05 * intensity, 0)
    bump('head', 0, Math.cos(Math.PI * cyc) * 0.03 * intensity, 0)
  }

  stepPoseSpring(spring, summed, delta, effClipMask)
  applyPose(registry, spring, effClipMask)

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

// H단계 — 비짐 타임라인 기반 입모양 (lipsyncRuntime). 타임라인이 없으면
// (디코드 실패 등) lipsync.active 동안 구 사인파 폴백, 둘 다 아니면 전
// 모음 모프가 0으로 수렴한다.
function lipsyncVRM(delta) {
  if (lipsync.active) lipsync.phase += 0.25
  updateMouthVRM(currentModel, delta, lipsync.active, lipsync.phase)
}

function lipsyncMMD(delta) {
  if (lipsync.active) lipsync.phase += 0.2
  updateMouthMMD(currentModel, delta, lipsync.active, lipsync.phase)
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
      maybeReachPropToMouth() // 소품 든 팔 IK 입-도달(모델 불문 — VRM에도 sip 적용)
      lipsyncVRM(delta)
      updateCharacter(root, t, delta)
      applyWalkLegs(currentModel, t, delta) // 보행 발 IK — 루트 이동 뒤(발 월드 고정)
    } else if (currentModel.type === 'mmd') {
      currentModel.mixer?.update(delta)
      getMmdHelper()?.update(delta)
      // A-2 — clip이 팔을 소유하면(granular mask) 모델별 팔처짐을 클립 출력
      // 위에 합성한다. helper.update 직후·inertialization 전이라 전환 평활화와
      // 표시자세 캐시가 처짐 포함 결과를 본다(클립은 제스처 델타만 갖는다).
      if (currentModel._clipRoles?.size && currentModel.poseRig?.registry) {
        // 소품을 든 팔은 "마시기/읽기" 클립이 일부러 어깨를 들어올리므로 팔처짐
        // 보정에서 제외한다 — 안 그러면 droop가 lift를 상쇄해 손이 입까지 못 옴.
        // 가정: 소품을 드는 활동은 그 팔에 의도된 raise 포즈(idle_sip)를 쓴다.
        // 향후 소품 팔에 일반 제스처 클립을 쓰면 이 제외를 포즈별로 한정할 것.
        let hangRoles = currentModel._clipRoles
        const heldArm = propManager.heldArmRole?.()
        if (heldArm && hangRoles.has(heldArm)) {
          hangRoles = new Set(hangRoles)
          hangRoles.delete(heldArm)
        }
        applyClipArmHangCorrection(currentModel.poseRig.registry, { roles: hangRoles })
      }
      // F단계 — 클립 전환 관성 보정. helper(mixer는 helper 내부 소유) 뒤,
      // 절차적 레이어 앞이 유일하게 유효한 자리다 (inertialization.js의
      // 설계 결정 주석 참조).
      applyInertialization(currentModel, delta)
      updateBody(t, delta)
      // J단계 — 소품(컵/책)을 든 팔이 clip 소유(sip 포즈)면 2본 IK로 손목을 입까지
      // 가져온다(FK로는 불가했던 "컵을 입 정중앙"). updateBody 뒤 = 절차 팔 위에 덮어씀.
      maybeReachPropToMouth()
      // 화면에 나가는 최종 자세를 캐시 — 다음 전환의 연속성 기준점
      recordDisplayedPose(currentModel, delta)
      updateCharacter(root, t, delta)
      applyWalkLegs(currentModel, t, delta) // 보행 발 IK — 루트 이동 뒤(발 월드 고정)
      lipsyncMMD(delta)
      // 표정은 맨 끝 — _updateBlink(updateCharacter 내부)가 갱신한 이번
      // 프레임 blink를 읽고, "managed morphs win after helper/lipsync"
      // (Codex MUST-FIX: updateBody 직후면 전 프레임 blink를 읽는다)
      updateExpression(
        currentModel, delta, getBlinkValue(),
        motionManager.getPersonalityVector?.() || null,
      )
      // 숨김 토글 파츠(opacity 0) 흰 셸 차단 — 모든 모프/재질 기록자(helper·
      // lipsync·updateExpression) 뒤 = MMD 분기 맨 끝(Codex MUST-FIX 위치).
      syncHiddenMaterialVisibility(currentModel.obj?.material)
    } else {
      updateCharacter(root, t, delta)

      if (currentModel.mouth) {
        currentModel.mouth.scale.y = lipsync.active
          ? 1 + Math.abs(Math.sin((lipsync.phase += 0.2))) * 3
          : 1
      }
    }

    // J단계 거주형 비서 — 손 소품 동기화. 반드시 updateCharacter(루트 위치/회전까지
    // 끝남) 뒤라야 손 본 월드 변환이 이번 프레임 최종값이다(Codex MUST-FIX).
    propManager.sync()
  }

  // 조명 패스 — 시간대 라이팅 리그 수렴 스텝(지수 lerp, 프레임당 상수 비용).
  _sceneRuntime.lighting?.tick(delta)

  updateBubblePosition()
  updateWorldLabels(camera)
  outlineRender(scene, camera)
}

// 조명 패스 — 실시간 시계 연동(분 포함). 리그는 타깃만 갱신하고 tick이
// 부드럽게 수렴하므로 60s 간격이면 충분(정시 경계 팝 없음).
setInterval(() => {
  const now = new Date()
  _sceneRuntime.lighting?.setHour(now.getHours() + now.getMinutes() / 60)
}, 60000)
// E2E/수동 검증용 — 시각을 강제하고 적용된 타깃 상태를 돌려준다.
window.__setLightingHour = (h, immediate = true) =>
  _sceneRuntime.lighting?.setHour(h, { immediate }) || null
// 후처리 킬스위치/튜닝 — 알파나 성능이 현장에서 문제면 끌 수 있게.
window.__setPostFx = (on) => { _sceneRuntime.postFx?.setEnabled(on); return _sceneRuntime.postFx?.isEnabled() ?? null }
window.__tunePostFx = ({ bloom, vignette } = {}) => {
  if (bloom) _sceneRuntime.postFx?.setBloom(bloom)
  if (vignette !== undefined) _sceneRuntime.postFx?.setVignette(vignette)
  return true
}

// ── ④ 스테이지(쇼츠급 방 교체) ──────────────────────────────────────
// 사용자가 받은 MMD 스테이지(.pmx)/GLB 방을 절차적 방 대신 로드.
// cfg: { path, scale?, position?, rotY?, castShadow?, outline?, walkBounds?,
//        obstacles? } — localStorage 영속(재시작 자동 적용).
const STAGE_STORE_KEY = 'apiaStage'
async function applyStage(cfg) {
  const obj = await _sceneRuntime.stage.load(cfg)
  if (!obj) return false // 경쟁에서 밀림(그 사이 clear/새 load)
  // 절차적 가구가 숨겨졌으니 그 장애물로 길을 돌면 안 된다 — 스테이지 명시
  // obstacles(기본 빈 배열)로 교체(Codex MUST-FIX).
  setStageNavigation({
    walkBounds: cfg.walkBounds || null,
    obstacles: Array.isArray(cfg.obstacles) ? cfg.obstacles : [],
  })
  return true
}
window.__setStage = async (path, cfg = {}) => {
  const full = { ...cfg, path }
  const ok = await applyStage(full).catch((err) => {
    console.warn('[stage] load failed', err)
    return false
  })
  if (ok) localStorage.setItem(STAGE_STORE_KEY, JSON.stringify(full))
  return ok
}
window.__clearStage = () => {
  _sceneRuntime.stage.clear()
  setStageNavigation(null)
  localStorage.removeItem(STAGE_STORE_KEY)
  return true
}
// 부팅 자동 적용 — 저장된 스테이지가 있으면 로드(실패해도 절차적 방 폴백,
// 저장은 유지해 파일 복구 시 다시 살아난다).
{
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(STAGE_STORE_KEY) || 'null') } catch {}
  if (saved?.path) {
    applyStage(saved).catch((err) => console.warn('[stage] 저장된 스테이지 로드 실패(절차적 방 유지):', err?.message || err))
  }
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

// F단계 — 전역 커서 시선. 벽지 모드는 forwardMouseInput:false라 위의
// mousemove가 영영 안 온다. 메인 프로세스가 50ms 폴링한 커서 좌표(창
// content 기준 [-1,1] 정규화)를 구독한다. 전역 피드가 한 번이라도 도착하면
// characterController가 canvas 경로를 무시해 이중 권한이 안 생긴다.
window.api?.onCursorPos?.((pos) => {
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    setLookTarget(pos.x, pos.y, { source: 'global' })
  }
})

// Opaque, screen-filling scene when actually attached as a desktop wallpaper;
// transparent overlay otherwise. Driven by the main process (true on a real
// wallpaper attach, false on overlay/fallback) so E2E and overlay mode stay
// see-through.
window.api?.onWallpaperOpaque?.((on) => {
  try { _sceneRuntime.setWallpaperOpaque?.(on === true) } catch {}
  // Hide the interactive HUD (chat, buttons, labels) when it's a real wallpaper
  // — it's behind icons + click-through, so it can't be used anyway.
  try { document.body.classList.toggle('wallpaper-mode', on === true) } catch {}
})

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
      measureSeatedHipHeight(currentModel?.poseRig?.registry) // 리스케일 후 재측정(stale 방지)
    }
  })
}

initWorld({
  scene,
  camera,
  renderer,
  showBubble,
  // 일반 가구 클릭 = 사용자가 다른 곳을 명시적으로 지시 → 호출 응답까지 포함해
  // 강제 중단(force) 후 이동. 안 그러면 러너 goto onArrive가 교체돼 wedge.
  onWalkTo: (payload) => { interruptActivity(true); walkTo(payload) },
  // J단계 스마트 오브젝트 — activity 사물 클릭 시 활동 시퀀서 시작. 사용자 클릭은
  // 지시된 의도라, 다른 활동이 진행 중이면 선점(force 중단 후 시작)한다.
  onStartActivity: (activity, { source } = {}) => {
    if (source === 'click') interruptActivity(true)
    return activityRunner.start(activity) === true
  }
})
  .then((manager) => {
    worldManager = manager
  })
  .catch((error) => {
    console.error('[WORLD_INIT_ERROR]', error)
    worldManager = null
  })

// 5단계 — 직접 상호작용 반응. 쓰다듬기=기쁨/수줍, 잡기(드래그)=놀람. 명시 모션
// 선택(pickReactMotion 감정 보장 안 됨, Codex). 터치는 markInteraction(recency·자율
// 억제)+onUserEngaged(4단계 보상·페이스) 둘 다 갱신. 쿨다운으로 과반응 억제.
let _lastPetAt = 0
let _lastReactAt = 0 // pet/grab 공유 — 직전 반응을 즉시 덮어쓰는 휘플래시 억제
let _lastTouchReaction = null // 디버그/검증용(__touchInfo)
function petReaction() {
  // 터치 입력 자체는 항상 recency·보상·페이스 갱신(쿨다운은 반응 모션만 억제, Codex).
  markInteraction()
  onUserEngaged()
  const now = Date.now()
  if (now - _lastPetAt < 2500) return
  // 직전 0.6초 내 grab(놀람)이 떴으면 기쁨으로 다운그레이드하지 않음(휘플래시 방지).
  // grab > pet 우선 — 드래그하다 멈춰 쓰다듬기로 재분류돼도 놀람 표정을 유지.
  if (_lastTouchReaction?.kind === 'grab' && now - _lastReactAt < 600) return
  _lastPetAt = now
  _lastReactAt = now
  setEmotion('happy')
  applyEmotion('happy')
  const name = motionManager.getPersonality?.() === 'shy' ? 'react_shy' : 'react_happy'
  playMotion({ category: 'react', name, intensity: 0.9 })
  _lastTouchReaction = { kind: 'pet', emotion: 'happy', motion: name }
}
let _lastGrabAt = 0
function grabReaction() {
  markInteraction()
  onUserEngaged()
  const now = Date.now()
  if (now - _lastGrabAt < 1500) return
  _lastGrabAt = now
  _lastReactAt = now
  // grab은 escalation 신호라 항상 우선 — applyEmotion이 이전 happy를 0으로 내려
  // 깔끔히 surprised로 교체(머시 없음). pet→grab 100ms happy 깜빡임은 허용(Codex).
  setEmotion('surprised')
  applyEmotion('surprised')
  const name = motionManager.getPersonality?.() === 'active' ? 'react_surprised' : 'react_small_surprised'
  playMotion({ category: 'react', name, intensity: 1.0 })
  _lastTouchReaction = { kind: 'grab', emotion: 'surprised', motion: name }
}
if (typeof window !== 'undefined') {
  // 5단계 디버그 — 쿨다운 무시하고 반응 트리거, 결과 스냅샷 반환(라이브 검증).
  window.__pet = () => { _lastPetAt = 0; petReaction(); return _lastTouchReaction }
  window.__grab = () => { _lastGrabAt = 0; grabReaction(); return _lastTouchReaction }
  window.__touchInfo = () => _lastTouchReaction
}

initChat({
  showBubble,
  startSpeaking,
  stopSpeaking,
  applyEmotion: (emotion) => {
    markInteraction() // J단계 — 감정 반응 = 방금 대화함(주의도 갱신)
    setEmotion(emotion)
    applyEmotion(emotion) // G단계 — 표정 모프/익스프레션도 같이
    const reactMotion = motionManager.pickReactMotion({ emotion })
    playMotion(reactMotion)
  },
  getTalkMotion: ({ emotion, text }) => {
    return motionManager.pickTalkMotion({ emotion, text })
  },
  getIdleMotion: () => {
    return motionManager.pickIdleMotion()
  },
  // 호출 응답 = 최우선 인터럽트 — 사용자가 메시지를 보내면(부르면) 하던 일을 멈추고
  // 컴퓨터 앞으로 와 앉아 "불렀어?". 성격이 타이밍을 표현.
  onUserCall: () => { onUserEngaged(); respondToCall() }, // 4단계: 사용자 입력=제스처 보상 신호
  onPet: () => petReaction(),   // 5단계: 쓰다듬기 반응
  onGrab: () => grabReaction()  // 5단계: 잡기/드래그 반응
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
  // 지시된 캐릭터 액션(감정·말풍선·카메라 응시·립싱크)은 사용자/백엔드가 시킨
  // 것이라 진행 중인 자율 활동보다 우선한다. 특히 face-camera는 walkTo를 부르므로
  // 활동을 먼저 끊지 않으면 러너가 wedge된다(Codex MUST-FIX).
  interruptActivity()
  switch (payload.action) {
    case 'emotion': {
      const emotion = payload.value || 'neutral'
      setEmotion(emotion)
      applyEmotion(emotion) // G단계 — IPC 경로도 표정 동일 적용 (Codex MUST-FIX)
      const reactMotion = motionManager.pickReactMotion({ emotion })
      playMotion(reactMotion)
      break
    }
    case 'bubble':
      if (typeof payload.text === 'string') showBubble(payload.text, 4000)
      break
    case 'face-camera':
      // 호출 응답(priority)으로 이미 컴퓨터 앞에 앉아있으면 approach=false —
      // approach:true는 walkTo를 불러 앉은 자세에서 끌려나온다(Codex MUST-FIX).
      requestFaceCamera({ durationMs: payload.durationMs || 12000, approach: !activityRunner.isPriority() })
      break
    case 'lipsync-start': {
      // H단계 Codex MUST-FIX(사후): 타임라인 검증이 먼저 — sanitize에서
      // 거부될 payload가 talk 상태·사인파 폴백을 트리거하면 안 된다.
      // timeline 부재는 송신측 디코드 실패의 명시적 폴백이라 사인파 허용.
      const tl = payload.value?.timeline
      if (tl && !playTimeline(tl, payload.value.offsetSec)) break
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
      // main overlay. setChatOpen syncs state.chatOpen(다음 토글 정상)+패널 표시+
      // 부름(onUserCall→respondToCall). 직접 DOM 변경은 상태 불일치라 금지(Codex).
      setChatOpen(true)
      break
    }
    case 'call':
      // 호출 — 단축키(Ctrl+Alt+A)·코너 버튼 등으로 채팅(창)을 열 때. 하던 일을
      // 멈추고 컴퓨터 앞으로 와 마주본다.
      respondToCall()
      break
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
