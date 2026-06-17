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
        cachedMmdHelper = new helperModule.MMDAnimationHelper()
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

export function stabilizeMmdPhysics(mesh, { warmupCycles = 60 } = {}) {
  const helper = getMmdHelper()
  const item = helper?.objects?.get?.(mesh)
  const physics = item?.physics
  if (!physics) return false

  if (!physics.__apiaScaleSafeReset) {
    const originalReset = physics.reset.bind(physics)
    physics.reset = () => runWithUnscaledMesh(mesh, originalReset)
    physics.__apiaScaleSafeReset = true
  }

  const t0 = performance.now()
  physics.reset()
  // warmup() goes through update(), which un-scales by itself — no wrapper.
  physics.warmup(warmupCycles)
  console.info('[Apia MMD physics] stabilized', {
    warmupCycles,
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
    return await fetchJsonSafe(manifestPath)
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
