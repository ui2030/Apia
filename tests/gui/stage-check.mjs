// 임시 E2E — 스테이지 어댑터 검증(실 스테이지 자산 없이):
// ① GLB 라운드트립: 현재 가구 그룹을 GLTFExporter로 내보내 임시 .glb 저장 →
//    __setStage → 'apia-stage' 존재 + 절차적 방 숨김 + 스크린샷.
// ② __clearStage → 방 복원.
// ③ PMX 경로: 로컬 캐릭터 PMX를 스테이지로 로드(시각은 무의미, file:// 텍스처
//    해석·정적 로드·외곽선 off 파이프 증명).
// ④ localStorage 영속 확인. 콘솔 에러 단언.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const outDir = path.resolve('test-results/stage')
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sceneState = () => mainWindow.evaluate(() => {
  const scene = window.__apiaScene
  let stage = null, room = null, furn = null
  scene.traverse((o) => {
    if (o.name === 'apia-stage') stage = o
    if (o.name === 'apia-room') room = o
    if (o.name === 'apia-furniture') furn = o
  })
  return { hasStage: !!stage, roomVisible: room?.visible ?? null, furnVisible: furn?.visible ?? null }
})

// ① node에서 three로 테스트 방 GLB 생성(바닥+벽+박스 가구 몇 개) → 저장.
//    실 스테이지 자산 없이 GLB 로드 경로를 증명한다.
// GLTFExporter가 브라우저 FileReader를 쓰므로 node용 최소 폴리필(Blob 기반).
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.() }) }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`
      this.onloadend?.()
    })
  }
}
const { Scene, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial, Group } = await import('three')
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
const testStage = new Group()
const mk = (geo, color, x, y, z) => {
  const m = new Mesh(geo, new MeshStandardMaterial({ color }))
  m.position.set(x, y, z)
  testStage.add(m)
}
mk(new BoxGeometry(6, 0.1, 8), 0x6a4a30, 0, -0.05, 4)      // 바닥
mk(new BoxGeometry(6, 3, 0.1), 0xc8b090, 0, 1.5, 0)        // 뒷벽
mk(new BoxGeometry(1.2, 0.5, 0.8), 0x9c2f2f, -1.5, 0.25, 2) // 침대풍 박스
mk(new BoxGeometry(0.8, 0.9, 0.5), 0x4a6a8a, 1.8, 0.45, 3)  // 수납풍 박스
const exportScene = new Scene()
exportScene.add(testStage)
const glbBuf = await new Promise((resolve, reject) =>
  new GLTFExporter().parse(exportScene, resolve, reject, { binary: true })
)
const glbPath = path.join(outDir, 'roundtrip-stage.glb')
writeFileSync(glbPath, Buffer.from(glbBuf))
console.log('generated glb bytes:', glbBuf.byteLength)

const okGlb = await mainWindow.evaluate((p) => window.__setStage(p, { position: { z: 0 } }), glbPath.replace(/\\/g, '/'))
await wait(600)
let st = await sceneState()
console.log('after glb stage:', JSON.stringify({ okGlb, ...st }))
if (!okGlb || !st.hasStage || st.roomVisible !== false || st.furnVisible !== false) { console.error('FAIL glb stage state'); fails++ }
await mainWindow.screenshot({ path: path.join(outDir, 'glb_stage.png') })
const persisted = await mainWindow.evaluate(() => localStorage.getItem('apiaStage'))
if (!persisted || !persisted.includes('roundtrip-stage')) { console.error('FAIL persistence'); fails++ }

// ② 복원
await mainWindow.evaluate(() => window.__clearStage())
await wait(400)
st = await sceneState()
console.log('after clear:', JSON.stringify(st))
if (st.hasStage || st.roomVisible !== true || st.furnVisible !== true) { console.error('FAIL clear/restore'); fails++ }
await mainWindow.screenshot({ path: path.join(outDir, 'restored.png') })

// ③ PMX 정적 로드 파이프(로컬 PMX 아무거나 스테이지로 — 시각 무의미, 파이프
//    증명). 모델 자산은 gitignore라 이름 하드코딩 금지 — 런타임 탐색, 없으면 skip.
let pmxPath = null
{
  const { readdirSync, statSync } = await import('node:fs')
  const roots = [path.resolve('src/assets')]
  const stack = [...roots]
  while (stack.length && !pmxPath) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const e of entries) {
      const p = path.join(dir, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) stack.push(p)
      else if (/\.pmx$/i.test(e)) { pmxPath = p; break }
    }
  }
}
if (pmxPath) {
  const okPmx = await mainWindow.evaluate((p) => window.__setStage(p, { position: { x: 2.0, z: 1.0 } }), pmxPath.replace(/\\/g, '/'))
  await wait(1500) // 텍스처 로드 여유
  st = await sceneState()
  console.log('after pmx stage:', JSON.stringify({ okPmx, ...st }))
  if (!okPmx || !st.hasStage) { console.error('FAIL pmx stage'); fails++ }
  await mainWindow.screenshot({ path: path.join(outDir, 'pmx_stage.png') })
  await mainWindow.evaluate(() => window.__clearStage())
} else {
  console.log('skip pmx pipe check (로컬 PMX 없음)')
}

if (errors.length) { console.error('console errors:', JSON.stringify(errors.slice(0, 5))); fails += errors.length }
await cleanup()
console.log(fails ? `STAGE CHECK FAILED (${fails})` : 'STAGE CHECK PASSED')
process.exit(fails ? 1 : 0)
