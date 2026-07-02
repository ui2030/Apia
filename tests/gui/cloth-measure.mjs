// 옷 물리 실측 — 떨림(프레임별 진폭)·올라감(장기 Y 드리프트)·박힘(시각 컷).
// idle 20s → walk → idle 순서로 치마/옷 물리 본을 매 프레임 샘플링해 수치화하고
// 힙 높이 클로즈업 컷을 남긴다. 판정 없음(진단 전용) — 수정 전후 비교 기준.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/cloth-measure')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
mainWindow.on('pageerror', (e) => console.log(`[pageerror] ${e?.message || e}`))
await mainWindow.evaluate(() => window.__setAutoBehavior?.(false)).catch(() => {})
{
  const end = Date.now() + 25000
  while (Date.now() < end) {
    const ok = await mainWindow.evaluate(() => {
      let m = null
      window.__apiaScene?.traverse((o) => { if (!m && o.skeleton) m = o })
      return !!m
    })
    if (ok) break
    await sleep(400)
  }
}
await sleep(1500)

// ── 페이지 안에 샘플러 설치: rAF마다 옷 본 월드좌표 기록 ─────────────────
await mainWindow.evaluate(() => {
  let mesh = null
  window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return
  // 옷·물리 본: すそ(치맛자락 체인), テール(트윈테일 머리), しっぽ(꼬리), 胸.
  // 전체 추적은 무겁고, 대표 샘플: 각 부위에서 말단 위주로 고르게 추린다.
  const all = mesh.skeleton.bones.filter((b) => /すそ|テール\d|しっぽ\d|[左右]胸$/i.test(b.name))
  // 치맛자락은 체인 끝 세그먼트(-5|-12)가 흔들림 대표 — 표본 축소.
  const targets = all.filter((b) => /すそ_.+-(5|9|12)\b|テール(5|10|15)|しっぽ(4|8|12)|胸/.test(b.name))
  window.__clothSampler = {
    targets: targets.map((b) => b.name),
    frames: [],
    on: false,
    _v: null
  }
  const V = mesh.position.constructor
  const v = new V()
  function tick() {
    if (window.__clothSampler.on) {
      const rec = { t: performance.now(), p: [] }
      for (const b of targets) {
        b.getWorldPosition(v)
        rec.p.push([+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5)])
      }
      window.__clothSampler.frames.push(rec)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const targets = await mainWindow.evaluate(() => window.__clothSampler?.targets || [])
console.log(`[cloth] tracking ${targets.length} bones:`, targets.slice(0, 12).join(','), targets.length > 12 ? `… +${targets.length - 12}` : '')
if (targets.length < 20) {
  // 본 이름 매칭이 깨지면 "측정 0"이 유효한 결과처럼 보인다 — 크게 실패시킨다.
  console.log(`[cloth] FAIL — tracked bones ${targets.length} < 20 (bone name regex broken?)`)
  await cleanup()
  process.exit(1)
}

async function record(label, ms) {
  await mainWindow.evaluate(() => { window.__clothSampler.frames = []; window.__clothSampler.on = true })
  await sleep(ms)
  const frames = await mainWindow.evaluate(() => { window.__clothSampler.on = false; return window.__clothSampler.frames })
  // 지표: 본별 프레임간 이동량(떨림), 시간 절반 전후 평균 y(올라감 추세)
  const n = frames.length
  if (n < 10) { console.log(`[cloth] ${label}: too few frames (${n})`); return null }
  const boneCount = frames[0].p.length
  let jitterSum = 0, jitterMax = 0, jitterMaxBone = -1
  const perBoneJitter = new Array(boneCount).fill(0)
  for (let f = 1; f < n; f++) {
    for (let b = 0; b < boneCount; b++) {
      const a = frames[f - 1].p[b], c = frames[f].p[b]
      const d = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])
      perBoneJitter[b] += d
      if (d > jitterMax) { jitterMax = d; jitterMaxBone = b }
    }
  }
  const half = Math.floor(n / 2)
  const meanY = (from, to) => {
    let s = 0, k = 0
    for (let f = from; f < to; f++) for (let b = 0; b < boneCount; b++) { s += frames[f].p[b][1]; k++ }
    return s / k
  }
  const yFirst = meanY(0, half)
  const ySecond = meanY(half, n)
  const avgJitterPerFrame = perBoneJitter.reduce((a, b) => a + b, 0) / (n - 1) / boneCount
  const worst = perBoneJitter.map((v, i) => [v / (n - 1), i]).sort((a, b) => b[0] - a[0]).slice(0, 5)
  const fps = Math.round((n - 1) / ((frames[n - 1].t - frames[0].t) / 1000))
  const summary = {
    label, frames: n, fps,
    avgJitterPerFrame: +avgJitterPerFrame.toFixed(6),
    maxSingleFrameJump: +jitterMax.toFixed(5),
    maxJumpBone: targets[jitterMaxBone],
    yDrift: +(ySecond - yFirst).toFixed(5),
    worstBones: worst.map(([v, i]) => `${targets[i]}:${v.toFixed(5)}`)
  }
  console.log(`[cloth] ${label} =`, JSON.stringify(summary))
  return { summary, frames }
}

async function hipCam(dx, dz, file) {
  await mainWindow.evaluate(({ dx, dz }) => {
    for (const id of ['chat-panel', 'speech-bubble']) {
      const el = document.getElementById(id)
      if (el) el.style.display = 'none'
    }
    let mesh = null
    window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
    const cam = window.__apiaCamera
    if (!mesh || !cam) return
    const v = mesh.getWorldPosition(new mesh.position.constructor())
    cam.position.set(v.x + dx, v.y + 0.75, v.z + dz)
    cam.lookAt(v.x, v.y + 0.6, v.z)
    cam.updateProjectionMatrix()
  }, { dx, dz })
  await sleep(300)
  await mainWindow.screenshot({ path: path.join(outDir, file) })
}

// ── 1) 서있기(idle) 15s ──────────────────────────────────────────────
const idleRes = await record('idle-standing', 15000)
await hipCam(0, 1.6, 'idle_front_hip.png')
await hipCam(1.6, 0.2, 'idle_side_hip.png')

// ── 2) 걷기 ──────────────────────────────────────────────────────────
await mainWindow.evaluate(() => window.__walkTo?.(2.0))
await sleep(600)
const walkRes = await record('walking', 6000)
await hipCam(0, 1.6, 'walk_front_hip.png')
await sleep(4000) // 걷기 종료 대기

// ── 3) 걷기 직후 idle(정착 여부) 10s ─────────────────────────────────
const settleRes = await record('post-walk-idle', 10000)
await hipCam(0, 1.6, 'settle_front_hip.png')
await hipCam(1.6, 0.2, 'settle_side_hip.png')

// 원시 데이터 저장(수정 전후 비교용)
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
  idle: idleRes?.summary, walk: walkRes?.summary, settle: settleRes?.summary
}, null, 2))
console.log('[cloth] done —', outDir)
await cleanup()
process.exit(0)
