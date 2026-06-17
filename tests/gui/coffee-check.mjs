// J단계 거주형 비서 — 스마트 오브젝트/소품 시각 검증.
// 자율 발동을 끄고 디버그 훅으로 ① 손 소품(컵/유리잔/책)을 직접 들려 손에 잘
// 붙는지 ② 커피 전체 사슬(걷기→내리기→컵 들고→앉아 마시기→정리)에서 컵이 손에
// 들리는지를 결정론적으로 트리거하고 스크린샷으로 남긴다(개발자가 눈으로 확인).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/coffee-check')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})

// 모델(스켈레톤) 로드 대기.
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
await sleep(800)

// ── 어포던스 목록 확인 ───────────────────────────────────────────────
const activities = await mainWindow.evaluate(() => window.__listActivities?.() || [])
console.log('[coffee-check] activities =', JSON.stringify(activities))
const expected = ['brewCoffee', 'rest', 'waterPlant', 'readBook', 'drinkWater']
const missing = expected.filter((id) => !activities.includes(id))
if (missing.length) console.log('[coffee-check] WARN missing activities:', missing.join(','))

// DOM 말풍선 오버레이를 숨긴다(카메라와 무관하게 상체를 가리므로).
async function hideBubble() {
  await mainWindow.evaluate(() => {
    const b = document.getElementById('speech-bubble')
    if (b) b.style.display = 'none'
  })
}

// 들고 있는 소품(손) 위치로 카메라를 바짝 줌인 — 컵이 손에 어떻게 붙었는지 확인.
async function zoomToHeldProp() {
  await hideBubble()
  await mainWindow.evaluate(() => {
    const st = window.__heldPropState?.()
    const cam = window.__apiaCamera
    if (!st?.pos || !cam) return
    const p = st.pos
    cam.position.set(p.x - 0.28, p.y + 0.06, p.z + 0.34)
    cam.lookAt(p.x, p.y - 0.02, p.z)
    cam.updateProjectionMatrix()
  })
}

// ── 1) 손 소품 직접 부착 — 컵/유리잔/책 ──────────────────────────────
const propShots = {}
for (const kind of ['cup', 'glass', 'book']) {
  await mainWindow.evaluate((k) => window.__attachProp?.(k, 'right'), kind)
  await sleep(700) // sync 몇 프레임
  const st = await mainWindow.evaluate(() => window.__heldPropState?.())
  propShots[kind] = st
  console.log(`[coffee-check] prop ${kind} =`, JSON.stringify(st))
  await hideBubble()
  await mainWindow.screenshot({ path: path.join(outDir, `prop_${kind}_full.png`) })
  await zoomToHeldProp()
  await sleep(400)
  await mainWindow.screenshot({ path: path.join(outDir, `prop_${kind}_zoom.png`) })
}
await mainWindow.evaluate(() => window.__detachProp?.())
await sleep(300)
const afterDetach = await mainWindow.evaluate(() => window.__heldPropState?.())
console.log('[coffee-check] after detach =', JSON.stringify(afterDetach))

// ── 2) 커피 전체 사슬 — 컵이 사슬 중 손에 들리는지 ──────────────────
// 카메라 원위치(전체 동선 보이게) 후 발동.
await mainWindow.evaluate(() => {
  // 기본 프레이밍 복원 시도(없으면 둠).
  window.__apiaResetCamera?.()
})
const started = await mainWindow.evaluate(() => window.__startActivity?.('brewCoffee'))
console.log('[coffee-check] brewCoffee started =', started)

let sawCupInChain = false
let drinkShotTaken = false
let cupSeenAt = 0
const chainEnd = Date.now() + 28000
let i = 0
while (Date.now() < chainEnd) {
  const snap = await mainWindow.evaluate(() => ({
    active: window.__activityActive?.(),
    prop: window.__heldPropState?.()
  }))
  if (snap.prop?.kind === 'cup') {
    if (!sawCupInChain) { sawCupInChain = true; cupSeenAt = Date.now() }
    // 컵을 든 뒤 ~9초(의자까지 걸어가 앉는 시간) 지나면 "마시는" 순간을 줌으로.
    if (!drinkShotTaken && Date.now() - cupSeenAt > 9000) {
      drinkShotTaken = true
      await hideBubble()
      await mainWindow.screenshot({ path: path.join(outDir, 'chain_drink_full.png') })
      await zoomToHeldProp()
      await sleep(300)
      await mainWindow.screenshot({ path: path.join(outDir, 'chain_drink_zoom.png') })
    }
  }
  if (i % 5 === 0) { await hideBubble(); await mainWindow.screenshot({ path: path.join(outDir, `chain_t${i}.png`) }) }
  if (!snap.active && i > 4) { console.log('[coffee-check] chain finished at i=', i); break }
  i++
  await sleep(700)
}
console.log('[coffee-check] sawCupInChain =', sawCupInChain, 'drinkShot =', drinkShotTaken)

// ── 3) 깨끗한 "마시는" 히어로 컷 — 왼손 컵 + 손을 얼굴로 올리는 포즈(talk_think) ──
await mainWindow.evaluate(() => window.__abortActivity?.())
await sleep(400)
await mainWindow.evaluate(() => { window.__detachProp?.(); window.__attachProp?.('cup', 'left') })
await mainWindow.evaluate(() => window.__playMotion?.('talk', 'talk_think'))
await sleep(2200) // 포즈가 손을 얼굴로 올릴 시간
await hideBubble()
await mainWindow.evaluate(() => {
  // 정면(+z)에서 상체를 프레이밍.
  let m = null
  window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
  const cam = window.__apiaCamera
  if (!m || !cam) return
  const v = new m.position.constructor(); m.getWorldPosition(v)
  cam.position.set(v.x, v.y + 1.15, v.z + 1.7)
  cam.lookAt(v.x, v.y + 0.95, v.z)
  cam.updateProjectionMatrix()
})
await sleep(400)
await mainWindow.screenshot({ path: path.join(outDir, 'hero_drink.png') })
const heroProp = await mainWindow.evaluate(() => window.__heldPropState?.())
console.log('[coffee-check] hero prop =', JSON.stringify(heroProp))

await mainWindow.screenshot({ path: path.join(outDir, 'final.png') })
console.log('[coffee-check] done — screenshots in', outDir)
await cleanup()
process.exit(0)
