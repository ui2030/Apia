// 환경설정 다중 모니터 선택 검증.
// 모니터 2대 이상인 머신에서: 설정 창에 "표시 모니터" 행이 보이고, 다른 모니터를
// 고르면 캐릭터 창이 그 모니터의 workArea로 실제로 이동하는지 확인한다.
// 모니터 1대면 행이 숨겨져 있는지 확인하고 SKIP.
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('test-results/display-picker')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { app, mainWindow, cleanup } = await launchApia({ extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' } })
const fails = []
const check = (label, ok) => {
  console.log(`[display-picker] ${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) fails.push(label)
}

try {
  const displays = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }))
  )
  console.log('[display-picker] displays =', JSON.stringify(displays))

  const settings = await openSettingsWindow(app, mainWindow)
  await sleep(600) // initDisplayPicker(async IIFE)가 목록을 그릴 시간

  const rowVisible = await settings.evaluate(() => {
    const row = document.getElementById('display-row')
    return !!row && row.style.display !== 'none'
  })

  if (displays.length < 2) {
    check('single display → row stays hidden', rowVisible === false)
    console.log('[display-picker] SKIP move test — single display machine')
  } else {
    check('row visible with 2+ displays', rowVisible === true)

    const optionCount = await settings.evaluate(() => document.getElementById('display-select').options.length)
    check(`option per display (got ${optionCount})`, optionCount === displays.length)

    // 현재가 아닌 모니터를 고른다.
    const target = await settings.evaluate(() => {
      const sel = document.getElementById('display-select')
      const other = [...sel.options].find((o) => o.value !== sel.value)
      return other ? other.value : null
    })
    check('a non-current display option exists', !!target)

    if (target) {
      await settings.selectOption('#display-select', target)
      await sleep(1500) // 이동 + (벽지모드였다면) 재부착 시간

      const mainBounds = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()
          .filter((x) => !x.isDestroyed())
          .sort((a, b) => (b.getBounds().width * b.getBounds().height) - (a.getBounds().width * a.getBounds().height))[0]
        return w ? w.getBounds() : null
      })
      const targetWa = displays.find((d) => String(d.id) === String(target))?.workArea
      console.log('[display-picker] main bounds =', JSON.stringify(mainBounds), 'target workArea =', JSON.stringify(targetWa))
      const cx = mainBounds.x + Math.floor(mainBounds.width / 2)
      const cy = mainBounds.y + Math.floor(mainBounds.height / 2)
      const inside = targetWa &&
        cx >= targetWa.x && cx < targetWa.x + targetWa.width &&
        cy >= targetWa.y && cy < targetWa.y + targetWa.height
      check('main window centre landed inside the chosen display workArea', inside === true)

      // 되돌리기(원래 모니터로) — 토글 반복 동작도 겸사 확인.
      const back = await settings.evaluate(() => {
        const sel = document.getElementById('display-select')
        const other = [...sel.options].find((o) => o.value !== sel.value)
        return other ? other.value : null
      })
      if (back) {
        await settings.selectOption('#display-select', back)
        await sleep(1200)
        const b2 = await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()
            .filter((x) => !x.isDestroyed())
            .sort((a, b) => (b.getBounds().width * b.getBounds().height) - (a.getBounds().width * a.getBounds().height))[0]
          return w ? w.getBounds() : null
        })
        const backWa = displays.find((d) => String(d.id) === String(back))?.workArea
        const bx = b2.x + Math.floor(b2.width / 2)
        const by = b2.y + Math.floor(b2.height / 2)
        const backInside = backWa &&
          bx >= backWa.x && bx < backWa.x + backWa.width &&
          by >= backWa.y && by < backWa.y + backWa.height
        check('moving back to the original display also works', backInside === true)
      }
    }
    await settings.evaluate(() => document.getElementById('display-row')?.scrollIntoView({ block: 'center' }))
    await sleep(300)
    await settings.screenshot({ path: path.join(outDir, 'settings_display_row.png') })
  }
} finally {
  await cleanup()
}

console.log(`[display-picker] done — ${fails.length ? 'FAILURES: ' + fails.join(' | ') : 'ALL PASS'}`)
process.exit(fails.length ? 1 : 0)
