import * as THREE from 'three'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { updateCharacter, onMouseMove, walkTo, setEmotion, applyMotion } from './characterController.js'
import { initWorld, updateWorldLabels } from './world.js'
import { initChat } from './chat.js'
import { MotionManager } from './motionManager.js'

window.THREE = THREE
window.__applyMotion = applyMotion
window.__textureMap = null

const canvas = document.getElementById('vrm-canvas')
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
})

renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setClearColor(0x000000, 0)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()

const CAM_DEFAULT = {
  pos: new THREE.Vector3(0, 1.0, 5.8),
  target: new THREE.Vector3(0, 0.95, 0),
  fov: 34,
}

const camera = new THREE.PerspectiveCamera(
  CAM_DEFAULT.fov,
  window.innerWidth / window.innerHeight,
  0.1,
  200
)

function applyCameraDefault() {
  camera.position.copy(CAM_DEFAULT.pos)
  camera.lookAt(CAM_DEFAULT.target)
  camera.fov = CAM_DEFAULT.fov
  camera.updateProjectionMatrix()
}

applyCameraDefault()

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
})

const clock = new THREE.Clock()

scene.add(new THREE.AmbientLight(0xffffff, 0.8))

const dir = new THREE.DirectionalLight(0xffffff, 0.9)
dir.position.set(2, 5, 4)
dir.castShadow = true
dir.shadow.mapSize.set(1024, 1024)
scene.add(dir)

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.ShadowMaterial({ opacity: 0.2 })
)
floor.rotation.x = -Math.PI / 2
floor.position.y = 0
floor.receiveShadow = true
scene.add(floor)

const rim = new THREE.DirectionalLight(0xa78bfa, 0.4)
rim.position.set(-3, 2, -2)
scene.add(rim)

const fill = new THREE.DirectionalLight(0xfff0e0, 0.3)
fill.position.set(0, -1, 3)
scene.add(fill)

let currentModel = null
let currentUserScale = 1
const lipsync = { active: false, phase: 0 }
const mmdHelper = new MMDAnimationHelper()
const motionManager = new MotionManager({
  personality: 'calm'
})

function normalizeUrlToFetchable(url) {
  const raw = String(url || '').replace(/\\/g, '/')

  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('file://')) {
    return raw
  }

  // Windows 절대경로
  if (/^[a-zA-Z]:\//.test(raw)) {
    return `file:///${raw}`
  }

  // Unix 절대경로
  if (raw.startsWith('/')) {
    return `file://${raw}`
  }

  return raw
}

async function fetchJsonSafe(url) {
  const normalized = normalizeUrlToFetchable(url)
  if (!normalized) return null

  const response = await fetch(normalized)
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${normalized}`)
  }
  return await response.json()
}

function alignCharacterToGround() {
  if (!currentModel?.root) return

  const box = new THREE.Box3().setFromObject(currentModel.root)
  if (box.isEmpty()) return

  const bottomY = box.min.y
  currentModel.root.position.y -= bottomY
}

function frameCharacterCamera() {
  if (!currentModel?.root) return

  const box = new THREE.Box3().setFromObject(currentModel.root)
  if (box.isEmpty()) return

  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  CAM_DEFAULT.target.set(center.x, 0.95, center.z)

  const height = Math.max(size.y, 1.6)
  const z = Math.max(5.6, height * 2.6)
  CAM_DEFAULT.pos.set(center.x, 1.0, z)

  applyCameraDefault()
}

async function loadManifestByPath(manifestPath) {
  try {
    const manifest = await fetchJsonSafe(manifestPath)
    window.__textureMap = manifest?.textureBasenameMap || null
    return manifest
  } catch (err) {
    console.warn('[Manifest 직접 로드 실패]', manifestPath, err)
    window.__textureMap = null
    return null
  }
}

async function loadManifestForModel(modelUrl) {
  try {
    const normalizedUrl = normalizeUrlToFetchable(modelUrl)
    if (!normalizedUrl) {
      window.__textureMap = null
      return null
    }

    const baseDir = normalizedUrl.substring(0, normalizedUrl.lastIndexOf('/'))

    // 엔트리 모델이 model/extracted/... 에 있을 수 있으므로 후보를 2개 본다.
    const candidates = [
      `${baseDir}/model_manifest.json`,
      `${baseDir.substring(0, baseDir.lastIndexOf('/'))}/model_manifest.json`
    ]

    for (const manifestUrl of candidates) {
      try {
        const response = await fetch(manifestUrl)
        if (!response.ok) continue

        const manifest = await response.json()
        window.__textureMap = manifest.textureBasenameMap || {}
        console.log('[Manifest 로드 성공]', manifestUrl)
        return manifest
      } catch {
        // 다음 후보 시도
      }
    }

    console.warn('[Manifest 없음]', candidates)
    window.__textureMap = null
    return null
  } catch (err) {
    console.warn('[Manifest 로드 실패]', err)
    window.__textureMap = null
    return null
  }
}

export async function loadModel(url, options = {}) {
  if (!url) {
    window.__textureMap = null
    loadDummy()
    return
  }

  const normalizedUrl = normalizeUrlToFetchable(url)
  const ext = String(normalizedUrl).split('?')[0].split('.').pop().toLowerCase()

  if (ext === 'pmx' || ext === 'pmd') {
    if (options.manifestPath) {
      await loadManifestByPath(options.manifestPath)
    } else {
      await loadManifestForModel(normalizedUrl)
    }
    loadMMD(normalizedUrl)
    return
  }

  window.__textureMap = null

  if (ext === 'vrm') {
    loadVRM(normalizedUrl)
  } else {
    console.warn('[Model] 미지원:', ext)
    loadDummy()
  }
}

function loadVRM(url) {
  const loader = new GLTFLoader()
  loader.register((p) => new VRMLoaderPlugin(p))

  loader.load(
    url,
    (gltf) => {
      clearModel()

      const vrm = gltf.userData.vrm
      VRMUtils.rotateVRM0(vrm)
      scene.add(vrm.scene)

      currentModel = {
        type: 'vrm',
        obj: vrm,
        root: vrm.scene,
        baseScale: 1,
        sourcePath: url
      }

      applyCharacterScale()
      alignCharacterToGround()
      frameCharacterCamera()
      showBubble('새 캐릭터로 바꿨어요! 안녕하세요 👋', 3000)
    },
    null,
    (e) => {
      console.error('[VRM]', e)
      loadDummy()
    }
  )
}

function loadMMD(url) {
  const loader = new MMDLoader()

  loader.manager.setURLModifier((resourceUrl) => {
    const fileName = String(resourceUrl).split('/').pop()?.toLowerCase()

    if (!window.__textureMap || !fileName) return resourceUrl

    const candidates = window.__textureMap[fileName]

    if (Array.isArray(candidates) && candidates.length > 0) {
      console.log('[텍스처 복구]', fileName, '→', candidates[0])
      return candidates[0]
    }

    return resourceUrl
  })

  loader.load(
    url,
    (mesh) => {
      clearModel()

      const box = new THREE.Box3().setFromObject(mesh)
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()

      box.getSize(size)
      box.getCenter(center)

      mesh.position.sub(center)

      const normalizedScale = size.y > 0 ? 1.6 / size.y : 1
      mesh.scale.setScalar(normalizedScale)

      const box2 = new THREE.Box3().setFromObject(mesh)
      const size2 = new THREE.Vector3()
      box2.getSize(size2)

      mesh.position.y += size2.y / 2
      mesh.castShadow = true

      scene.add(mesh)

      currentModel = {
        type: 'mmd',
        obj: mesh,
        root: mesh,
        mixer: new THREE.AnimationMixer(mesh),
        morphs: mesh.morphTargetDictionary || {},
        baseScale: normalizedScale,
        sourcePath: url
      }

      applyCharacterScale()
      alignCharacterToGround()
      frameCharacterCamera()
      showBubble('안녕하세요! 잘 부탁드려요 😊', 3000)
    },
    null,
    (e) => {
      console.error('[MMD]', e)
      loadDummy()
    }
  )
}

export function loadDummy() {
  clearModel()

  const g = new THREE.Group()

  const mk = (geo, color, pos, side = THREE.FrontSide) => {
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ color, side })
    )
    m.position.set(...pos)
    m.castShadow = true
    return m
  }

  g.add(mk(new THREE.CapsuleGeometry(0.18, 0.45, 8, 16), 0x7c3aed, [0, 0.9, 0]))
  g.add(mk(new THREE.SphereGeometry(0.2, 16, 16), 0xfde68a, [0, 1.55, 0]))
  g.add(mk(new THREE.SphereGeometry(0.035, 8, 8), 0x1e1b4b, [-0.07, 1.58, 0.18]))
  g.add(mk(new THREE.SphereGeometry(0.035, 8, 8), 0x1e1b4b, [0.07, 1.58, 0.18]))
  g.add(mk(
    new THREE.SphereGeometry(0.21, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    0x5b21b6,
    [0, 1.55, 0],
    THREE.DoubleSide
  ))

  const mouth = mk(new THREE.PlaneGeometry(0.08, 0.04), 0x92400e, [0, 1.48, 0.195])
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

  if (currentModel.type === 'mmd') {
    try { mmdHelper.remove(currentModel.obj) } catch {}
  }

  scene.remove(currentModel.obj)

  if (currentModel.type === 'vrm') {
    VRMUtils.deepDispose(currentModel.obj.scene)
  }

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

  const headPos = new THREE.Vector3()
  currentModel.root.getWorldPosition(headPos)
  headPos.y += 1.9
  headPos.project(camera)

  const sx = (headPos.x * 0.5 + 0.5) * window.innerWidth
  const sy = (-headPos.y * 0.5 + 0.5) * window.innerHeight

  b.style.left = Math.max(10, Math.min(window.innerWidth - 250, sx - b.offsetWidth / 2)) + 'px'
  b.style.top = Math.max(10, sy - b.offsetHeight - 10) + 'px'
}

function idleVRM(t) {
  const vrm = currentModel.obj
  if (!vrm.humanoid) return

  const chest = vrm.humanoid.getRawBoneNode('chest')
  if (chest) chest.rotation.x = Math.sin(t * 0.8) * 0.02

  const head = vrm.humanoid.getRawBoneNode('head')
  if (head) {
    head.rotation.y = Math.sin(t * 0.5) * 0.03
    head.rotation.z = Math.sin(t * 0.3) * 0.01
  }

  if (vrm.expressionManager) {
    const b = t % 4.0
    vrm.expressionManager.setValue('blink', b < 0.12 ? Math.sin((b / 0.12) * Math.PI) : 0)
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
      idleVRM(t)
      lipsyncVRM()
      updateCharacter(root, t, delta)
    } else if (currentModel.type === 'mmd') {
      currentModel.mixer?.update(delta)
      mmdHelper.update(delta)
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
  updateWorldLabels(camera, renderer)
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

    if (!character?.modelManifestPath) return false

    const manifest = await loadManifestByPath(character.modelManifestPath)
    if (!manifest) return false

    const entryUrl = manifest.entryFileUrl || manifest.entryAbsoluteWebPath || null
    if (!entryUrl) return false

    await loadModel(entryUrl, { manifestPath: character.modelManifestPath })
    return true
  } catch (err) {
    console.warn('[레지스트리 캐릭터 로드 실패]', err)
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

    const loadedFromRegistry = await tryLoadActiveCharacterFromRegistry()
    if (loadedFromRegistry) return

    if (s.activeModel && s.activeModel !== 'dummy') {
      const m = (s.models || []).find((model) => model.id === s.activeModel)
      if (m?.path) {
        await loadModel(m.path)
      }
    }
  }).catch(() => {})

  window.api.onSettingsApplied(async (s) => {
    currentUserScale = (s.charScale || 100) / 100

    const loadedFromRegistry = await tryLoadActiveCharacterFromRegistry()
    if (loadedFromRegistry) return

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
initChat({
  showBubble,
  startSpeaking,
  stopSpeaking,
  applyEmotion: (emotion) => {
    setEmotion(emotion)
    const reactMotion = motionManager.pickReactMotion({ emotion })
    applyMotion(reactMotion)
  },
  getTalkMotion: ({ emotion, text }) => {
    return motionManager.pickTalkMotion({ emotion, text })
  },
  getIdleMotion: () => {
    return motionManager.pickIdleMotion()
  }
})