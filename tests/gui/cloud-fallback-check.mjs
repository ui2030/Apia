// 발주서 23 — 고른 클라우드 모델이 안 켜졌을 때 다른 클라우드로 넘어가기 전에 한 번 묻는다.
//
// 백엔드는 이 파일이 띄우는 SSE 스텁이다. allow_cloud_fallback이 없으면 final에
// fallback_offer를, 있으면 대신 답한 결과(fallback={from,to})를 돌려준다.
//
//   1) 첫 질문 → 제안 말풍선 + 버튼 3개(스샷) → [아니요] → 재전송 없음 + 안내 + [설정 열기]
//   2) 두 번째 → [이번만] → 같은 말을 allow로 재전송, 사용자 말풍선은 늘지 않음
//   3) 세 번째 → [앞으로 항상] → 설정 always 저장 + 재전송
//   4) 네 번째 → 처음부터 allow로 가서 더 묻지 않음
import { launchApia } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-cf-e2e-'))
await mkdir(outDir, { recursive: true })
const settingsFile = join(userData, 'apia-settings.json')
await writeFile(settingsFile, JSON.stringify({
  ...SECOND_MONITOR_SEED, ttsEnabled: false, autoBehavior: false, aiMode: 'claude'
}, null, 2), 'utf-8')

const UNAVAILABLE = '고른 답변 모델(Claude API)을 지금 쓸 수 없어요. 설정 → AI 설정에서 API 키를 넣은 뒤 [저장 및 적용]을 눌러 주세요.'
const captured = []

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.url?.startsWith('/chat/stream')) {
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      captured.push(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const final = body.allow_cloud_fallback
        ? { type: 'final', reply: `Groq가 대신 답해요: ${body.message}`, emotion: 'happy', citations: [], fallback: { from: 'claude', to: 'groq' } }
        : { type: 'final', reply: UNAVAILABLE, emotion: 'sad', citations: [], fallback_offer: { from: 'claude', to: 'groq', to_label: 'Groq API' } }
      res.write(`data: ${JSON.stringify(final)}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', ai_mode: 'claude', modes: ['claude', 'groq'] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const { mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl }
})

const pageErrors = []
const checks = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  mainWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await sleep(4000)
  await mainWindow.click('#chat-toggle')
  await sleep(600)

  const view = () => mainWindow.evaluate(() => ({
    ai: [...document.querySelectorAll('#messages .msg-row.ai .msg-bubble')].map((b) => b.textContent),
    users: document.querySelectorAll('#messages .msg-row.user').length,
    chips: [...document.querySelectorAll('#messages .msg-row.ai .citation-chip')].map((b) => b.textContent)
  }))
  const ask = async (text) => {
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    await sleep(1200)
  }
  const pick = async (label) => {
    await mainWindow.locator('#messages .citation-chip', { hasText: label }).last().click()
    await sleep(1200)
  }

  // 1) 제안 → [아니요]
  await ask('안녕')
  let v = await view()
  checks.offerShown = v.ai.some((t) => t.includes('대신 Groq API로 답할까요?'))
    && JSON.stringify(v.chips) === JSON.stringify(['이번만', '앞으로 항상', '아니요'])
  checks.firstNoFlag = captured.length === 1 && captured[0].allow_cloud_fallback !== true
  await mainWindow.screenshot({ path: join(outDir, 'cloud_fallback_offer.png') })
  await pick('아니요')
  v = await view()
  checks.noResend = captured.length === 1
  checks.declined = v.ai.some((t) => t.startsWith('알겠어요, 다른 클라우드 모델로는')) && v.chips.includes('설정 열기')
  await mainWindow.screenshot({ path: join(outDir, 'cloud_fallback_declined.png') })

  // 2) [이번만]
  await ask('두 번째')
  await pick('이번만')
  v = await view()
  checks.onceResent = captured.length === 3 && captured[2].allow_cloud_fallback === true && captured[2].message === '두 번째'
  checks.onceNoDupUser = v.users === 2
  checks.onceReply = v.ai.includes('Groq가 대신 답해요: 두 번째')
  // 다시 보낼 때 실패한 안내 답이 대화 기록에 끼지 않는다
  checks.historyClean = !(captured[2].history || []).some((m) => m.content === UNAVAILABLE)
  await mainWindow.screenshot({ path: join(outDir, 'cloud_fallback_once.png') })

  // 3) [앞으로 항상]
  await ask('세 번째')
  checks.stillAsksAfterOnce = captured.length === 4 && captured[3].allow_cloud_fallback !== true
  await pick('앞으로 항상')
  const saved = JSON.parse(await readFile(settingsFile, 'utf-8'))
  checks.alwaysSaved = saved.cloudFallbackPolicy === 'always'
  checks.alwaysResent = captured.length === 5 && captured[4].allow_cloud_fallback === true

  // 4) 더 묻지 않음
  const chipsBefore = (await view()).chips.length
  await ask('네 번째')
  v = await view()
  checks.noMoreAsk = captured.length === 6 && captured[5].allow_cloud_fallback === true
    && v.chips.length === chipsBefore && v.ai.includes('Groq가 대신 답해요: 네 번째')
  await mainWindow.screenshot({ path: join(outDir, 'cloud_fallback_always.png') })
  checks.noErrors = pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

console.log(JSON.stringify({ checks, pageErrors, requests: captured.map((c) => ({ m: c.message, allow: c.allow_cloud_fallback === true })) }, null, 2))
if (!Object.values(checks).every(Boolean)) {
  console.error('CLOUD FALLBACK CHECK FAILED')
  process.exit(1)
}
console.log('CLOUD FALLBACK CHECK PASSED')
process.exit(0)
