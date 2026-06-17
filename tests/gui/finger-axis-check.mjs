// 손가락 굽힘 축/부호 실측 — 추측 대신 실제 로드된 모델에서 본을 각 로컬
// 축으로 회전시켜 손끝이 "손바닥 쪽(=손목 방향)"으로 가는 축+부호를 찾는다.
// poseRig의 FINGER_CURL_AXIS / FINGER_CURL_SIGN 확정 근거.
//
//   node tests/gui/finger-axis-check.mjs   (dist 로드 — 먼저 vite build)
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/finger-axis')
mkdirSync(outDir, { recursive: true })

const { mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

await new Promise((r) => setTimeout(r, 5000))

const result = await mainWindow.evaluate(() => {
  /* eslint-disable no-undef */
  const scene = window.__apiaScene
  if (!scene) return { error: 'no scene' }
  let mesh = null
  scene.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return { error: 'no skeletal mesh' }
  const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))

  // three 클래스는 본 객체 생성자에서 얻는다(별도 노출 불필요).
  const b0 = mesh.skeleton.bones[0]
  const V = b0.position.constructor
  const Q = b0.quaternion.constructor

  function wpos(b) { const v = new V(); b.getWorldPosition(v); return v }

  // 손가락 본 존재 여부.
  const fingerNames = []
  for (const side of ['左', '右'])
    for (const [jp, segs] of [['親指', ['０', '１', '２']], ['人指', ['１', '２', '３']],
      ['中指', ['１', '２', '３']], ['薬指', ['１', '２', '３']], ['小指', ['１', '２', '３']]])
      for (const s of segs) fingerNames.push(`${side}${jp}${s}`)
  const present = fingerNames.filter((n) => map.has(n))

  // 왼손 검지 체인으로 축 실측: 人指１을 각 로컬축±로 회전 → 손끝 이동 측정.
  function testHand(side) {
    const base = map.get(`${side}人指１`)
    const tip = map.get(`${side}人指３`) || map.get(`${side}人指２`)
    const wrist = map.get(`${side}手首`)
    if (!base || !tip || !wrist) return { side, error: 'missing index/wrist bones' }

    mesh.updateMatrixWorld(true)
    const tip0 = wpos(tip)
    const basePos = wpos(base)
    const wristPos = wpos(wrist)
    // "손바닥/굽힘" 기준 방향 ≈ 손끝이 손목 쪽으로 말려 들어가는 방향.
    const toWrist = wristPos.clone().sub(basePos).normalize()

    const saved = base.quaternion.clone()
    const angle = 0.6
    const axes = { x: new V(1, 0, 0), y: new V(0, 1, 0), z: new V(0, 0, 1) }
    const scores = []
    for (const [axisName, axisVec] of Object.entries(axes)) {
      for (const sign of [1, -1]) {
        const dq = new Q().setFromAxisAngle(axisVec, angle * sign)
        base.quaternion.copy(saved).multiply(dq) // 로컬축 회전(post-multiply)
        mesh.updateMatrixWorld(true)
        const tip1 = wpos(tip)
        base.quaternion.copy(saved)
        mesh.updateMatrixWorld(true)
        const delta = tip1.clone().sub(tip0)
        const total = delta.length()
        const towardWrist = delta.dot(toWrist) // +면 손목 쪽(굽힘)으로 말림
        const lateral = Math.sqrt(Math.max(0, total * total - towardWrist * towardWrist))
        scores.push({
          axis: axisName, sign,
          towardWrist: +towardWrist.toFixed(4),
          lateral: +lateral.toFixed(4),
          total: +total.toFixed(4),
        })
      }
    }
    // 굽힘 = 손목 쪽 이동이 가장 크고 측면 이동은 작은 축+부호.
    scores.sort((a, b) => (b.towardWrist - b.lateral) - (a.towardWrist - a.lateral))
    return { side, best: scores[0], scores }
  }

  return {
    boneTotal: mesh.skeleton.bones.length,
    fingerPresent: present.length,
    fingerMissing: fingerNames.filter((n) => !map.has(n)),
    left: testHand('左'),
    right: testHand('右'),
  }
})

console.log(JSON.stringify(result, null, 2))
await cleanup()
process.exit(0)
