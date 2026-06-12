// H단계 검증: 비짐 타임라인 → 입 모프 연동.
//
//   단언 1: 'a' 구간(open 1.0)에서 あ > 0.5, い < 0.2
//   단언 2: 'i' 구간에서 い > 0.4 (모음 전환이 실제로 일어남)
//   단언 3: 타임라인 종료 후 모음 모프 5종 전부 < 0.05 (입 닫힘)
//   단언 4: 비정상 타임라인(NaN/초과 길이)은 sanitize가 거부 (false 반환)
//   단언 5: IPC 경로 — 채팅 창의 lipsync-start(value={timeline, offsetSec})
//           가 메인 창 입을 움직인다 (Codex 권고: __lipsyncPlay 훅만이
//           아니라 실제 창 간 경로도 커버)
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/lipsync-check')
mkdirSync(outDir, { recursive: true })

const { app, mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await new Promise((r) => setTimeout(r, 1500))

// 합성 타임라인: 1s 'a'(open 1) → 1s 'i'(open .8) → 0.5s 닫힘
const mkFrames = (...specs) => specs.flatMap(([n, open, vowel]) =>
  Array.from({ length: n }, () => ({ open, vowel })))
const TIMELINE = {
  duration: 2.5,
  step: 0.02,
  frames: mkFrames([50, 1.0, 'a'], [50, 0.8, 'i'], [25, 0, 'n'])
}

const mouth = () => mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  const d = mesh?.morphTargetDictionary
  const out = {}
  for (const n of ['あ', 'い', 'う', 'え', 'お']) {
    out[n] = d?.[n] === undefined ? null : +mesh.morphTargetInfluences[d[n]].toFixed(3)
  }
  return out
})

// ── 단언 1·2·3: 로컬 훅 재생 ────────────────────────────────────────
const accepted = await mainWindow.evaluate((tl) => window.__lipsyncPlay(tl), TIMELINE)
await new Promise((r) => setTimeout(r, 500))
const atA = await mouth()
await mainWindow.screenshot({ path: path.join(outDir, 'vowel_a.png') })
await new Promise((r) => setTimeout(r, 1000))
const atI = await mouth()
await mainWindow.evaluate(() => window.__lipsyncStop())
await new Promise((r) => setTimeout(r, 1200))
const after = await mouth()
console.log(`accepted=${accepted}`)
console.log(`t=0.5s(a): ${JSON.stringify(atA)}`)
console.log(`t=1.5s(i): ${JSON.stringify(atI)}`)
console.log(`after stop: ${JSON.stringify(after)}`)

const aOk = accepted === true && atA['あ'] > 0.5 && atA['い'] < 0.2
const iOk = atI['い'] > 0.4
const closedOk = Object.values(after).every((v) => v !== null && v < 0.05)

// ── 단언 4: sanitize 거부 ───────────────────────────────────────────
const badNaN = await mainWindow.evaluate(() =>
  window.__lipsyncPlay({ duration: 1, step: 0.02, frames: [{ open: NaN, vowel: 'a' }] }))
const badHuge = await mainWindow.evaluate(() =>
  window.__lipsyncPlay({ duration: 99999, step: 0.02, frames: [{ open: 1, vowel: 'a' }] }))
await mainWindow.evaluate(() => window.__lipsyncStop())
const sanitizeOk = badNaN === false && badHuge === false
console.log(`sanitize: NaN=${badNaN} huge=${badHuge}`)

// ── 단언 5: 채팅 창 → IPC 경로 ──────────────────────────────────────
let ipcOk = false
try {
  const [chatWindow] = await Promise.all([
    app.waitForEvent('window', { timeout: 10000 }),
    mainWindow.evaluate(() => window.api.chatToggle())
  ])
  await chatWindow.waitForLoadState('domcontentloaded')
  await chatWindow.evaluate((tl) => window.api.notifyCharacter({
    action: 'lipsync-start',
    value: { timeline: tl, offsetSec: 0.1 }
  }), TIMELINE)
  await new Promise((r) => setTimeout(r, 500))
  const viaIpc = await mouth()
  await chatWindow.evaluate(() => window.api.notifyCharacter({ action: 'lipsync-stop' }))
  console.log(`via IPC(a): ${JSON.stringify(viaIpc)}`)
  ipcOk = viaIpc['あ'] > 0.4
} catch (e) {
  console.error('IPC path error:', e?.message)
}

await cleanup()

console.log(`\naOk=${aOk} iOk=${iOk} closedOk=${closedOk} sanitizeOk=${sanitizeOk} ipcOk=${ipcOk}`)
if (!aOk || !iOk || !closedOk || !sanitizeOk || !ipcOk) {
  console.error('LIPSYNC CHECK FAILED')
  process.exit(1)
}
console.log('LIPSYNC CHECK PASSED')
process.exit(0)
