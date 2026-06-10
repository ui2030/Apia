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
  Vector3,
  WebGLRenderer
} from 'three'

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
export const ROOM = Object.freeze({
  width: 8,    // x extent (-4 .. +4)
  depth: 6,    // z extent (0 .. +6)
  height: 3,   // y extent (0 .. +3)
  wallColor: 0xeae3d8,   // warm cream
  floorColor: 0xd8cdb8,  // a shade darker so the floor reads
  ceilColor: 0xf2ecdf
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

  // Lighting + ground plane. These are static for the lifetime of the
  // overlay — no character switch should add/remove them.
  scene.add(new AmbientLight(0xffffff, 0.8))

  const dir = new DirectionalLight(0xffffff, 0.9)
  dir.position.set(2, 5, 4)
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

  const rim = new DirectionalLight(0xa78bfa, 0.4)
  rim.position.set(-3, 2, -2)
  scene.add(rim)

  const fill = new DirectionalLight(0xfff0e0, 0.3)
  fill.position.set(0, -1, 3)
  scene.add(fill)

  // ── Phase B — Build the room ───────────────────────────────────────────
  // The character lives inside this box; the open (camera-facing) wall is
  // the metaphorical aquarium glass. Walls are MeshStandardMaterial so
  // ambient/directional/rim lights all read on them; doubleside on the
  // back so a future "peek through" camera angle stays sane.
  const room = buildRoom(scene)
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
    room
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
