// 발가락 굽힘 축/부호 실측 — 足先EX를 각 로컬축±로 돌려 발끝(tip)이
// 아래(접지/toe-off, world -Y)로 가는 축+부호를 찾는다. 손가락과 동일 방식.
import { launchApia } from './helpers/launchApia.mjs'

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})
await new Promise((r) => setTimeout(r, 5000))

const result = await mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  if (!scene) return { error: 'no scene' }
  let mesh = null
  scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return { error: 'no mesh' }
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
  const b0 = mesh.skeleton.bones[0]
  const V = b0.position.constructor
  const Q = b0.quaternion.constructor
  function wpos(b) { const v = new V(); b.getWorldPosition(v); return v }

  function testToe(side) {
    const toe = map.get(`${side}足先EX`) || map.get(`${side}つま先`)
    if (!toe) return { side, error: 'no toe bone' }
    // 움직임을 잴 tip: 足先EX의 자식, 없으면 つま先, 없으면 足先EX 자신 자식.
    let tip = toe.children?.[0] || map.get(`${side}つま先`)
    if (!tip || tip === toe) return { side, toeBone: toe.name, error: 'no tip to measure', childCount: toe.children?.length || 0 }

    mesh.updateMatrixWorld(true)
    const tip0 = wpos(tip)
    const saved = toe.quaternion.clone()
    const down = new V(0, -1, 0) // 접지 = 아래로
    const angle = 0.5
    const axes = { x: new V(1, 0, 0), y: new V(0, 1, 0), z: new V(0, 0, 1) }
    const scores = []
    for (const [axisName, axisVec] of Object.entries(axes)) {
      for (const sign of [1, -1]) {
        toe.quaternion.copy(saved).multiply(new Q().setFromAxisAngle(axisVec, angle * sign))
        mesh.updateMatrixWorld(true)
        const d = wpos(tip).sub(tip0)
        toe.quaternion.copy(saved); mesh.updateMatrixWorld(true)
        const total = d.length()
        const downward = d.dot(down)
        const lateral = Math.sqrt(Math.max(0, total * total - downward * downward))
        scores.push({ axis: axisName, sign, downward: +downward.toFixed(4), lateral: +lateral.toFixed(4), total: +total.toFixed(4) })
      }
    }
    scores.sort((a, b) => (b.downward - b.lateral) - (a.downward - a.lateral))
    return { side, toeBone: toe.name, tip: tip.name, best: scores[0], scores }
  }

  return {
    has足先EX_L: map.has('左足先EX'), has足先EX_R: map.has('右足先EX'),
    hasつま先_L: map.has('左つま先'), hasつま先_R: map.has('右つま先'),
    left: testToe('左'), right: testToe('右'),
  }
})
console.log(JSON.stringify(result, null, 2))
await cleanup()
process.exit(0)
