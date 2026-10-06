// 발주서 19 채팅 배려 — 실제 앱에서 원장에 frozen 화제를 심고 채팅 1턴을 보낸다.
//
// 백엔드는 이 파일이 띄우는 기록용 스텁(파이썬 백엔드·GPU 미사용). 스텁이 /chat
// 요청 body를 받아 적어 "앱이 진짜로 care_topics를 실어 보내는가"를 실기로 본다.
//
//   단언 1: frozen 화제 라벨이 body.care_topics에 실린다(pending 화제는 빠진다)
//   단언 2: 관제판 원장 패널에 "채팅 배려 중인 화제 1개" 줄이 뜬다
//   단언 3: 그 화제를 joke_ok로 바꾸면 다음 턴엔 care_topics 키 자체가 없다
//   단언 4: 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-care-chat-'))
await mkdir(outDir, { recursive: true })

await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ...SECOND_MONITOR_SEED,
  ttsEnabled: false,
  autoBehavior: false,
  aiMode: 'groq'
}, null, 2), 'utf-8')

// 원장: career는 burn-in을 넘겨 frozen, money는 증거 부족(pending).
const frozen = { score: 0.8, evidence: 10, state: 'frozen', demote: 1, promote: 0, updatedAt: Date.now() }
const pending = { score: 0.9, evidence: 1, state: 'frozen', demote: 0, promote: 0, updatedAt: Date.now() }
await writeFile(join(userData, 'apia-topic-ledger.json'), JSON.stringify({
  schema_version: 2,
  raw: {},
  topics: { career: { ...frozen, goldLabel: null }, money: { ...pending, goldLabel: null } },
  consolidated: { topics: { career: frozen, money: pending } },
  events: { demote: 1, promote: 0, falseFreeze: 0, falseThaw: 0 },
  lastAggregatedAt: Date.now()
}, null, 2), 'utf-8')

const captured = []
const REPLY = '그렇구나, 오늘 하루는 어땠어?'
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.url?.startsWith('/chat')) {
      try { captured.push(JSON.parse(raw)) } catch { captured.push({ parseError: raw }) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'delta', text: REPLY })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'final', reply: REPLY, emotion: 'neutral', citations: [] })}\n\n`)
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', ai_mode: 'groq', modes: ['groq'] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl }
})

const pageErrors = []
let ok = false
try {
  mainWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 4000))

  const ask = async (text) => {
    const before = captured.length
    if (!(await mainWindow.isVisible('#chat-input'))) {
      await mainWindow.click('#chat-toggle')
      await new Promise((r) => setTimeout(r, 600))
    }
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    await mainWindow.waitForFunction(() => {
      const rows = document.querySelectorAll('#messages .msg-bubble')
      const last = rows[rows.length - 1]
      return !!last && !last.classList.contains('typing') && !last.textContent.includes('●')
    }, null, { timeout: 4000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 800))
    return captured.length > before ? captured[captured.length - 1] : {}
  }

  const first = await ask('요즘 좀 피곤하네')
  const careOn = JSON.stringify(first.care_topics) === JSON.stringify(['진로·이직'])
  await mainWindow.screenshot({ path: join(outDir, 'care_chat_on.png') })

  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))
  await settingsWindow.evaluate(() => document.getElementById('ledger-care')?.scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 400))
  const panelText = await settingsWindow.evaluate(() => document.getElementById('ledger-care')?.textContent || '')
  const panelOk = panelText.startsWith('채팅 배려 중인 화제 1개') && panelText.includes('진로·이직')
  await settingsWindow.screenshot({ path: join(outDir, 'care_panel.png') })

  await mainWindow.evaluate(() => window.api.ledger.setGold('career', 'joke_ok'))
  await new Promise((r) => setTimeout(r, 300))
  const second = await ask('요즘 좀 피곤하네')
  const careOff = captured.length >= 2 && !('care_topics' in second)

  console.log(`captured=${JSON.stringify(captured.map((c) => ({ message: c.message, care_topics: c.care_topics })))}`)
  console.log(`panel=${JSON.stringify(panelText)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`\ncareOn=${careOn} panelOk=${panelOk} careOff=${careOff} noErrors=${pageErrors.length === 0}`)
  ok = careOn && panelOk && careOff && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('CARE CHAT CHECK FAILED')
  process.exit(1)
}
console.log('CARE CHAT CHECK PASSED')
process.exit(0)
