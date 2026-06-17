// 앉기 높이 실측 — 서 있을 때 골반(腰)/발목 world Y, 의자 좌면 높이.
// offset.y(앉을 때 루트 올림값) 보정 근거.
import { launchApia } from './helpers/launchApia.mjs'

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
await mainWindow.evaluate(() => window.__apiaFurnitureReady ?? Promise.resolve()).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))

const out = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let mesh = null
  scene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return { error: 'no mesh' }
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const V = mesh.skeleton.bones[0].position.constructor
  const wy = (name) => { const b = map.get(name); if (!b) return null; const v = new V(); b.getWorldPosition(v); return +v.y.toFixed(3) }

  // 캐릭터 루트(발 기준) Y
  let rootY = null
  scene?.traverse((o) => { if (o === mesh) { /* skin mesh */ } })
  // 모델 루트는 mesh의 조상 중 scene 바로 아래 — 대략 mesh world pos
  const mv = new V(); mesh.getWorldPosition(mv)

  // 의자 좌면: furniture-chair_window bbox
  let chair = null
  scene?.traverse((o) => { if (o.name === 'furniture-chair_window') chair = o })
  let chairTop = null, chairBot = null
  if (chair) {
    let min = Infinity, max = -Infinity
    chair.updateWorldMatrix(true, true)
    chair.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      o.geometry.computeBoundingBox?.()
      const bb = o.geometry.boundingBox; if (!bb) return
      for (const cy of [bb.min.y, bb.max.y]) {
        const v = new V(0, cy, 0); o.localToWorld(v)
        min = Math.min(min, v.y); max = Math.max(max, v.y)
      }
    })
    chairTop = +max.toFixed(3); chairBot = +min.toFixed(3)
  }

  return {
    hip_腰: wy('腰'), lowerBody_下半身: wy('下半身'), ankle_左足首: wy('左足首'),
    head_頭: wy('頭'), meshWorldY: +mv.y.toFixed(3),
    chairTotalTop: chairTop, chairBottom: chairBot,
    chairHeight: chairTop != null ? +(chairTop - chairBot).toFixed(3) : null,
  }
})
console.log(JSON.stringify(out, null, 2))
await cleanup()
process.exit(0)
