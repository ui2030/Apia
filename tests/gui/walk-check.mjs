// 걷기(이동) 검증 — "미끄러짐(glide)" 회귀를 막는 전용 하니스.
//
// 기존 transition-check는 클립을 *해제한 뒤* 다리 진동만 봤다(클립이 떠 있을 때
// gait가 스킵되던 실제 버그 경로·팔 움직임·발 접지는 미검증). 이 체크가 그 빈틈을
// 메운다. 자가검증: 다각도 스샷 + 수치 단언([[apia-walk-gait]]).
//
//   단언 1 (legsMove)  : 걷는 동안 다리 본(左足D) 회전이 진동한다(얼어붙은 glide 아님).
//   단언 2 (armsMove)  : 걷는 동안 팔 본(左腕) 회전이 진동한다(팔도 흔든다).
//   단언 3 (gaitWithClip): 상체 idle 클립이 떠 있는 동안에도 다리 gait가 돈다
//                          — 클립이 있으면 gait를 통째로 스킵하던 회귀 방지.
//   단언 4 (footPlant) : 발 미끄러짐 비율이 한계 이하(완전 glide=1.0 차단).
//
// APIA_WALK_MEASURE=1 → 단언 없이 측정값만 출력(임계 채집용).
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const measureOnly = process.env.APIA_WALK_MEASURE === '1'
// 임계 근거: FK gait ON에서 다리/팔 회전 폭 0.2rad+(실측). 얼어붙으면 ~0이라
// 0.08로 잡으면 glide를 확실히 잡는다.
const SWING_MIN = Number(process.env.APIA_WALK_SWING_MIN || '0.08')
// 발 미끄러짐: 0=완벽 접지, 1=완전 미끄러짐. 다리 IK(applyWalkLegs)가 디딘 발을
// 월드에 고정하므로 실측 ~0.09. 0.35로 잡으면 접지가 깨지면(IK 회귀/FK로 후퇴)
// 확실히 잡는다([[apia-walk-gait]]).
const SLIP_MAX = Number(process.env.APIA_WALK_SLIP_MAX || '0.35')

const outDir = path.resolve('test-results/walk-check')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))

await sleep(4500)
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false))
await sleep(800)

// 가구 숨김 — 다리 가림 방지(캐릭터 서브트리만 남긴다).
await mainWindow.evaluate(() => {
  let charRoot = null
  window.__apiaScene?.traverse((o) => { if (!charRoot && o.skeleton) charRoot = o })
  let top = charRoot
  while (top && top.parent && top.parent !== window.__apiaScene) top = top.parent
  for (const c of window.__apiaScene.children) { if (c === top || c.isLight || c.isCamera) continue; c.visible = false }
})

// 캐릭터에 3/4 측면 고정 카메라(스트라이드가 보이게). 매 프레임 캐릭터 추종.
async function sideCam() {
  await mainWindow.evaluate(() => {
    const b = document.getElementById('speech-bubble'); if (b) b.style.display = 'none'
    let m = null; window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
    const cam = window.__apiaCamera; if (!m || !cam) return
    const v = new m.position.constructor(); m.getWorldPosition(v)
    cam.position.set(v.x + 2.4, v.y + 0.95, v.z + 0.6)
    cam.lookAt(v.x, v.y + 0.85, v.z)
    cam.updateProjectionMatrix()
  })
}

// 걷는 동안 in-page rAF로 본 회전 + 발목/루트 월드 위치를 수집(IPC 지터 배제).
// durationMs 동안 매 프레임 1샘플. 도착해 idle 되면 일찍 멈춘다.
async function collectWalk(durationMs) {
  await mainWindow.evaluate((dur) => new Promise((resolve) => {
    let mesh = null; window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const map = new Map(mesh.skeleton.bones.map((b) => [b.name, b]))
    const leg = map.get('左足D') || map.get('左足')
    const arm = map.get('左腕')
    const lAnk = map.get('左足首D') || map.get('左足首')
    const rAnk = map.get('右足首D') || map.get('右足首')
    const V = mesh.position.constructor
    const samples = []
    const t0 = performance.now()
    const step = () => {
      const f = window.__clipFlags?.() || {}
      const la = lAnk ? lAnk.getWorldPosition(new V()) : null
      const ra = rAnk ? rAnk.getWorldPosition(new V()) : null
      const rp = mesh.getWorldPosition(new V())
      samples.push({
        t: performance.now() - t0,
        legX: leg ? leg.quaternion.x : null,
        armX: arm ? arm.quaternion.x : null,
        state: f.state, vmd: f.vmd,
        lA: la ? { x: la.x, y: la.y, z: la.z } : null,
        rA: ra ? { x: ra.x, y: ra.y, z: ra.z } : null,
        root: { x: rp.x, z: rp.z },
      })
      const elapsed = performance.now() - t0
      if (f.state !== 'walk') window.__walkTo?.(2.5) // 도착하면 재출발 — 끊김 없이 지속
      if (elapsed < dur) requestAnimationFrame(step)
      else { window.__wcSamples = samples; resolve(samples.length) }
    }
    requestAnimationFrame(step)
  }), durationMs)
  return mainWindow.evaluate(() => window.__wcSamples || [])
}

const range = (arr) => arr.length ? Math.max(...arr) - Math.min(...arr) : 0
const median = (a) => { if (!a.length) return -1; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
// 발 미끄러짐: 안정 스탠스(같은 발이 3프레임 연속 디딤) 프레임의 (발 이동/몸 이동)
// 중앙값. 합이 아닌 중앙값이라 touchdown/전환 1~2프레임 이상치에 강건. 0=완벽 접지.
function slipRatio(samples) {
  const ratios = []
  let prev = null, streak = 0
  for (const s of samples) {
    if (s.state !== 'walk' || !s.lA || !s.rA) { prev = null; streak = 0; continue }
    const planted = s.lA.y <= s.rA.y ? 'lA' : 'rA'
    if (prev && prev.planted === planted) {
      streak++
      const a = s[planted], b = prev[planted]
      const bStep = Math.hypot(s.root.x - prev.root.x, s.root.z - prev.root.z)
      // 디딘 지 3프레임 지난 안정 스탠스 + 몸이 충분히 이동한 프레임만.
      if (streak >= 3 && bStep > 0.006) ratios.push(Math.hypot(a.x - b.x, a.z - b.z) / bStep)
    } else streak = 0
    prev = { planted, lA: s.lA, rA: s.rA, root: s.root }
  }
  return median(ratios)
}

// 걷기를 시작시키고 state가 'walk'로 들어갈 때까지 기다린다(도착·시퀀싱 플레이크 방지).
async function startWalk() {
  for (let i = 0; i < 12; i++) {
    await mainWindow.evaluate(() => window.__walkTo?.(2.5))
    for (let j = 0; j < 8; j++) {
      const st = await mainWindow.evaluate(() => window.__clipFlags?.()?.state)
      if (st === 'walk') return true
      await sleep(80)
    }
  }
  return false
}

// ── A) 클린 보행(클립 없음) — 다리/팔 진동 + 발 접지 ──────────────────
await startWalk()
await sleep(450) // gait weight 정착
const sA = await collectWalk(2200)
// 진동은 걷는 프레임만.
const walkA = sA.filter((s) => s.state === 'walk')
const legRangeA = range(walkA.map((s) => s.legX).filter((v) => v != null))
const armRangeA = range(walkA.map((s) => s.armX).filter((v) => v != null))
const slip = slipRatio(sA)
console.log(`[walk-check] clean walk: frames=${walkA.length} legRange=${legRangeA.toFixed(3)} armRange=${armRangeA.toFixed(3)} slip=${slip.toFixed(3)}`)
// 측면 연속컷.
for (let i = 0; i < 6; i++) { await sideCam(); await mainWindow.screenshot({ path: path.join(outDir, `clean_${i}.png`) }); await mainWindow.evaluate(() => window.__walkTo?.(2.5)); await sleep(130) }

// ── B) idle 클립을 깐 뒤에도 걷기 시 다리·팔이 도는가(회귀 방지) ──────
// 예전 버그: 클립이 떠 있으면 gait를 통째로 스킵 → 얼어붙음. 이제 다리는 클립과
// 무관하게 IK가 구동하고, 팔은 effClipMask가 클립에서 떼내 흔든다. idle_sway는
// 실제 .vmd라 clipMask를 만든다(idle 포즈 클립은 E2E에 vmd 없을 수 있어 회피).
await sleep(600)
await mainWindow.evaluate(() => window.__applyMotion?.({ name: 'idle_sway', intensity: 1 }))
await sleep(900) // 클립 본 소유
await startWalk()
await sleep(300)
const sB = await collectWalk(1800)
const walkB = sB.filter((s) => s.state === 'walk')
const legRangeB = range(walkB.map((s) => s.legX).filter((v) => v != null))
const armRangeB = range(walkB.map((s) => s.armX).filter((v) => v != null))
const clipActiveDuringWalk = walkB.some((s) => s.vmd === true)
console.log(`[walk-check] walk after clip: frames=${walkB.length} legRange=${legRangeB.toFixed(3)} armRange=${armRangeB.toFixed(3)} clipActiveSeen=${clipActiveDuringWalk}`)
await sideCam(); await mainWindow.screenshot({ path: path.join(outDir, 'with_clip.png') })

await cleanup()

if (measureOnly) { console.log('MEASURE ONLY — no assertions'); process.exit(0) }

// 하드 단언 — ① glide(얼어붙음) 회귀 ② 발 접지(미끄러짐) 둘 다 잠근다.
const legsMove = legRangeA > SWING_MIN
const armsMove = armRangeA > SWING_MIN
const gaitWithClip = legRangeB > SWING_MIN && armRangeB > SWING_MIN
const footPlant = slip >= 0 && slip < SLIP_MAX
console.log(`\nlegsMove=${legsMove} armsMove=${armsMove} gaitWithClip=${gaitWithClip} footPlant=${footPlant} (slip=${slip.toFixed(3)} < ${SLIP_MAX})`)
if (!legsMove || !armsMove || !gaitWithClip || !footPlant) {
  console.error('WALK CHECK FAILED')
  process.exit(1)
}
console.log('WALK CHECK PASSED')
process.exit(0)
