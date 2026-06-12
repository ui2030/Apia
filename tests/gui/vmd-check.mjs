import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/vmd-check')
mkdirSync(outDir, { recursive: true })

// All 9 motions (mermay removed from the pack — commit 098d184), multi-frame
// so we catch the "arm bent backwards" moment.
const motions = [
  'idle_confident', 'idle_air_scent', 'idle_fix_hair', 'idle_skywatch',
  'idle_stretch', 'idle_sway', 'idle_tidy', 'idle_tracker',
  'idle_impatient'
]

// Clipping often only shows from the side/back, so each sample point is
// captured from three yaw angles orbiting the character's upper body.
const ANGLES = [
  ['front', 0],
  ['side', Math.PI / 2],
  ['back', Math.PI]
]

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

// 단언 근거는 errorLogs만 — [VMD diag] 진단 라인은 정보용(diagLogs)이라
// 실패 판정에 섞이면 안 된다 (Codex 사전 검토 MUST-FIX).
const errorLogs = []
const diagLogs = []
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (t.includes('Electron Security')) return
  if (msg.type() === 'error' && !t.includes('unknown char code')) {
    errorLogs.push(`[error] ${t}`)
  }
  if (t.includes('[VMD diag]') || t.includes('[VMD] stripped')) {
    diagLogs.push(`[${msg.type()}] ${t}`)
  }
})

await new Promise((r) => setTimeout(r, 4500))

// Keep her planted at the spawn point — free-roam mid-test walks her behind
// the desk and the screenshots show furniture instead of the motion.
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))

// Orbit the live camera around the character at the given yaw offset
// (0 = the camera's own default bearing). Radius is clamped so side/back
// positions stay inside the room geometry instead of behind a wall.
async function setCameraAngle(yaw) {
  await mainWindow.evaluate((yawOffset) => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    if (!cam || !scene) return
    if (!window.__vmdCheckCam) {
      window.__vmdCheckCam = {
        pos: cam.position.clone(),
        quat: cam.quaternion.clone()
      }
    }
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const anchor = map.get('上半身') || map.get('センター') || mesh.skeleton.bones[0]
    const V = cam.position.constructor
    const center = anchor.getWorldPosition(new V())
    const base = window.__vmdCheckCam.pos
    const r = Math.min(
      Math.hypot(base.x - center.x, base.z - center.z), 2.4)
    const bearing = Math.atan2(base.x - center.x, base.z - center.z) + yawOffset
    cam.position.set(
      center.x + Math.sin(bearing) * r,
      base.y,
      center.z + Math.cos(bearing) * r
    )
    cam.lookAt(center)
  }, yaw)
  // one breath for the moved camera to be rendered before the screenshot
  await new Promise((r) => setTimeout(r, 150))
}

async function restoreCamera() {
  await mainWindow.evaluate(() => {
    const cam = window.__apiaCamera
    const saved = window.__vmdCheckCam
    if (cam && saved) {
      cam.position.copy(saved.pos)
      cam.quaternion.copy(saved.quat)
    }
  })
}

async function snapshot(label) {
  for (const [suffix, yaw] of ANGLES) {
    await setCameraAngle(yaw)
    await mainWindow.screenshot({ path: path.join(outDir, `${label}_${suffix}.png`) })
  }
  await restoreCamera()
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

// Rest pose first — the procedural idle (no clip) is where the original
// "hands behind the back" bug lived (Layer 6 over-abduction), so it gets
// its own 3-angle capture before any motion plays.
await new Promise((r) => setTimeout(r, 2000))
console.log('\n=== rest (no clip) ===')
console.log('  rest:', JSON.stringify(await snapshot('rest')))

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

if (diagLogs.length) {
  console.log('\n========== diag logs (정보용, 실패 판정 아님) ==========')
  for (const l of diagLogs) console.log(l)
}

await cleanup()

// 단언: 렌더러 콘솔에 [error]가 한 줄이라도 있으면 실패
if (errorLogs.length) {
  console.error('\n========== error logs ==========')
  for (const l of errorLogs) console.error(l)
  console.error('VMD CHECK FAILED')
  process.exit(1)
}
console.log('VMD CHECK PASSED')
process.exit(0)
