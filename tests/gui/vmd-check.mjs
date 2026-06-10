import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/vmd-check')
mkdirSync(outDir, { recursive: true })

// All 10 motions, multi-frame so we catch the "arm bent backwards" moment
const motions = [
  'idle_confident', 'idle_air_scent', 'idle_fix_hair', 'idle_skywatch',
  'idle_stretch', 'idle_sway', 'idle_tidy', 'idle_tracker',
  'idle_impatient', 'idle_mermay'
]

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const logs = []
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (t.includes('Electron Security')) return
  if (msg.type() === 'error' && !t.includes('unknown char code')) {
    logs.push(`[error] ${t}`)
  }
  if (t.includes('[VMD diag]') || t.includes('[VMD] stripped')) {
    logs.push(`[${msg.type()}] ${t}`)
  }
})

await new Promise((r) => setTimeout(r, 4500))

async function snapshot(label) {
  await mainWindow.screenshot({ path: path.join(outDir, `${label}.png`) })
  return await mainWindow.evaluate(() => {
    const scene = window.__apiaScene
    if (!scene) return null
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return null
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const q = (n) => {
      const b = map.get(n)
      return b ? [b.quaternion.x.toFixed(3), b.quaternion.y.toFixed(3),
                  b.quaternion.z.toFixed(3), b.quaternion.w.toFixed(3)] : null
    }
    return {
      lArm: q('左腕'),
      rArm: q('右腕'),
      lElbow: q('左ひじ'),
      rElbow: q('右ひじ'),
    }
  })
}

for (const name of motions) {
  console.log(`\n=== ${name} ===`)
  await mainWindow.evaluate((n) => window.__applyMotion({ name: n, intensity: 1 }), name)
  // Frame 1 — right after trigger (fadeIn ~0.5s)
  await new Promise((r) => setTimeout(r, 800))
  console.log('  t=0.8s:', JSON.stringify(await snapshot(`${name}_a`)))
  // Frame 2 — mid clip
  await new Promise((r) => setTimeout(r, 1500))
  console.log('  t=2.3s:', JSON.stringify(await snapshot(`${name}_b`)))
}

if (logs.length) {
  console.log('\n========== logs ==========')
  for (const l of logs) console.log(l)
}

await cleanup()
process.exit(0)
