// 이모지 응답의 말풍선/발화 분리 E2E (발주서 12 §A).
//
//   단언 1: 말풍선은 **원문 그대로** — 이모지·마크다운이 화면에 남는다
//   단언 2: /tts 요청은 원문 + emotion 라벨을 실어 보낸다(정화·운율은 백엔드 몫,
//           단위 테스트 test_speech_text.py / test_tts_service.py가 증명)
//   단언 3: 스트림 응답의 [EMOTION:] 라벨이 tts까지 도달한다
//
// 정화 자체를 여기서 재검증하지 않는 이유: 가짜 백엔드는 정화를 안 한다.
// 이 하네스가 지키는 계약은 "렌더러는 원문을 보내고 화면에도 원문을 남긴다"다.
import { launchApia } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPLY = '반가워요 😊🎉 **정말** ㅋㅋㅋ'
const ttsBodies = []

// 44바이트 무음 wav — 렌더러가 재생만 시도하면 되고 소리는 필요 없다.
const TINY_WAV = (() => {
  const buf = Buffer.alloc(44 + 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(38, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(22050, 24); buf.writeUInt32LE(44100, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(2, 40)
  return buf
})()

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8')
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (req.url === '/tts') {
      try { ttsBodies.push(JSON.parse(body)) } catch { ttsBodies.push({ parseError: body }) }
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      return res.end(TINY_WAV)
    }
    if (req.url === '/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ voices: [{ id: 'edge:ko-KR-SunHiNeural', name: '선히', source: 'edge' }] }))
    }
    if (req.url === '/classify') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ raw: '{"topic_id":"small_talk","confidence":0.9}' }))
    }
    if (req.url === '/chat/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'final', reply: REPLY, emotion: 'happy', citations: [] })}\n\n`)
      return res.end()
    }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const userData = await mkdtemp(join(tmpdir(), 'apia-tts-'))
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ...SECOND_MONITOR_SEED, ttsEnabled: true, voiceId: 'edge:ko-KR-SunHiNeural'
}), 'utf-8')

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl }
})

let ok = false
try {
  await new Promise((r) => setTimeout(r, 2500))

  // 채팅 창을 띄우고(선톡 강제 발화가 ensureChatWindow를 만든다) 한 마디 보낸다.
  const [chatWin] = await Promise.all([
    app.waitForEvent('window'),
    mainWindow.evaluate(() => window.api.chatToggle?.() ?? window.api.proactiveOpener.fireNow())
  ])
  await chatWin.waitForLoadState('domcontentloaded')
  await new Promise((r) => setTimeout(r, 1000))

  await chatWin.evaluate(() => {
    document.getElementById('chat-input').value = '안녕'
    document.getElementById('send-btn').click()
  })
  await new Promise((r) => setTimeout(r, 2500))

  // 단언 1 — 말풍선 원문 유지
  const bubbles = await chatWin.evaluate(() =>
    [...document.querySelectorAll('.msg-row.ai .msg-bubble')].map((b) => b.textContent)
  )
  const bubbleKeepsRawOk = bubbles.some((t) => t === REPLY)
  await chatWin.screenshot({ path: join('test-results', 'tts-sanitize-bubble.png') })

  // 단언 2·3 — /tts에 원문 + emotion
  const ttsCall = ttsBodies.find((b) => typeof b.text === 'string' && b.text.includes('😊'))
  const ttsRawOk = !!ttsCall && ttsCall.text === REPLY
  const emotionOk = ttsCall?.emotion === 'happy'

  console.log(JSON.stringify({ bubbles, bubbleKeepsRawOk, ttsRawOk, emotionOk, ttsBodies }, null, 2))
  ok = bubbleKeepsRawOk && ttsRawOk && emotionOk
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) { console.error('TTS SANITIZE CHECK FAILED'); process.exit(1) }
console.log('TTS SANITIZE CHECK PASSED')
process.exit(0)
