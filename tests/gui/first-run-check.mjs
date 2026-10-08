// 발주서 24 — 처음 켜는 사람용 4가지 실기 검증.
//
//   A) 빈 userData + 답변 모델 없는 백엔드 스텁 → 시작 카드 → 키 없이 채팅 → [설정 열기]
//      → [API 키 넣기]로 설정 창 AI 칸 → 정보·도움 패널 → 문제 신고용 묶기 → [나중에]
//      → 키가 생기면(스텁이 모델을 돌려주면) 영구 종료
//   B) lowEndMode=true → 레버 적용 상태 + 화면
//   C) GPU를 끈 채 실행 → WebGL 실패 안내 카드
import { _electron as electron } from 'playwright'
import { launchApia } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import AdmZip from 'adm-zip'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { readdirSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
await mkdir(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = {}
const pageErrors = []

const UNAVAILABLE = '쓸 수 있는 답변 모델이 없어요. 설정 → AI 설정에서 API 키를 넣은 뒤 [저장 및 적용]을 눌러 주세요. 지금 설치된 Apia에는 로컬 모델이 들어 있지 않아요.'
let availableModes = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.url?.startsWith('/chat/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'final', reply: UNAVAILABLE, emotion: 'sad', citations: [] })}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url?.startsWith('/warmup') && req.method === 'GET') {
      res.end(JSON.stringify({ available_modes: availableModes, initialized_modes: [], auto_target: availableModes[0] || null }))
      return
    }
    if (req.url?.startsWith('/voices')) { res.end(JSON.stringify({ voices: [] })); return }
    res.end(JSON.stringify({ status: 'ok' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

async function seededUserData(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'apia-firstrun-e2e-'))
  await writeFile(join(dir, 'apia-settings.json'), JSON.stringify({ ...SECOND_MONITOR_SEED, ttsEnabled: false, autoBehavior: false, ...extra }), 'utf-8')
  return dir
}

const desktop = join(homedir(), 'Desktop')
const reportZips = () => readdirSync(desktop).filter((n) => /^apia-report-\d{8}-\d{6}\.zip$/.test(n))

// ── A ──────────────────────────────────────────────────────────────────────
{
  const userData = await seededUserData()
  const { app, mainWindow, cleanup } = await launchApia({ existingUserData: userData, extraEnv: { APIA_BACKEND_URL: backendUrl } })
  try {
    mainWindow.on('pageerror', (e) => pageErrors.push('A:' + e))
    await mainWindow.waitForSelector('#first-run-card', { timeout: 20000 })
    checks.cardShown = (await mainWindow.textContent('#first-run-card')).includes('환영해요. 대화하려면 두 가지만 하면 돼요.')
    await mainWindow.screenshot({ path: join(outDir, 'firstrun_card.png') })

    // 키 없이 채팅 → 안내 + [설정 열기]
    await mainWindow.click('#chat-toggle')
    await sleep(500)
    await mainWindow.fill('#chat-input', '안녕')
    await mainWindow.press('#chat-input', 'Enter')
    await sleep(1500)
    const chips = await mainWindow.$$eval('#messages .msg-row.ai .citation-chip', (els) => els.map((e) => e.textContent))
    checks.chatSettingsButton = chips.includes('설정 열기')
    await mainWindow.screenshot({ path: join(outDir, 'firstrun_chat_no_key.png') })
    const [fromChat] = await Promise.all([
      app.waitForEvent('window'),
      mainWindow.locator('#messages .citation-chip', { hasText: '설정 열기' }).last().click()
    ])
    await fromChat.waitForURL(/settings\.html#ai$/)
    checks.chatButtonOpensAi = true
    await fromChat.close()
    await sleep(500)

    // [API 키 넣기] → 설정 창 AI 칸
    const [settings] = await Promise.all([
      app.waitForEvent('window'),
      mainWindow.locator('#first-run-card button', { hasText: 'API 키 넣기' }).click()
    ])
    settings.on('pageerror', (e) => pageErrors.push('S:' + e))
    await settings.waitForURL(/settings\.html#ai$/)
    await settings.waitForLoadState('domcontentloaded')
    await sleep(2500)
    checks.aiSectionInView = await settings.evaluate(() => {
      const r = document.getElementById('section-ai').getBoundingClientRect()
      return r.top >= 0 && r.top < 200
    })
    await settings.screenshot({ path: join(outDir, 'firstrun_settings_ai.png') })

    // 정보·도움 패널
    await settings.evaluate(() => document.getElementById('section-about').scrollIntoView({ block: 'end' }))
    await settings.waitForFunction(() => document.getElementById('about-version').textContent !== '—', null, { timeout: 10000 })
    const about = await settings.evaluate(() => ({
      version: document.getElementById('about-version').textContent,
      kind: document.getElementById('about-kind').textContent,
      backend: document.getElementById('about-backend').textContent,
      local: document.getElementById('about-local').textContent
    }))
    checks.aboutPanel = about.version === '1.0.0' && about.kind === '개발' &&
      about.backend.startsWith('연결됨') && about.local === '들어 있지 않아요'
    await settings.screenshot({ path: join(outDir, 'firstrun_about_panel.png') })
    const guide = await settings.evaluate(() => window.api.openHelp('guide'))
    const privacy = await settings.evaluate(() => window.api.openHelp('privacy'))
    const bogus = await settings.evaluate(() => window.api.openHelp('https://evil.example'))
    checks.helpLinks = new URL(guide.url).hostname === 'github.com' && guide.url.endsWith('%EC%84%A4%EC%B9%98%ED%95%98%EA%B8%B0.md') &&
      privacy.url.endsWith('/PRIVACY.md') && bogus.ok === false

    // 문제 신고용 묶기
    const before = new Set(reportZips())
    await settings.click('#about-report')
    await settings.waitForSelector('.toast', { timeout: 10000 }).catch(() => {})
    const toastText = await settings.evaluate(() => document.getElementById('toast-container').textContent)
    checks.reportToast = toastText.includes('묶었어요. 깃허브 이슈에 첨부해 주세요')
    const made = reportZips().filter((n) => !before.has(n))
    let reportFiles = []
    if (made.length === 1) {
      const zipPath = join(desktop, made[0])
      const zip = new AdmZip(zipPath)
      reportFiles = zip.getEntries().map((e) => e.entryName)
      const all = zip.getEntries().map((e) => e.getData().toString('utf-8')).join('\n')
      checks.reportContents = reportFiles.includes('summary.txt') && reportFiles.includes('apia-settings.json') &&
        reportFiles.some((n) => n.startsWith('logs/')) &&
        !reportFiles.some((n) => /backend\.env|\.db|courseware|voices|personal/.test(n)) &&
        !all.includes(homedir().split(/[\\/]/).pop())
      checks.reportSummaryGpu = /GPU: .+/.test(zip.readAsText('summary.txt'))
      console.log('[report]', made[0], reportFiles, '\n' + zip.readAsText('summary.txt'))
      unlinkSync(zipPath)
    }
    checks.reportMade = made.length === 1
    await settings.screenshot({ path: join(outDir, 'firstrun_report_toast.png') })
    await settings.close()

    // [나중에] → 이번 실행만 숨김 + 회수 저장
    await mainWindow.locator('#first-run-card button', { hasText: '나중에' }).click()
    await sleep(800)
    checks.dismissHides = (await mainWindow.$('#first-run-card')) === null
    const afterDismiss = JSON.parse(await readFile(join(userData, 'apia-settings.json'), 'utf-8'))
    checks.dismissCounted = afterDismiss.firstRunDismissCount === 1 && afterDismiss.firstRunDone !== true
    checks.stillHiddenThisRun = (await mainWindow.evaluate(() => window.api.firstRun.state())).show === false

    // 키가 들어와 답변 모델이 생기면 영구 종료
    availableModes = ['groq']
    await mainWindow.evaluate(() => window.api.firstRun.state())
    const afterKey = JSON.parse(await readFile(join(userData, 'apia-settings.json'), 'utf-8'))
    checks.keyEndsFirstRun = afterKey.firstRunDone === true
  } finally {
    await cleanup()
    await rm(userData, { recursive: true, force: true })
  }
}

// ── B ──────────────────────────────────────────────────────────────────────
{
  availableModes = ['groq']
  const userData = await seededUserData({ lowEndMode: true, firstRunDone: true })
  const { app, mainWindow, cleanup } = await launchApia({ existingUserData: userData, extraEnv: { APIA_BACKEND_URL: backendUrl } })
  try {
    mainWindow.on('pageerror', (e) => pageErrors.push('B:' + e))
    await sleep(5000)
    const st = await mainWindow.evaluate(() => window.__lowEndState())
    checks.lowEndLevers = st.postFxOn === false && st.pixelRatio === 1 && st.spectateIntervalScale === 2 && st.physics.unitStep === 1 / 60
    checks.lowEndNoCard = (await mainWindow.$('#first-run-card')) === null
    await mainWindow.screenshot({ path: join(outDir, 'lowend_main.png') })
    const [settings] = await Promise.all([app.waitForEvent('window'), mainWindow.click('#settings-btn')])
    await settings.waitForURL(/settings\.html$/)
    await sleep(2000)
    await settings.evaluate(() => document.getElementById('low-end-mode').closest('.row').scrollIntoView({ block: 'center' }))
    checks.lowEndToggleOn = await settings.evaluate(() => document.getElementById('low-end-mode').checked)
    await settings.screenshot({ path: join(outDir, 'lowend_settings_toggle.png') })
    await settings.close()

    // 컨텍스트 유실(드라이버 리셋 상황) → 안내 카드
    await mainWindow.evaluate(() => document.getElementById('vrm-canvas').getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())
    await mainWindow.waitForSelector('#gfx-fail-card', { timeout: 5000 }).then(() => { checks.contextLostCard = true }).catch(() => { checks.contextLostCard = false })
    await mainWindow.screenshot({ path: join(outDir, 'webgl_context_lost_card.png') })
  } finally {
    await cleanup()
    await rm(userData, { recursive: true, force: true })
  }
}

// ── C ──────────────────────────────────────────────────────────────────────
{
  const userData = await seededUserData({ firstRunDone: true })
  const app = await electron.launch({
    args: [projectRoot, '--disable-gpu', '--disable-software-rasterizer'],
    cwd: projectRoot,
    env: {
      ...process.env, APIA_E2E_USER_DATA_DIR: userData, APIA_E2E_DISABLE_BACKEND: '1', APIA_E2E_NO_SHELL_OPEN: '1',
      APIA_E2E_NO_CURSOR_FEED: '1', APIA_E2E_DISABLE_WALLPAPER: '1', APIA_BACKEND_URL: backendUrl
    }
  })
  try {
    const mainWindow = await app.firstWindow()
    await mainWindow.waitForSelector('#gfx-fail-card', { timeout: 15000 })
      .then(() => { checks.webglFailCard = true }).catch(() => { checks.webglFailCard = false })
    if (checks.webglFailCard) {
      checks.webglFailText = (await mainWindow.textContent('#gfx-fail-card')).includes('그래픽을 그리지 못했어요')
    }
    await mainWindow.screenshot({ path: join(outDir, 'webgl_fail_card.png') })
  } finally {
    try { await app.close() } catch {}
    await rm(userData, { recursive: true, force: true })
  }
}

// ── D: 백엔드에 못 붙는 채로 → 10초 "연결 중" → 30초 [다시 시도] [로그 묶기] ──
{
  const userData = await seededUserData({ firstRunDone: true })
  const { mainWindow, cleanup } = await launchApia({ existingUserData: userData, extraEnv: { APIA_BACKEND_URL: 'http://127.0.0.1:9' } })
  try {
    await mainWindow.click('#chat-toggle')
    await sleep(12000)
    checks.bannerConnecting = (await mainWindow.textContent('#backend-banner')).includes('AI 엔진에 연결 중이에요')
    await mainWindow.screenshot({ path: join(outDir, 'backend_banner_connecting.png') })
    await sleep(20000)
    const labels = await mainWindow.$$eval('#backend-banner button', (els) => els.map((e) => e.textContent))
    checks.bannerStuckButtons = labels.join(',') === '다시 시도,로그 묶기'
    await mainWindow.screenshot({ path: join(outDir, 'backend_banner_stuck.png') })
  } finally {
    await cleanup()
    await rm(userData, { recursive: true, force: true })
  }
}

await new Promise((r) => server.close(r))
checks.noPageErrors = pageErrors.filter((e) => !/WebGL|webgl/.test(e)).length === 0
console.log(JSON.stringify({ checks, pageErrors }, null, 2))
if (!Object.values(checks).every(Boolean)) {
  console.error('FIRST RUN CHECK FAILED')
  process.exit(1)
}
console.log('FIRST RUN CHECK PASSED')
process.exit(0)
