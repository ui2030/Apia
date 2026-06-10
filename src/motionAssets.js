// src/motionAssets.js
// Loads the VRMA + VMD + FBX manifests and resolves motion names → clip descriptors.
// Missing clips return null (caller falls back to procedural layer silently).
//
// FBX path (Step 6): Mixamo .fbx clips for VRM targets. playFBXAnimation
// retargets `mixamorig:` bones onto the VRM humanoid rig + corrects the cm→m
// hips translation scale. MMD/PMX models silently skip the FBX path because
// Mixamo bones don't share the PMX rig topology.

import vrmaManifest from './assets/motions/manifest.json'
import vmdManifest from './assets/motions/vmd/manifest.json'
import fbxManifest from './assets/motions/fbx/manifest.json'

// Vite picks up every .vrma / .vmd / .fbx under the matching folder as a
// hashed URL. `query: '?url'` forces raw URL output instead of trying to
// parse the binary.
const vrmaModules = import.meta.glob('./assets/motions/vrma/**/*.vrma', {
  eager: true,
  query: '?url',
  import: 'default'
})
const vmdModules = import.meta.glob('./assets/motions/vmd/**/*.vmd', {
  eager: true,
  query: '?url',
  import: 'default'
})
const fbxModules = import.meta.glob('./assets/motions/fbx/**/*.fbx', {
  eager: true,
  query: '?url',
  import: 'default'
})

function buildPathMap(modules, stripPrefix) {
  const map = new Map()
  for (const [key, url] of Object.entries(modules)) {
    const rel = key.replace(stripPrefix, '')
    map.set(rel, url)
  }
  return map
}

const vrmaPathToUrl = buildPathMap(vrmaModules, /^\.\/assets\/motions\/vrma\//)
const vmdPathToUrl = buildPathMap(vmdModules, /^\.\/assets\/motions\/vmd\//)
const fbxPathToUrl = buildPathMap(fbxModules, /^\.\/assets\/motions\/fbx\//)

function resolveFromManifest(manifest, pathToUrl, motionName, kind) {
  if (!motionName) return null
  const entry = manifest.clips?.[motionName]
  if (!entry || !entry.path) return null
  const url = pathToUrl.get(entry.path)
  if (!url) return null // manifest entry exists but file not dropped yet
  return {
    url,
    kind,
    loop: entry.loop === true,
    fadeIn: Number.isFinite(entry.fadeIn) ? entry.fadeIn : (manifest.defaultFadeIn ?? 0.4)
  }
}

/**
 * VRM motion resolver. Step 6: tries .vrma first (native VRM format), then
 * .fbx (Mixamo) as a fallback so a model author can ship either or both.
 * `kind` lets the caller route to playVRMAnimation vs playFBXAnimation.
 *
 * @param {string} motionName - e.g. 'idle_breath_soft'
 * @returns {{ url: string, kind: 'vrma' | 'fbx', loop: boolean, fadeIn: number } | null}
 */
export function resolveMotionAsset(motionName) {
  return (
    resolveFromManifest(vrmaManifest, vrmaPathToUrl, motionName, 'vrma') ||
    resolveFromManifest(fbxManifest, fbxPathToUrl, motionName, 'fbx')
  )
}

// Step 5 of /goal — auto-register .vmd files that the user dropped into
// idle/talk/react folders without editing manifest.json. Filename (sans
// extension) becomes a motion key. Categories are inferred from the
// parent folder: idle/walk.vmd → motion name 'idle_walk', talk/foo.vmd
// → 'talk_foo'. Files already covered by the manifest are skipped (the
// manifest entry's loop/fadeIn metadata wins).
const _autoVmdEntries = new Map()
{
  const manifestPaths = new Set(
    Object.values(vmdManifest.clips || {})
      .map((c) => c?.path)
      .filter(Boolean)
  )
  for (const [rel, url] of vmdPathToUrl.entries()) {
    if (manifestPaths.has(rel)) continue
    const parts = rel.split('/')
    if (parts.length < 2) continue
    const category = parts[0] // 'idle' | 'talk' | 'react' | …
    const baseName = parts[parts.length - 1].replace(/\.vmd$/i, '')
    const motionName = `${category}_${baseName}`
    // Default loop=true for idle/talk, false for react.
    const loop = category === 'idle' || category === 'talk'
    _autoVmdEntries.set(motionName, { url, loop, fadeIn: vmdManifest.defaultFadeIn ?? 0.4 })
  }
  if (_autoVmdEntries.size > 0) {
    console.info('[motionAssets] auto-registered .vmd clips', Array.from(_autoVmdEntries.keys()))
  }
}

/**
 * MMD 측 동일 motion-name 키에 대한 .vmd 클립 resolver.
 * VRMA와 같은 이름 ('idle_breath_soft' 등)을 받지만 vmd manifest를 본다.
 * Step 5 of /goal: manifest 미등록 .vmd도 filename 기반 motion name으로
 * 자동 등록. 사용자가 매니페스트 안 만져도 idle/foo.vmd 드롭만으로
 * `idle_foo` 모션이 활성화됨.
 *
 * @param {string} motionName
 * @returns {{ url: string, kind: 'vmd', loop: boolean, fadeIn: number } | null}
 */
export function resolveMmdMotionAsset(motionName) {
  const fromManifest = resolveFromManifest(vmdManifest, vmdPathToUrl, motionName, 'vmd')
  if (fromManifest) return fromManifest
  const auto = _autoVmdEntries.get(motionName)
  if (auto) return { url: auto.url, kind: 'vmd', loop: auto.loop, fadeIn: auto.fadeIn }
  return null
}

export function listAvailableMotions() {
  const names = new Set([
    ...Object.keys(vrmaManifest.clips || {}),
    ...Object.keys(vmdManifest.clips || {}),
    ...Object.keys(fbxManifest.clips || {})
  ])
  const out = []
  for (const name of names) {
    if (resolveMotionAsset(name) || resolveMmdMotionAsset(name)) out.push(name)
  }
  return out
}
