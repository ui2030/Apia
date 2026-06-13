// 생성한 VMD talk/react 클립을 kisaki(PMX)에서 재생해 회전 방향/크기를 검증.
// 각 클립을 재생하며 핵심 본(頭/上半身/左腕/右腕) 로컬 회전을 ~1.5s 샘플링,
// 절대값 피크를 기록하고 피크 시점 스크린샷을 저장한다.
//
//   node tests/gui/motion-test.mjs [outDir]
import { launchApia } from './helpers/launchApia.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const OUT = process.argv[2] || path.resolve('test-results', 'motion')
await mkdir(OUT, { recursive: true })

const CLIPS = (process.argv[3] ? process.argv[3].split(',').map((s) => {
  const [category, name] = s.includes(':') ? s.split(':') : [s.split('_')[0], s]
  return { category, name }
}) : [
  { category: 'react', name: 'react_nod' },
  { category: 'react', name: 'react_surprised' },
  { category: 'react', name: 'react_happy' },
  { category: 'react', name: 'react_shy' },
  { category: 'talk', name: 'talk_explain' },
  { category: 'talk', name: 'talk_think' },
  { category: 'talk', name: 'talk_soft' },
  { category: 'talk', name: 'talk_happy' },
  { category: 'talk', name: 'talk_neutral' },
  { category: 'talk', name: 'talk_explain_soft' },
])
const BONES = ['頭', '首', '上半身', '左腕', '右腕', '左ひじ', '右ひじ']

const { app, mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const readBones = () => mainWindow.evaluate((names) => {
  const s = window.__apiaScene; if (!s) return null
  let mesh = null
  s.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o })
  if (!mesh?.skeleton) return null
  const by = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const out = {}
  for (const n of names) {
    const b = by.get(n)
    if (b) out[n] = { x: +b.rotation.x.toFixed(3), y: +b.rotation.y.toFixed(3), z: +b.rotation.z.toFixed(3) }
  }
  return out
}, BONES).catch(() => null)

try {
  // kisaki(SkinnedMesh) 로드 대기
  for (let i = 0; i < 60; i++) {
    const ok = await mainWindow.evaluate(() => {
      const s = window.__apiaScene; if (!s) return false
      let f = false; s.traverse((o) => { if (o.isSkinnedMesh) f = true }); return f
    }).catch(() => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))

  const present = await readBones()
  console.log('bones present:', present ? Object.keys(present).join(', ') : 'NONE')

  for (const clip of CLIPS) {
    // rest로 리셋(잠깐 idle), 그 다음 클립 재생
    await mainWindow.evaluate((c) => window.__applyMotion?.(c), { category: 'idle', name: 'idle_neutral', intensity: 1 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))

    await mainWindow.evaluate((c) => window.__applyMotion?.({ ...c, intensity: 1 }), clip).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    const flags = await mainWindow.evaluate(() => window.__clipFlags?.()).catch(() => null)
    console.log(`[${clip.name}] clipRoles:`, flags?.clipRoles ? flags.clipRoles.join(',') : 'none')

    // ~1.6s 동안 100ms마다 본 회전 절대 피크 추적
    const peak = {}
    let peakAt = 0
    for (let t = 0; t < 16; t++) {
      await new Promise((r) => setTimeout(r, 100))
      const b = await readBones()
      if (!b) continue
      let frameMag = 0
      for (const [n, r] of Object.entries(b)) {
        const m = Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.z)
        if (m > frameMag) frameMag = m
        const cur = peak[n] || { x: 0, y: 0, z: 0 }
        if (Math.abs(r.x) > Math.abs(cur.x)) cur.x = r.x
        if (Math.abs(r.y) > Math.abs(cur.y)) cur.y = r.y
        if (Math.abs(r.z) > Math.abs(cur.z)) cur.z = r.z
        peak[n] = cur
      }
      if (t === 3) await mainWindow.screenshot({ path: path.join(OUT, `${clip.name}_t400ms.png`) })
      if (t === 7) await mainWindow.screenshot({ path: path.join(OUT, `${clip.name}_t800ms.png`) })
    }
    console.log(`\n[${clip.name}] peak |rot| per bone:`)
    for (const [n, r] of Object.entries(peak)) {
      if (Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.z) > 0.02) console.log(`  ${n}: x=${r.x} y=${r.y} z=${r.z}`)
    }
  }
  console.log('\nMOTION TEST DONE ->', OUT)
} finally {
  await cleanup()
}
process.exit(0)
