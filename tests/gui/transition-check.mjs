// C단계 검증: 루프 idle VMD가 본을 소유한 채 걷기가 시작되면
// releaseActiveClips가 클립을 fade로 내리고 절차적 gait가 다리를
// 넘겨받는지 확인한다.
//
// 단언 1: 걷기 시작 후 ~1.5s 안에 __clipFlags().vmd === false
// 단언 2: 걷는 동안 다리 본 쿼터니언이 실제로 진동한다 (gait 활성)
// 단언 3: 도착 후 치마 물리가 회복된다 — 클립 해제 후 helper backupBones
//         동결로 물리가 클립 자세를 따라가 치마가 엉키던 회귀 방지
//         (syncMmdPhysicsBackup). 지표: 엉덩이(下半身)에서 치마 최하단
//         본까지의 수직 낙하량이 idle 기준치의 70% 이상.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/transition-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))

const legSample = () => mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const bone = map.get('左足D') || map.get('左足')
  return bone ? bone.quaternion.x : null
})

// 엉덩이 본에서 치마 최하단 본까지의 수직 낙하량. 치마가 정상으로
// 늘어져 있으면 크고, 엉켜 말려 올라가면 작아진다.
const skirtDrop = () => mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const V = window.__apiaCamera.position.constructor
  let hipY = null
  let minY = Infinity
  for (const b of mesh.skeleton.bones) {
    const y = b.getWorldPosition(new V()).y
    if (b.name === '下半身') hipY = y
    // kisaki 모델은 치마 자락 본이 前すそ_*/後すそ_* (すそ=옷자락)
    if (/すそ|スカート|skirt/i.test(b.name)) minY = Math.min(minY, y)
  }
  if (hipY === null || !Number.isFinite(minY)) return null
  return hipY - minY
})

// 1) 루프 idle 클립 재생 → 클립이 본 소유 확인
await mainWindow.evaluate(() => window.__applyMotion({ name: 'idle_sway', intensity: 1 }))
await new Promise((r) => setTimeout(r, 1200))
const flagsBefore = await mainWindow.evaluate(() => window.__clipFlags?.())
const skirtBaseline = await skirtDrop()
console.log('before walk:', JSON.stringify(flagsBefore), 'skirtDrop=', skirtBaseline?.toFixed(4))
await mainWindow.screenshot({ path: path.join(outDir, '0_idle_clip.png') })

// 2) 걷기 트리거 — 목적지가 가까우면 샘플링 중 도착해 gait 단언이
// 플레이키해지므로 충분한 거리를 강제한다
const walked = await mainWindow.evaluate(() => window.__walkTo?.(2.5))
console.log('walk triggered:', walked)

// 3) 1.8s 동안 150ms 간격 샘플링 (걷기 상태 여부도 기록)
const samples = []
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 150))
  samples.push({
    t: (i + 1) * 0.15,
    legX: await legSample(),
    flags: await mainWindow.evaluate(() => window.__clipFlags?.())
  })
}
await mainWindow.screenshot({ path: path.join(outDir, '1_walking.png') })
for (const s of samples) {
  console.log(`t=${s.t.toFixed(2)}s legX=${s.legX?.toFixed(4)} vmd=${s.flags?.vmd} state=${s.flags?.state}`)
}

// 단언 1: vmd 플래그가 풀렸는가 (fade 0.45s + 여유)
const flagCleared = samples.some((s) => s.t >= 0.6 && s.flags?.vmd === false)
// 단언 2: 플래그 해제 후 *걷는 중* 구간에서 다리 본이 진동하는가 —
// 도착 후 샘플은 감쇠 구간이라 제외
const post = samples
  .filter((s) => s.flags?.vmd === false && s.flags?.state === 'walk' && s.legX !== null)
  .map((s) => s.legX)
const legRange = post.length >= 3 ? Math.max(...post) - Math.min(...post) : 0
const gaitActive = legRange > 0.05

console.log(`\nflagCleared=${flagCleared} legRange=${legRange.toFixed(4)} gaitActive=${gaitActive}`)

// 단언 3: 도착 + 3s 정착 후 치마 낙하량이 idle 기준의 70% 이상
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const walking = await mainWindow.evaluate(() => window.__clipFlags?.()?.state === 'walk')
  if (!walking) break
}
await new Promise((r) => setTimeout(r, 3000))
const skirtAfter = await skirtDrop()
await mainWindow.screenshot({ path: path.join(outDir, '2_after_arrive.png') })
const skirtOk = skirtBaseline === null
  ? true // 치마 본 없는 모델이면 단언 생략
  : skirtAfter !== null && skirtAfter >= skirtBaseline * 0.7
console.log(`skirtBaseline=${skirtBaseline?.toFixed(4)} skirtAfter=${skirtAfter?.toFixed(4)} skirtOk=${skirtOk}`)

// 단언 4: 해제 후 다음 클립 재생 — 빼둔 mixer가 재부착되어 클립이 다시
// 본을 소유하고(_vmdClipActive), 치마도 멀쩡해야 한다 (stash/re-attach 경로)
await mainWindow.evaluate(() => window.__applyMotion({ name: 'idle_stretch', intensity: 1 }))
await new Promise((r) => setTimeout(r, 1500))
const flagsReplay = await mainWindow.evaluate(() => window.__clipFlags?.())
const skirtReplay = await skirtDrop()
await mainWindow.screenshot({ path: path.join(outDir, '3_replay_clip.png') })
const replayOk = flagsReplay?.vmd === true &&
  (skirtBaseline === null || (skirtReplay !== null && skirtReplay >= skirtBaseline * 0.7))
console.log(`replay: vmd=${flagsReplay?.vmd} skirt=${skirtReplay?.toFixed(4)} replayOk=${replayOk}`)

await cleanup()
if (!walked || !flagCleared || !gaitActive || !skirtOk || !replayOk) {
  console.error('TRANSITION CHECK FAILED')
  process.exit(1)
}
console.log('TRANSITION CHECK PASSED')
process.exit(0)
