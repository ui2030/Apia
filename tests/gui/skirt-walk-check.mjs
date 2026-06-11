// 일회용 진단: 걷기 핸드오프 중 치마 물리가 뭉치는 현상이
// (a) 걷는 동안만의 일시적 지연인지 (b) 영구 붕괴(슬램)인지 구분한다.
// 타임라인: idle 클립 1.2s → 걷기 → 2s/4s/도착 후 3s 시점 스크린샷.
// 캐릭터가 무작위 지점으로 걸어 프레임을 벗어나므로 매 샷 전에
// 카메라를 캐릭터 상반신에 다시 조준한다 (vmd-check와 같은 방식).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/skirt-walk-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

await new Promise((r) => setTimeout(r, 4500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))

async function aimAndShoot(label) {
  await mainWindow.evaluate(() => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    if (!cam || !scene) return
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    if (!mesh) return
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const anchor = map.get('上半身') || map.get('センター') || mesh.skeleton.bones[0]
    const V = cam.position.constructor
    const center = anchor.getWorldPosition(new V())
    cam.position.set(center.x, center.y + 0.15, center.z + 2.0)
    cam.lookAt(center)
  })
  await new Promise((r) => setTimeout(r, 150))
  await mainWindow.screenshot({ path: path.join(outDir, label) })
}

// 귀속 실험: APIA_SKIRT_NOCLIP=1이면 클립을 전혀 틀지 않고(핸드오프 경로
// 미사용) 순수 절차적 idle 상태에서 바로 걷는다. 치마가 그래도 구겨지면
// 원인은 핸드오프가 아니라 걷기+물리 자체다.
const useClip = process.env.APIA_SKIRT_NOCLIP !== '1'
if (useClip) {
  await mainWindow.evaluate(() => window.__applyMotion({ name: 'idle_sway', intensity: 1 }))
}
await new Promise((r) => setTimeout(r, 1200))
await aimAndShoot('0_idle.png')

await mainWindow.evaluate(() => window.__walkTo?.())
await new Promise((r) => setTimeout(r, 2000))
await aimAndShoot('1_walk_2s.png')
await new Promise((r) => setTimeout(r, 2000))
await aimAndShoot('2_walk_4s.png')

// 도착 대기 (walk 상태 종료 폴링, 최대 10s)
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const walking = await mainWindow.evaluate(() => window.__apiaPoseInfo?.()?.state === 'walk')
  if (!walking) break
}
await new Promise((r) => setTimeout(r, 3000))
await aimAndShoot('3_after_arrive_3s.png')

await cleanup()
console.log('done — check test-results/skirt-walk-check')
process.exit(0)
