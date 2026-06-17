// 진단: 여러 창 크기에서 캐릭터의 화면 점유율(가로/세로 비율)과 카메라 값을
// 측정한다. "display 2(2560x1440 16:9)에서 캐릭터가 어떻게 보이나"를 수치로.
import { launchApia } from './helpers/launchApia.mjs'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OUT = process.argv[2] || path.resolve('test-results', 'diag')
await mkdir(OUT, { recursive: true })
const userData = await mkdtemp(path.join(tmpdir(), 'apia-diag-'))
await writeFile(path.join(userData, 'apia-settings.json'), JSON.stringify({
  alwaysOnTop: true, charScale: 101, autoBehavior: false, ttsEnabled: true,
  aiMode: 'auto', windowAnchor: { x: -2560, y: 720 }
}, null, 2))

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData, extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const setWindow = (w, h) => app.evaluate(({ BrowserWindow }, { w, h }) => {
  const win = BrowserWindow.getAllWindows()[0]; const b = win.getBounds()
  win.setBounds({ x: b.x, y: b.y, width: w, height: h })
}, { w, h })

// THREE 미노출 → 카메라 행렬(projection·matrixWorldInverse)로 직접 투영.
const measure = () => mainWindow.evaluate(() => {
  const scene = window.__apiaScene, cam = window.__apiaCamera
  if (!scene || !cam) return null
  let mesh = null
  scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o })
  if (!mesh) return null
  const geo = mesh.geometry
  if (!geo.boundingBox) geo.computeBoundingBox()
  const bb = geo.boundingBox
  mesh.updateMatrixWorld()
  const mw = mesh.matrixWorld.elements
  const vi = cam.matrixWorldInverse.elements
  const pj = cam.projectionMatrix.elements
  const apply = (e, v) => ({
    x: e[0]*v.x + e[4]*v.y + e[8]*v.z + e[12]*v.w,
    y: e[1]*v.x + e[5]*v.y + e[9]*v.z + e[13]*v.w,
    z: e[2]*v.x + e[6]*v.y + e[10]*v.z + e[14]*v.w,
    w: e[3]*v.x + e[7]*v.y + e[11]*v.z + e[15]*v.w
  })
  const xs = [], ys = []
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
    let p = apply(mw, { x, y, z, w: 1 })
    p = apply(vi, p)
    p = apply(pj, p)
    xs.push(p.x / p.w); ys.push(p.y / p.w)
  }
  const ndcW = Math.max(...xs) - Math.min(...xs)
  const ndcH = Math.max(...ys) - Math.min(...ys)
  return {
    fov: +cam.fov.toFixed(2), aspect: +cam.aspect.toFixed(3),
    vw: window.innerWidth, vh: window.innerHeight,
    widthFrac: +(ndcW / 2).toFixed(3),
    heightFrac: +(ndcH / 2).toFixed(3),
    cxNDC: +(((Math.max(...xs) + Math.min(...xs)) / 2)).toFixed(3)
  }
}).catch((e) => ({ error: String(e) }))

try {
  for (let i = 0; i < 60; i++) {
    const ok = await mainWindow.evaluate(() => { const s=window.__apiaScene; if(!s) return false; let f=false; s.traverse(o=>{if(o.isSkinnedMesh)f=true}); return f }).catch(()=>false)
    if (ok) break; await new Promise(r=>setTimeout(r,1000))
  }
  await new Promise(r=>setTimeout(r,1500))
  for (const [w,h,label] of [[1920,1032,'D1_1920x1032'],[2560,1392,'D2_2560x1392'],[2560,1440,'D2_full_2560x1440']]) {
    await setWindow(w,h); await new Promise(r=>setTimeout(r,1000))
    const m = await measure()
    console.log(label, JSON.stringify(m))
    await mainWindow.screenshot({ path: path.join(OUT, label + '.png') })
  }
} finally { await cleanup() }
process.exit(0)
