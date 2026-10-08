// 개인정보 스위치 2개 + 화면 한국어화 실기 검증 (발주서 22). 보조 모니터에 띄운다.
//
// 진짜 파이썬 백엔드를 키 없이 띄운다 — 답변 모델이 없으니 채팅 답은 "쓸 수 있는
// 답변 모델이 없어요" 안내가 되고, 그 교환도 장기 기억에는 쌓인다(지우기 대상).
//
//   단언 1: 모으기 스위치를 끄면 설정 파일에 바로 반영되고 "모으지 않는 중" 표시
//   단언 2: 끈 채 채팅 1턴 → buffers 변화 없음, 답은 한국어 안내
//   단언 3: [모은 원문 지금 지우기] — 취소면 그대로, 확인이면 buffers만 비고 cards는 그대로
//   단언 4: [기억 모두 지우기] — 확인창(되돌릴 수 없음) → 통계 0
//   단언 5: 영어 코드가 뜨던 자리(최근 오류·현재 답변 모델)에 한국어
//   단언 6: 스위치를 다시 켜면 다음 턴부터 다시 모은다
//   단언 7: 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { spawn, execSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-privacy-e2e-'))
const root = join(userData, 'courseware')
const backendData = join(userData, 'backend-data')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(join(root, 'buffers'), { recursive: true })
await mkdir(join(root, 'cards'), { recursive: true })
await mkdir(backendData, { recursive: true })
await mkdir(outDir, { recursive: true })

const CARD = '{"day":"2026-08-31","u":"주말엔 뭐 해?","a":"등산 다니신다고 하셨어요."}\n'
await writeFile(join(root, 'cards', '2026-08-31.jsonl'), CARD, 'utf-8')
await writeFile(join(root, 'buffers', '2026-09-01.jsonl'),
  '{"t":1788310800000,"u":"오늘 회의 길었어","a":"고생하셨네요."}\n', 'utf-8')
await writeFile(join(root, 'status.json'), JSON.stringify({
  schema_version: 2, lastConvertedAt: null, cardCounts: { '2026-08-31': 1 }, spend: {},
  failures: {}, warnings: [], lastError: { at: Date.now(), day: '2026-09-01', message: 'no DEEPSEEK_API_KEY' }
}, null, 2), 'utf-8')
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ttsEnabled: false, autoBehavior: false, aiMode: 'auto', ...SECOND_MONITOR_SEED
}, null, 2), 'utf-8')
await writeFile(join(backendData, 'backend.env'), '# 키 없음 — 검증용\n', 'utf-8')

const port = await new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
})
// 기억 지우기(DELETE /store/memory)는 Electron main만 아는 공유 비밀을 요구한다 —
// 하네스는 백엔드를 직접 띄우므로 같은 토큰을 양쪽에 준다(APIA_E2E_TRAINING_TOKEN 시험용 틈).
const E2E_TOKEN = 'e2e-privacy-switch-token'
const backend = spawn(join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe'), ['main.py'], {
  cwd: join(projectRoot, 'backend'),
  env: {
    ...process.env,
    APIA_TRAINING_TOKEN: E2E_TOKEN,
    DATA_DIR: backendData,
    APIA_BACKEND_PORT: String(port),
    APIA_GROQ_KEY: '', APIA_ANTHROPIC_KEY: '', APIA_HF_TOKEN: '', DEEPSEEK_API_KEY: '',
    APIA_AUTO_MODE_PRIORITY: 'groq', APIA_AI_MODE: 'auto', APIA_MEMORY_ENABLED: 'true',
    PYTHONIOENCODING: 'utf-8'
  },
  stdio: 'ignore'
})
const backendUrl = `http://127.0.0.1:${port}`
const killBackend = () => { try { execSync(`taskkill /PID ${backend.pid} /T /F`, { stdio: 'ignore' }) } catch {} }

const listBuffers = async () => {
  const names = (await readdir(join(root, 'buffers'))).sort()
  return Promise.all(names.map(async (n) => `${n}:${await readFile(join(root, 'buffers', n), 'utf-8')}`))
}
const memStats = () => fetch(`${backendUrl}/store/memory/stats`).then((r) => r.json())

let ok = false
let app = null
let cleanup = async () => {}
const pageErrors = []
try {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${backendUrl}/health`)).ok) break } catch {}
    await sleep(1000)
  }

  ;({ app, cleanup } = await launchApia({ existingUserData: userData, extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_TRAINING_TOKEN: E2E_TOKEN } }))
  const mainWindow = await app.firstWindow()
  mainWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await sleep(4000)

  // main 쪽 네이티브 확인창을 가로채 응답을 주입한다(자동화로는 네이티브 위젯을 못 누른다).
  await app.evaluate(({ dialog }) => {
    globalThis.__dlg = []
    globalThis.__dlgResponse = 0
    dialog.showMessageBox = async (_w, opts) => {
      globalThis.__dlg.push({ title: opts.title, message: opts.message, detail: opts.detail })
      return { response: globalThis.__dlgResponse }
    }
  })

  const ask = async (text) => {
    const before = await mainWindow.evaluate(() => document.querySelectorAll('#messages .msg-bubble').length)
    if (!(await mainWindow.isVisible('#chat-input'))) await mainWindow.click('#chat-toggle')
    await sleep(600)
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    await mainWindow.waitForFunction((n) => {
      const rows = document.querySelectorAll('#messages .msg-bubble')
      const last = rows[rows.length - 1]
      return rows.length >= n + 2 && !!last && !last.classList.contains('typing') && !last.textContent.includes('●')
    }, before, { timeout: 120000 }).catch(() => {})
    await sleep(1500)
    return mainWindow.evaluate(() => {
      const rows = document.querySelectorAll('#messages .msg-bubble')
      return rows[rows.length - 1]?.textContent || ''
    })
  }

  // 단언 1 — 스위치 끄기
  let settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await sleep(2000)
  const initial = await settingsWindow.evaluate(() => document.getElementById('courseware-collect-toggle')?.checked)
  await settingsWindow.evaluate(() => {
    const el = document.getElementById('courseware-collect-toggle')
    el.checked = false
    el.dispatchEvent(new Event('change'))
    document.getElementById('courseware-section').scrollIntoView({ block: 'start' })
  })
  await sleep(1200)
  const offPanel = await settingsWindow.evaluate(() => ({
    state: document.getElementById('courseware-collect-state').textContent,
    warn: document.getElementById('courseware-warn').textContent
  }))
  const savedOff = JSON.parse(await readFile(join(userData, 'apia-settings.json'), 'utf-8')).coursewareCollectEnabled
  await settingsWindow.screenshot({ path: join(outDir, 'privacy_collect_off.png') })
  const switchOk = initial === true && savedOff === false && offPanel.state.includes('모으지 않는 중')

  // 단언 2 — 끈 채 채팅 1턴
  const buffersBefore = await listBuffers()
  const reply = await ask('오늘 날씨 어때?')
  const buffersAfterChat = await listBuffers()
  await mainWindow.screenshot({ path: join(outDir, 'privacy_chat_off.png') })
  const noCollectOk = JSON.stringify(buffersBefore) === JSON.stringify(buffersAfterChat)
  const replyKoreanOk = reply.includes('쓸 수 있는 답변 모델이 없어요') && !/No AI provider|unavailable/.test(reply)

  // 단언 3 — 모은 원문 지우기 (취소 → 확인)
  await settingsWindow.evaluate(() => document.getElementById('courseware-clear-btn').scrollIntoView({ block: 'center' }))
  await settingsWindow.click('#courseware-clear-btn')
  await sleep(1200)
  const afterCancel = await listBuffers()
  await app.evaluate(() => { globalThis.__dlgResponse = 1 })
  await settingsWindow.click('#courseware-clear-btn')
  await sleep(600)
  const clearToast = await settingsWindow.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))
  await settingsWindow.screenshot({ path: join(outDir, 'privacy_buffers_cleared.png') })
  await sleep(800)
  const afterClear = await listBuffers()
  const cardsAfter = await readFile(join(root, 'cards', '2026-08-31.jsonl'), 'utf-8')
  const clearOk = afterCancel.length === 1 && afterClear.length === 0 && cardsAfter === CARD
    && clearToast.includes('모은 원문 1건을 지웠어요')

  // 단언 4 — 장기 기억 모두 지우기
  let before = await memStats()
  for (let i = 0; i < 60 && before.turn_count < 2; i += 1) { await sleep(1000); before = await memStats() }
  await settingsWindow.evaluate(() => document.getElementById('memory-clear-btn').scrollIntoView({ block: 'center' }))
  await settingsWindow.evaluate(() => refreshMemoryPanel())
  await sleep(800)
  const memTextBefore = await settingsWindow.evaluate(() => document.getElementById('memory-stats-text').textContent)
  await settingsWindow.click('#memory-clear-btn')
  await sleep(1500)
  const memToast = await settingsWindow.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))
  const memTextAfter = await settingsWindow.evaluate(() => document.getElementById('memory-stats-text').textContent)
  await settingsWindow.screenshot({ path: join(outDir, 'privacy_memory_cleared.png') })
  const after = await memStats()
  const dialogs = await app.evaluate(() => globalThis.__dlg)
  const memDialog = dialogs.find((d) => d.title === '장기 기억 모두 지우기')
  const memoryOk = before.turn_count >= 2 && after.turn_count === 0 && after.summary_count === 0
    && memTextAfter.includes('대화 0번 · 요약 0개') && memToast.includes(`기억 ${before.turn_count + before.summary_count}건을 지웠어요`)
    && !!memDialog && memDialog.detail.includes('되돌릴 수 없어요')

  // 단언 5 — 한국어 표시
  const t0 = Date.now()
  const warmupDirect = await fetch(`${backendUrl}/warmup`).then((r) => r.json()).catch((e) => String(e))
  console.log(`warmupDirect(${Date.now() - t0}ms)=${JSON.stringify(warmupDirect)}`)
  for (let i = 0; i < 8; i += 1) {
    await settingsWindow.evaluate(() => refreshProviderStatus())
    await sleep(1500)
    if (await settingsWindow.evaluate(() => document.getElementById('ps-active')?.textContent !== '--')) break
  }
  const labels = await settingsWindow.evaluate(() => {
    document.getElementById('ps-active')?.scrollIntoView({ block: 'center' })
    return {
      active: document.getElementById('ps-active')?.textContent,
      available: document.getElementById('ps-available')?.textContent,
      autoTarget: document.getElementById('ps-auto-target')?.textContent
    }
  })
  await sleep(400)
  await settingsWindow.screenshot({ path: join(outDir, 'privacy_provider_labels.png') })
  const englishCode = /\b(fallback|groq|claude_code|hf_api|local|auto)\b/
  const labelsOk = offPanel.warn.includes('DeepSeek 키가 없어서 미룸') && !offPanel.warn.includes('no DEEPSEEK')
    && labels.active !== '--' && !englishCode.test(`${labels.active} ${labels.available} ${labels.autoTarget}`)

  // 단언 6 — 다시 켜면 다음 턴부터 모은다
  await settingsWindow.evaluate(() => {
    const el = document.getElementById('courseware-collect-toggle')
    el.checked = true
    el.dispatchEvent(new Event('change'))
  })
  await sleep(1000)
  await ask('다시 켰어')
  const afterOn = await listBuffers()
  const resumeOk = afterOn.length === 1 && afterOn[0].includes('다시 켰어')

  console.log(`initial=${initial} savedOff=${savedOff} offPanel=${JSON.stringify(offPanel)}`)
  console.log(`reply=${JSON.stringify(reply)}`)
  console.log(`buffersBefore=${JSON.stringify(buffersBefore)} afterChat=${JSON.stringify(buffersAfterChat)}`)
  console.log(`afterCancel=${afterCancel.length} afterClear=${afterClear.length} clearToast=${JSON.stringify(clearToast)}`)
  console.log(`memBefore=${JSON.stringify(before)} memAfter=${JSON.stringify(after)} memText=${JSON.stringify([memTextBefore, memTextAfter])} memToast=${JSON.stringify(memToast)}`)
  console.log(`dialogs=${JSON.stringify(dialogs, null, 1)}`)
  console.log(`labels=${JSON.stringify(labels)}`)
  console.log(`afterOn=${JSON.stringify(afterOn)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshots=${outDir}\\privacy_*.png`)
  console.log(`\nswitchOk=${switchOk} noCollectOk=${noCollectOk} replyKoreanOk=${replyKoreanOk} clearOk=${clearOk} memoryOk=${memoryOk} labelsOk=${labelsOk} resumeOk=${resumeOk} noErrors=${pageErrors.length === 0}`)
  ok = switchOk && noCollectOk && replyKoreanOk && clearOk && memoryOk && labelsOk && resumeOk && pageErrors.length === 0
} finally {
  await cleanup()
  killBackend()
  await sleep(500)
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}

if (!ok) {
  console.error('PRIVACY SWITCH CHECK FAILED')
  process.exit(1)
}
console.log('PRIVACY SWITCH CHECK PASSED')
process.exit(0)
