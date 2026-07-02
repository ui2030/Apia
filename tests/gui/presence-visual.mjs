// J단계 — 복귀 인사 클로즈업 검수(해부학적 자연스러움용 스크린샷).
// 채팅 패널/말풍선을 숨기고 카메라를 상체에 프레이밍한 뒤, 부재→복귀를 주입해
// 인사 모션의 진행을 정면 연속 컷으로 남긴다.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/presence-visual')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
async function modelReady() {
  return mainWindow.evaluate(() => {
    let m = null
    window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
    return !!m
  })
}
{
  const end = Date.now() + 25000
  while (Date.now() < end) { if (await modelReady()) break; await sleep(400) }
}
await sleep(1200)

// 오버레이 숨김 + 정면 상체 프레이밍(coffee-check hero 컷과 같은 방식).
await mainWindow.evaluate(() => {
  for (const id of ['chat-panel', 'speech-bubble']) {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  }
  let m = null
  window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
  const cam = window.__apiaCamera
  if (!m || !cam) return
  const v = new m.position.constructor(); m.getWorldPosition(v)
  cam.position.set(v.x, v.y + 1.1, v.z + 2.1)
  cam.lookAt(v.x, v.y + 0.9, v.z)
  cam.updateProjectionMatrix()
})
await sleep(400)
await mainWindow.screenshot({ path: path.join(outDir, '0_idle_front.png') })

// 측면 컷(해부학 검수는 다각도).
await mainWindow.evaluate(() => {
  let m = null
  window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
  const cam = window.__apiaCamera
  if (!m || !cam) return
  const v = new m.position.constructor(); m.getWorldPosition(v)
  cam.position.set(v.x + 2.0, v.y + 1.1, v.z + 0.3)
  cam.lookAt(v.x, v.y + 0.9, v.z)
  cam.updateProjectionMatrix()
})
await sleep(300)
await mainWindow.screenshot({ path: path.join(outDir, '0_idle_side.png') })

// 정면 복귀 후 부재→복귀 주입, 인사 진행을 0.4s 간격 6컷.
await mainWindow.evaluate(() => {
  let m = null
  window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
  const cam = window.__apiaCamera
  if (!m || !cam) return
  const v = new m.position.constructor(); m.getWorldPosition(v)
  cam.position.set(v.x, v.y + 1.1, v.z + 2.1)
  cam.lookAt(v.x, v.y + 0.9, v.z)
  cam.updateProjectionMatrix()
})
await mainWindow.evaluate(() => {
  window.__presenceDebug.idle(600)
  window.__presenceDebug.idle(1)
})
for (let i = 0; i < 6; i++) {
  await sleep(400)
  await mainWindow.screenshot({ path: path.join(outDir, `greet_t${i}.png`) })
}
const motion = await mainWindow.evaluate(() => window.__currentMotion?.())
console.log('[presence-visual] greet motion =', JSON.stringify(motion))
console.log('[presence-visual] done — screenshots in', outDir)
await cleanup()
process.exit(0)
