// 야간 학습기 + 그림자 모드 설정 패널·배선 검증 (6단언) + 스크린샷.
// 백엔드는 **가짜**로 띄운다 — 그림자 경로가 실제 채팅 초크포인트를 타는지,
// 그리고 디스크에 점수만 남는지가 이 하네스의 존재 이유다.
//
//   단언 1: 학습 섹션 요소 3종 존재 (마지막 학습·채택 델타·그림자) + 시작 버튼
//   단언 2: 미리 심어둔 채택 델타/그림자 집계가 그대로 렌더된다
//   단언 3: 채팅 한 번 → 그림자 시도 수가 늘고, **응답 원문도 인증 토큰도
//           디스크에 없다**(토큰은 실행마다 새로 나는 64자리 hex)
//   단언 4: 채택 델타를 치우면 그림자는 조용히 휴면(시도 수 그대로 + 사유 기록)
//   단언 5: '지금 시작'은 조건 미충족 시 연기하고 이전 채택 델타를 건드리지 않는다
//   단언 6: 설정 창 콘솔에 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-nightschool-e2e-'))
const trainingDir = join(userData, 'courseware', 'training')
const anchorDir = join(trainingDir, 'anchors', '2026-09-25T02-00')
const statusPath = join(trainingDir, 'status.json')

// 백엔드는 [EMOTION:...]을 떼고 reply를 준다(chat 라우터 계약). 그림자 쪽도
// 같은 규칙으로 떼고 오므로 둘은 같은 형태로 비교된다.
const API_REPLY = '모루는 여섯 살이에요.'
const SHADOW_REPLY = '모루는 여섯 살이라고 하셨어요.'  // 비슷하지만 같지는 않은 답

await mkdir(anchorDir, { recursive: true })
await mkdir(outDir, { recursive: true })
await writeFile(join(anchorDir, 'adapter_config.json'), '{"peft_type":"LORA"}', 'utf-8')
await writeFile(join(anchorDir, 'adapter_model.safetensors'), 'fake-weights', 'utf-8')
await writeFile(statusPath, JSON.stringify({
  schema_version: 1,
  lastRunAt: Date.now() - 3600000,
  lastStatus: 'passed',
  lastReason: '통과',
  lastSuccessAt: Date.now() - 3600000,
  cardsAtLastSuccess: 30,
  adopted: { version: '2026-09-25T02-00', dir: anchorDir, adoptedAt: Date.now() - 3600000, gate: { passed: true } },
  anchors: ['2026-09-25T02-00'],
  teacherSpentWeek: 0.0021,
  shadow: {},
  shadowDormant: null
}, null, 2), 'utf-8')

// 학습용 파이썬을 일부러 없는 경로로 — '지금 시작'이 조건 미충족으로 연기되는지 본다.
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  trainingPythonPath: join(userData, 'no-such-python.exe')
}, null, 2), 'utf-8')

// ── 가짜 백엔드 ─────────────────────────────────────────────────────────────
const seen = []
let shadowToken = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    seen.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/chat') return res.end(JSON.stringify({ reply: API_REPLY, emotion: 'happy' }))
    if (req.url === '/training/shadow') {
      shadowToken = req.headers['x-apia-training-token'] || ''
      const parsed = JSON.parse(body || '{}')
      // 델타 경로가 실제로 실려 오는지가 계약이다.
      if (!parsed.delta_dir) return res.end(JSON.stringify({ status: 'dormant', reason: 'no delta' }))
      return res.end(JSON.stringify({ status: 'ok', reply: SHADOW_REPLY }))
    }
    res.end(JSON.stringify({}))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const readStatus = async () => JSON.parse(await readFile(statusPath, 'utf-8'))
const shadowAttempts = (s) => Object.values(s.shadow || {}).reduce((n, b) => n + (b.attempts || 0), 0)

const pageErrors = []
let ok = false
const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_DISABLE_WALLPAPER: '1' }
})

try {
  await new Promise((r) => setTimeout(r, 3000))
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))

  const elements = await settingsWindow.evaluate(() => ({
    last: !!document.getElementById('training-last'),
    delta: !!document.getElementById('training-delta'),
    shadow: !!document.getElementById('training-shadow'),
    button: !!document.getElementById('training-now-btn')
  }))
  const elementsOk = Object.values(elements).every(Boolean)

  await settingsWindow.evaluate(() => {
    document.getElementById('training-now-btn')?.scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'night_school_panel.png') })

  const rendered = await settingsWindow.evaluate(() => ({
    last: document.getElementById('training-last').textContent,
    delta: document.getElementById('training-delta').textContent,
    shadow: document.getElementById('training-shadow').textContent
  }))
  const renderOk = rendered.last.includes('채택')
    && rendered.delta.includes('2026-09-25T02-00') && rendered.delta.includes('앵커 1개')
    && rendered.shadow.includes('시도 없음')

  // ── 그림자: 채팅 한 번 ────────────────────────────────────────────────────
  const reply = await mainWindow.evaluate(
    () => window.api.sendMessage('제 고양이는 몇 살인가요?', [], {})
  )
  await new Promise((r) => setTimeout(r, 2500))
  const afterChat = await readStatus()
  const raw = await readFile(statusPath, 'utf-8')
  const shadowOk = reply?.reply === API_REPLY
    && shadowAttempts(afterChat) === 1
    && !raw.includes(SHADOW_REPLY) && !raw.includes('고양이')   // 원문은 디스크에 없다
    // 2-gram Jaccard — 비슷하지만 같지 않은 답은 0과 1 사이에 떨어진다.
    && Object.values(afterChat.shadow)[0].simSum > 0.3
    && Object.values(afterChat.shadow)[0].simSum < 1
    // 인증 토큰이 실제로 실려 나가고, 디스크에는 남지 않는다.
    && /^[0-9a-f]{64}$/.test(shadowToken || '')
    && !raw.includes(shadowToken)

  // ── 휴면: 채택 델타를 치운다 ──────────────────────────────────────────────
  await rm(anchorDir, { recursive: true, force: true })
  await mainWindow.evaluate(() => window.api.sendMessage('두 번째 질문', [], {}))
  await new Promise((r) => setTimeout(r, 2500))
  const afterDormant = await readStatus()
  const dormantOk = shadowAttempts(afterDormant) === 1
    && String(afterDormant.shadowDormant || '').includes('델타')

  // ── '지금 시작': 파이썬 경로가 없으니 연기, 이전 델타는 그대로 ─────────────
  await settingsWindow.click('#training-now-btn')
  await new Promise((r) => setTimeout(r, 3000))
  const afterClick = await readStatus()
  const deferOk = afterClick.lastStatus === 'deferred'
    && String(afterClick.lastReason).includes('파이썬')
    && afterClick.adopted?.version === '2026-09-25T02-00'

  console.log(`elements=${JSON.stringify(elements)}`)
  console.log(`rendered=${JSON.stringify(rendered, null, 2)}`)
  console.log(`backend hits=${JSON.stringify([...new Set(seen)])}`)
  console.log(`shadow=${JSON.stringify(afterChat.shadow)}`)
  console.log(`shadowTokenSent=${/^[0-9a-f]{64}$/.test(shadowToken || '')} tokenOnDisk=${raw.includes(shadowToken)}`)
  console.log(`dormantReason=${afterDormant.shadowDormant}`)
  console.log(`afterClick=${JSON.stringify({ lastStatus: afterClick.lastStatus, lastReason: afterClick.lastReason, adopted: afterClick.adopted?.version })}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshot=${join(outDir, 'night_school_panel.png')}`)
  console.log(`\nelementsOk=${elementsOk} renderOk=${renderOk} shadowOk=${shadowOk} dormantOk=${dormantOk} deferOk=${deferOk} noErrors=${pageErrors.length === 0}`)
  ok = elementsOk && renderOk && shadowOk && dormantOk && deferOk && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('NIGHT SCHOOL UI CHECK FAILED')
  process.exit(1)
}
console.log('NIGHT SCHOOL UI CHECK PASSED')
process.exit(0)
