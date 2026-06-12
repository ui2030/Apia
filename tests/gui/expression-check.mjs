// G단계 검증: 감정 → PMX 표정 모프 연동 + 깜빡임.
//
//   단언 1: 핵심 표정 모프(笑い·まばたき·困る·怒り·びっくり)가 모델에
//           존재한다 — 없으면 조용히 스킵하지 말고 실패 (Codex 권고).
//   단언 2: __applyEmotion('happy') 1s 후 笑い·にっこり 영향치 > 0.3.
//   단언 3: __applyEmotion('neutral') 2s 후 笑い < 0.1 (감쇠 경로).
//   단언 4: 7s 관찰 중 まばたき가 한 번 이상 > 0.5 (PMX 깜빡임 살아있음
//           — G단계 전까지 PMX는 깜빡이지 않았다).
//   스크린샷: 감정 4종 × 얼굴 클로즈업 (사람 눈 확인용).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/expression-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await new Promise((r) => setTimeout(r, 1500))

// 얼굴 클로즈업에서 채팅 패널/말풍선이 정확히 얼굴 위로 투영돼 사람 확인용
// 스크린샷을 가린다 — DOM 오버레이만 숨긴다 (3D 장면엔 영향 없음)
await mainWindow.evaluate(() => {
  for (const id of ['chat-panel', 'speech-bubble', 'backend-status', 'world-layer']) {
    const el = document.getElementById(id)
    if (el) el.style.visibility = 'hidden'
  }
})

const morph = (name) => mainWindow.evaluate((n) => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  const i = mesh?.morphTargetDictionary?.[n]
  return i === undefined ? null : mesh.morphTargetInfluences[i]
}, name)

// ── 단언 1: 핵심 모프 존재 ──────────────────────────────────────────
const CORE = ['笑い', 'まばたき', '困る', '怒り', 'びっくり', 'にっこり']
const missing = []
for (const n of CORE) {
  if ((await morph(n)) === null) missing.push(n)
}
console.log(`core morphs: ${missing.length ? `MISSING ${missing.join(',')}` : 'all present'}`)

// 얼굴 클로즈업 — 頭 본 기준 정면 0.8m. 깜빡임 순간(0.24s, 2~5s 주기)에
// 찍히면 감정과 무관하게 졸린 눈이 나와 사람 확인을 오도한다 — まばたき가
// 0으로 돌아올 때까지 최대 1.5s 대기 후 촬영.
async function faceShot(label) {
  for (let i = 0; i < 15; i++) {
    const blinking = await mainWindow.evaluate(() => {
      const scene = window.__apiaScene
      let mesh = null
      scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
      const idx = mesh?.morphTargetDictionary?.['まばたき']
      return idx !== undefined && mesh.morphTargetInfluences[idx] > 0.05
    })
    if (!blinking) break
    await new Promise((r) => setTimeout(r, 100))
  }
  await mainWindow.evaluate(() => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    let mesh = null
    scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return
    const head = new Map(mesh.skeleton.bones.map((b) => [b.name, b])).get('頭')
    if (!head) return
    const V = cam.position.constructor
    const c = head.getWorldPosition(new V())
    cam.position.set(c.x, c.y + 0.05, c.z + 0.8)
    cam.lookAt(c.x, c.y, c.z)
  })
  await new Promise((r) => setTimeout(r, 150))
  await mainWindow.screenshot({ path: path.join(outDir, `${label}.png`) })
}

// ── 단언 2: happy → 모프 떠오름 ─────────────────────────────────────
await mainWindow.evaluate(() => window.__applyEmotion('happy'))
await new Promise((r) => setTimeout(r, 1000))
const smile = await morph('笑い')
const grin = await morph('にっこり')
await faceShot('happy')
console.log(`happy: 笑い=${smile?.toFixed(3)} にっこり=${grin?.toFixed(3)}`)
const happyOk = smile !== null && smile > 0.3 && grin !== null && grin > 0.3

// 나머지 감정 스크린샷 (사람 확인용 — 단언은 happy 하나로 대표)
for (const e of ['sad', 'angry', 'surprised']) {
  await mainWindow.evaluate((em) => window.__applyEmotion(em), e)
  await new Promise((r) => setTimeout(r, 1000))
  await faceShot(e)
}

// ── 단언 3: neutral 감쇠 ────────────────────────────────────────────
await mainWindow.evaluate(() => window.__applyEmotion('neutral'))
await new Promise((r) => setTimeout(r, 2000))
const smileAfter = await morph('笑い')
await faceShot('neutral')
console.log(`neutral(+2s): 笑い=${smileAfter?.toFixed(3)}`)
const decayOk = smileAfter !== null && smileAfter < 0.1

// ── 단언 4: 깜빡임 — renderer rAF로 7s 수집 ─────────────────────────
await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  const i = mesh?.morphTargetDictionary?.['まばたき']
  window.__blinkWatch = { max: 0, done: false }
  const t0 = performance.now()
  const step = () => {
    if (i !== undefined) {
      window.__blinkWatch.max = Math.max(window.__blinkWatch.max, mesh.morphTargetInfluences[i])
    }
    if (performance.now() - t0 < 7000) requestAnimationFrame(step)
    else window.__blinkWatch.done = true
  }
  requestAnimationFrame(step)
})
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 100))
  if (await mainWindow.evaluate(() => window.__blinkWatch?.done)) break
}
const blinkMax = await mainWindow.evaluate(() => window.__blinkWatch?.max ?? 0)
console.log(`blink: max まばたき=${blinkMax.toFixed(3)} over 7s`)
const blinkOk = blinkMax > 0.5

await cleanup()

console.log(`\ncoreOk=${missing.length === 0} happyOk=${happyOk} decayOk=${decayOk} blinkOk=${blinkOk}`)
if (missing.length || !happyOk || !decayOk || !blinkOk) {
  console.error('EXPRESSION CHECK FAILED')
  process.exit(1)
}
console.log('EXPRESSION CHECK PASSED')
process.exit(0)
