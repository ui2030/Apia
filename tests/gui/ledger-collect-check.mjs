// 눈치 원장 수집 경로 E2E (4단언) — 가짜 백엔드로 실제 IPC 파이프라인을 태운다.
//
//   단언 1: 스트리밍 채팅 3교환 → 원장 파일에 신호 2건 (마지막 교환은 무효)
//   단언 2: 비스트리밍(send-message) 경로도 같은 신호를 만든다
//   단언 3: 분류가 3초 걸려도 채팅 응답은 기다리지 않는다 (비동기 큐)
//   단언 4: 원장 파일 어디에도 발화 원문이 없다
import { launchApia } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLASSIFY_DELAY_MS = 3000
const SECRET = '이건원장에절대남으면안되는문장'

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (req.url === '/classify') {
      // 일부러 느리게 — 채팅이 이걸 기다리면 단언 3이 깨진다.
      await new Promise((r) => setTimeout(r, CLASSIFY_DELAY_MS))
      const topic = String(body.text || '').includes('[game]') ? 'game' : 'work'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ raw: `{"topic_id":"${topic}","confidence":0.9}` }))
    }
    if (req.url === '/chat') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ reply: '응 그렇구나', emotion: 'neutral', citations: [] }))
    }
    if (req.url === '/chat/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'delta', text: '응 ' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'final', reply: '응 그렇구나', emotion: 'neutral', citations: [] })}\n\n`)
      return res.end()
    }
    res.writeHead(404)
    res.end('{}')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const userData = await mkdtemp(join(tmpdir(), 'apia-ledger-collect-'))
const ledgerPath = join(userData, 'apia-topic-ledger.json')

const { mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_DISABLE_WALLPAPER: '1' }
})

let ok = false
try {
  await new Promise((r) => setTimeout(r, 3000))

  // 스트리밍 3교환. 매 교환 사이 ledgerInputStart로 '입력 시작'을 찍는다.
  const streamTiming = await mainWindow.evaluate(async () => {
    const timings = []
    for (const text of ['[game] 어제 그 판 봤어?', '[game] 진짜 재밌었어ㅋㅋ', '[work] 보고서 써야 돼']) {
      const t0 = Date.now()
      await window.api.chatStreamStart(text, [])
      timings.push(Date.now() - t0)
      await new Promise((r) => setTimeout(r, 900))
      window.api.ledgerInputStart()
      await new Promise((r) => setTimeout(r, 400))
    }
    return timings
  })

  // 비스트리밍 경로 1교환 더 (앞 교환을 확정시킨다)
  const sendTiming = await mainWindow.evaluate(async () => {
    const t0 = Date.now()
    await window.api.sendMessage('[work] 마감이 언제더라', [])
    return Date.now() - t0
  })

  // 분류가 끝나고 신호가 파일에 내려앉을 때까지 기다린다.
  await new Promise((r) => setTimeout(r, CLASSIFY_DELAY_MS + 2500))

  const exists = existsSync(ledgerPath)
  const doc = exists ? JSON.parse(await readFile(ledgerPath, 'utf-8')) : null
  const signals = doc ? Object.values(doc.raw).flat() : []

  const collectOk = signals.length === 3
  const shiftOk = signals.some((s) => s.topic_shifted === true) && signals.some((s) => s.topic_shifted === false)
  const latencyOk = signals.every((s) => s.reply_latency_ms === null || s.reply_latency_ms >= 0)
  const nonBlockingOk = Math.max(...streamTiming, sendTiming) < CLASSIFY_DELAY_MS
  const rawText = exists ? await readFile(ledgerPath, 'utf-8') : ''
  const noTextOk = !rawText.includes('보고서') && !rawText.includes('어제') && !rawText.includes(SECRET)

  console.log(`streamStart ms = ${JSON.stringify(streamTiming)}  sendMessage ms = ${sendTiming}  (classify delay = ${CLASSIFY_DELAY_MS})`)
  console.log(`signals = ${JSON.stringify(signals, null, 2)}`)
  console.log(`\ncollectOk=${collectOk} shiftOk=${shiftOk} latencyOk=${latencyOk} nonBlockingOk=${nonBlockingOk} noTextOk=${noTextOk}`)
  ok = collectOk && shiftOk && latencyOk && nonBlockingOk && noTextOk
} finally {
  await cleanup()
  await new Promise((resolve) => server.close(resolve))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('LEDGER COLLECT CHECK FAILED')
  process.exit(1)
}
console.log('LEDGER COLLECT CHECK PASSED')
process.exit(0)
