// E2E — 후처리(블룸+비네트) 검증: ① on/off A/B 스크린샷(노을+밤) ② 투명 영역
// 알파 불변(방 밖 픽셀 on/off 동일 — 과거 블룸 알파 파손 회귀 감시) ③ 성능
// (rAF 평균 프레임시간 on/off, 예산 +4ms) ④ 콘솔 에러. 실패 시 exit 1.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
const outDir = path.resolve('test-results/postfx')
mkdirSync(outDir, { recursive: true })
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let fails = 0
const errors = []
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (msg.type() === 'error' && !t.includes('unknown char code') && !t.includes('Electron Security')) errors.push(t)
})
await new Promise((r) => setTimeout(r, 5500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await mainWindow.evaluate(() => {
  document.querySelectorAll('[class*="bubble" i],[id*="bubble" i]').forEach((e) => { e.style.display = 'none' })
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 투명 영역 알파 판독 — 캔버스 좌상단(방 밖, 데스크톱 노출 영역) readPixels
const readCornerAlpha = () => mainWindow.evaluate(() => {
  const canvas = document.getElementById('vrm-canvas')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  const px = new Uint8Array(4)
  gl.readPixels(10, gl.drawingBufferHeight - 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return Array.from(px)
})

// 성능 — 300프레임 평균 rAF 델타(ms)
const measureFps = () => mainWindow.evaluate(async () => {
  const N = 300
  let last = performance.now()
  let sum = 0
  for (let i = 0; i < N; i++) {
    await new Promise((r) => requestAnimationFrame(r))
    const now = performance.now()
    sum += now - last
    last = now
  }
  return sum / N
})

for (const [label, hour] of [['sunset18', 18], ['night22', 22]]) {
  await mainWindow.evaluate((h) => window.__setLightingHour?.(h), hour)
  await wait(700)
  await mainWindow.evaluate(() => window.__setPostFx?.(true))
  await wait(300)
  await mainWindow.screenshot({ path: path.join(outDir, `${label}_on.png`) })
  const alphaOn = await readCornerAlpha()
  await mainWindow.evaluate(() => window.__setPostFx?.(false))
  await wait(300)
  await mainWindow.screenshot({ path: path.join(outDir, `${label}_off.png`) })
  const alphaOff = await readCornerAlpha()
  console.log(`${label}: cornerRGBA on=${JSON.stringify(alphaOn)} off=${JSON.stringify(alphaOff)}`)
  if (JSON.stringify(alphaOn) !== JSON.stringify(alphaOff)) {
    console.error(`FAIL alpha mismatch @${label}`)
    fails++
  }
  await mainWindow.evaluate(() => window.__setPostFx?.(true))
}

await mainWindow.evaluate(() => window.__setPostFx?.(true))
const msOn = await measureFps()
await mainWindow.evaluate(() => window.__setPostFx?.(false))
const msOff = await measureFps()
await mainWindow.evaluate(() => window.__setPostFx?.(true))
console.log(`frame avg: postFx ON ${msOn.toFixed(2)}ms / OFF ${msOff.toFixed(2)}ms`)
if (msOn - msOff > 4) { console.error(`FAIL postFx cost ${(msOn - msOff).toFixed(2)}ms > 4ms budget`); fails++ }
if (errors.length) { console.error('console errors:', JSON.stringify(errors.slice(0, 5))); fails += errors.length }
await cleanup()
console.log(fails ? `POSTFX CHECK FAILED (${fails})` : 'POSTFX CHECK PASSED')
process.exit(fails ? 1 : 0)
