// 매무새 재안착 실험 — 로드 직후 옷자락 상태(엉킴 여부) → __reseatPhysics →
// 회복 여부를 측면·후면 컷으로 비교. 그리고 걷기 2회로 흔든 뒤 한 번 더.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/reseat-experiment')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
{
  const end = Date.now() + 25000
  while (Date.now() < end) {
    const ok = await mainWindow.evaluate(() => {
      let m = null
      window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
      return !!m
    })
    if (ok) break
    await sleep(400)
  }
}
await sleep(2000)

async function shot(dx, dz, file) {
  await mainWindow.evaluate(({ dx, dz }) => {
    for (const id of ['chat-panel', 'speech-bubble']) {
      const el = document.getElementById(id)
      if (el) el.style.display = 'none'
    }
    let mesh = null
    window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const cam = window.__apiaCamera
    if (!mesh || !cam) return
    const v = mesh.getWorldPosition(new mesh.position.constructor())
    cam.position.set(v.x + dx, v.y + 0.8, v.z + dz)
    cam.lookAt(v.x, v.y + 0.65, v.z)
    cam.updateProjectionMatrix()
  }, { dx, dz })
  await sleep(300)
  await mainWindow.screenshot({ path: path.join(outDir, file) })
}

await shot(1.7, 0.3, '1_load_side.png')
await shot(0.3, -1.9, '1_load_back.png')

const r1 = await mainWindow.evaluate(() => window.__reseatPhysics?.())
console.log('[reseat] after-load reseat =', r1)
await sleep(1500)
await shot(1.7, 0.3, '2_reseat_side.png')
await shot(0.3, -1.9, '2_reseat_back.png')

// 걷기 2회로 물리를 흔든다(엉킴 유발 시도).
for (let i = 0; i < 2; i++) {
  await mainWindow.evaluate(() => window.__walkTo?.(2.0))
  await sleep(5000)
}
await sleep(2000)
await shot(1.7, 0.3, '3_after_walks_side.png')

const r2 = await mainWindow.evaluate(() => window.__reseatPhysics?.())
console.log('[reseat] after-walk reseat =', r2)
await sleep(1500)
await shot(1.7, 0.3, '4_reseat2_side.png')

// 모니터 틱 스모크(기준선 캡처 → 감지 경로가 에러 없이 도는지).
const t1 = await mainWindow.evaluate(() => window.__clothMonitorTick?.())
const t2 = await mainWindow.evaluate(() => window.__clothMonitorTick?.())
console.log('[reseat] monitor tick streaks =', t1, t2)

console.log('[reseat] done —', outDir)
await cleanup()
process.exit(0)
