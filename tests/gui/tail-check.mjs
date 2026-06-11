// D단계 검증: 꼬리(しっぽ 12마디)가 바닥에 끌리지 않는지.
//
// 모델 제작자의 ★Up_しっぽ 본 모프(しっぽ支 지지 본을 들어 올려 스프링이
// 꼬리 전체를 끌어올리는 장치)는 three.js에서 무효라 Apia가 직접 적용한다
// (modelRuntime.applyAuthorTailLift). 이 스크립트는 그 적용 여부와 효과를
// 단언한다:
//   단언 1: しっぽ支 본 로컬 위치가 PMX 바인드 값에서 +Y로 들려 있다
//   단언 2: 물리 정착 후 꼬리 끝(しっぽ12) 월드 Y가 바닥 위 임계값 이상
// APIA_TAIL_MEASURE=1이면 단언 없이 측정값만 출력(수정 전 기준값 채집용).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/tail-check')
mkdirSync(outDir, { recursive: true })
const measureOnly = process.env.APIA_TAIL_MEASURE === '1'

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
// 물리 정착 + 로드 인사 말풍선(3s)이 사라질 때까지 대기
await new Promise((r) => setTimeout(r, 6000))

const probe = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const V = window.__apiaCamera.position.constructor
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const get = (n) => map.get(n)
  const world = (b) => b ? b.getWorldPosition(new V()).toArray().map((v) => +v.toFixed(4)) : null
  const support = get('しっぽ支')
  return {
    supportLocal: support ? support.position.toArray().map((v) => +v.toFixed(4)) : null,
    supportWorldY: world(support)?.[1] ?? null,
    tipWorldY: world(get('しっぽ12'))?.[1] ?? null,
    midWorldY: world(get('しっぽ7'))?.[1] ?? null,
    footWorldY: world(get('左足首'))?.[1] ?? null, // 바닥 높이 참조용
  }
})
console.log('tail probe:', JSON.stringify(probe, null, 1))

// 측면/후면 스크린샷 (꼬리는 옆/뒤에서만 보임)
async function aimAndShoot(label, yaw) {
  await mainWindow.evaluate((yawOffset) => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    let mesh = null
    scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const anchor = map.get('下半身') || mesh.skeleton.bones[0]
    const V = cam.position.constructor
    const center = anchor.getWorldPosition(new V())
    // 반경 1.7 + 약간 위에서 내려보는 각 — 후면(원경 2.2)에서 카메라가
    // 책상을 뚫고 들어가 화면이 가구로 덮이던 문제 회피
    cam.position.set(
      center.x + Math.sin(yawOffset) * 1.7,
      center.y + 0.45,
      center.z + Math.cos(yawOffset) * 1.7
    )
    cam.lookAt(center.x, center.y - 0.15, center.z)
  }, yaw)
  await new Promise((r) => setTimeout(r, 150))
  await mainWindow.screenshot({ path: path.join(outDir, label) })
}
await aimAndShoot('side.png', Math.PI / 2)
await aimAndShoot('back.png', Math.PI)

await cleanup()

if (measureOnly) {
  console.log('MEASURE ONLY — no assertions')
  process.exit(0)
}

// PMX 바인드: しっぽ支 로컬 위치 ≈ (2.20, -2.31, -3.93)(부모 しっぽ親 기준).
// ★Up_しっぽ 적용 시 +(1.39, 3.05, 0.36). Y 성분이 +2 이상 들려 있으면 적용된 것.
const liftApplied = probe?.supportLocal && probe.supportLocal[1] > 0
// 꼬리 끝이 바닥면 위에 있는가. 물리 정착 위치는 실행마다 다른 다중 안정
// 상태라(측정: 0.08~0.34) 발목 기준 고정 마진은 플레이키 — 수정 전 값이
// -0.055(바닥 관통)였으므로 "바닥면 위 +0.02"가 명확하고 안정적인 경계다.
const tipClear = probe?.tipWorldY !== null && probe.tipWorldY > 0.02
// 꼬리 중간(しっぽ7)은 들림의 핵심 — 지지 스프링이 일하면 항상 0.3 이상
const midClear = probe?.midWorldY !== null && probe.midWorldY > 0.3

console.log(`liftApplied=${liftApplied} tipClear=${tipClear} midClear=${midClear}`)
if (!liftApplied || !tipClear || !midClear) {
  console.error('TAIL CHECK FAILED')
  process.exit(1)
}
console.log('TAIL CHECK PASSED')
process.exit(0)
