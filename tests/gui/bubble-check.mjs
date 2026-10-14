// 발주서28 D5 — 말풍선이 세로로 긴 빈 상자(230×400)로 그려지던 것 재현·검증.
// 창 1280×752(가상 PC와 같은 크기)에서 짧은 문장·긴 문장, 배율 100%·125%.
//   node tests/gui/bubble-check.mjs [출력폴더] [접두사]
import { launchApia } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outDir = process.argv[2] || join(process.cwd(), 'render-shots')
const prefix = process.argv[3] || 'bubble'
await mkdir(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SHORT = '잠깐 앉아 있을게요.'
const LONG = '오늘은 날씨가 참 좋네요. 창문을 열어 두고 커피 한 잔 마시면서 책을 읽어 볼까 해요. 같이 읽을래요?'
const results = []

for (const scale of [1, 1.25]) {
  const userData = await mkdtemp(join(tmpdir(), 'apia-bubble-'))
  await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
    ...SECOND_MONITOR_SEED, ttsEnabled: false, autoBehavior: false, firstRunDone: true
  }), 'utf-8')
  const { app, mainWindow, cleanup } = await launchApia({
    existingUserData: userData,
    extraArgs: scale === 1 ? [] : [`--force-device-scale-factor=${scale}`]
  })
  try {
    await sleep(8000) // 모델·방 로드
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setResizable(true)
      const b = win.getBounds()
      win.setBounds({ x: b.x, y: b.y, width: 1280, height: 752 })
    })
    await sleep(1500)
    for (const [name, text] of [['short', SHORT], ['long', LONG]]) {
      await app.evaluate(({ BrowserWindow }, t) => {
        BrowserWindow.getAllWindows()[0].webContents.send('character:action', { action: 'bubble', text: t })
      }, text)
      await sleep(700)
      const r = await mainWindow.evaluate(() => {
        const rect = document.getElementById('speech-bubble').getBoundingClientRect()
        return { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y), vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio }
      })
      const shot = join(outDir, `${prefix}_${name}_dpi${Math.round(scale * 100)}.png`)
      await mainWindow.screenshot({ path: shot })
      // 한 줄 문장은 높이가 한 줄 + 패딩(<60px), 긴 문장도 폭 상한(230) 안에서 적당히 접힌다.
      const ok = name === 'short' ? r.h < 60 && r.w > 100 : r.h < 160 && r.w >= 200 && r.w <= 232
      results.push({ scale, name, ...r, ok, shot })
    }
  } finally {
    await cleanup()
    await rm(userData, { recursive: true, force: true })
  }
}

console.log(JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `[BUBBLE_CHECK_FAIL] ${failed.length}건` : '[BUBBLE_CHECK_OK]')
process.exit(failed.length ? 1 : 0)
