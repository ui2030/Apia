// 연기 클립 검수 하네스 — 어휘 편입 후보를 하나씩 재생하며 시점 3개 × 각도 3개
// (정면/우측/후면) 스크린샷을 남긴다. 판정은 사람이(해부학·뚫림·자연스러움) —
// 이 스크립트는 결정론적 채집만 담당한다.
// 사용: node tests/gui/motion-audit.mjs [클립명들...] (기본: 후보 8종)
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['air_scent', 'fix_hair', 'impatient', 'skywatch', 'stretch', 'sway', 'tidy', 'tracker']

const outDir = path.resolve('test-results/motion-audit')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))
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
await sleep(2500) // 로드 재안착 후 시작

const ANGLES = {
  front: { dx: 0, dz: 2.1 },
  right: { dx: 2.1, dz: 0.2 },
  // 캐릭터가 뒷벽 가까이 서므로 순수 -z는 벽 밖 — 대각 후방(방 안쪽)에서.
  back: { dx: -1.1, dz: -1.15 }
}

async function shot(angle, file) {
  const { dx, dz } = ANGLES[angle]
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
    cam.position.set(v.x + dx, v.y + 1.05, v.z + dz)
    cam.lookAt(v.x, v.y + 0.85, v.z)
    cam.updateProjectionMatrix()
  }, { dx, dz })
  await sleep(250)
  await mainWindow.screenshot({ path: path.join(outDir, file) })
}

for (const name of CANDIDATES) {
  console.log(`[audit] ▶ idle_${name}`)
  await mainWindow.evaluate((n) => { window.__playMotion?.('idle', `idle_${n}`) }, name)
  // 시점 3개: 도입(1.2s) / 중반 피크(3.5s) / 후반(6s). 각 시점에 3각도.
  const marks = [[1200, 't1'], [2300, 't2'], [2500, 't3']] // 누적 대기(1.2s→3.5s→6.0s)
  for (const [wait, tag] of marks) {
    await sleep(wait)
    for (const angle of Object.keys(ANGLES)) {
      await shot(angle, `${name}_${tag}_${angle}.png`)
    }
  }
  const cur = await mainWindow.evaluate(() => window.__currentMotion?.())
  console.log(`[audit]   current motion = ${cur?.category}/${cur?.name}`)
  // 다음 후보 전에 절차 idle로 손 놓고, 직전 클립이 흐트린 옷 매무새를
  // 재안착(오염 없는 독립 채집 — 클립별 공정 평가).
  await mainWindow.evaluate(() => { window.__playMotion?.('idle', 'idle_breath_soft') })
  await sleep(1200)
  await mainWindow.evaluate(() => window.__reseatPhysics?.())
  await sleep(900)
}

console.log('[audit] done —', outDir)
await cleanup()
process.exit(0)
