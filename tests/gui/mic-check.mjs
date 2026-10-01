// 마이크(음성 입력 1단계) E2E — 가짜 STT로 전사→라우팅을 검증한다.
//
//   단언 1: stt:transcribe(WAV) → 백엔드 전사 텍스트를 돌려준다(가짜 STT)
//   단언 2: 전사 텍스트 라우팅 → 채팅 입력으로 전송(chatStreamStart 발생)
//   단언 3: 제3자 청취(use #2 ambient)는 격리 상태 — 저장 0이고 동의 설정도 같은
//           계약({stored:false, reason:'isolated'})으로 거절한다
//   단언 4: "귀 닫아"는 전송하지 않고 캡처를 멈춘다
//   단언 5: 표시등 = 캡처의 동어반복 — 창이 숨으면 듣지 않고, 버튼도 안 켜진다
//   단언 6: micEnabled를 안 켠 사용자에겐 🎤 버튼 자체가 안 보인다
import { launchApia } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'

const STT_TEXT = '안녕 반가워'
let sttHits = 0
let streamHits = 0

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (req.url === '/stt/transcribe') {
      sttHits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: STT_TEXT }))
    }
    if (req.url === '/classify') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ raw: '{"topic_id":"small_talk","confidence":0.9}' }))
    }
    if (req.url === '/chat') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ reply: '반가워!', emotion: 'neutral', citations: [] }))
    }
    if (req.url === '/chat/stream') {
      streamHits += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'final', reply: '반가워!', emotion: 'neutral', citations: [] })}\n\n`)
      return res.end()
    }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const userData = await mkdtemp(join(tmpdir(), 'apia-mic-'))
// 마이크는 기본 OFF다 — 켠 사용자를 재현하려면 설정을 미리 심어야 한다.
// (기본 OFF 자체는 settingsAggregate 단위 테스트가 지킨다.)
// 검증 창은 보조 모니터(모니터 2)에.
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({ ...SECOND_MONITOR_SEED, micEnabled: true }), 'utf-8')
const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl }
})

let ok = false
try {
  await new Promise((r) => setTimeout(r, 3000))

  // 채팅 창을 띄운다(선톡 fireNow가 ensureChatWindow로 생성·표시).
  const [chatWin] = await Promise.all([
    app.waitForEvent('window'),
    mainWindow.evaluate(() => window.api.proactiveOpener.fireNow())
  ])
  await chatWin.waitForLoadState('domcontentloaded')
  await new Promise((r) => setTimeout(r, 800))
  await chatWin.bringToFront()
  await new Promise((r) => setTimeout(r, 300))

  const hasHook = await chatWin.evaluate(() => !!window.__apiaMic)

  // 단언 1 — 가짜 STT 전사
  const text = await chatWin.evaluate(async () => {
    const r = await window.api.mic.transcribe(new ArrayBuffer(128))
    return r?.text
  })
  const transcribeOk = text === STT_TEXT && sttHits >= 1

  // 단언 3 — 제3자 청취(use #2)는 격리됐다. 동의를 켜려 해도 저장되지 않는다.
  const amb = await chatWin.evaluate(() => window.api.mic.ambient('혼잣말 테스트'))
  const micState = await chatWin.evaluate(() => window.api.mic.getState())
  // 동의 설정도 **같은 계약**으로 거절한다 — 효과가 없는 동의를 받아두지 않는다.
  const consent = await chatWin.evaluate(() => window.api.mic.setConsent(true))
  const ambientIsolatedOk =
    amb?.stored === false && amb?.reason === 'isolated' && micState?.ambientIsolated === true &&
    consent?.stored === false && consent?.reason === 'isolated' && consent?.consent === false

  // 단언 6 — 버튼 가시성은 micEnabled를 따른다(여기선 켠 사용자라 보인다).
  const btnShownOk = await chatWin.evaluate(() => {
    const btn = document.getElementById('mic-btn')
    return !!btn && getComputedStyle(btn).display !== 'none'
  })

  // 단언 2 — 전사 텍스트가 채팅 입력으로 전송된다
  const beforeStream = streamHits
  const vis = await chatWin.evaluate(() => document.visibilityState)
  await chatWin.evaluate(() => window.__apiaMic.routeTranscript('마이크로 보낸 말'))
  await new Promise((r) => setTimeout(r, 600))
  const userRow = await chatWin.evaluate(() => {
    const rows = [...document.querySelectorAll('.msg-row.user .msg-bubble')]
    return rows.map((r) => r.textContent)
  })
  const routeOk = (streamHits > beforeStream) && userRow.includes('마이크로 보낸 말')

  // 단언 4 — "귀 닫아"는 전송하지 않는다
  const beforeEar = streamHits
  await chatWin.evaluate(() => window.__apiaMic.routeTranscript('귀 닫아'))
  await new Promise((r) => setTimeout(r, 400))
  const earOk = streamHits === beforeEar
  // "귀 닫아" 뒤에는 듣지 않는 상태여야 한다(멈춤 = 스트림 놓기).
  const earStopsListening = await chatWin.evaluate(() => window.__apiaMic.shouldListen() === false)

  // 단언 5 — 창을 숨기면 듣지 않는다. 표시등이 안 보이는 청취는 없다.
  await chatWin.evaluate(() => {
    document.getElementById('mic-btn').click() // 멈춤 해제 — 다시 듣는 상태로
  })
  const listeningWhenVisible = await chatWin.evaluate(() => window.__apiaMic.shouldListen())
  // 표시등 증거 — 듣는 동안 🎤가 빨갛게 켜진 채팅창.
  await new Promise((r) => setTimeout(r, 400))
  await chatWin.screenshot({ path: join('test-results', 'mic-listening-indicator.png') })
  await mainWindow.evaluate(() => window.api.chatHide?.())
  await new Promise((r) => setTimeout(r, 800))
  const hiddenState = await chatWin.evaluate(() => ({
    visibility: document.visibilityState,
    windowVisibleFlag: !!window.__apiaMic.shouldListen,
    listening: window.__apiaMic.shouldListen(),
    indicator: document.getElementById('mic-btn').classList.contains('listening')
  }))
  // main이 보내는 chat:visibility가 단일 출처라 디버거 연결 여부와 무관하게
  // 확정적으로 검증된다(렌더러 visibilityState는 'visible'로 굳을 수 있다).
  const hiddenOk = hiddenState.listening === false && hiddenState.indicator === false

  console.log(JSON.stringify({
    hasHook, vis, transcribeOk, ambientIsolatedOk, btnShownOk, routeOk, earOk,
    earStopsListening, listeningWhenVisible, hiddenState, hiddenOk, sttHits, streamHits
  }, null, 2))
  ok = hasHook && transcribeOk && ambientIsolatedOk && btnShownOk && routeOk && earOk &&
    earStopsListening && hiddenOk
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) { console.error('MIC CHECK FAILED'); process.exit(1) }
console.log('MIC CHECK PASSED')
process.exit(0)
