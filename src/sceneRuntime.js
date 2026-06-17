/**
 * Scene aggregate for the Apia desktop overlay.
 *
 * Owns the static Three.js setup — renderer/scene/camera/lights/floor —
 * and the camera-default helper that the world manager + post-load
 * framing logic in main.js reads back. Treating it as one factory
 * encapsulates the boot-time wiring (initial size, shadowMap config,
 * fixed-light positions) so main.js doesn't carry 70 lines of
 * "constructor" code at module scope.
 *
 * What's deliberately NOT here:
 *   - currentModel state and the load/clear flow (main.js)
 *   - animation playback (animationRuntime.js)
 *   - world interactions (world.js)
 *   - the per-frame render loop (main.js — depends on too many of the above)
 *
 * The factory shape returns *handles* to the live three objects (scene,
 * camera, renderer, clock) plus the camera-default helpers; mutation of
 * scene contents (scene.add for loaded models, scene.remove on clear) is
 * still the caller's job. We're not hiding three; we're hiding the boot
 * recipe.
 */
import {
  AmbientLight,
  BackSide,
  Box3,
  BoxGeometry,
  Clock,
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer
} from 'three'

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'

import { FURNITURE_DEFAULT } from './furnitureLayout.js'

// Phase F — CC0 Kenney Furniture Kit GLBs (src/assets/room/, License.txt
// included). `?url` so Vite emits each to dist and hands back a resolvable
// URL the GLTFLoader can fetch in the Electron file:// renderer.
import bedSingleUrl from './assets/room/bedSingle.glb?url'
import pottedPlantUrl from './assets/room/pottedPlant.glb?url'
import rugRoundedUrl from './assets/room/rugRounded.glb?url'
import bookcaseClosedWideUrl from './assets/room/bookcaseClosedWide.glb?url'
import tableCoffeeUrl from './assets/room/tableCoffee.glb?url'
import loungeSofaUrl from './assets/room/loungeSofa.glb?url'
import lampRoundFloorUrl from './assets/room/lampRoundFloor.glb?url'
import plantSmall1Url from './assets/room/plantSmall1.glb?url'
import chairUrl from './assets/room/chair.glb?url'
import tableUrl from './assets/room/table.glb?url'
import kitchenFridgeUrl from './assets/room/kitchenFridge.glb?url'
import kitchenSinkUrl from './assets/room/kitchenSink.glb?url'
import kitchenStoveUrl from './assets/room/kitchenStove.glb?url'
import kitchenCabinetUrl from './assets/room/kitchenCabinet.glb?url'
import doorwayFrontUrl from './assets/room/doorwayFront.glb?url'
import rugDoormatUrl from './assets/room/rugDoormat.glb?url'
import sideTableDrawersUrl from './assets/room/sideTableDrawers.glb?url'
import coatRackStandingUrl from './assets/room/coatRackStanding.glb?url'
import bathroomSinkUrl from './assets/room/bathroomSink.glb?url'
import toiletUrl from './assets/room/toilet.glb?url'
// Foreground desk props (the "내 책상에서 방을 보는" lo-fi POV).
import computerKeyboardUrl from './assets/room/computerKeyboard.glb?url'
import computerMouseUrl from './assets/room/computerMouse.glb?url'
import booksUrl from './assets/room/books.glb?url'
import lampSquareTableUrl from './assets/room/lampSquareTable.glb?url'
import kitchenCoffeeMachineUrl from './assets/room/kitchenCoffeeMachine.glb?url'

const GLB_URLS = Object.freeze({
  'bedSingle.glb': bedSingleUrl,
  'pottedPlant.glb': pottedPlantUrl,
  'rugRounded.glb': rugRoundedUrl,
  'bookcaseClosedWide.glb': bookcaseClosedWideUrl,
  'tableCoffee.glb': tableCoffeeUrl,
  'loungeSofa.glb': loungeSofaUrl,
  'lampRoundFloor.glb': lampRoundFloorUrl,
  'plantSmall1.glb': plantSmall1Url,
  'chair.glb': chairUrl,
  'table.glb': tableUrl,
  'kitchenFridge.glb': kitchenFridgeUrl,
  'kitchenSink.glb': kitchenSinkUrl,
  'kitchenStove.glb': kitchenStoveUrl,
  'kitchenCabinet.glb': kitchenCabinetUrl,
  'doorwayFront.glb': doorwayFrontUrl,
  'rugDoormat.glb': rugDoormatUrl,
  'sideTableDrawers.glb': sideTableDrawersUrl,
  'coatRackStanding.glb': coatRackStandingUrl,
  'bathroomSink.glb': bathroomSinkUrl,
  'toilet.glb': toiletUrl,
  'computerKeyboard.glb': computerKeyboardUrl,
  'computerMouse.glb': computerMouseUrl,
  'books.glb': booksUrl,
  'lampSquareTable.glb': lampSquareTableUrl,
  'kitchenCoffeeMachine.glb': kitchenCoffeeMachineUrl,
})

// ── Toon (cel) shading — 애니 룩 (사용자: 그래픽이 너무 구식, 애니 원함) ──
// 매끈한 그라데이션 대신 3~4단 셀 밴드로 칠해 일러스트/애니 느낌을 낸다.
// PMX 캐릭터는 이미 toon이라 방·가구도 toon으로 통일. 색/맵/투명도/emissive/
// side를 보존(Codex MUST-FIX)하고, ShadowMaterial은 건드리지 않는다.
let _toonGradient = null
function toonGradient() {
  if (_toonGradient) return _toonGradient
  const ramp = new Uint8Array([72, 120, 168, 205]) // 4단 명암(상단 낮춤 — 과노출 방지)
  const tex = new DataTexture(ramp, ramp.length, 1, RedFormat)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.needsUpdate = true
  _toonGradient = tex
  return tex
}

function toonifyMaterial(mat) {
  if (!mat || mat.isMeshToonMaterial) return mat
  if (mat.isShadowMaterial || mat.type === 'ShadowMaterial') return mat
  const toon = new MeshToonMaterial({
    color: mat.color ? mat.color.clone() : new Color(0xffffff),
    map: mat.map || null,
    gradientMap: toonGradient(),
    transparent: !!mat.transparent,
    opacity: mat.opacity ?? 1,
    side: mat.side ?? undefined,
    emissive: mat.emissive ? mat.emissive.clone() : new Color(0x000000),
    emissiveMap: mat.emissiveMap || null,
    emissiveIntensity: mat.emissiveIntensity ?? 1,
    alphaTest: mat.alphaTest || 0,
  })
  // wallpaper-opaque 토글이 읽는 stash 등 userData 유지.
  toon.userData = { ...(mat.userData || {}) }
  return toon
}

function toonifyTree(root) {
  if (!root) return root
  root.traverse((o) => {
    const m = o.material
    if (!m || o.userData?.noToon) return // noToon 메시(수평 바닥 등)는 제외
    o.material = Array.isArray(m) ? m.map(toonifyMaterial) : toonifyMaterial(m)
  })
  return root
}

// ── 절차 텍스처(단조로운 단색 면 탈피) ───────────────────────────────
let _woodTex = null
function woodTexture() {
  if (_woodTex) return _woodTex
  const c = document.createElement('canvas')
  c.width = 256; c.height = 256
  const g = c.getContext('2d')
  const planks = 7, ph = c.height / planks
  for (let i = 0; i < planks; i += 1) {
    const base = 120 + ((i * 17) % 40) + (i % 2 ? -12 : 10)
    g.fillStyle = `rgb(${base + 40},${Math.round(base * 0.66)},${Math.round(base * 0.42)})`
    g.fillRect(0, i * ph, c.width, ph)
    g.strokeStyle = 'rgba(80,50,28,0.16)'; g.lineWidth = 1
    for (let k = 0; k < 3; k += 1) {
      const yy = i * ph + (k + 1) * (ph / 4)
      g.beginPath(); g.moveTo(0, yy)
      g.bezierCurveTo(80, yy + 2, 170, yy - 2, c.width, yy + 1); g.stroke()
    }
    g.fillStyle = 'rgba(45,28,16,0.45)'; g.fillRect(0, i * ph + ph - 2, c.width, 2)
  }
  const tex = new CanvasTexture(c)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  tex.repeat.set(5, 5)
  _woodTex = tex
  return tex
}

let _sunsetTex = null
function sunsetTexture() {
  if (_sunsetTex) return _sunsetTex
  const c = document.createElement('canvas')
  c.width = 128; c.height = 128
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, 128)
  grad.addColorStop(0, '#9ec7e8')   // 하늘 위
  grad.addColorStop(0.5, '#ffd9a0') // 노을
  grad.addColorStop(0.72, '#ff9e6b')
  grad.addColorStop(1, '#caa07a')   // 먼 지평/건물
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128)
  g.fillStyle = 'rgba(255,240,200,0.9)'; g.beginPath(); g.arc(48, 78, 14, 0, Math.PI * 2); g.fill()
  g.fillStyle = 'rgba(120,140,110,0.55)'; g.fillRect(0, 110, 128, 18) // 풍경 실루엣
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  _sunsetTex = tex
  return tex
}

// ── Foreground desk (lo-fi 데스크 POV) ───────────────────────────────
// A fixed desk surface + props sitting just in front of the camera, filling
// the lower foreground so the shot reads as "내 책상에 앉아 방을 바라보는"
// view (ref the user shared). NOT part of FURNITURE_DEFAULT — it's camera
// framing, not room furniture, and never a walk/interaction target.
// Positions are world-space near the camera (z just inside the front edge);
// tuned by screenshot. Props ride on the desk top (y = DESK_TOP).
const DESK_TOP = 1.06
const FG_DESK = Object.freeze({
  surface: { w: 3.9, h: DESK_TOP, d: 1.2, z: 7.7, color: 0x6f4a2f },
  props: [
    { model: 'computerKeyboard.glb', x: -0.1, z: 7.55, size: { w: 0.95, h: 0.06, d: 0.36 }, rotY: 0 },
    { model: 'computerMouse.glb', x: 0.8, z: 7.55, size: { w: 0.12, h: 0.05, d: 0.18 }, rotY: 0 },
    { model: 'books.glb', x: 1.55, z: 7.6, size: { w: 0.46, h: 0.26, d: 0.34 }, rotY: 0.2 },
    { model: 'lampSquareTable.glb', x: -1.6, z: 7.6, size: { w: 0.48, h: 0.6, d: 0.48 }, rotY: 0.3 },
    { model: 'kitchenCoffeeMachine.glb', x: -0.95, z: 7.6, size: { w: 0.32, h: 0.38, d: 0.32 }, rotY: -0.3 },
  ],
})

// Phase B — "fishbowl" framing: the room sits a little further away and the
// camera looks down into it at a soft angle. fov tightened from 34 to 30 so
// the depth cue (room recedes into the back wall) actually reads. CAM_DEFAULT
// is now the room/aquarium frame, not the bare character closeup it used to be.
// Phase G — "one-point perspective" room view (사용자 요청: 1점 투시). The
// camera sits dead-centered on X and looks STRAIGHT down the room's depth
// axis (−Z) with a LEVEL gaze (pos.y === target.y, target.x === 0), so the
// back wall is face-on and the floor/ceiling/side walls all converge to a
// single vanishing point at the center — the diorama / dollhouse box look.
// The character stands centered, facing the camera; the rectangular room
// reads as a real 3D box behind her. A wide-ish FOV makes the convergence
// (= the 3D-ness) read. frameCharacterCamera() only re-applies this, so the
// framing is identical across character swaps. Tuned by screenshot.
const CAM_DEFAULT = Object.freeze({
  // lo-fi 데스크 POV: 카메라(=모니터)가 책상 위에 있고 살짝 내려다보며 방을
  // 1점 투시로 본다. x 중앙, 완만한 하향각이라 전경 책상이 아래에 깔리고
  // 바닥/벽/천장이 중앙 소실점으로 모인다(거의 1점 투시 + 약간의 부감).
  pos: new Vector3(0, 1.62, 8.7),
  target: new Vector3(0, 0.72, 0.8),
  fov: 50
})

// The room framing (camera pos/fov above) was tuned at ~16:9. On displays
// narrower than this the fixed vertical FOV would clip the room/character
// left and right; on wider displays the character stays the same vertical
// size and only the room sides reveal more.
const DESIGN_ASPECT = 16 / 9

// Current viewport aspect, guarded against a zero/negative height (can happen
// mid display-move / minimize) — falls back to the design aspect.
function viewportAspect() {
  const w = window.innerWidth
  const h = window.innerHeight
  if (!(w > 0) || !(h > 0)) return DESIGN_ASPECT
  return w / h
}

// Vertical FOV that keeps the 16:9 horizontal frame from being cropped.
// Asymmetric clamp (Codex-approved): widen vertical FOV only when narrower
// than design so nothing is cut off horizontally; keep the base FOV on wider
// screens so the character's vertical size stays constant (no head/feet crop
// that two-way horizontal-FOV preservation would cause on ultrawide).
function adaptiveFov(baseDeg, aspect) {
  if (aspect >= DESIGN_ASPECT) return baseDeg
  const baseHalf = (baseDeg * Math.PI) / 360
  const adjusted = 2 * Math.atan(Math.tan(baseHalf) * (DESIGN_ASPECT / aspect))
  return (adjusted * 180) / Math.PI
}

// Room geometry. Z convention (Codex MUST-FIX round 2):
//   - Camera lives at z=+7.6, looks toward -z into the room.
//   - z=0 is the "back wall" (the deepest wall the user sees).
//   - z=ROOM.depth is the "open" face — the metaphorical aquarium glass /
//     the user's monitor. No mesh there.
//   - BOUNDS.minZ keeps the character at z≥0.7 (off the back wall);
//     BOUNDS.maxZ keeps them at z≤5.5 (off the front glass).
// The ceiling covers the back half only so the camera's forward view isn't
// clipped from above. Codex NICE-TO-HAVE round 1.
// Phase D — warm cafe palette. Earlier neutral cream
// (0xeae3d8/0xd8cdb8/0xf2ecdf) read as "concrete box" under the bare
// AmbientLight; bumping wall warmth + adding amber wood floor + a slightly
// warmer ceiling gets the right "afternoon sunlight in a school cafe" vibe
// before any texture work.
//
// Phase E — Apia is an *overlay* on the desktop. The opaque walls/floor/
// ceiling from Phase D were blanking out the desktop the user actually
// wants to see behind the character. Each surface keeps its color but goes
// transparent at a tuned opacity so the desktop reads through:
//   - walls + ceiling: low opacity (just a wash of room tint)
//   - floor: low opacity (a hint of the wood, not a slab)
//   - shadow catcher stays as-is (it's already alpha-driven)
// Furniture meshes deliberately stay opaque — the character + furniture are
// the "in front of the glass" subject; the room is the "behind the glass"
// implication.
export const ROOM = Object.freeze({
  width: 5.8,  // x extent (-2.9 .. +2.9) — Phase G: NARROW galley studio per
               // the reference (좁고 깊은 원룸). Narrow walls → strong one-point.
  depth: 8.0,  // z extent (0 .. +8) — deep so the perspective recedes.
  height: 2.9, // y extent

  wallColor: 0xf0d9b8,   // 따뜻한 크림(약간 진하게 — 희멀건 방지)
  floorColor: 0x7e5436,  // 진한 우드
  ceilColor: 0xf3e4cb,   // 따뜻한 크림 천장
  // Phase G — 솔리드 방(불투명). 블룸 합성기가 alpha를 보존 안 해 반투명이
  // 검게 떴고, 사용자 방향이 "방을 비춰 보는" 뷰라 면을 모두 불투명으로.
  // (데스크톱 오버레이 투과는 별도 모드로 분리 가능.)
  wallOpacity: 1.0,
  floorOpacity: 1.0,
  ceilOpacity: 1.0,
  rugOpacity: 1.0
})

// Window cutout on the back wall — gives the "afternoon light" implication
// without making the back wall actually transparent. Sits just inside the
// back wall (z=0.02) so its emissive face is visible from the camera side.
const WINDOW = Object.freeze({
  width: 2.4,
  height: 1.6,
  y: 1.7,
  z: 0.02,
  paneColor: 0xb3e3ff,
  emissive: 0xfff0c8,
  emissiveIntensity: 0.55,
  frameColor: 0x9f8056
})

/**
 * Build the static scene + camera + renderer. Returns an object the caller
 * keeps as a long-lived handle for the lifetime of the renderer process.
 *
 * `canvasEl` is the DOM canvas to bind the WebGLRenderer to (typically
 * `document.getElementById('vrm-canvas')` — taken as an argument so the
 * factory has no implicit DOM coupling).
 */
export function createSceneRuntime({ canvasEl }) {
  if (!canvasEl) {
    throw new Error('createSceneRuntime: canvasEl is required')
  }

  const renderer = new WebGLRenderer({
    canvas: canvasEl,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false
  })
  // Capped here too (not just in applyViewport) so a high-DPR display gets
  // the cap from the very first frame, before any resize/DPR-change fires.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  // Phase G — 필름 톤매핑으로 색을 부드럽고 따뜻하게(단조로움 완화).
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.82

  // 애니 잉크 외곽선(MMD 캐릭터가 쓰는 OutlineEffect) — toon 처리된 방·가구에도
  // 외곽선을 그려 일러스트/애니로 읽히게. renderer 래핑 → main.js는 outlineRender.
  const outlineEffect = new OutlineEffect(renderer, {
    defaultThickness: 0.006,
    defaultColor: [0.14, 0.1, 0.09],
    defaultAlpha: 0.9,
    defaultKeepAlpha: true,
  })

  const scene = new Scene()
  // 아늑한 웜톤 기본 배경(솔리드 방 뷰).
  scene.background = new Color(0x352a20)

  // Mutable copy of the default camera framing — `frameCharacterCamera` in
  // main.js writes into `pos`/`target` after a character loads. The frozen
  // CAM_DEFAULT above is the *source*; this is the live state. We hand out
  // `live` so callers (main.js) can keep mutating it the way they do today,
  // and `applyCameraDefault()` reads from `live`.
  const live = {
    pos: CAM_DEFAULT.pos.clone(),
    target: CAM_DEFAULT.target.clone(),
    fov: CAM_DEFAULT.fov
  }

  const camera = new PerspectiveCamera(
    live.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  )

  function applyCameraDefault() {
    const aspect = viewportAspect()
    camera.position.copy(live.pos)
    camera.lookAt(live.target)
    camera.aspect = aspect
    // live.fov stays the *base* (debug slider / reset write it); only the
    // applied camera.fov is the aspect-adapted value.
    camera.fov = adaptiveFov(live.fov, aspect)
    camera.updateProjectionMatrix()
  }

  // Re-fit renderer + camera to the current viewport. The single place that
  // reacts to a window resize OR a display move (different size *or* DPI).
  function applyViewport() {
    const aspect = viewportAspect()
    // Cap DPR at 2 — a 3x/4x monitor would otherwise blow up the transparent
    // overlay's WebGL buffer for no visible gain.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    outlineEffect.setSize(window.innerWidth, window.innerHeight)
    camera.aspect = aspect
    camera.fov = adaptiveFov(live.fov, aspect)
    camera.updateProjectionMatrix()
  }

  applyCameraDefault()

  window.addEventListener('resize', applyViewport)

  // A monitor move that changes DPI but not the CSS pixel size won't fire
  // 'resize', so watch the resolution media query directly. matchMedia keys
  // on the *current* dpr, so the watcher must re-arm itself on every change
  // (and drop the previous listener first — no leak / double-fire).
  let resolutionMql = null
  function onResolutionChange() {
    applyViewport()
    armResolutionWatcher()
  }
  function armResolutionWatcher() {
    if (resolutionMql) {
      if (resolutionMql.removeEventListener) resolutionMql.removeEventListener('change', onResolutionChange)
      else if (resolutionMql.removeListener) resolutionMql.removeListener(onResolutionChange)
    }
    const dpr = window.devicePixelRatio || 1
    resolutionMql = window.matchMedia(`(resolution: ${dpr}dppx)`)
    if (resolutionMql.addEventListener) resolutionMql.addEventListener('change', onResolutionChange)
    else if (resolutionMql.addListener) resolutionMql.addListener(onResolutionChange)
  }
  function disposeResolutionWatcher() {
    if (!resolutionMql) return
    if (resolutionMql.removeEventListener) resolutionMql.removeEventListener('change', onResolutionChange)
    else if (resolutionMql.removeListener) resolutionMql.removeListener(onResolutionChange)
    resolutionMql = null
  }
  armResolutionWatcher()

  const clock = new Clock()

  // Phase D — warm afternoon lighting. Ambient gets a slight amber tint so
  // unlit faces read as paper/wood rather than gray. The "sun" comes from
  // the back-wall window side; its target is explicitly added to the scene
  // (Codex MUST-FIX round 1: a DirectionalLight without a registered target
  // shines toward (0,0,0) — which here is the back-wall corner, not the
  // room interior).
  // Phase G — 따뜻하고 부드러운 lo-fi 저녁 조명. toon 밴드가 또렷이 읽히도록
  // 부드러운 웜 키라이트 + 따뜻한 앰비언트. 거센 햇빛 느낌을 줄인다.
  scene.add(new AmbientLight(0xffe0c0, 0.5))

  const dir = new DirectionalLight(0xffdca0, 0.7)
  dir.position.set(-3, 4, 0.6)        // upper-left, near the back-wall window
  dir.target.position.set(0, 1.0, 3.0) // shine into the room center
  scene.add(dir.target)
  dir.castShadow = true
  dir.shadow.mapSize.set(1024, 1024)
  scene.add(dir)

  // Shadow-catching floor (kept) — under the visible room floor so the old
  // shadow contract still works regardless of the room's material.
  const shadowFloor = new Mesh(
    new PlaneGeometry(20, 20),
    new ShadowMaterial({ opacity: 0.2 })
  )
  shadowFloor.rotation.x = -Math.PI / 2
  shadowFloor.position.y = 0.001
  shadowFloor.receiveShadow = true
  // Phase G — shadowFloor 제거: ShadowMaterial이 OutlineEffect 렌더에서 흰색
  // 으로 떠 바닥을 통째로 하얗게 덮는 버그의 원인이었다. 솔리드 방으로 바뀐
  // 지금은 바닥 자체가 receiveShadow로 그림자를 받으므로 이 보조 캐처는 불필요.
  void shadowFloor // (남겨두되 씬에 추가하지 않음)

  // Soft pink rim from above-right, and a warm fill from front-low. Together
  // with the amber sun above these knock out the cold-gray look without
  // washing detail out.
  const rim = new DirectionalLight(0xffb4a0, 0.18)
  rim.position.set(3, 3, 1)
  scene.add(rim)

  const fill = new DirectionalLight(0xfff0e0, 0.1)
  fill.position.set(0, 0.5, 7)  // from the camera side, very low intensity
  scene.add(fill)

  // Phase G — warm desk-lamp glow on the foreground desk (lo-fi 저녁 감성).
  const deskGlow = new PointLight(0xffd9a0, 0.5, 6, 2)
  deskGlow.position.set(-1.5, 1.6, 7.4) // 책상 스탠드 자리쯤
  scene.add(deskGlow)

  // ── Phase B — Build the room ───────────────────────────────────────────
  // The character lives inside this box; the open (camera-facing) wall is
  // the metaphorical aquarium glass. Walls are MeshStandardMaterial so
  // ambient/directional/rim lights all read on them; doubleside on the
  // back so a future "peek through" camera angle stays sane.
  const room = toonifyTree(buildRoom(scene))

  // Wallpaper-opaque state must be tracked so a GLB furniture piece that
  // finishes loading AFTER the user already toggled wallpaper mode still gets
  // solidified (Codex MUST-FIX: async loads must not leave see-through props
  // in an otherwise opaque wallpaper scene). The flag + the extracted
  // applyOpaqueToMaterials() helper are the shared state both setWallpaperOpaque
  // and the per-piece load callback read.
  let wallpaperOpaque = false
  function applyOpaqueToMaterials(root, on) {
    if (!root) return
    root.traverse((o) => {
      const m = o.material
      if (!m) return
      for (const mat of (Array.isArray(m) ? m : [m])) {
        if (mat.isShadowMaterial || mat.type === 'ShadowMaterial') continue
        if (mat.userData.__origOpacity === undefined) {
          mat.userData.__origOpacity = mat.opacity
          mat.userData.__origTransparent = mat.transparent
        }
        if (on) { mat.opacity = 1; mat.transparent = false } else {
          mat.opacity = mat.userData.__origOpacity
          mat.transparent = mat.userData.__origTransparent
        }
        mat.needsUpdate = true
      }
    })
  }

  // Phase D/F — furniture group lives outside the room group so character
  // import doesn't accidentally pull furniture as a child (Codex NICE-TO-HAVE
  // round 1). Each piece keeps the same coordinates the world.js interactive
  // objects use, so clicking "책상" walks the character to where the visual
  // desk actually stands. Phase F: pieces are CC0 GLB models, loaded async +
  // auto-fit; box primitives remain as a per-piece fallback.
  const onPieceLoaded = (obj) => { if (wallpaperOpaque) applyOpaqueToMaterials(obj, true) }
  const { root: furniture, ready: furnitureReady } = buildFurniture(scene, { onPieceLoaded })
  // Foreground desk (the lo-fi 데스크 POV framing). Its ready promise is
  // folded into furnitureReady so screenshot checks wait for it too.
  const fgDeskReady = buildForegroundDesk(scene, { onPieceLoaded })
  const allReady = Promise.allSettled([furnitureReady, fgDeskReady])
  // Constrain the directional light's shadow camera to the room footprint
  // so shadow texels stay tight where the character actually walks.
  dir.shadow.camera.left = -ROOM.width / 2
  dir.shadow.camera.right = ROOM.width / 2
  dir.shadow.camera.top = ROOM.depth
  dir.shadow.camera.bottom = -ROOM.depth
  dir.shadow.camera.near = 0.5
  dir.shadow.camera.far = 12
  dir.shadow.camera.updateProjectionMatrix()

  // Wallpaper mode wants an OPAQUE, screen-filling scene (like Wallpaper
  // Engine) — a solid backdrop + solid room so it reads as a real desktop
  // background, not a faint see-through overlay (which is invisible against a
  // busy/dark desktop). Overlay mode keeps the transparent look so the
  // character floats over the live desktop. Reversible: original material
  // opacity/transparent are stashed once and restored on toggle-off.
  const OPAQUE_BACKDROP = 0xe9dcc4 // warm room tone behind the back wall
  function setWallpaperOpaque(on) {
    wallpaperOpaque = on // 이후 로드되는 GLB 소품도 이 상태를 따른다
    if (on) {
      scene.background = new Color(OPAQUE_BACKDROP)
      renderer.setClearColor(OPAQUE_BACKDROP, 1)
    } else {
      scene.background = null
      renderer.setClearColor(0x000000, 0)
    }
    applyOpaqueToMaterials(room, on)
    applyOpaqueToMaterials(furniture, on)
  }

  return {
    scene,
    camera,
    renderer,
    // 애니 외곽선 렌더. main.js 렌더 루프는 renderer.render 대신 이걸.
    outlineRender: (sc, cam) => outlineEffect.render(sc, cam),
    clock,
    CAM_DEFAULT: live, // caller can mutate pos/target/fov on this; applyCameraDefault uses it
    applyCameraDefault,
    applyViewport, // re-fit renderer+camera to current viewport (size/aspect/DPI)
    disposeResolutionWatcher,
    setWallpaperOpaque,
    ROOM,
    room,
    furniture,
    // Resolves once every furniture piece + foreground desk prop has loaded
    // (or fallen back). E2E screenshot checks await this so they don't catch
    // the room mid pop-in (Codex NICE-TO-HAVE).
    furnitureReady: allReady
  }
}

function buildRoom(scene) {
  const halfW = ROOM.width / 2
  const root = new Group()
  root.name = 'apia-room'

  // Colored floor inside the shadow plane. Slightly inset so the shadow
  // catcher above (y=0.001) renders shadows on top. Phase E: low-opacity
  // so the actual desktop is visible underneath the wood tint.
  const floor = new Mesh(
    new PlaneGeometry(ROOM.width, ROOM.depth),
    new MeshStandardMaterial({
      color: ROOM.floorColor,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: ROOM.floorOpacity
    })
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, ROOM.depth / 2)
  floor.receiveShadow = true
  floor.userData.noToon = true // toon이 수평 바닥에서 흰색으로 깨져 일반 셰이딩 유지
  root.add(floor)

  const wallMat = new MeshStandardMaterial({
    color: ROOM.wallColor,
    roughness: 0.9,
    metalness: 0,
    side: BackSide, // visible from inside the room only
    transparent: true,
    opacity: ROOM.wallOpacity
  })

  // Back wall sits at z=0 — the deepest wall, farthest from the camera. A
  // plane's default normal is +z, so leaving rotation at zero already faces
  // the camera (which sits at +z); we keep BackSide material so other walls
  // share one shader.
  const back = new Mesh(new PlaneGeometry(ROOM.width, ROOM.height), wallMat)
  back.position.set(0, ROOM.height / 2, 0)
  back.rotation.y = Math.PI  // flip so its inside face is the visible one
  back.receiveShadow = true
  root.add(back)

  // Phase D — window on the back wall. Codex MUST-FIX round 1: emissive
  // requires MeshStandardMaterial (Basic has no emissive slot). The pane
  // sits a hair inside the room (z slightly positive) so it's visible
  // through the open camera-side face.
  const paneMat = new MeshStandardMaterial({
    color: WINDOW.paneColor,
    map: sunsetTexture(),         // 창밖 노을 풍경
    emissive: 0xffffff,
    emissiveMap: sunsetTexture(), // 스스로 빛나 bloom 글로우 → 따뜻한 초점
    emissiveIntensity: 1.15,
    roughness: 0.4,
    metalness: 0
  })
  const pane = new Mesh(new PlaneGeometry(WINDOW.width, WINDOW.height), paneMat)
  pane.position.set(0, WINDOW.y, WINDOW.z)
  root.add(pane)

  // Simple wooden frame around the pane (4 thin boxes). Reads as a window
  // sash without taxing the user with a texture.
  const frameMat = new MeshStandardMaterial({
    color: WINDOW.frameColor,
    roughness: 0.7,
    metalness: 0
  })
  const frameThickness = 0.08
  const frameDepth = 0.04
  const hFrame = new BoxGeometry(WINDOW.width + frameThickness * 2, frameThickness, frameDepth)
  const vFrame = new BoxGeometry(frameThickness, WINDOW.height, frameDepth)
  const topF = new Mesh(hFrame, frameMat)
  topF.position.set(0, WINDOW.y + WINDOW.height / 2 + frameThickness / 2, WINDOW.z)
  root.add(topF)
  const bottomF = new Mesh(hFrame, frameMat)
  bottomF.position.set(0, WINDOW.y - WINDOW.height / 2 - frameThickness / 2, WINDOW.z)
  root.add(bottomF)
  const leftF = new Mesh(vFrame, frameMat)
  leftF.position.set(-WINDOW.width / 2 - frameThickness / 2, WINDOW.y, WINDOW.z)
  root.add(leftF)
  const rightF = new Mesh(vFrame, frameMat)
  rightF.position.set(WINDOW.width / 2 + frameThickness / 2, WINDOW.y, WINDOW.z)
  root.add(rightF)

  // Left and right walls. Codex MUST-FIX round 3: side wall rotations are
  // mirrored so the BackSide-culled face ends up pointing outward (the
  // visible inside face stays toward the room interior). Left wall sits at
  // x=-halfW with normal -x (rotation.y = -π/2) so its BackSide is +x
  // (room interior). Right wall is the mirror.
  const left = new Mesh(new PlaneGeometry(ROOM.depth, ROOM.height), wallMat)
  left.position.set(-halfW, ROOM.height / 2, ROOM.depth / 2)
  left.rotation.y = -Math.PI / 2
  left.receiveShadow = true
  root.add(left)

  const right = new Mesh(new PlaneGeometry(ROOM.depth, ROOM.height), wallMat)
  right.position.set(halfW, ROOM.height / 2, ROOM.depth / 2)
  right.rotation.y = Math.PI / 2
  right.receiveShadow = true
  root.add(right)

  // Ceiling — only the back half (z=0..depth/2) so the high-mounted camera
  // looking in from z=+7.6 doesn't have its forward view clipped by the lid.
  // Codex MUST-FIX round 2: the ceiling belonged on the back half, not the
  // front (it used to sit near the camera).
  const ceilMat = new MeshStandardMaterial({
    color: ROOM.ceilColor,
    roughness: 0.95,
    metalness: 0,
    side: DoubleSide,
    transparent: true,
    opacity: ROOM.ceilOpacity
  })
  const ceilingDepth = ROOM.depth / 2
  const ceiling = new Mesh(new PlaneGeometry(ROOM.width, ceilingDepth), ceilMat)
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(0, ROOM.height, ceilingDepth / 2)
  root.add(ceiling)

  scene.add(root)
  return root
}

/**
 * Phase F — load the CC0 Kenney Furniture Kit GLBs and auto-fit each into the
 * footprint/height declared in FURNITURE_DEFAULT (so placement is independent
 * of the kit's native unit). Box primitives from Phase D remain as a per-piece
 * FALLBACK when a GLB is missing or fails to load (Codex MUST-FIX: an async
 * load error must never leave the slot empty forever).
 *
 * Returns `{ root, ready }`:
 *   - root  : the group, added to the scene immediately (pieces pop in async)
 *   - ready : Promise that settles once every piece loaded or fell back
 *
 * @param {THREE.Scene} scene
 * @param {{ onPieceLoaded?: (obj: THREE.Object3D) => void }} [opts]
 */
function buildFurniture(scene, { onPieceLoaded } = {}) {
  const root = new Group()
  root.name = 'apia-furniture'
  scene.add(root)

  const loader = new GLTFLoader()
  const settle = (obj) => {
    if (!obj) return
    root.add(obj)
    onPieceLoaded?.(obj)
  }
  const fallbackBox = (f) => {
    const box = buildFurniturePiece(f)
    if (box) { box.name = `furniture-fallback-${f.id}`; settle(box) }
  }

  const promises = []
  for (const f of FURNITURE_DEFAULT) {
    const url = f.model ? GLB_URLS[f.model] : null
    if (!url) { fallbackBox(f); continue } // no model declared → keep the box
    promises.push(
      loadGLBPiece(loader, url, f)
        .then((obj) => settle(obj))
        .catch((err) => {
          console.warn(`[scene] furniture GLB failed (${f.id}), using box fallback:`, err?.message || err)
          fallbackBox(f)
        })
    )
  }

  const ready = Promise.allSettled(promises)
  return { root, ready }
}

/**
 * Phase G — the fixed foreground desk (lo-fi 데스크 POV). A wood slab just in
 * front of the camera + a few props (keyboard/mouse/books/lamp/coffee) riding
 * on top, so the shot reads as "내 책상에 앉아 방을 바라보는" view. Not a room
 * furniture / walk target. Returns a promise that settles when props load.
 */
function buildForegroundDesk(scene, { onPieceLoaded } = {}) {
  const root = new Group()
  root.name = 'apia-fg-desk'
  scene.add(root)

  // Desk slab (top surface the camera looks down onto). A thick box reads as a
  // solid desk edge from the camera side without needing legs in frame.
  const s = FG_DESK.surface
  const slab = new Mesh(
    new BoxGeometry(s.w, 0.16, s.d),
    toonifyMaterial(new MeshStandardMaterial({ color: s.color }))
  )
  slab.position.set(0, s.h - 0.08, s.z)
  slab.receiveShadow = true
  slab.castShadow = true
  root.add(slab)

  const loader = new GLTFLoader()
  const promises = []
  for (const p of FG_DESK.props) {
    const url = GLB_URLS[p.model]
    if (!url) continue
    const f = {
      id: `fgprop_${p.model.replace('.glb', '')}`,
      model: p.model,
      position: { x: p.x, y: s.h, z: p.z },
      size: p.size,
      fitMode: 'height',
      modelRotY: p.rotY || 0,
    }
    promises.push(
      loadGLBPiece(loader, url, f)
        .then((obj) => { if (obj) { root.add(obj); onPieceLoaded?.(obj) } })
        .catch((err) => console.warn(`[scene] fg-desk prop failed (${p.model}):`, err?.message || err))
    )
  }
  return Promise.allSettled(promises)
}

/**
 * Load one GLB and auto-fit it to `f`'s target box. fitMode:
 *   - 'height'    : uniform scale = f.size.h / bbox.height (real-world height)
 *   - 'footprint' : uniform scale = min(f.size.w/bbox.x, f.size.d/bbox.z) —
 *                   used for the rug (size.h=0 would vanish under height-fit)
 *                   and wide items whose footprint shouldn't overflow.
 * The model is centered on (x,z) and seated with its base at f.position.y,
 * then rotated by f.modelRotY around its own vertical axis.
 */
function loadGLBPiece(loader, url, f) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        try {
          const model = gltf.scene
          model.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = f.id !== 'rug'
              o.receiveShadow = true
            }
          })
          toonifyTree(model) // 애니 셀 셰이딩으로 통일

          // pivot holds the centered+seated model; rotating/translating the
          // pivot keeps modelRotY a clean spin about the piece's own center.
          const pivot = new Group()
          pivot.name = `furniture-${f.id}`
          pivot.add(model)

          // 1) scale
          const box0 = new Box3().setFromObject(model)
          const size0 = box0.getSize(new Vector3())
          let s = 1
          if ((f.fitMode || 'height') === 'footprint') {
            const sw = size0.x > 1e-6 ? f.size.w / size0.x : 1
            const sd = size0.z > 1e-6 ? f.size.d / size0.z : 1
            s = Math.min(sw, sd)
          } else {
            s = size0.y > 1e-6 ? f.size.h / size0.y : 1
            // Footprint clamp (Codex MUST-FIX): height-fit follows native
            // proportions, so a wide wall piece (sink/cabinet/door) can poke
            // through the wall. Cap the uniform scale so the footprint never
            // exceeds the declared size.w×size.d — set those to the available
            // wall space and the piece stays inset. modelRotY swaps which
            // native axis maps to width vs depth, so test both orderings.
            const rot = Number.isFinite(f.modelRotY) ? f.modelRotY : 0
            const swapped = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1
            const footW = swapped ? size0.z : size0.x
            const footD = swapped ? size0.x : size0.z
            if (footW * s > f.size.w && footW > 1e-6) s = Math.min(s, f.size.w / footW)
            if (footD * s > f.size.d && footD > 1e-6) s = Math.min(s, f.size.d / footD)
          }
          s *= Number.isFinite(f.scaleMul) ? f.scaleMul : 1
          model.scale.setScalar(s)

          // 2) center on x,z and seat base at y=0 within the pivot
          const box1 = new Box3().setFromObject(model)
          const center1 = box1.getCenter(new Vector3())
          model.position.x -= center1.x
          model.position.z -= center1.z
          model.position.y -= box1.min.y

          // 3) place + face. yOffset lifts wall-mounted/surface props (e.g. a
          // plant sitting on a cabinet) above the floor seat.
          pivot.rotation.y = Number.isFinite(f.modelRotY) ? f.modelRotY : 0
          pivot.position.set(
            f.position.x,
            f.position.y + (Number.isFinite(f.yOffset) ? f.yOffset : 0),
            f.position.z,
          )
          resolve(pivot)
        } catch (err) {
          reject(err)
        }
      },
      undefined,
      (err) => reject(err)
    )
  })
}

function buildFurniturePiece(f) {
  if (f.id === 'desk') return buildDesk(f)
  if (f.id === 'bed') return buildBed(f)
  if (f.id === 'chair_window') return buildChair(f)
  if (f.id === 'plant') return buildPlant(f)
  if (f.id === 'rug' || f.id === 'doormat') return buildRug(f)
  // Generic box fallback for any other piece (Codex MUST-FIX): a failed GLB
  // load must never leave an empty slot. A colored box sized to f.size at the
  // piece's footprint is better than nothing.
  return buildGenericBox(f)
}

function buildGenericBox(f) {
  if (!f.size || !(f.size.h > 0)) return null // flat (rug-like) handled above
  const g = new Group()
  const box = new Mesh(
    new BoxGeometry(f.size.w || 0.5, f.size.h, f.size.d || 0.5),
    toonifyMaterial(softMat(f.color ?? 0xb5a48d))
  )
  box.position.set(f.position.x, (f.position.y || 0) + f.size.h / 2, f.position.z)
  box.castShadow = true
  box.receiveShadow = true
  g.add(box)
  return g
}

function woodMat(color) {
  return new MeshStandardMaterial({ color, roughness: 0.78, metalness: 0 })
}

function softMat(color) {
  return new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 })
}

function buildDesk(f) {
  const g = new Group()
  const top = new Mesh(new BoxGeometry(f.size.w, 0.05, f.size.d), woodMat(f.color))
  top.position.set(f.position.x, f.size.h, f.position.z)
  top.castShadow = true
  top.receiveShadow = true
  g.add(top)
  // four legs
  const legGeom = new BoxGeometry(0.06, f.size.h, 0.06)
  const legMat = woodMat(0x6f4f30)
  const half = (size) => size / 2 - 0.06
  for (const dx of [-half(f.size.w), half(f.size.w)]) {
    for (const dz of [-half(f.size.d), half(f.size.d)]) {
      const leg = new Mesh(legGeom, legMat)
      leg.position.set(f.position.x + dx, f.size.h / 2, f.position.z + dz)
      leg.castShadow = true
      g.add(leg)
    }
  }
  // book stack + laptop hint on the desk
  const book = new Mesh(new BoxGeometry(0.4, 0.06, 0.28), softMat(0xc97171))
  book.position.set(f.position.x - 0.3, f.size.h + 0.06, f.position.z)
  book.castShadow = true
  g.add(book)
  const book2 = new Mesh(new BoxGeometry(0.36, 0.05, 0.24), softMat(0xf3d484))
  book2.position.set(f.position.x - 0.32, f.size.h + 0.12, f.position.z + 0.02)
  book2.castShadow = true
  g.add(book2)
  const laptop = new Mesh(new BoxGeometry(0.5, 0.03, 0.35), softMat(0xe9eaec))
  laptop.position.set(f.position.x + 0.35, f.size.h + 0.04, f.position.z)
  laptop.castShadow = true
  g.add(laptop)
  return g
}

function buildBed(f) {
  const g = new Group()
  const mattress = new Mesh(new BoxGeometry(f.size.w, f.size.h, f.size.d), softMat(f.color))
  mattress.position.set(f.position.x, f.size.h / 2, f.position.z)
  mattress.castShadow = true
  mattress.receiveShadow = true
  g.add(mattress)
  // pillow at the back of the bed (toward the back wall)
  const pillow = new Mesh(new BoxGeometry(f.size.w * 0.7, 0.12, 0.4), softMat(f.pillowColor))
  pillow.position.set(f.position.x, f.size.h + 0.06, f.position.z - f.size.d / 2 + 0.25)
  pillow.castShadow = true
  g.add(pillow)
  return g
}

function buildChair(f) {
  const g = new Group()
  const seat = new Mesh(
    new BoxGeometry(f.size.w, 0.08, f.size.d),
    woodMat(f.color)
  )
  seat.position.set(f.position.x, f.seatHeight, f.position.z)
  seat.castShadow = true
  seat.receiveShadow = true
  g.add(seat)
  // back rest
  const back = new Mesh(
    new BoxGeometry(f.size.w, f.size.h - f.seatHeight, 0.08),
    woodMat(f.color)
  )
  back.position.set(
    f.position.x,
    (f.size.h + f.seatHeight) / 2,
    f.position.z - f.size.d / 2 + 0.04
  )
  back.castShadow = true
  g.add(back)
  // 4 legs
  const legMat = woodMat(0x5c4631)
  const legGeom = new BoxGeometry(0.05, f.seatHeight, 0.05)
  const lh = (s) => s / 2 - 0.05
  for (const dx of [-lh(f.size.w), lh(f.size.w)]) {
    for (const dz of [-lh(f.size.d), lh(f.size.d)]) {
      const leg = new Mesh(legGeom, legMat)
      leg.position.set(f.position.x + dx, f.seatHeight / 2, f.position.z + dz)
      leg.castShadow = true
      g.add(leg)
    }
  }
  return g
}

function buildPlant(f) {
  const g = new Group()
  const pot = new Mesh(
    new BoxGeometry(f.size.w, f.size.h * 0.4, f.size.d),
    softMat(f.color)
  )
  pot.position.set(f.position.x, f.size.h * 0.2, f.position.z)
  pot.castShadow = true
  pot.receiveShadow = true
  g.add(pot)
  // foliage as a soft round-ish stack of two spheres
  const foliage1 = new Mesh(
    new SphereGeometry(f.size.w * 0.55, 12, 10),
    softMat(f.foliageColor)
  )
  foliage1.position.set(f.position.x, f.size.h * 0.7, f.position.z)
  foliage1.castShadow = true
  g.add(foliage1)
  const foliage2 = new Mesh(
    new SphereGeometry(f.size.w * 0.45, 12, 10),
    softMat(f.foliageColor)
  )
  foliage2.position.set(f.position.x + 0.05, f.size.h * 0.9, f.position.z - 0.05)
  foliage2.castShadow = true
  g.add(foliage2)
  return g
}

function buildRug(f) {
  // Codex NICE-TO-HAVE round 1: shadowFloor sits at y=0.001. Rug at y=0.01
  // so it never z-fights, and casts no shadow itself (it IS the shadow
  // receiver visually).
  // Phase E: the rug is the largest "room" surface inside the camera's
  // direct line of sight, so transparency here matters a lot for keeping
  // the desktop visible. Slightly higher opacity than the walls because
  // the rug pattern wants to read as a softening pad under the character.
  const rug = new Mesh(
    new PlaneGeometry(f.size.w, f.size.d),
    new MeshStandardMaterial({
      color: f.color,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: ROOM.rugOpacity
    })
  )
  rug.rotation.x = -Math.PI / 2
  rug.position.set(f.position.x, f.position.y, f.position.z)
  rug.receiveShadow = true
  return rug
}
