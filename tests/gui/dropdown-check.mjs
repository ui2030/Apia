// 설정창 드롭다운(select) 가독성 검증 — 다크 테마에서 option이 보이는가.
//
// 배경: select 본체는 background:rgba(255,255,255,0.07) + color:흰색 계열이다.
// color-scheme 선언이 없으면 Chromium이 네이티브 팝업을 밝은 테마 기본값(흰
// 바탕)으로 그려서, 흰 바탕 + 흰 글씨 = "항목이 하나도 안 보이는" 드롭다운이
// 된다. 선택은 되는데 보이지 않아 사용자는 "목록이 비었다"로 읽는다.
//
//   단언 1: option의 배경이 불투명 어두운 색 (알파 1, 밝기 낮음)
//   단언 2: option 글자색과 배경색의 밝기 차가 충분 (대비 비율 >= 4.5)
//   단언 3: 볼 창 목록이 비면 "(고를 수 있는 창이 없어요…)" 항목이 붙는다
//           — 스타일 때문에 안 보이는 것과 실제로 빈 것을 구별시켜 준다
//   단언 4: 페이지 에러 0건
//
// 그리고 실기 증거로, 모니터 2(없으면 주 모니터)로 설정 창을 옮긴 뒤 목소리·
// 볼 창 드롭다운을 실제로 열어 OS 화면 캡처를 남긴다. 네이티브 팝업은 Electron
// 스크린샷에 잡히지 않아 PowerShell CopyFromScreen을 쓴다.
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const outDir = path.resolve('test-results/dropdown-check')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`[dropdown] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

/** rgb(a) 문자열 → {r,g,b,a} */
function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(',').map((n) => parseFloat(n))
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

/** WCAG 상대 휘도 */
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrastRatio(fg, bg) {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** 모니터 영역을 PNG로 저장 (네이티브 select 팝업까지 잡힌다). */
function grabScreen(bounds, file) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$bmp = New-Object System.Drawing.Bitmap(${bounds.width}, ${bounds.height});`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    `$g.CopyFromScreen(${bounds.x}, ${bounds.y}, 0, 0, $bmp.Size);`,
    `$bmp.Save('${file.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose(); $bmp.Dispose();'
  ].join(' ')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8'
  })
  if (r.status !== 0) console.warn('[dropdown] screen grab failed:', r.stderr)
}

/** 열려 있는 네이티브 팝업을 OS 레벨 ESC로 닫는다 (렌더러가 중첩 루프에 잡혀 있어도 먹는다). */
function pressEscape() {
  spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ESC}")'
  ], { encoding: 'utf8' })
}

const { app, mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const pageErrors = []
try {
  await sleep(2500)
  const settings = await openSettingsWindow(app, mainWindow)
  settings.on('pageerror', (e) => pageErrors.push(String(e)))
  await sleep(1500)

  // ── 단언 1·2: option 실측 ────────────────────────────────────────────
  const styles = await settings.evaluate(() => {
    const out = {}
    for (const id of ['voice-select', 'spectate-window', 'ai-mode']) {
      const sel = document.getElementById(id)
      if (!sel) { out[id] = null; continue }
      const opt = sel.options[0]
      const cs = getComputedStyle(opt)
      out[id] = {
        optionBg: cs.backgroundColor,
        optionColor: cs.color,
        selectBg: getComputedStyle(sel).backgroundColor,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        optionCount: sel.options.length,
        optionTexts: [...sel.options].map((o) => o.textContent)
      }
    }
    return out
  })
  console.log('[dropdown] measured =', JSON.stringify(styles, null, 2))

  for (const [id, s] of Object.entries(styles)) {
    if (!s) { check(`${id} exists`, false); continue }
    const bg = parseRgb(s.optionBg)
    const fg = parseRgb(s.optionColor)
    check(`${id} option 배경 불투명`, !!bg && bg.a === 1, s.optionBg)
    check(`${id} option 배경 어두움`, !!bg && luminance(bg) < 0.2, String(bg && luminance(bg).toFixed(3)))
    const ratio = bg && fg ? contrastRatio(fg, bg) : 0
    check(`${id} option 대비 >= 4.5`, ratio >= 4.5, `ratio=${ratio.toFixed(2)}`)
  }
  check('color-scheme: dark 선언', styles['ai-mode']?.colorScheme === 'dark', styles['ai-mode']?.colorScheme)

  // ── 단언 3: 빈 목록은 "없다"고 말한다 ─────────────────────────────────
  const emptyNotice = await settings.evaluate(() => {
    const sel = document.getElementById('spectate-window')
    if (!sel) return null
    const texts = [...sel.options].map((o) => o.textContent)
    // 실제 목록이 비었을 때만 안내 항목이 붙는 게 계약이다.
    return { texts, real: sel.options.length - 1 }
  })
  console.log('[dropdown] spectate options =', JSON.stringify(emptyNotice))
  // ── 로컬 모델 라벨이 백엔드 MODEL_ID에서 파생되는가 ────────────────────
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('warmup:status')
    ipcMain.handle('warmup:status', async () => ({
      initialized_modes: [], available_modes: ['local'], auto_target: 'local',
      mode: 'local', default_mode: 'local', warming: false, last_error: null,
      model_id: 'Vendor/SomeModel-9Z-Instruct-1234'
    }))
  })
  const labels = await settings.evaluate(async () => {
    document.getElementById('provider-status-refresh').click()
    await new Promise((r) => setTimeout(r, 600))
    return [...document.querySelectorAll('select option[value="local"]')].map((o) => o.textContent)
  })
  check('로컬 라벨이 MODEL_ID 파생', labels.length > 0 && labels.every((t) => t === '로컬 (SomeModel-9Z)'),
    JSON.stringify(labels))

  // ── 실기 캡처: 모니터 2(가능하면)에서 드롭다운을 실제로 펼친다 ────────
  const displays = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }))
  )
  const target = displays[1] || displays[0]
  console.log(`[dropdown] capture display = ${target.id} ${JSON.stringify(target.bounds)} (of ${displays.length})`)

  // DIP(Electron 좌표) → 물리 픽셀(GDI 캡처 좌표). 보조 모니터가 다른 배율이면
  // 이 변환 없이는 엉뚱한 영역을 찍는다.
  const shot = await app.evaluate(({ BrowserWindow, screen }, b) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings'))
    if (!win) return null
    const rect = { x: b.x + 60, y: b.y + 60, width: 460, height: 760 }
    win.setBounds(rect)
    win.setAlwaysOnTop(true, 'screen-saver') // 터미널/탐색기에 가리지 않게
    win.focus()
    const grow = { x: rect.x - 10, y: rect.y - 10, width: rect.width + 20, height: rect.height + 20 }
    return screen.dipToScreenRect(null, grow)
  }, target.bounds)
  console.log('[dropdown] capture rect(physical) =', JSON.stringify(shot))
  await sleep(1000)

  for (const [id, file] of [
    ['voice-select', 'dropdown-voice.png'],
    ['spectate-window', 'dropdown-spectate.png']
  ]) {
    const box = await settings.evaluate((elId) => {
      const el = document.getElementById(elId)
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, id)
    await sleep(400)
    // await 하지 않는다 — 네이티브 팝업이 열리면 중첩 메시지 루프가 돌아
    // CDP 응답이 팝업 닫힘까지 안 온다.
    settings.mouse.click(box.x, box.y).catch(() => {})
    await sleep(1400)
    grabScreen(shot, path.join(outDir, file))
    pressEscape()
    await sleep(700)
    console.log(`[dropdown] captured ${file}`)
  }

  // ── 단언 3 (캡처 뒤에 둔다 — 목록을 비우면 되돌릴 수 없다) ────────────
  if (emptyNotice && emptyNotice.real === 0) {
    check('빈 목록 안내 항목', emptyNotice.texts.some((t) => t.includes('없어요')))
  } else {
    // 실기에는 늘 창이 있으니, 메인 프로세스의 IPC 핸들러를 빈 배열로 갈아끼우고
    // 새로고침을 눌러 빈 분기를 실제로 태운다 (window.api는 contextBridge라 동결).
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('spectate:listWindows')
      ipcMain.handle('spectate:listWindows', async () => [])
    })
    const forced = await settings.evaluate(async () => {
      document.getElementById('spectate-refresh').click()
      await new Promise((r) => setTimeout(r, 600))
      const opts = [...document.getElementById('spectate-window').options]
      return { texts: opts.map((o) => o.textContent), disabled: opts.map((o) => o.disabled) }
    })
    check('빈 목록 안내 항목', forced.texts.some((t) => t.includes('없어요')), JSON.stringify(forced.texts))
    check('안내 항목은 고를 수 없음', forced.disabled.at(-1) === true)

    // 빈 상태 드롭다운도 한 장 남긴다 — "안 보이는 것"과 "없는 것"의 차이 증거.
    const box = await settings.evaluate(() => {
      const el = document.getElementById('spectate-window')
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await sleep(400)
    settings.mouse.click(box.x, box.y).catch(() => {})
    await sleep(1400)
    grabScreen(shot, path.join(outDir, 'dropdown-spectate-empty.png'))
    pressEscape()
    await sleep(700)
    console.log('[dropdown] captured dropdown-spectate-empty.png')
  }

  check('페이지 에러 0건', pageErrors.length === 0, JSON.stringify(pageErrors))
} finally {
  await cleanup()
}

console.log(fails.length === 0 ? 'DROPDOWN CHECK PASSED' : `DROPDOWN CHECK FAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)
