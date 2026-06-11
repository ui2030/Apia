// One-off experiment: does enabling the model's own fix-up morphs
// (★貫通対策 anti-clipping, ★Up_しっぽ tail-up) actually work under
// three.js MMDLoader? Screenshots before/after from 3 angles.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/morph-test')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))

async function setCameraYaw(yawOffset) {
  await mainWindow.evaluate((yaw) => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    if (!cam || !scene) return
    if (!window.__camBase) {
      window.__camBase = { pos: cam.position.clone(), quat: cam.quaternion.clone() }
    }
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const anchor = map.get('上半身') || mesh.skeleton.bones[0]
    const V = cam.position.constructor
    const center = anchor.getWorldPosition(new V())
    const base = window.__camBase.pos
    const r = Math.min(Math.hypot(base.x - center.x, base.z - center.z), 2.4)
    const bearing = Math.atan2(base.x - center.x, base.z - center.z) + yaw
    cam.position.set(center.x + Math.sin(bearing) * r, base.y, center.z + Math.cos(bearing) * r)
    cam.lookAt(center)
  }, yawOffset)
  await new Promise((r) => setTimeout(r, 150))
}

async function shoot(label) {
  for (const [suffix, yaw] of [['front', 0], ['side', Math.PI / 2], ['back', Math.PI]]) {
    await setCameraYaw(yaw)
    await mainWindow.screenshot({ path: path.join(outDir, `${label}_${suffix}.png`) })
  }
}

const setMorph = (name, value) => mainWindow.evaluate(({ name, value }) => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return 'no mesh'
  const idx = mesh.morphTargetDictionary?.[name]
  if (idx === undefined) return 'morph not found: ' + name
  mesh.morphTargetInfluences[idx] = value
  return 'ok ' + name + '=' + value
}, { name, value })

// baseline (rest pose, no motion, physics settled)
await new Promise((r) => setTimeout(r, 1500))
await shoot('0_baseline')

console.log(await setMorph('★貫通対策', 1.0))
await new Promise((r) => setTimeout(r, 500))
await shoot('1_kantsuu')

console.log(await setMorph('★Up_しっぽ', 1.0))
await new Promise((r) => setTimeout(r, 1500)) // tail physics needs settle time
await shoot('2_tail_up')

// also try during the worst motion from the previous round
await mainWindow.evaluate(() => window.__applyMotion({ name: 'idle_fix_hair', intensity: 1 }))
await new Promise((r) => setTimeout(r, 2300))
await shoot('3_fix_hair_with_morphs')

await cleanup()
process.exit(0)
