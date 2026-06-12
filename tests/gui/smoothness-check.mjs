// F단계 검증: 시선 추적 + 클립 전환 부드러움 (inertialization).
//
//   단언 1 (gaze): __setLookTarget 좌/우에 눈(左目, 폴백 首) 본 yaw가
//           반대 부호로 반응한다 — 시선 파이프라인이 살아 있다는 증거.
//           (전역 커서 IPC 폴러는 OS 커서를 움직일 수 없어 E2E에선
//           renderer 훅으로 같은 경로를 자극한다.)
//   단언 2 (smoothness): idle_sway 재생 중 idle_stretch로 전환할 때
//           左腕 쿼터니언의 프레임당 각도 점프 최댓값이 임계 이하.
//           스냅(즉시 점프)이 돌아오면 여기서 잡힌다.
//
// APIA_SMOOTH_MEASURE=1 → 단언 없이 측정값만 출력(임계 채집용).
// inertialization off 비교 측정도 항상 출력한다(단언은 안 함 — 클립
// 조합이 달라 직접 비교는 지표일 뿐).
import { launchApia } from './helpers/launchApia.mjs'

const measureOnly = process.env.APIA_SMOOTH_MEASURE === '1'
// 임계 근거: 측정 모드 채집 결과 inertialization ON에서 전환 구간 최대
// 프레임당 점프 ~0.05rad대, 자연 모션 구간 ~0.03rad대. 스냅이 살아나면
// 0.3rad+로 튄다 — 여유를 두고 0.15.
const JUMP_MAX = Number(process.env.APIA_SMOOTH_JUMP_MAX || '0.15')

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await new Promise((r) => setTimeout(r, 1500))

// ── 단언 1: gaze ─────────────────────────────────────────────────────
const gazeProbe = (nx) => mainWindow.evaluate(async (x) => {
  window.__setLookTarget(x, 0)
  await new Promise((r) => setTimeout(r, 700)) // spring 정착 대기
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  // 両目는 그랜트용 컨트롤 본이라 identity로 남는다(실측) — 실제 회전이
  // 적히는 左目을 본다. 측정: 左目 y ±0.22, 首 ±0.089.
  const bone = map.get('左目') || map.get('右目') || map.get('首')
  return bone ? { name: bone.name, y: bone.quaternion.y } : null
}, nx)

const lookRight = await gazeProbe(0.9)
const lookLeft = await gazeProbe(-0.9)
await mainWindow.evaluate(() => window.__setLookTarget(0, 0))
console.log(`gaze: bone=${lookRight?.name} right.y=${lookRight?.y?.toFixed(4)} left.y=${lookLeft?.y?.toFixed(4)}`)
const gazeDelta = (lookRight && lookLeft) ? Math.abs(lookRight.y - lookLeft.y) : 0
const gazeOk = lookRight !== null && lookLeft !== null &&
  Math.sign(lookRight.y) !== Math.sign(lookLeft.y) && gazeDelta > 0.015

// ── 단언 2: 전환 부드러움 ────────────────────────────────────────────
// renderer 안에서 rAF로 프레임당 左腕 quat을 수집 — IPC 왕복 지터 배제.
// 수집 시작 0.4s 후 전환을 트리거해 전환 순간이 반드시 창 안에 들어온다.
async function sampleTransition(nextMotion) {
  await mainWindow.evaluate((next) => {
    const scene = window.__apiaScene
    let mesh = null
    scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const bone = new Map(mesh.skeleton.bones.map((b) => [b.name, b])).get('左腕')
    window.__smooth = { samples: [], done: false }
    const t0 = performance.now()
    const step = () => {
      const q = bone.quaternion
      window.__smooth.samples.push([performance.now() - t0, q.x, q.y, q.z, q.w])
      if (performance.now() - t0 < 1600) requestAnimationFrame(step)
      else window.__smooth.done = true
    }
    requestAnimationFrame(step)
    setTimeout(() => window.__applyMotion({ name: next, intensity: 1 }), 400)
  }, nextMotion)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await mainWindow.evaluate(() => window.__smooth?.done)) break
  }
  return await mainWindow.evaluate(() => window.__smooth?.samples ?? [])
}

function maxJump(samples) {
  let max = 0
  let at = 0
  for (let i = 1; i < samples.length; i++) {
    const [, ax, ay, az, aw] = samples[i - 1]
    const [t, bx, by, bz, bw] = samples[i]
    const dot = Math.abs(ax * bx + ay * by + az * bz + aw * bw)
    const ang = 2 * Math.acos(Math.min(1, dot))
    if (ang > max) { max = ang; at = t }
  }
  return { max, at, n: samples.length }
}

// 기준 클립 깔기 (rest → sway 전환은 워밍업이라 측정 안 함)
await mainWindow.evaluate(() => window.__applyMotion({ name: 'idle_sway', intensity: 1 }))
await new Promise((r) => setTimeout(r, 2500))

const onRun = maxJump(await sampleTransition('idle_stretch'))
console.log(`smoothness ON : maxJump=${onRun.max.toFixed(4)}rad @${onRun.at.toFixed(0)}ms (${onRun.n} frames)`)

// 비교 측정: inertialization 끄고 반대 방향 전환 (지표용, 단언 없음)
await new Promise((r) => setTimeout(r, 1500))
await mainWindow.evaluate(() => window.__setInertialization(false))
const offRun = maxJump(await sampleTransition('idle_sway'))
await mainWindow.evaluate(() => window.__setInertialization(true))
console.log(`smoothness OFF: maxJump=${offRun.max.toFixed(4)}rad @${offRun.at.toFixed(0)}ms (${offRun.n} frames) [비교용]`)

await cleanup()

if (measureOnly) {
  console.log('MEASURE ONLY — no assertions')
  process.exit(0)
}

const smoothOk = onRun.n >= 30 && onRun.max < JUMP_MAX
console.log(`\ngazeOk=${gazeOk} smoothOk=${smoothOk} (jumpMax=${JUMP_MAX})`)
if (!gazeOk || !smoothOk) {
  console.error('SMOOTHNESS CHECK FAILED')
  process.exit(1)
}
console.log('SMOOTHNESS CHECK PASSED')
process.exit(0)
