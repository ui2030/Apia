// 교재 파이프라인 설정 패널 검증 (5단언) + 스크린샷. 백엔드는 꺼진 상태로 돈다.
//
//   단언 1: 교재 섹션 요소 5종 존재 (카드·대기·지출·마지막 변환·지금 변환)
//   단언 2: 미리 심어둔 교재/버퍼/상태가 그대로 렌더된다
//   단언 3: '지금 변환'을 눌러도 — 백엔드가 없으니 — 원본 버퍼가 살아남는다
//           (폐기 규칙을 실제 앱 경로에서 확인하는 자리)
//   단언 4: 실패가 아니라 조용한 연기다 (status.json의 failures가 비어 있다)
//   단언 5: 설정 창 콘솔에 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-courseware-e2e-'))
const root = join(userData, 'courseware')
const bufferPath = join(root, 'buffers', '2026-09-01.jsonl')

await mkdir(join(root, 'buffers'), { recursive: true })
await mkdir(join(root, 'cards'), { recursive: true })
await mkdir(outDir, { recursive: true })

// 변환이 끝난 이틀치 교재 + 아직 안 끝난 하루치 원본.
await writeFile(join(root, 'cards', '2026-08-30.jsonl'),
  ['{"day":"2026-08-30","u":"커피는 하루 몇 잔 마셔?","a":"두 잔쯤이요."}',
   '{"day":"2026-08-30","u":"주말엔 뭐 해?","a":"등산 다니시죠."}'].join('\n') + '\n', 'utf-8')
await writeFile(join(root, 'cards', '2026-08-31.jsonl'),
  '{"day":"2026-08-31","u":"등산화는 새로 샀어?","a":"네, 잘 맞는다고 하셨어요."}\n', 'utf-8')
await writeFile(bufferPath,
  '{"t":1788310800000,"u":"오늘 회의 길었어","a":"고생하셨네요."}\n', 'utf-8')
await writeFile(join(root, 'status.json'), JSON.stringify({
  schema_version: 2,
  lastConvertedAt: Date.now() - 86400000,
  cardCounts: { '2026-08-30': 2, '2026-08-31': 1 },
  spend: { '2026-09-01': 0.0004, '2026-09-02': 0.0011 },
  failures: {},
  warnings: [],
  lastError: null
}, null, 2), 'utf-8')

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
    section: !!document.getElementById('courseware-section'),
    cards: !!document.getElementById('courseware-cards'),
    pending: !!document.getElementById('courseware-pending'),
    spend: !!document.getElementById('courseware-spend'),
    last: !!document.getElementById('courseware-last'),
    convert: !!document.getElementById('courseware-convert-btn')
  }))
  const elementsOk = Object.values(elements).every(Boolean)

  await settingsWindow.evaluate(() => {
    document.getElementById('courseware-section')?.scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'courseware_panel.png') })

  const rendered = await settingsWindow.evaluate(() => ({
    cards: document.getElementById('courseware-cards').textContent,
    pending: document.getElementById('courseware-pending').textContent,
    spend: document.getElementById('courseware-spend').textContent,
    last: document.getElementById('courseware-last').textContent
  }))
  const renderOk = rendered.cards.includes('3장') && rendered.cards.includes('2일치')
    && rendered.pending.includes('2026-09-01')
    && rendered.spend.includes('$0.0015') && rendered.spend.includes('$0.07')
    && !rendered.last.includes('아직 없음')

  // 백엔드가 꺼진 채로 "지금 변환" — 변환은 못 하지만 원본은 반드시 남아야 한다.
  await settingsWindow.click('#courseware-convert-btn')
  await new Promise((r) => setTimeout(r, 3000))
  const bufferSurvived = existsSync(bufferPath)
  const status = JSON.parse(await readFile(join(root, 'status.json'), 'utf-8'))
  const deferredOk = Object.keys(status.failures).length === 0 && status.warnings.length === 0
  const afterClick = await settingsWindow.evaluate(
    () => document.getElementById('courseware-pending').textContent
  )

  console.log(`elements=${JSON.stringify(elements)}`)
  console.log(`rendered=${JSON.stringify(rendered, null, 2)}`)
  console.log(`afterClick pending=${afterClick}`)
  console.log(`status=${JSON.stringify(status)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshot=${join(outDir, 'courseware_panel.png')}`)
  console.log(`\nelementsOk=${elementsOk} renderOk=${renderOk} bufferSurvived=${bufferSurvived} deferredOk=${deferredOk} noErrors=${pageErrors.length === 0}`)
  ok = elementsOk && renderOk && bufferSurvived && deferredOk && pageErrors.length === 0
} finally {
  await cleanup()
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('COURSEWARE UI CHECK FAILED')
  process.exit(1)
}
console.log('COURSEWARE UI CHECK PASSED')
process.exit(0)
