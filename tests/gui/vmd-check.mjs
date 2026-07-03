import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/vmd-check')
mkdirSync(outDir, { recursive: true })

// All 9 motions (mermay removed from the pack — commit 098d184), multi-frame
// so we catch the "arm bent backwards" moment.
// argv로 모션 이름을 주면 그것만 검사한다(신규 클립 검수용):
//   node tests/gui/vmd-check.mjs react_giggle idle_curious
const DEFAULT_MOTIONS = [
  'idle_confident', 'idle_air_scent', 'idle_fix_hair', 'idle_skywatch',
  'idle_stretch', 'idle_sway', 'idle_tidy', 'idle_tracker',
  'idle_impatient'
]
const argMotions = process.argv.slice(2).filter((a) => /^[a-z]+_[a-z0-9_]+$/.test(a))
const motions = argMotions.length ? argMotions : DEFAULT_MOTIONS

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
  if (t.includes('[VMD diag]') || t.includes('[VMD] stripped') || t.includes('clip owns morph') ||
      t.includes('PropertyBinding')) {
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
  // 수치 판독을 스크린샷 **앞**에서 — 3각도 촬영이 ~1.5s 걸려, 뒤에서 읽으면
  // 짧은 연기 클립은 이미 끝난 값을 보고한다(전신 연기 v2 QA에서 실측한 함정).
  const pose = await readPose()
  for (const [suffix, yaw] of ANGLES) {
    await setCameraAngle(yaw)
    await mainWindow.screenshot({ path: path.join(outDir, `${label}_${suffix}.png`) })
  }
  await restoreCamera()
  return pose
}

async function readPose() {
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
    // 활성 모프(>0.05)도 보고 — 표정 트랙이 실제 적용되는지 QA(스크린샷
    // 거리에선 얼굴이 작아 모프를 눈으로 판정하기 어렵다).
    const morphs = {}
    const dict = mesh.morphTargetDictionary || {}
    const infl = mesh.morphTargetInfluences || []
    for (const [name, idx] of Object.entries(dict)) {
      const w = infl[idx]
      if (w > 0.05) morphs[name] = Number(w.toFixed(2))
    }
    return {
      lArm: q('左腕'),
      rArm: q('右腕'),
      lElbow: q('左ひじ'),
      rElbow: q('右ひじ'),
      morphs,
    }
  })
}

// Rest pose first — the procedural idle (no clip) is where the original
// "hands behind the back" bug lived (Layer 6 over-abduction), so it gets
// its own 3-angle capture before any motion plays.
await new Promise((r) => setTimeout(r, 2000))
console.log('\n=== rest (no clip) ===')
console.log('  rest:', JSON.stringify(await snapshot('rest')))

// 샘플 시점(초) — APIA_VMD_SAMPLES="1.0,2.0"로 재정의 가능(짧은 연기 클립의
// 피크 프레임 검수용). 주의: snapshot 자체가 ~1.5s 걸려 뒤 샘플일수록 명목
// 시각보다 늦게 찍힌다 — 정밀해야 하는 피크는 첫 샘플에 배치할 것.
const SAMPLE_TIMES = (process.env.APIA_VMD_SAMPLES || '0.8,2.3')
  .split(',').map(Number).filter((v) => Number.isFinite(v) && v > 0)

for (const name of motions) {
  console.log(`\n=== ${name} ===`)
  await mainWindow.evaluate((n) => window.__applyMotion({ name: n, intensity: 1 }), name)
  let prev = 0
  for (let i = 0; i < SAMPLE_TIMES.length; i++) {
    const t = SAMPLE_TIMES[i]
    await new Promise((r) => setTimeout(r, Math.max(0, (t - prev) * 1000)))
    prev = t
    const suffix = String.fromCharCode(97 + i) // a, b, c…
    console.log(`  t=${t}s:`, JSON.stringify(await snapshot(`${name}_${suffix}`)))
  }
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
