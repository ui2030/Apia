// E2E — 시간대 라이팅 리그 검수: 4시간대(아침8/낮13/노을18/밤22) 방 전경 +
// 캐릭터 근접 촬영, __setLightingHour 상태 어서션, 콘솔 에러 단언.
// 실패(상태 미적용/에러)면 exit 1 — CI/수동 QA 겸용.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/lighting')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
const errors = []
let fails = 0
mainWindow.on('console', (msg) => {
  const t = msg.text()
  if (msg.type() === 'error' && !t.includes('unknown char code') && !t.includes('Electron Security')) errors.push(t)
})
await new Promise((r) => setTimeout(r, 5500))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
// 인사 말풍선(DOM)이 상반신을 가리므로 촬영 동안 숨김.
await mainWindow.evaluate(() => {
  document.querySelectorAll('[class*="bubble" i],[id*="bubble" i]').forEach((e) => { e.style.display = 'none' })
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function closeupChar(label) {
  await mainWindow.evaluate(() => {
    const cam = window.__apiaCamera
    const scene = window.__apiaScene
    let mesh = null
    scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const anchor = map.get('上半身') || mesh.skeleton.bones[0]
    const V = cam.position.constructor
    const c = anchor.getWorldPosition(new V())
    if (!window.__lc) window.__lc = { pos: cam.position.clone(), quat: cam.quaternion.clone() }
    const base = window.__lc.pos
    const bearing = Math.atan2(base.x - c.x, base.z - c.z)
    cam.position.set(c.x + Math.sin(bearing) * 1.3, c.y + 0.1, c.z + Math.cos(bearing) * 1.3)
    cam.lookAt(c.x, c.y, c.z)
  })
  await wait(150)
  await mainWindow.screenshot({ path: path.join(outDir, `${label}.png`) })
  await mainWindow.evaluate(() => {
    const cam = window.__apiaCamera, s = window.__lc
    if (cam && s) { cam.position.copy(s.pos); cam.quaternion.copy(s.quat) }
  })
}

// expectKey = 해당 정시 앵커의 keyIntensity(lightingRig ANCHORS와 동기 유지)
for (const [label, hour, expectKey] of [
  ['h08_morning', 8, null],
  ['h13_day', 13, null],
  ['h18_sunset', 18, 1.0],
  ['h22_night', 22, 0.22],
]) {
  const state = await mainWindow.evaluate((h) => window.__setLightingHour?.(h), hour)
  if (!state) { console.error(`FAIL __setLightingHour(${hour}) returned null`); fails++; continue }
  if (expectKey !== null && Math.abs(state.keyIntensity - expectKey) > 1e-6) {
    console.error(`FAIL key @${hour}: ${state.keyIntensity} != ${expectKey}`)
    fails++
  }
  await wait(700) // 하늘 리드로 + 한두 프레임
  await mainWindow.screenshot({ path: path.join(outDir, `${label}_room.png`) })
  await closeupChar(`${label}_char`)
  console.log(`${label}: key=${state.keyIntensity.toFixed(2)} amb=${state.ambientIntensity.toFixed(2)} desk=${state.deskGlowIntensity.toFixed(2)}`)
}

await cleanup()
if (errors.length) {
  console.error('console errors:', JSON.stringify(errors.slice(0, 5)))
  fails += errors.length
}
console.log(fails ? `LIGHTING CHECK FAILED (${fails})` : 'LIGHTING CHECK PASSED')
process.exit(fails ? 1 : 0)
