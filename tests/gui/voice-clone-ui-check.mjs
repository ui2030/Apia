// 음성 복제 설정 UI 검증 (4단언) — 백엔드 없이 UI 배선만.
//
//   단언 1: 설정 창에 복제 UI 요소 5종 존재 (이름·파일·만들기·게이지·완료)
//   단언 2: 파일 미선택 시 만들기 버튼 disabled
//   단언 3: 복제 음성(custom:) 선택 시에만 미리듣기/삭제 행 표시
//   단언 4: 설정 창 콘솔에 페이지 에러 0건 (인라인 스크립트 문법/배선 오류 검출)
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'

const { app, mainWindow, cleanup } = await launchApia({
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const pageErrors = []
try {
  await new Promise((r) => setTimeout(r, 3000))
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))

  const ui = await settingsWindow.evaluate(() => ({
    name: !!document.getElementById('voice-clone-name'),
    file: !!document.getElementById('voice-clone-file'),
    start: !!document.getElementById('voice-clone-start'),
    bar: !!document.getElementById('voice-clone-bar'),
    done: !!document.getElementById('voice-clone-done'),
    startDisabled: document.getElementById('voice-clone-start')?.disabled,
    actionsHidden: document.getElementById('voice-custom-actions')?.hidden
  }))
  const elementsOk = ui.name && ui.file && ui.start && ui.bar && ui.done
  const disabledOk = ui.startDisabled === true

  // custom 옵션을 주입해 선택 → 액션 행 토글 검증 (백엔드 없이)
  const toggleOk = await settingsWindow.evaluate(() => {
    const sel = document.getElementById('voice-select')
    const o = document.createElement('option')
    o.value = 'custom:voice_00000000'
    o.textContent = '테스트 (복제 음성)'
    sel.appendChild(o)
    sel.value = o.value
    sel.dispatchEvent(new Event('change'))
    const shown = document.getElementById('voice-custom-actions').hidden === false
    sel.value = ''
    sel.dispatchEvent(new Event('change'))
    const hidden = document.getElementById('voice-custom-actions').hidden === true
    return shown && hidden
  })

  console.log(`elements=${JSON.stringify(ui)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`\nelementsOk=${elementsOk} disabledOk=${disabledOk} toggleOk=${toggleOk} noErrors=${pageErrors.length === 0}`)
  if (!elementsOk || !disabledOk || !toggleOk || pageErrors.length > 0) {
    console.error('VOICE CLONE UI CHECK FAILED')
    await cleanup()
    process.exit(1)
  }
  console.log('VOICE CLONE UI CHECK PASSED')
} finally {
  await cleanup()
}
process.exit(0)
