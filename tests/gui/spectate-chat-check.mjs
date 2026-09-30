// 발주13 관전-채팅 연결 — 실제 앱에서 가짜 관전 상태를 만들고 화면 질문을 던진다.
//
// 백엔드는 이 파일이 띄우는 **기록용 스텁**이다(파이썬 백엔드는 꺼진 채). 스텁이
// /chat/stream 요청 body를 그대로 받아 적으므로 "앱이 진짜로 관전 문맥을 실어
// 보내는가"를 단위 테스트가 아닌 실기에서 확인할 수 있다.
//
// 새 비전 호출은 하지 않는다: 관전 관찰은 spectateNote로 직접 심는다(관전 모드가
// 정규화한 관측을 main에 남기는 그 경로 그대로).
//
//   단언 1: 관전 중 화면 질문 → body.spectate.window가 보는 창 제목
//   단언 2: 최근 관찰이 최신순 3건까지 실리고 age_sec이 붙는다
//   단언 3: 창을 바꾸기 전 tick이 늦게 남긴 관찰(옛 세대)은 섞이지 않는다
//   단언 4: 관전을 끄면 같은 질문에도 spectate 키 자체가 없다
//   단언 5: 페이지 에러 0건
import { launchApia } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-spectate-chat-'))
await mkdir(outDir, { recursive: true })

const WINDOW_TITLE = '파이썬 기초 강의 3화 - YouTube'
const OBSERVATIONS = [
  '영상에서 강사가 for문 예제를 화면에 띄우고 설명하는 중',
  '댓글창을 내려 읽고 있다',
  '영상 재생이 일시정지된 상태'
]
// 창을 바꾸기 전 tick이 늦게 남긴 관찰 — 절대 실리면 안 된다.
const STALE_OBSERVATION = '엑셀 시트에 숫자를 입력하는 중'

// 진짜 모델에 물려 보고 싶을 때만(APIA_SPECTATE_UPSTREAM=http://127.0.0.1:8000).
const UPSTREAM = process.env.APIA_SPECTATE_UPSTREAM || ''
const AI_MODE = process.env.APIA_SPECTATE_AI_MODE || 'local'

await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ...SECOND_MONITOR_SEED,          // 실기 창은 보조 모니터에
  ttsEnabled: false,
  autoBehavior: false,
  aiMode: UPSTREAM ? AI_MODE : 'local'
}, null, 2), 'utf-8')

// ── 기록용 스텁 백엔드 ──────────────────────────────────────────────────────
const captured = []
const REPLY = '"파이썬 기초 강의 3화" 보고 계시네요! for문 예제 나오는 부분이요.'

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const isChat = req.url?.startsWith('/chat')
    if (isChat) {
      try { captured.push(JSON.parse(raw)) } catch { captured.push({ parseError: raw }) }
    }
    if (UPSTREAM) {
      try {
        const up = await fetch(UPSTREAM + req.url, {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          body: req.method === 'POST' ? raw : undefined
        })
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' })
        res.end(Buffer.from(await up.arrayBuffer()))
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
      return
    }
    if (isChat) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'delta', text: REPLY })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'final', reply: REPLY, emotion: 'happy', citations: [] })}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', ai_mode: AI_MODE, modes: [AI_MODE] }))
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

  // 가짜 관전 상태 — 창을 고르고(제목이 여기서 들어온다) 관찰 3건을 오래된 것부터
  // 심는다. 캡처도 VLM도 부르지 않는다.
  // 마지막 한 건은 **옛 세대**로 남긴다 — 창을 바꾸기 전 tick이 늦게 돌아온 상황.
  await mainWindow.evaluate(async ({ title, observations, stale }) => {
    const { generation } = await window.api.spectateSetSource('window:fake:0', title)
    for (const text of observations) await window.api.spectateNote(text, generation)
    await window.api.spectateNote(stale, generation - 1)
  }, { title: WINDOW_TITLE, observations: OBSERVATIONS, stale: STALE_OBSERVATION })
  await new Promise((r) => setTimeout(r, 300))

  const replyWait = UPSTREAM ? 150000 : 2500
  const ask = async (text) => {
    await mainWindow.click('#chat-toggle')
    await new Promise((r) => setTimeout(r, 600))
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    await mainWindow.waitForFunction(() => {
      const rows = document.querySelectorAll('#messages .msg-bubble')
      const last = rows[rows.length - 1]
      return !!last && !last.classList.contains('typing') && !last.textContent.includes('●')
    }, null, { timeout: replyWait }).catch(() => {})
    await new Promise((r) => setTimeout(r, 800))
  }

  // 단언 1·2 — 관전 중 화면 질문.
  await ask('지금 보고 있는 영상 제목 뭐야?')
  const first = captured[0] || {}
  const sp = first.spectate
  const windowOk = sp?.window === WINDOW_TITLE
  const obsOk = Array.isArray(sp?.observations)
    && sp.observations.length === 3
    && sp.observations[0].text === OBSERVATIONS[2]   // 최신이 앞
    && sp.observations[2].text === OBSERVATIONS[0]
    && sp.observations.every((o) => Number.isInteger(o.age_sec) && o.age_sec >= 0)
  const staleDropped = !JSON.stringify(sp || {}).includes(STALE_OBSERVATION)

  await mainWindow.screenshot({ path: join(outDir, 'spectate_chat_on.png') })

  // 단언 3 — 관전을 끄면(창 해제) 같은 질문에도 키 자체가 없다.
  await mainWindow.evaluate(() => window.api.spectateSetSource(null, ''))
  await new Promise((r) => setTimeout(r, 300))
  await ask('지금 보고 있는 영상 제목 뭐야?')
  const second = captured[captured.length - 1] || {}
  const offSkipped = captured.length >= 2 && !('spectate' in second)

  await mainWindow.screenshot({ path: join(outDir, 'spectate_chat_off.png') })

  console.log(`captured=${JSON.stringify(captured.map((c) => ({
    message: c.message, spectate: c.spectate
  })), null, 2)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshots=${join(outDir, 'spectate_chat_on.png')} , ${join(outDir, 'spectate_chat_off.png')}`)
  console.log(`\nwindowOk=${windowOk} obsOk=${obsOk} staleDropped=${staleDropped} `
    + `offSkipped=${offSkipped} noErrors=${pageErrors.length === 0}`)
  ok = windowOk && obsOk && staleDropped && offSkipped && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('SPECTATE CHAT CHECK FAILED')
  process.exit(1)
}
console.log('SPECTATE CHAT CHECK PASSED')
process.exit(0)
