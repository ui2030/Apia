import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/visual-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (t.includes('Electron Security')) return
  if (t.includes('Download the React DevTools')) return
  if (msg.type() === 'error' || msg.type() === 'warning') {
    console.log(`[${msg.type()}] ${t}`)
  } else if (
    t.includes('[poseRig]') ||
    t.includes('[Apia MMD physics + morphs]') ||
    t.includes('[Apia MMD]') ||
    t.includes('character') ||
    t.includes('Character')
  ) {
    console.log(`[${msg.type()}] ${t}`)
  }
})
mainWindow.on('pageerror', (e) => {
  console.log(`[pageerror] ${e?.message || e}`)
})

await new Promise((r) => setTimeout(r, 4500))

// Pull arm/head/eye bone state at three time points to verify the
// refactor's three goals:
//   (a) T-pose double-application gone (lArm world rotation z near rest)
//   (b) head rest tilt survives (head world quat has the model's baked tilt)
//   (c) eye bones actually receive saccade (両目 quaternion changes between frames)
async function snap(label) {
  const png = await mainWindow.screenshot({ path: path.join(outDir, `${label}.png`) })
  const boneState = await mainWindow.evaluate(() => {
    const scene = window.__apiaScene
    if (!scene) return null
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return null
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    function q(n) {
      const b = map.get(n)
      if (!b) return null
      return [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]
    }
    return {
      lArm: q('左腕'),
      rArm: q('右腕'),
      head: q('頭'),
      neck: q('首'),
      eyes: q('両目'),
      lEye: q('左目'),
      rEye: q('右目'),
    }
  })
  console.log(`[${label}] ${png.length} bytes`)
  if (boneState) {
    for (const [name, q] of Object.entries(boneState)) {
      if (!q) { console.log(`  ${name}: (not found)`); continue }
      const fmt = q.map((v) => v.toFixed(3)).join(',')
      console.log(`  ${name}: [${fmt}]`)
    }
  }
  return { boneState }
}

const a = await snap('frame-1')
await new Promise((r) => setTimeout(r, 1500))
const b = await snap('frame-2')
await new Promise((r) => setTimeout(r, 1500))
const c = await snap('frame-3')

// Compare quaternions between frame-1 and frame-3 — anything that's
// moving will have a non-trivial delta. If eyes are still (0,0,0,1) the
// gaze path is dead.
function delta(name) {
  const q1 = a.boneState?.[name]
  const q3 = c.boneState?.[name]
  if (!q1 || !q3) return null
  let d = 0
  for (let i = 0; i < 4; i += 1) d += Math.abs(q1[i] - q3[i])
  return d
}

console.log('\n[delta f1→f3]')
for (const name of ['lArm', 'rArm', 'head', 'neck', 'eyes', 'lEye', 'rEye']) {
  const d = delta(name)
  console.log(`  ${name}: ${d === null ? 'n/a' : d.toFixed(4)}`)
}

await cleanup()
process.exit(0)
