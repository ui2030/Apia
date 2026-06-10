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
  BoxGeometry,
  Clock,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer
} from 'three'

import { FURNITURE_DEFAULT } from './furnitureLayout.js'

// Phase B — "fishbowl" framing: the room sits a little further away and the
// camera looks down into it at a soft angle. fov tightened from 34 to 30 so
// the depth cue (room recedes into the back wall) actually reads. CAM_DEFAULT
// is now the room/aquarium frame, not the bare character closeup it used to be.
const CAM_DEFAULT = Object.freeze({
  pos: new Vector3(0, 1.6, 7.6),
  target: new Vector3(0, 0.95, 2.8),
  fov: 30
})

// Room geometry. Z convention (Codex MUST-FIX round 2):
//   - Camera lives at z=+7.6, looks toward -z into the room.
//   - z=0 is the "back wall" (the deepest wall the user sees).
//   - z=ROOM.depth is the "open" face — the metaphorical aquarium glass /
//     the user's monitor. No mesh there.
//   - BOUNDS.minZ keeps the character at z≥0.7 (off the back wall);
//     BOUNDS.maxZ keeps them at z≤5.5 (off the front glass).
// The ceiling covers the back half only so the camera's forward view isn't
// clipped from above. Codex NICE-TO-HAVE round 1.
// Phase D — Blue Archive style warm cafe palette. Earlier neutral cream
// (0xeae3d8/0xd8cdb8/0xf2ecdf) read as "concrete box" under the bare
// AmbientLight; bumping wall warmth + adding amber wood floor + a slightly
// warmer ceiling gets the right "afternoon sunlight in a school cafe" vibe
// before any texture work.
export const ROOM = Object.freeze({
  width: 8,    // x extent (-4 .. +4)
  depth: 6,    // z extent (0 .. +6)
  height: 3,   // y extent (0 .. +3)
  wallColor: 0xfff5e1,   // warm pastel cream (was 0xeae3d8)
  floorColor: 0xc9956a,  // walnut / honey wood (was 0xd8cdb8)
  ceilColor: 0xfff8ea    // brighter cream so the room doesn't feel low
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
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap

  const scene = new Scene()

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
    camera.position.copy(live.pos)
    camera.lookAt(live.target)
    camera.fov = live.fov
    camera.updateProjectionMatrix()
  }

  applyCameraDefault()

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight)
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  })

  const clock = new Clock()

  // Phase D — warm afternoon lighting. Ambient gets a slight amber tint so
  // unlit faces read as paper/wood rather than gray. The "sun" comes from
  // the back-wall window side; its target is explicitly added to the scene
  // (Codex MUST-FIX round 1: a DirectionalLight without a registered target
  // shines toward (0,0,0) — which here is the back-wall corner, not the
  // room interior).
  scene.add(new AmbientLight(0xfff3d8, 0.7))

  const dir = new DirectionalLight(0xffe9a8, 1.2)
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
  shadowFloor.position.y = 0.001 // sits just above the colored floor so
                                  // the shadow renders on top, not under it
  shadowFloor.receiveShadow = true
  scene.add(shadowFloor)

  // Soft pink rim from above-right, and a warm fill from front-low. Together
  // with the amber sun above these knock out the cold-gray look without
  // washing detail out.
  const rim = new DirectionalLight(0xff9ec4, 0.35)
  rim.position.set(3, 3, 1)
  scene.add(rim)

  const fill = new DirectionalLight(0xfff0e0, 0.3)
  fill.position.set(0, 0.5, 7)  // from the camera side, very low intensity
  scene.add(fill)

  // ── Phase B — Build the room ───────────────────────────────────────────
  // The character lives inside this box; the open (camera-facing) wall is
  // the metaphorical aquarium glass. Walls are MeshStandardMaterial so
  // ambient/directional/rim lights all read on them; doubleside on the
  // back so a future "peek through" camera angle stays sane.
  const room = buildRoom(scene)
  // Phase D — furniture group lives outside the room group so character
  // import doesn't accidentally pull furniture as a child (Codex NICE-TO-HAVE
  // round 1). Each piece keeps the same coordinates the world.js interactive
  // objects use, so clicking "책상" walks the character to where the visual
  // desk actually stands.
  const furniture = buildFurniture(scene)
  // Constrain the directional light's shadow camera to the room footprint
  // so shadow texels stay tight where the character actually walks.
  dir.shadow.camera.left = -ROOM.width / 2
  dir.shadow.camera.right = ROOM.width / 2
  dir.shadow.camera.top = ROOM.depth
  dir.shadow.camera.bottom = -ROOM.depth
  dir.shadow.camera.near = 0.5
  dir.shadow.camera.far = 12
  dir.shadow.camera.updateProjectionMatrix()

  return {
    scene,
    camera,
    renderer,
    clock,
    CAM_DEFAULT: live, // caller can mutate pos/target/fov on this; applyCameraDefault uses it
    applyCameraDefault,
    ROOM,
    room,
    furniture
  }
}

function buildRoom(scene) {
  const halfW = ROOM.width / 2
  const root = new Group()
  root.name = 'apia-room'

  // Colored floor inside the shadow plane. Slightly inset so the shadow
  // catcher above (y=0.001) renders shadows on top.
  const floor = new Mesh(
    new PlaneGeometry(ROOM.width, ROOM.depth),
    new MeshStandardMaterial({ color: ROOM.floorColor, roughness: 0.95, metalness: 0 })
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, ROOM.depth / 2)
  floor.receiveShadow = true
  root.add(floor)

  const wallMat = new MeshStandardMaterial({
    color: ROOM.wallColor,
    roughness: 0.9,
    metalness: 0,
    side: BackSide // visible from inside the room only
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
    emissive: WINDOW.emissive,
    emissiveIntensity: WINDOW.emissiveIntensity,
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
    side: DoubleSide
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
 * Phase D — assemble a simple wooden/pastel furniture set from BoxGeometry
 * primitives. No external GLTF needed; the goal is to break the empty-box
 * feeling and give the auto-behavior something to walk between. Each piece
 * is positioned from `FURNITURE_DEFAULT` so world.js can reference the same
 * coordinates for click targets and the visual mesh.
 */
function buildFurniture(scene) {
  const root = new Group()
  root.name = 'apia-furniture'

  for (const f of FURNITURE_DEFAULT) {
    const piece = buildFurniturePiece(f)
    if (piece) root.add(piece)
  }

  scene.add(root)
  return root
}

function buildFurniturePiece(f) {
  if (f.id === 'desk') return buildDesk(f)
  if (f.id === 'bed') return buildBed(f)
  if (f.id === 'chair_window') return buildChair(f)
  if (f.id === 'plant') return buildPlant(f)
  if (f.id === 'rug') return buildRug(f)
  return null
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
  const rug = new Mesh(
    new PlaneGeometry(f.size.w, f.size.d),
    softMat(f.color)
  )
  rug.rotation.x = -Math.PI / 2
  rug.position.set(f.position.x, f.position.y, f.position.z)
  rug.receiveShadow = true
  return rug
}
