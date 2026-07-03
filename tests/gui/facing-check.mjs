// 임시 E2E — 방 리워크 검증: ① 가구 실높이/소품 착지 ② __respondToCall →
// 정중앙 책상 앞 착석 + 카메라(사용자) 방향 어서션 ③ 구도 스크린샷(낮/노을).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
const outDir = path.resolve('test-results/facing')
mkdirSync(outDir, { recursive: true })
const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let fails = 0
const errors = []
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (msg.type() === 'error' && !t.includes('unknown char code') && !t.includes('Electron Security')) errors.push(t)
})
await new Promise((r) => setTimeout(r, 6000))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await mainWindow.evaluate(() => window.__apiaFurnitureReady)
await mainWindow.evaluate(() => {
  document.querySelectorAll('[class*="bubble" i],[id*="bubble" i]').forEach((e) => { e.style.display = 'none' })
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ① 데스크/노트북 위치 어서션(정중앙, 노트북이 책상 위)
const geo = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  const V = window.__apiaCamera.position.constructor
  const box = (id) => {
    let n = null
    scene.traverse((o) => { if (!n && (o.name === `furniture-${id}` || o.name === `furniture-fallback-${id}`)) n = o })
    if (!n) return null
    let minY = Infinity, maxY = -Infinity, sx = 0, sz = 0, c = 0
    n.updateWorldMatrix(true, true)
    n.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      const bb = o.geometry.boundingBox
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        const v = new V(cx, cy, cz).applyMatrix4(o.matrixWorld)
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); sx += v.x; sz += v.z; c++
      }
    })
    return { top: Number(maxY.toFixed(3)), base: Number(minY.toFixed(3)), cx: Number((sx / c).toFixed(2)), cz: Number((sz / c).toFixed(2)) }
  }
  return { desk: box('workDesk'), laptop: box('monitor'), deskChair: box('deskChair') }
})
console.log('geometry:', JSON.stringify(geo))
if (!geo.desk || Math.abs(geo.desk.cx) > 0.1 || Math.abs(geo.desk.top - 0.68) > 0.03) { console.error('FAIL desk center/height'); fails++ }
if (!geo.laptop || Math.abs(geo.laptop.base - geo.desk.top) > 0.04) { console.error('FAIL laptop seating'); fails++ }

// ② 호출 → 책상 의자 착석 + 사용자 방향
await mainWindow.evaluate(() => window.__respondToCall?.())
let seated = false
for (let i = 0; i < 60; i++) {
  await wait(1000)
  const info = await mainWindow.evaluate(() => window.__activityInfo?.() || null)
  if (info?.state === 'sit') { seated = true; break }
}
console.log('seated:', seated)
if (!seated) { console.error('FAIL not seated'); fails++ }
if (seated) {
  await wait(1500)
  const pose = await mainWindow.evaluate(() => {
    const scene = window.__apiaScene
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const root = mesh?.parent?.parent || mesh?.parent || mesh
    // 캐릭터 루트 그룹(모델 래퍼) 위치·yaw — main이 관리하는 root를 찾는 대신
    // skinned mesh 월드 위치로 판정
    const V = window.__apiaCamera.position.constructor
    const p = mesh.getWorldPosition(new V())
    return { x: Number(p.x.toFixed(2)), z: Number(p.z.toFixed(2)) }
  })
  console.log('character at:', JSON.stringify(pose))
  if (Math.abs(pose.x) > 0.35) { console.error('FAIL not centered at desk'); fails++ }
  // 수치 방향 어서션 — 카메라 방향 = yaw 0 규약(실측 확정). 스크린샷 의존 탈피.
  const yaw = await mainWindow.evaluate(() => {
    const scene = window.__apiaScene
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    let n = mesh
    while (n.parent && n.parent.type !== 'Scene') n = n.parent
    return Number(n.rotation.y.toFixed(2))
  })
  console.log('seated yaw:', yaw, '(0=카메라 마주봄)')
  if (Math.abs(yaw) > 0.4) { console.error(`FAIL seated yaw ${yaw} — 사용자를 안 봄`); fails++ }
  await mainWindow.evaluate(() => window.__setLightingHour?.(13))
  await wait(600)
  await mainWindow.screenshot({ path: path.join(outDir, 'facing_day.png') })
  await mainWindow.evaluate(() => window.__setLightingHour?.(18))
  await wait(800)
  await mainWindow.screenshot({ path: path.join(outDir, 'facing_sunset.png') })
}
if (errors.length) { console.error('console errors:', JSON.stringify(errors.slice(0, 3))); fails += errors.length }
await cleanup()
console.log(fails ? `FACING CHECK FAILED (${fails})` : 'FACING CHECK PASSED')
process.exit(fails ? 1 : 0)
