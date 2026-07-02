// 클립 소유 모프 양보 라이브 검증 — 표정 트랙이 든 VMD를 재생하고, 그 모프가
// 실제로 클립에 의해 움직이는지(절차 표정에 0으로 덮이지 않는지) 샘플링한다.
import { launchApia } from './helpers/launchApia.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let pageErrors = 0
let ownsLog = null
mainWindow.on('pageerror', (e) => { pageErrors++; console.log(`[pageerror] ${e?.message || e}`) })
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (t.includes('clip owns morph tracks')) ownsLog = t
})
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
await sleep(2500) // 로드 재안착까지 지나서 시작

const fails = []
const check = (label, ok) => {
  console.log(`[clip-morph] ${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) fails.push(label)
}

// 표정 트랙이 든 로컬 클립을 재생(폴더 규약 자동등록: idle/air_scent.vmd →
// idle_air_scent). air_scent는 まばたき(깜빡임)를 15키로 직접 연출한다.
await mainWindow.evaluate(() => { window.__playMotion?.('idle', 'idle_air_scent') })
await sleep(1500) // 클립 로드+페이드

// 소유권 로그는 콘솔 캡처 타이밍에 따라 플레이키 — 참고용으로만 남긴다.
// (기능 판정은 아래 "클립 깜빡임이 화면에 도달"이 담당.)
console.log(`[clip-morph] ownership log captured: ${ownsLog ? 'yes' : 'no (informational)'}`)

// 클립 한 사이클(~11s) 동안 まばたき 영향치를 샘플링 — 클립이 연출한
// 깜빡임이 실제로 화면 모프에 도달하는지(절차 표정에 안 덮이는지).
const series = []
for (let i = 0; i < 110; i++) {
  const v = await mainWindow.evaluate(() => {
    let mesh = null
    window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return null
    const dict = mesh.morphTargetDictionary || {}
    return { blink: mesh.morphTargetInfluences[dict['まばたき']] ?? null }
  })
  if (v) series.push(v.blink)
  await sleep(100)
}
const peaks = series.filter((b) => b !== null && b > 0.5).length
const max = Math.max(...series.filter((b) => b !== null))
console.log(`[clip-morph] blink samples=${series.length} max=${max?.toFixed(3)} peaks(>0.5)=${peaks}`)
check('clip-driven blink actually reaches the screen (max > 0.5)', max > 0.5)
check('no renderer page errors', pageErrors === 0)

console.log(`[clip-morph] done — ${fails.length ? 'FAILURES: ' + fails.join(' | ') : 'ALL PASS'}`)
await cleanup()
process.exit(fails.length ? 1 : 0)
