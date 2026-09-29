// 선톡(먼저 말 걸기) E2E — 가짜 백엔드로 실제 IPC 파이프라인을 태운다.
//
//   단언 1: opener:fireNow(force) → 발화 생성(가짜 provider), 카운트 sent=1, lastTopic=game
//   단언 2: 사용자가 답하면(chatStreamStart) → replied=1 (무응답 타이머 취소)
//   단언 3: 무응답이면 → ignored=1, 그리고 **눈치 원장에는 아무것도 쓰지 않는다**
//           (합성 신호 금지 — 원장은 관측한 교환만 담는 계측 기록이다)
//   단언 4: 선톡 경로 어디에도 원문이 새지 않는다(원장 파일에 발화 원문 없음)
import { launchApia } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'

const OPENER_TEXT = '요즘 그 게임 재밌어?'

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (req.url === '/classify') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ raw: '{"topic_id":"game","confidence":0.9}' }))
    }
    if (req.url === '/chat') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ reply: OPENER_TEXT, emotion: 'neutral', citations: [] }))
    }
    if (req.url === '/chat/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'final', reply: '응 그래', emotion: 'neutral', citations: [] })}\n\n`)
      return res.end()
    }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const userData = await mkdtemp(join(tmpdir(), 'apia-opener-'))
const ledgerPath = join(userData, 'apia-topic-ledger.json')
// thawed 'game' 화제를 심어 pickTopic이 고르도록(evidence>=BURN_IN이라야 pending 탈출).
await writeFile(ledgerPath, JSON.stringify({
  schema_version: 1,
  raw: {},
  topics: { game: { score: 0.15, evidence: 10, state: 'thawed', goldLabel: null, updatedAt: Date.now() } },
  events: { demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 },
  lastAggregatedAt: Date.now()
}), 'utf-8')

// 검증 창은 보조 모니터(모니터 2)에 띄운다 — 사용자 주 화면을 가리지 않게.
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify(SECOND_MONITOR_SEED), 'utf-8')

const { mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_OPENER_IGNORE_MS: '800' }
})

let ok = false
try {
  await new Promise((r) => setTimeout(r, 3000))

  // 단언 1 — 강제 발화
  const fire1 = await mainWindow.evaluate(() => window.api.proactiveOpener.fireNow())
  const s1 = await mainWindow.evaluate(() => window.api.proactiveOpener.getState())
  const fireOk = fire1?.fired === true && fire1.text === OPENER_TEXT && fire1.topic === 'game'
  const sentOk = s1.counts.sent === 1 && s1.lastTopicId === 'game'

  // 단언 2 — 응답 확정
  await mainWindow.evaluate(() => window.api.chatStreamStart('응 완전', []))
  await new Promise((r) => setTimeout(r, 400))
  const s2 = await mainWindow.evaluate(() => window.api.proactiveOpener.getState())
  const repliedOk = s2.counts.replied === 1

  // 단언 3 — 무응답 → 무시 + 눈치 하락 신호
  await mainWindow.evaluate(() => window.api.proactiveOpener.fireNow())
  await new Promise((r) => setTimeout(r, 1300)) // ignore 타이머(800ms) 경과 대기
  const s3 = await mainWindow.evaluate(() => window.api.proactiveOpener.getState())
  const ignoredOk = s3.counts.ignored === 1

  // 선톡을 무시했다고 원장에 지어낸 신호를 넣지 않는다 — 실제로 관측한 교환은
  // 없었으므로 원장의 raw는 비어 있어야 한다(계측 전용 원칙).
  const doc = JSON.parse(await readFile(ledgerPath, 'utf-8'))
  const signals = Object.values(doc.raw || {}).flat()
  const noSyntheticSignalOk = signals.length === 0

  // 단언 4 — 원문 무유출
  const rawText = await readFile(ledgerPath, 'utf-8')
  const noLeakOk = !rawText.includes(OPENER_TEXT) && !rawText.includes('응 완전')

  console.log(JSON.stringify({ fireOk, sentOk, repliedOk, ignoredOk, noSyntheticSignalOk, noLeakOk, s3 }, null, 2))
  ok = fireOk && sentOk && repliedOk && ignoredOk && noSyntheticSignalOk && noLeakOk
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) { console.error('PROACTIVE OPENER CHECK FAILED'); process.exit(1) }
console.log('PROACTIVE OPENER CHECK PASSED')
process.exit(0)
