// Phase F 방 리모델 시각 검증 — GLB 가구가 다 로드된 뒤 코너 디오라마
// 앵글로 스크린샷 + 가구 배치 진단(피스별 world bbox).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/room-check')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error' || t.includes('[scene]') || t.includes('GLB')) console.log(`[${m.type()}] ${t}`)
})
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

// 자유보행 끄기(가구 뒤로 걸어가 가림 방지) + 가구 로드 완료 대기.
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))

const diag = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let furniture = null
  scene?.traverse((o) => { if (o.name === 'apia-furniture') furniture = o })
  if (!furniture) return { error: 'no furniture group' }
  // three는 본 객체 생성자로 (별도 노출 불필요)
  const out = []
  for (const child of furniture.children) {
    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }
    child.updateWorldMatrix(true, true)
    child.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      o.geometry.computeBoundingBox?.()
      const bb = o.geometry.boundingBox
      if (!bb) return
      for (const corner of [[bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z]]) {
        const v = new o.position.constructor(corner[0], corner[1], corner[2])
        o.localToWorld(v)
        min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z)
        max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z)
      }
    })
    out.push({
      name: child.name,
      size: [+(max.x - min.x).toFixed(2), +(max.y - min.y).toFixed(2), +(max.z - min.z).toFixed(2)],
      baseY: +min.y.toFixed(2),
      centerXZ: [+((min.x + max.x) / 2).toFixed(2), +((min.z + max.z) / 2).toFixed(2)],
    })
  }
  return { count: furniture.children.length, pieces: out }
})
console.log(JSON.stringify(diag, null, 2))

await mainWindow.screenshot({ path: path.join(outDir, 'room.png') })
console.log('[room-check] screenshot saved')
await cleanup()
process.exit(0)
