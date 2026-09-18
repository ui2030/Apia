// 눈치 원장 열람 UI 검증 (5단언) + 스크린샷. 백엔드 없이 UI 배선만.
//
//   단언 1: 원장 섹션 요소 5종 존재 (상태·이벤트·표·집계·초기화)
//   단언 2: 미리 심어둔 원장이 화제 행으로 렌더된다 (점수·증거·상태)
//   단언 3: 수동 라벨 선택이 원장 파일에 저장된다 (골드 라벨 보존)
//   단언 4: '전체 초기화'가 표를 비운다
//   단언 5: 설정 창 콘솔에 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-ledger-e2e-'))
const ledgerPath = join(userData, 'apia-topic-ledger.json')

// 시나리오 테스트가 만든 골든 원장을 그대로 심는다 — UI가 실제 형태의 데이터를
// 그린다는 걸 보여줘야 스크린샷이 의미가 있다.
const golden = await readFile(join(projectRoot, 'tests', 'fixtures', 'topicLedger.golden.json'), 'utf-8')
await writeFile(ledgerPath, golden, 'utf-8')
await mkdir(outDir, { recursive: true })

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const pageErrors = []
let ok = false
try {
  await new Promise((r) => setTimeout(r, 3000))
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))

  const elements = await settingsWindow.evaluate(() => ({
    section: !!document.getElementById('ledger-section'),
    status: !!document.getElementById('ledger-status'),
    events: !!document.getElementById('ledger-events'),
    table: !!document.getElementById('ledger-table'),
    aggregate: !!document.getElementById('ledger-aggregate-btn'),
    reset: !!document.getElementById('ledger-reset-btn')
  }))
  const elementsOk = Object.values(elements).every(Boolean)

  await settingsWindow.evaluate(() => {
    document.getElementById('ledger-section')?.scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'ledger_panel.png') })

  const rendered = await settingsWindow.evaluate(() => {
    const rows = [...document.querySelectorAll('#ledger-table .row')]
    return {
      count: rows.length,
      texts: rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
      status: document.getElementById('ledger-status').textContent,
      events: document.getElementById('ledger-events').textContent
    }
  })
  const renderOk = rendered.count === 2
    && rendered.texts.some((t) => t.includes('업무') && t.includes('조심'))
    && rendered.texts.some((t) => t.includes('게임') && t.includes('편함'))
    && rendered.status.includes('29건')

  // 수동 라벨 → 파일까지 내려가는지
  await settingsWindow.evaluate(() => {
    const select = document.querySelector('#ledger-table select')
    select.value = 'sensitive'
    select.dispatchEvent(new Event('change'))
  })
  await new Promise((r) => setTimeout(r, 600))
  const afterLabel = JSON.parse(await readFile(ledgerPath, 'utf-8'))
  const labelOk = Object.values(afterLabel.topics).some((t) => t.goldLabel === 'sensitive')

  // 전체 초기화 (confirm은 harness에서 자동 승인)
  settingsWindow.on('dialog', (d) => d.accept())
  await settingsWindow.click('#ledger-reset-btn')
  await new Promise((r) => setTimeout(r, 600))
  const afterReset = await settingsWindow.evaluate(
    () => document.getElementById('ledger-table').textContent
  )
  const resetOk = afterReset.includes('아직 모인 기록이 없어요')

  console.log(`elements=${JSON.stringify(elements)}`)
  console.log(`rendered=${JSON.stringify(rendered, null, 2)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshot=${join(outDir, 'ledger_panel.png')}`)
  console.log(`\nelementsOk=${elementsOk} renderOk=${renderOk} labelOk=${labelOk} resetOk=${resetOk} noErrors=${pageErrors.length === 0}`)
  ok = elementsOk && renderOk && labelOk && resetOk && pageErrors.length === 0
} finally {
  await cleanup()
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('LEDGER UI CHECK FAILED')
  process.exit(1)
}
console.log('LEDGER UI CHECK PASSED')
process.exit(0)
