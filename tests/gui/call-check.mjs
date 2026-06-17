// J단계 — 호출 응답 = 최우선 인터럽트 검증.
// 자율 활동(커피) 진행 중 호출(respondToCall)하면 멈추고 컴퓨터(deskChair)로 와
// 앉아 "불렀어?"가 되는지(priority 활동), 그리고 유휴 후 자율 복귀하는지 확인.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve('test-results/call-check'); mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
for (let i = 0; i < 40; i++) { const r = await mainWindow.evaluate(() => { let m = null; window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o }); return !!m }); if (r) break; await sleep(400) }
await sleep(800)
const hideBubble = () => mainWindow.evaluate(() => { const b = document.getElementById('speech-bubble'); if (b) b.style.display = 'none' })

// 1) 자율 활동 시작(커피) — 부엌으로 걸어가는 중
await mainWindow.evaluate(() => window.__startActivity?.('brewCoffee'))
await sleep(2500)
console.log('[call] during coffee =', JSON.stringify(await mainWindow.evaluate(() => window.__activityInfo?.())))

// 2) 호출! — 하던 일 멈추고 컴퓨터로 와야 함
await mainWindow.evaluate(() => window.__respondToCall?.())
console.log('[call] right after call =', JSON.stringify(await mainWindow.evaluate(() => window.__activityInfo?.())))
await sleep(7000) // 컴퓨터로 걸어가 앉기

const info = await mainWindow.evaluate(() => window.__activityInfo?.())
console.log('[call] after arriving =', JSON.stringify(info))
await hideBubble(); await mainWindow.screenshot({ path: path.join(out, 'responded.png') })

// 3) 디바운스 — 다시 호출해도 자리 유지(재경로 안 함)
await mainWindow.evaluate(() => window.__respondToCall?.())
await sleep(1500)
console.log('[call] after 2nd call =', JSON.stringify(await mainWindow.evaluate(() => window.__activityInfo?.())))

console.log('[call] done')
await cleanup(); process.exit(0)
