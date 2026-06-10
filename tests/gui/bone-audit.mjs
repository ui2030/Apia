import { launchApia } from './helpers/launchApia.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/bone-audit')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

// Wait for model to load.
await new Promise((r) => setTimeout(r, 5000))

// Pull skeleton data out of the renderer.
const dump = await mainWindow.evaluate(() => {
  /* eslint-disable no-undef */
  const m = window.__apiaCurrentModel?.obj || window.currentModel?.obj
  // The actual scene root is harder to reach from outside; instead walk
  // the scene we exposed (we'll inject a helper inline).
  const scene = window.__apiaScene
  if (!scene) return { error: 'no scene exposed; need to expose first' }

  let mesh = null
  scene.traverse((o) => {
    if (!mesh && o.skeleton && o.geometry?.userData?.MMD) mesh = o
    else if (!mesh && o.skeleton) mesh = o
  })
  if (!mesh) return { error: 'no skeletal mesh found' }

  const bones = mesh.skeleton.bones
  const interesting = [
    '腰', '下半身', '上半身', '上半身2',
    '首', '頭',
    '両目', '左目', '右目',
    '左肩', '左肩C', '左肩P', '右肩', '右肩C', '右肩P',
    '左腕', '右腕', '左腕捩', '右腕捩',
    '左ひじ', '右ひじ', '左ヒジ', '右ヒジ',
    '左手首', '右手首', '左手捩', '右手捩',
    '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首',
    '左足D', '右足D', '左ひざD', '右ひざD',
  ]
  const out = []
  const byName = new Map(bones.map((b) => [b.name, b]))

  function worldPos(b) {
    const v = new (b.position.constructor)()
    b.getWorldPosition(v)
    return [v.x, v.y, v.z]
  }
  function eulerOf(b) {
    const e = b.rotation
    return [e.x, e.y, e.z]
  }
  function quatOf(b) {
    const q = b.quaternion
    return [q.x, q.y, q.z, q.w]
  }

  for (const n of interesting) {
    const b = byName.get(n)
    if (!b) { out.push({ name: n, found: false }); continue }
    const childPos = b.children.length > 0 ? worldPos(b.children[0]) : null
    out.push({
      name: n,
      found: true,
      parent: b.parent?.name || null,
      worldPos: worldPos(b),
      restQuat: quatOf(b),
      restEuler: eulerOf(b),
      childCount: b.children.length,
      firstChildName: b.children[0]?.name || null,
      firstChildWorldPos: childPos,
    })
  }

  // Also dump physics + helper state for the report.
  const phys = mesh.geometry?.userData?.MMD
  const ammo = typeof globalThis.Ammo !== 'undefined'
  return {
    boneTotal: bones.length,
    physics: {
      rigidBodyCount: phys?.rigidBodies?.length ?? 0,
      constraintCount: phys?.constraints?.length ?? 0,
      ammoLoaded: ammo,
    },
    interesting: out,
  }
})

writeFileSync(path.join(outDir, 'dump.json'), JSON.stringify(dump, null, 2))
console.log('[dump] total bones:', dump.boneTotal)
console.log('[dump] physics:', dump.physics)
console.log('[dump] interesting bones found:')
for (const b of dump.interesting || []) {
  if (!b.found) { console.log('  ✗', b.name); continue }
  const wp = b.worldPos.map((v) => v.toFixed(3)).join(',')
  const cp = b.firstChildWorldPos ? b.firstChildWorldPos.map((v) => v.toFixed(3)).join(',') : 'none'
  const eu = b.restEuler.map((v) => v.toFixed(3)).join(',')
  console.log(`  ✓ ${b.name}  worldPos=[${wp}]  childPos=[${cp}]  restEuler=[${eu}]  parent=${b.parent}`)
}

await cleanup()
process.exit(0)
