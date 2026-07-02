/**
 * State-free runtime helpers extracted from src/main.js.
 *
 * Scope is deliberately narrow: manifest fetching + lazy-import wrappers for
 * the VRM/MMD runtimes. The model *loaders themselves* (loadVRMRuntimeModel,
 * loadMMDRuntimeModel) stay in main.js until the surrounding state surface
 * (currentModel, activeModelLoadToken, clearModel, scene setup helpers) is
 * refactored. Pulling them out now would just trade a single 1190-line file
 * for two tightly-coupled files passing 10+ deps to each other.
 *
 * What MOVED here:
 *   - URL/JSON fetch helpers (pure)
 *   - Manifest loaders (return the parsed manifest; caller owns
 *     `window.__textureMap` assignment so the global stays at the app
 *     boundary, not buried in a leaf module)
 *   - Lazy `@pixiv/three-vrm`, `MMDLoader`, `MMDAnimationHelper` imports
 *     with module-level singletons. Caller-side teardown (`clearModel`
 *     calling `VRMUtils.deepDispose`) reads the cached values via the
 *     getter exports below.
 */

let vrmRuntimePromise = null
let mmdRuntimePromise = null
let cachedVRMUtils = null
let cachedMmdHelper = null

/**
 * Lazy-loads `@pixiv/three-vrm` + `three`'s GLTFLoader on first call and
 * caches the resolved promise. Subsequent calls reuse the same promise.
 * The VRMUtils handle is also stashed for caller-side cleanup.
 */
export async function getVRMRuntime() {
  if (!vrmRuntimePromise) {
    vrmRuntimePromise = Promise.all([
      import('@pixiv/three-vrm'),
      import('three/examples/jsm/loaders/GLTFLoader.js')
    ]).then(([vrmModule, gltfModule]) => {
      cachedVRMUtils = vrmModule.VRMUtils
      return {
        GLTFLoader: gltfModule.GLTFLoader,
        VRMLoaderPlugin: vrmModule.VRMLoaderPlugin,
        VRMUtils: vrmModule.VRMUtils
      }
    })
  }

  return vrmRuntimePromise
}

/**
 * Caller-side cleanup (e.g. `VRMUtils.deepDispose(model)`) needs access to
 * the runtime even when it doesn't load a model. Returns null until the
 * first `getVRMRuntime()` resolves.
 */
export function getVRMUtils() {
  return cachedVRMUtils
}

/**
 * Lazy-loads `MMDLoader` + `MMDAnimationHelper`. Caches a single helper
 * instance for the lifetime of the process — animation playback later
 * reuses this same instance via `getMmdHelper()`.
 */
export async function getMmdRuntime() {
  if (!mmdRuntimePromise) {
    mmdRuntimePromise = Promise.all([
      import('three/examples/jsm/loaders/MMDLoader.js'),
      import('three/examples/jsm/animation/MMDAnimationHelper.js')
    ]).then(([loaderModule, helperModule]) => {
      if (!cachedMmdHelper) {
        // resetPhysicsOnLoop:false — 루프마다 물리(치마/꼬리) 강체 속도가 0으로
        // 리셋되며 생기던 주기적 스냅(뻣뻣했다 다시 흔들림)을 제거한다. 루트 이동
        // 트랙은 이미 제거·크로스페이드로 이어 붙으므로 루프 경계에서 물리를
        // 리셋할 이유가 없다. 초기 정착은 로드 시 stabilizeMmdPhysics가 담당.
        cachedMmdHelper = new helperModule.MMDAnimationHelper({ resetPhysicsOnLoop: false })
      }

      return {
        MMDLoader: loaderModule.MMDLoader,
        helper: cachedMmdHelper
      }
    })
  }

  return mmdRuntimePromise
}

/**
 * Returns the singleton MMDAnimationHelper, or null until the first
 * `getMmdRuntime()` call resolves. Animation playback in main.js calls
 * this rather than holding the reference itself, so there's exactly one
 * place that owns lazy initialization.
 */
export function getMmdHelper() {
  return cachedMmdHelper
}

/**
 * Lazy-loads ammo.js (bundled with three.js as `ammo.wasm.js`) and parks
 * the resolved namespace on `globalThis.Ammo`. `MMDAnimationHelper` reads
 * it from there when `physics: true` is requested. Without this step the
 * MMDPhysics constructor throws "Import ammo.js" and every PMX hair /
 * skirt / tail bone sits still — exactly the freeze the user reported.
 *
 * Cached as a promise so concurrent first calls share one wasm fetch.
 */
let ammoPromise = null
export async function getAmmoRuntime() {
  if (ammoPromise) return ammoPromise
  ammoPromise = (async () => {
    // The emscripten-built ammo.wasm.js fetches the matching `.wasm`
    // binary at runtime via `import.meta.url` + relative path. Two
    // problems with that in our environment:
    //   1. Vite's static analysis doesn't see the path → wasm never
    //      gets emitted to dist/ unless we register it explicitly.
    //   2. Even after `?url` registration the emscripten fetch fails
    //      inside Electron's file:// renderer (both async + sync
    //      fetch attempts abort), so MMDPhysics still throws.
    // Workaround: we fetch the bytes ourselves and hand them to the
    // factory via the `wasmBinary` option, bypassing the broken
    // internal fetch entirely.
    const [mod, wasmUrlMod] = await Promise.all([
      import('three/examples/jsm/libs/ammo.wasm.js'),
      import('three/examples/jsm/libs/ammo.wasm.wasm?url')
    ])
    const wasmUrl = wasmUrlMod.default || wasmUrlMod
    const wasmResponse = await fetch(wasmUrl)
    const wasmBinary = await wasmResponse.arrayBuffer()
    const AmmoFactory = mod.default || mod.Ammo
    // Emscripten output ends with `this.Ammo = b;` to publish the runtime
    // namespace onto the caller's `this`. ESM strict mode makes the
    // function's `this` undefined when called as `AmmoFactory(opts)`,
    // which throws "Cannot set properties of undefined". Calling with
    // `.call(globalThis, ...)` gives it a writable target.
    const Ammo = await AmmoFactory.call(globalThis, {
      wasmBinary,
      locateFile: () => wasmUrl
    })
    // MMDPhysics reads `window.Ammo` — set both for safety across envs.
    globalThis.Ammo = Ammo
    if (typeof window !== 'undefined') window.Ammo = Ammo
    return Ammo
  })().catch((err) => {
    ammoPromise = null // allow retry on next character load
    throw err
  })
  return ammoPromise
}

// ── MMD physics scale-space stabilizer ──────────────────────────────────
//
// three's MMDPhysics simulates in UNSCALED space — update() temporarily
// forces mesh.scale to (1,1,1) before stepping — but RigidBody.reset()
// snaps bodies to the bones' CURRENT world transforms, which include
// Apia's ~0.08 display scale. Every reset therefore parks the rigid
// bodies ×12.5 off from where the next update() expects them; the first
// sim step slams the skirt/tail/hair constraints and the cloth settles
// tangled (tent-shaped skirt, panels stretched into boards, tail zigzag
// on the floor — see test-results/vmd-check). reset() runs at physics
// creation AND on every clip loop (helper's resetPhysicsOnLoop default),
// so the slam used to repeat forever.
//
// Fix: patch the instance's reset() to run with the mesh temporarily
// unscaled — the exact space update() simulates in — then settle the
// cloth with a warmup. The patch survives for the physics instance's
// lifetime, which also makes the helper's own per-loop reset scale-safe.

function runWithUnscaledMesh(mesh, fn) {
  const parent = mesh.parent
  if (parent) mesh.parent = null
  const scale = mesh.scale.clone()
  mesh.scale.set(1, 1, 1)
  mesh.updateMatrixWorld(true)
  try {
    return fn()
  } finally {
    if (parent) mesh.parent = parent
    mesh.scale.copy(scale)
    mesh.updateMatrixWorld(true)
  }
}

// MMD 숨김 토글 파츠(제작자가 transparent+opacity 0으로 꺼둔 재질 — 여우꼬리·
// 대체신발·OFF_* 등)가 본 패스/외곽선에서 **불투명 흰 셸**로 새는 것을 차단한다.
// (실측: MMDToonMaterial+OutlineEffect 경로에서 opacity 0이 무시되고 흰색으로
// 그려짐 — visible=false만이 본 패스·외곽선 둘 다 확실히 끈다.)
// 재질 모프가 런타임에 opacity를 올릴 수 있으므로(예: 홍조 0→1) 일회성이 아니라
// 매 프레임 동기화한다. 우리가 숨긴 재질(__hiddenByOpacity)만 복원하고, 다른
// 코드가 숨긴 재질은 절대 강제로 켜지 않는다.
// 트레이드오프: "opacity 0인데 그려져야 하는" 가상의 depth-only 패스는 미지원 —
// 숨김 토글 파츠 관례가 압도적으로 일반적이라 그 쪽을 택한다.
export function syncHiddenMaterialVisibility(materials, eps = 0.001) {
  if (!materials) return 0
  const list = Array.isArray(materials) ? materials : [materials]
  let hidden = 0
  for (const m of list) {
    if (!m) continue
    const shouldHide = m.transparent === true && (m.opacity ?? 1) <= eps
    if (shouldHide) {
      if (m.visible !== false) {
        if (m.userData) m.userData.__hiddenByOpacity = true
        m.visible = false
      }
      if (m.userData?.__hiddenByOpacity) hidden++
    } else if (m.userData?.__hiddenByOpacity) {
      // 모프가 다시 켠 재질 — 우리가 숨긴 것만 복원.
      m.visible = true
      delete m.userData.__hiddenByOpacity
    }
  }
  return hidden
}

// 고주사율 시간 팽창 수정 — three MMDPhysics._stepSimulation은 프레임 delta가
// unitStep보다 짧으면 stepTime을 unitStep으로 "올려서" 시뮬한다. 120Hz 화면에선
// 매 프레임 15.4ms(1/65)씩 돌아 물리가 ~1.7배속 → 옷·머리·꼬리가 초조하게
// 떨리는 근본 원인(실측: idle 치맛자락 프레임당 ~1.2cm 진동). bullet은 자체
// 시간 누적기가 있으므로 실제 delta를 그대로 넘기면 어떤 주사율에서도 정속이
// 된다(부족분은 누적돼 다음 프레임에 스텝 — 60Hz 사용자가 보던 것과 동일한
// 1프레임 홀드). 물리 객체는 로드 때 helper에 1회 등록 후 유지되므로(클립
// 교체는 mixer stash 방식) 이 패치도 모델당 1회면 충분하다.
export function patchRealtimePhysicsStep(physics) {
  if (!physics || physics.__apiaRealtimeStep) return false
  physics._stepSimulation = function (delta) {
    const unitStep = this.unitStep
    let maxStepNum = ((delta / unitStep) | 0) + 1
    if (maxStepNum > this.maxStepNum) maxStepNum = this.maxStepNum
    this.world.stepSimulation(delta, maxStepNum, unitStep)
  }
  physics.__apiaRealtimeStep = true
  return true
}

// 동적(시뮬) 물리 본 목록 — 옷자락·머리·꼬리처럼 물리가 움직이는 본만 추린다
// (본따라가기 kinematic 제외). 매무새 자가 회복의 감시 대상. 모델 불문:
// 본 이름이 아니라 PMX 강체 타입(0=본추종, 1/2=물리)으로 고른다.
export function getDynamicPhysicsBones(mesh) {
  const helper = getMmdHelper()
  const physics = helper?.objects?.get?.(mesh)?.physics
  if (!physics?.bodies || !mesh?.skeleton?.bones) return []
  const out = []
  const seen = new Set()
  for (const body of physics.bodies) {
    const p = body?.params
    if (!p || p.type === 0) continue // 본따라가기(kinematic)는 제외
    const bone = mesh.skeleton.bones[p.boneIndex]
    if (bone && !seen.has(bone)) { seen.add(bone); out.push(bone) }
  }
  return out
}

// 물리 본의 바인드(제작 시) 로컬 변환 스냅샷 — 로드 직후, 어떤 포즈/시뮬도
// 닿기 전에 떠 둔다. "옷 매무새 고치기"의 기준: 로컬 바인드 = "부모에서 자연히
// 늘어뜨린 모양"이라, 몸이 어떤 포즈든 이걸 복원하면 자연 드레이프의 시작점.
export function capturePhysicsBoneRest(mesh) {
  if (!mesh?.skeleton?.bones) return 0
  const rest = new Map()
  for (const b of mesh.skeleton.bones) {
    rest.set(b, { p: b.position.clone(), q: b.quaternion.clone() })
  }
  mesh.userData.__apiaBoneRest = rest
  return rest.size
}

// three physics.reset()은 강체를 본의 "현재"(=이미 엉킨) 위치로 되돌려서 엉킴을
// 보존한다(실측: 치맛자락이 머리카락에 감긴 채 reset+warmup해도 그대로).
// 진짜 재안착 = 동적 물리 본 로컬을 바인드로 복원 → reset → warmup.
function restorePhysicsBoneRest(mesh) {
  const rest = mesh?.userData?.__apiaBoneRest
  if (!rest) return false
  const bones = getDynamicPhysicsBones(mesh)
  if (!bones.length) return false
  for (const b of bones) {
    const r = rest.get(b)
    if (!r) continue
    b.position.copy(r.p)
    b.quaternion.copy(r.q)
  }
  mesh.updateMatrixWorld(true)
  return true
}

export function stabilizeMmdPhysics(mesh, { warmupCycles = 60, reseatBones = false } = {}) {
  const helper = getMmdHelper()
  const item = helper?.objects?.get?.(mesh)
  const physics = item?.physics
  if (!physics) return false

  patchRealtimePhysicsStep(physics)

  if (!physics.__apiaScaleSafeReset) {
    const originalReset = physics.reset.bind(physics)
    physics.reset = () => runWithUnscaledMesh(mesh, originalReset)
    physics.__apiaScaleSafeReset = true
  }

  const t0 = performance.now()
  // 매무새 고치기 — 엉킨 옷자락/머리를 바인드 드레이프에서 다시 정착시킨다.
  const reseated = reseatBones ? restorePhysicsBoneRest(mesh) : false
  physics.reset()
  // warmup() goes through update(), which un-scales by itself — no wrapper.
  physics.warmup(warmupCycles)
  console.info('[Apia MMD physics] stabilized', {
    warmupCycles,
    reseated,
    ms: Math.round(performance.now() - t0)
  })
  return true
}

// ── 제작자 본 모프 적용 (꼬리 올림) ──────────────────────────────────────
//
// PMX에는 "본 모프"(켜면 특정 본에 위치/회전 오프셋이 더해지는 토글)가
// 있는데 three.js MMDLoader는 정점 모프만 변환하고 본 모프 데이터는
// 버린다 — morphTargetDictionary에 이름만 남은 빈 슬롯이 생겨 켜도 무효.
// 어떤 PMX의 ★Up_しっぽ가 그 경우: しっぽ支(꼬리 지지, 뼈 추종 강체) 본을
// (1.39, 3.05, 0.36) 들어 올리면 스프링 조인트(しっぽ3~11_Side)가 꼬리
// 체인 전체를 바닥에서 끌어올리는, 제작자가 의도한 "꼬리 올림" 장치다.
// PMX를 다시 파싱해(HTTP 캐시 적중, 모델 로드당 1회) 해당 본 모프를 본
// 위치에 직접 적용한다 — 수치는 하드코딩 없이 항상 모델 파일이 출처라
// 같은 관례의 다른 모델에도 그대로 작동한다.
//
// 반드시 stabilizeMmdPhysics(정착 warmup) *전에* 호출할 것 — 정착 후에
// 지지 본을 옮기면 이미 안정된 동적 체인을 순간이동으로 흐트러뜨린다
// (Codex MUST-FIX).
export async function applyAuthorTailLift(mesh, url) {
  const fetchable = normalizeUrlToFetchable(url)
  const bones = mesh?.skeleton?.bones
  if (!fetchable || !bones?.length) return 0
  const [{ MMDParser }, buffer] = await Promise.all([
    import('three/examples/jsm/libs/mmdparser.module.js'),
    fetch(fetchable).then((r) => {
      if (!r.ok) throw new Error(`PMX re-fetch failed: ${r.status}`)
      return r.arrayBuffer()
    }),
  ])
  const pmx = new MMDParser.Parser().parsePmx(buffer, true)
  let applied = 0
  for (const morph of pmx.morphs ?? []) {
    if (morph.type !== 2) continue // 2 = 본 모프
    if (!/Up_しっぽ/.test(morph.name)) continue
    for (const el of morph.elements ?? []) {
      const bone = bones[el.index]
      // 파서 본 순서 ↔ skeleton.bones 1:1 가정의 안전망: 이름까지 대조
      if (!bone || pmx.bones?.[el.index]?.name !== bone.name) continue
      const [qx, qy, qz, qw] = el.rotation ?? [0, 0, 0, 1]
      if (Math.abs(1 - qw) > 1e-6 || Math.abs(qx) + Math.abs(qy) + Math.abs(qz) > 1e-6) {
        // 회전 성분은 이 모델에선 identity — 비-identity를 만나면 요소
        // 전체를 보류하고 알린다 (검증 없는 코드 경로를 묵묵히 켜지 않는다)
        console.warn('[Apia MMD] tail-lift morph has rotation — element skipped:', morph.name, bone.name)
        continue
      }
      bone.position.x += el.position[0]
      bone.position.y += el.position[1]
      bone.position.z += el.position[2]
      applied += 1
    }
  }
  return applied
}

// ── URL / fetch helpers ─────────────────────────────────────────────────

export function normalizeUrlToFetchable(url) {
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

export async function fetchJsonSafe(url) {
  const normalized = normalizeUrlToFetchable(url)
  if (!normalized) return null

  const response = await fetch(normalized)
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${normalized}`)
  }
  return await response.json()
}

export async function loadOptionalJson(url, label = 'json') {
  if (!url) return null

  try {
    return await fetchJsonSafe(url)
  } catch (error) {
    console.warn(`[CharacterProfile] failed to load ${label}`, url, error)
    return null
  }
}

// ── Manifest loaders ────────────────────────────────────────────────────
//
// Both return the *full* parsed manifest object — callers (e.g.
// tryLoadActiveCharacterFromRegistry) read fields like `entryFileUrl` off
// it. The window.__textureMap assignment is the caller's responsibility so
// the global stays owned at the app boundary.
//
// `loadManifestByPath` is the explicit-path variant (called with a known
// manifest path). On failure, returns null.
//
// `loadManifestForModel` is the heuristic variant: given a model URL, tries
// the sibling and parent `model_manifest.json` paths. Caller can distinguish
// "manifest not found at any candidate" (null return) from "found but had
// no textureBasenameMap" (manifest with `textureBasenameMap` missing —
// caller assigns `{}` per existing convention).

export async function loadManifestByPath(manifestPath) {
  try {
    const manifest = await fetchJsonSafe(manifestPath)
    if (manifest && manifest.entryRelPath) {
      // 이식성: 저장된 절대 entryFileUrl 대신 매니페스트 실제 위치 기준 상대경로로
      // 재해석 → 다른 PC/설치본에서도 로드. entryRelPath 없는 구 매니페스트는
      // 저장된 절대 entryFileUrl 그대로(하위호환).
      const dir = String(manifestPath).replace(/\\/g, '/').replace(/\/[^/]*$/, '')
      const rel = String(manifest.entryRelPath).replace(/\\/g, '/').replace(/^\.?\//, '')
      manifest.entryFileUrl = normalizeUrlToFetchable(`${dir}/${rel}`)
    }
    return manifest
  } catch (err) {
    console.warn('[Manifest 직접 로드 실패]', manifestPath, err)
    return null
  }
}

export async function loadManifestForModel(modelUrl) {
  try {
    const normalizedUrl = normalizeUrlToFetchable(modelUrl)
    if (!normalizedUrl) return null

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
        console.log('[Manifest 로드 성공]', manifestUrl)
        return manifest
      } catch {
        // 다음 후보 시도
      }
    }

    console.warn('[Manifest 없음]', candidates)
    return null
  } catch (err) {
    console.warn('[Manifest 로드 실패]', err)
    return null
  }
}
