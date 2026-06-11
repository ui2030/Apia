// One-off: capture the poseRig fingerprint log + the arm bones' actual
// quaternions at boot (procedural rest) so the VMD arm correction math
// uses measured values, not guesses.
import { launchApia } from './helpers/launchApia.mjs'

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (t.includes('[poseRig]') || t.includes('[Apia MMD')) console.log('[console]', t)
})

await new Promise((r) => setTimeout(r, 5000))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))

const sample = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const dump = (n) => {
    const b = map.get(n)
    if (!b) return null
    const q = b.quaternion
    const e = { _x: 0, _y: 0, _z: 0 }
    return { quat: [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(4)), pos: b.position.toArray().map((v) => +v.toFixed(3)) }
  }
  return {
    lArm: dump('左腕'), rArm: dump('右腕'),
    lElbow: dump('左ひじ'), rElbow: dump('右ひじ'),
    lShoulder: dump('左肩'), rShoulder: dump('右肩')
  }
})
console.log('boot-state bones:', JSON.stringify(sample, null, 1))

const poseInfo = await mainWindow.evaluate(() => window.__apiaPoseInfo?.() ?? null)
console.log('poseRig fingerprint:', JSON.stringify(poseInfo?.fingerprint, null, 1))
console.log('arm restEuler:', JSON.stringify({
  lArm: poseInfo?.restEuler?.lArm,
  rArm: poseInfo?.restEuler?.rArm,
  lShoulder: poseInfo?.restEuler?.lShoulder,
  rShoulder: poseInfo?.restEuler?.rShoulder
}, null, 1))

await cleanup()
process.exit(0)
