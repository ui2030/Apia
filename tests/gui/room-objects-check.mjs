// J단계 — 새 스마트 오브젝트(컴퓨터 너머 마주보기 + 화장실) 시각 검증.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
const out = path.resolve('test-results/room-objects'); mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
for (let i = 0; i < 40; i++) { const r = await mainWindow.evaluate(() => { let m = null; window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o }); return !!m }); if (r) break; await sleep(400) }
await sleep(800)
const hideBubble = () => mainWindow.evaluate(() => { const b = document.getElementById('speech-bubble'); if (b) b.style.display = 'none' })

const acts = await mainWindow.evaluate(() => window.__listActivities?.() || [])
console.log('[room] activities =', JSON.stringify(acts))
for (const id of ['useComputer', 'bathroom']) if (!acts.includes(id)) console.log('[room] WARN missing', id)

// 빈 방(데스크/모니터 배치 확인)
await hideBubble(); await mainWindow.screenshot({ path: path.join(out, 'room_empty.png') })

// 컴퓨터 너머 마주보기 — 책상 의자에 앉아 카메라(사용자)를 향함
console.log('[room] useComputer =', await mainWindow.evaluate(() => window.__startActivity?.('useComputer')))
await sleep(7000) // 걸어가 앉기
await hideBubble(); await mainWindow.screenshot({ path: path.join(out, 'computer_sit.png') })
console.log('[room] state after sit =', await mainWindow.evaluate(() => window.__clipFlags?.()?.state))

await mainWindow.evaluate(() => window.__abortActivity?.()); await sleep(500)

// 화장실 — 문으로 감
console.log('[room] bathroom =', await mainWindow.evaluate(() => window.__startActivity?.('bathroom')))
await sleep(5000)
await hideBubble(); await mainWindow.screenshot({ path: path.join(out, 'bathroom.png') })
console.log('[room] done')
await cleanup(); process.exit(0)
