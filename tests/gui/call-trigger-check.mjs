// 채팅 열기 = 호출 트리거 검증. 자율 활동 중 #chat-toggle 클릭 → respondCall로 선점.
import { launchApia } from './helpers/launchApia.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
for (let i = 0; i < 40; i++) { const r = await mainWindow.evaluate(() => { let m = null; window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o }); return !!m }); if (r) break; await sleep(400) }
await sleep(800)

await mainWindow.evaluate(() => window.__startActivity?.('brewCoffee'))
await sleep(2000)
console.log('[trig] during coffee =', JSON.stringify(await mainWindow.evaluate(() => window.__activityInfo?.())))

// 채팅 토글 클릭 = 부름
const clicked = await mainWindow.evaluate(() => {
  const t = document.getElementById('chat-toggle')
  if (!t) return 'no-toggle'
  t.click(); return 'clicked'
})
console.log('[trig] chat-toggle =', clicked)
await sleep(800)
console.log('[trig] after open =', JSON.stringify(await mainWindow.evaluate(() => window.__activityInfo?.())))
await cleanup(); process.exit(0)
