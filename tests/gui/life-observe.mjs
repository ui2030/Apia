// J단계 — 자율 생활 실관찰(회귀 sanity). 자율 행동을 켠 채 일정 시간 돌리며
// 모션/활동/욕구 변화를 로그로 남기고 주기 스크린샷을 찍는다. 판정은 최소한만
// (페이지 에러 0, 자율 행동이 실제로 일어났는가) — 나머지는 사람이 컷을 본다.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/life-observe')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OBSERVE_MS = 90000

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let pageErrors = 0
mainWindow.on('pageerror', (e) => { pageErrors++; console.log(`[pageerror] ${e?.message || e}`) })

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
await sleep(1000)

// 자율 행동 켜기(launchApia 기본이 꺼짐일 수 있어 명시).
await mainWindow.evaluate(() => window.__setAutoBehavior?.(true)).catch(() => {})

const seenMotions = new Set()
let sawActivity = false
const start = Date.now()
let shot = 0
while (Date.now() - start < OBSERVE_MS) {
  const snap = await mainWindow.evaluate(() => ({
    motion: window.__currentMotion?.(),
    activity: window.__activityInfo?.(),
    needs: window.__needs?.(),
    presence: window.__presenceDebug?.state?.()
  }))
  const m = snap.motion ? `${snap.motion.category}/${snap.motion.name}` : 'none'
  if (snap.motion?.name) seenMotions.add(snap.motion.name)
  if (snap.activity?.active) sawActivity = true
  console.log(`[life] +${Math.round((Date.now() - start) / 1000)}s motion=${m} state=${snap.activity?.state} activity=${snap.activity?.id || '-'} presence=${snap.presence}`)
  if ((Date.now() - start) / 15000 >= shot) {
    await mainWindow.screenshot({ path: path.join(outDir, `life_t${shot}.png`) })
    shot++
  }
  await sleep(5000)
}

const needs = await mainWindow.evaluate(() => window.__needs?.())
console.log('[life] final needs =', JSON.stringify(needs))
console.log('[life] distinct motions seen =', seenMotions.size, [...seenMotions].join(','))
console.log('[life] activity ran =', sawActivity)
const ok = pageErrors === 0 && seenMotions.size >= 2
console.log(`[life] ${ok ? 'PASS' : 'FAIL'} (pageErrors=${pageErrors}, motions=${seenMotions.size})`)
await cleanup()
process.exit(ok ? 0 : 1)
