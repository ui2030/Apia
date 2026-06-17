// 앉기 검증 — GLB 의자(chairCushion)로 바뀐 뒤에도 캐릭터가 좌면 높이에
// 맞게 앉는지. 의자 world 버튼을 클릭 → 걷기 → 앉기 후 스크린샷.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/sit-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
await new Promise((r) => setTimeout(r, 1000))

// 의자 상호작용 트리거 — world 버튼 클릭(없으면 매니저 직접 호출 폴백).
const triggered = await mainWindow.evaluate(() => {
  const btn = document.querySelector('[data-object-id="chair_window"]')
  if (btn) { btn.click(); return 'button' }
  return 'none'
})
console.log('[sit-check] trigger =', triggered)

// 걷기 + 앉기 정착 대기.
await new Promise((r) => setTimeout(r, 7000))

const state = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let model = null
  scene?.traverse((o) => { if (!model && o.skeleton) model = o })
  // 캐릭터 루트 y(발 높이)와 대략적 상태 추정용
  let chairY = null
  scene?.traverse((o) => {
    if (o.name === 'furniture-chair_window') {
      const v = new o.position.constructor()
      o.getWorldPosition(v); chairY = +v.y.toFixed(2)
    }
  })
  return { hasModel: !!model, chairY }
})
console.log('[sit-check]', JSON.stringify(state))

await mainWindow.screenshot({ path: path.join(outDir, 'sit.png') })

// 의자 가까이 줌인해서 앉은 높이(뜸/파묻힘) 확인.
await mainWindow.evaluate(() => {
  const cam = window.__apiaCamera
  if (!cam) return
  cam.position.set(5.4, 0.95, 3.4) // 의자 오른쪽 측면, 좌면 높이
  cam.lookAt(1.95, 0.6, 3.4)
  cam.updateProjectionMatrix()
})
await new Promise((r) => setTimeout(r, 600))
await mainWindow.screenshot({ path: path.join(outDir, 'sit_zoom.png') })
console.log('[sit-check] screenshots saved')
await cleanup()
process.exit(0)
