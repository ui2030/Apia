// MMD 숨김 토글 파츠(transparent+opacity 0 재질) 흰 셸 회귀 체크.
// 렌더 루프의 syncHiddenMaterialVisibility가 실제로 숨겼는지(visible=false)
// 단언하고, 측면 스크린샷을 시각 기록으로 남긴다.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/hidden-parts-check')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
let pageErrors = 0
mainWindow.on('pageerror', (e) => { pageErrors++; console.log(`[pageerror] ${e?.message || e}`) })

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
await sleep(1200) // 렌더 루프가 몇 프레임 돌아 sync가 적용될 시간

const fails = []
const check = (label, ok) => {
  console.log(`[hidden-parts] ${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) fails.push(label)
}

// 프로덕션 로직과 동일 기준(transparent===true && opacity<=eps)으로 단언.
const report = await mainWindow.evaluate(() => {
  let mesh = null
  window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  if (!mesh) return null
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const eps = 0.001
  const hiddenTargets = []
  const leaks = []
  for (const m of mats) {
    if (!m) continue
    if (m.transparent === true && (m.opacity ?? 1) <= eps) {
      hiddenTargets.push(m.name)
      if (m.visible !== false) leaks.push(m.name)
    }
  }
  return { total: mats.length, hiddenTargets, leaks }
})
console.log('[hidden-parts] report =', JSON.stringify(report))
check('model found with materials', !!report && report.total > 0)
check(`this model has hidden toggle parts (got ${report?.hiddenTargets?.length})`, (report?.hiddenTargets?.length ?? 0) > 0)
check(`all hidden parts are invisible (leaks: ${report?.leaks?.join(',') || 'none'})`, (report?.leaks?.length ?? 0) === 0)

// 시각 기록 — 어제 흰 셸이 보이던 측면 각도.
await mainWindow.evaluate(() => {
  for (const id of ['chat-panel', 'speech-bubble']) {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  }
  let mesh = null
  window.__apiaScene?.traverse((o) => { if (!mesh && o.skeleton) mesh = o })
  const cam = window.__apiaCamera
  if (!mesh || !cam) return
  const v = mesh.getWorldPosition(new mesh.position.constructor())
  cam.position.set(v.x + 2.2, v.y + 1.0, v.z + 0.2)
  cam.lookAt(v.x, v.y + 0.8, v.z)
  cam.updateProjectionMatrix()
})
await sleep(400)
await mainWindow.screenshot({ path: path.join(outDir, 'side_clean.png') })

check('no renderer page errors', pageErrors === 0)
console.log(`[hidden-parts] done — ${fails.length ? 'FAILURES: ' + fails.join(' | ') : 'ALL PASS'} — ${outDir}`)
await cleanup()
process.exit(fails.length ? 1 : 0)
