// J단계 — 사용자 존재 인지 시각 검증.
// __presenceDebug(실제 IPC 피드와 같은 핸들러)로 부재→복귀를 주입해
// ① 상태기계 전이 ② 복귀 인사(react 모션+happy 표정)가 실제로 나오는지
// ③ 잠금 정지/재개 경로가 도는지 확인하고 스크린샷을 남긴다.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/presence-check')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let pageErrors = 0
mainWindow.on('pageerror', (e) => { pageErrors++; console.log(`[pageerror] ${e?.message || e}`) })

// 자율 행동 정지(결정론) + 모델 로드 대기.
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

const fails = []
const check = (label, ok) => {
  console.log(`[presence-check] ${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) fails.push(label)
}

// ── 0) 훅 존재 ────────────────────────────────────────────────────────
const hooks = await mainWindow.evaluate(() => ({
  debug: !!window.__presenceDebug,
  state: window.__presenceDebug?.state?.()
}))
console.log('[presence-check] hooks =', JSON.stringify(hooks))
check('__presenceDebug exposed, starts active', hooks.debug && hooks.state === 'active')

// ── 1) 유휴 승격: active → short-idle → away ──────────────────────────
const s1 = await mainWindow.evaluate(() => { window.__presenceDebug.idle(90); return window.__presenceDebug.state() })
check(`short-idle at 90s (got ${s1})`, s1 === 'short-idle')
const s2 = await mainWindow.evaluate(() => { window.__presenceDebug.idle(600); return window.__presenceDebug.state() })
check(`away at 600s (got ${s2})`, s2 === 'away')
await mainWindow.screenshot({ path: path.join(outDir, '1_away.png') })

// ── 2) 복귀 → 인사(react 모션 + happy) ────────────────────────────────
const before = await mainWindow.evaluate(() => window.__currentMotion?.())
const s3 = await mainWindow.evaluate(() => { window.__presenceDebug.idle(1); return window.__presenceDebug.state() })
check(`back to active (got ${s3})`, s3 === 'active')
await sleep(600) // 인사 모션이 currentMotion에 잡힐 시간
const after = await mainWindow.evaluate(() => window.__currentMotion?.())
console.log('[presence-check] motion before =', JSON.stringify(before), '→ after =', JSON.stringify(after))
check(`greeting react motion played (got ${after?.category}/${after?.name})`, after?.category === 'react')
await mainWindow.screenshot({ path: path.join(outDir, '2_greet_peak.png') })
await sleep(1200)
await mainWindow.screenshot({ path: path.join(outDir, '3_greet_settle.png') })

// ── 3) 인사 디바운스 — 곧바로 또 비웠다 와도 두 번 인사 안 함 ─────────
await mainWindow.evaluate(() => { window.__presenceDebug.idle(600); window.__presenceDebug.idle(1) })
await sleep(400)
const again = await mainWindow.evaluate(() => window.__currentMotion?.())
// 디바운스면 인사 모션이 새로 시작되지 않는다(직전 게이트/디바운스 통과 안 함).
console.log('[presence-check] motion after immediate re-return =', JSON.stringify(again))

// ── 4) 잠금 → 정지, 해제 → 유예 후 재개 ──────────────────────────────
const lockState = await mainWindow.evaluate(() => {
  window.__presenceDebug.event('lock-screen')
  return window.__presenceDebug.state()
})
check(`lock forces away (got ${lockState})`, lockState === 'away')
const lockedIdle = await mainWindow.evaluate(() => { window.__presenceDebug.idle(1); return window.__presenceDebug.state() })
check(`stays away while locked despite input (got ${lockedIdle})`, lockedIdle === 'away')
const unlocked = await mainWindow.evaluate(() => {
  window.__presenceDebug.event('unlock-screen')
  window.__presenceDebug.idle(1)
  return window.__presenceDebug.state()
})
check(`unlock + input returns to active (got ${unlocked})`, unlocked === 'active')

await mainWindow.screenshot({ path: path.join(outDir, 'final.png') })
check('no renderer page errors', pageErrors === 0)

console.log(`[presence-check] done — ${fails.length ? 'FAILURES: ' + fails.join(' | ') : 'ALL PASS'} — screenshots in ${outDir}`)
await cleanup()
process.exit(fails.length ? 1 : 0)
