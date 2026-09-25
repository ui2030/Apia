// A-2 교재 검색 참조 — 실제 앱에서 카드를 심고 물어본다 (6단언) + 스크린샷.
//
// 백엔드는 이 파일이 띄우는 **기록용 스텁**이다(파이썬 백엔드는 꺼진 채).
// 스텁이 /chat/stream 요청 body를 그대로 받아 적으므로, "앱이 진짜로 참조
// 카드를 실어 보내는가"를 단위 테스트가 아닌 실기에서 확인할 수 있다.
//
//   단언 1: 설정 창에 '기억 참조' 토글이 있고 기본 ON
//   단언 2: 토글 ON에서 물으면 요청 body에 reference_cards가 실린다
//   단언 3: 실린 카드가 질문과 관련된 그 카드다
//   단언 4: 토글을 끄면 같은 질문에도 reference_cards 키 자체가 없다
//   단언 5: status.json에 첨부 횟수가 세지고 사용자 발화 원문은 없다
//   단언 6: 페이지 에러 0건
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-a2-e2e-'))
const root = join(userData, 'courseware')

await mkdir(join(root, 'cards'), { recursive: true })
await mkdir(outDir, { recursive: true })

// 심어둔 교재 — 하나만 질문과 겹친다.
await writeFile(join(root, 'cards', '2026-09-01.jsonl'), [
  '{"day":"2026-09-01","u":"취미가 뭐냐고 물으면?","a":"주말마다 등산을 다닌다고 하셨어요."}',
  '{"day":"2026-09-01","u":"커피를 얼마나 마시냐고 물으면?","a":"하루 두 잔이라고 하셨어요."}'
].join('\n') + '\n', 'utf-8')
await writeFile(join(root, 'cards', '2026-09-02.jsonl'),
  '{"day":"2026-09-02","u":"좋아하는 계절을 물으면?","a":"가을이라고 하셨어요."}\n', 'utf-8')

// APIA_A2_UPSTREAM이 있으면 스텁이 진짜 백엔드로 그대로 넘긴다 — 같은 하네스로
// "앱이 카드를 싣는가"(단언)와 "모델이 그걸 쓰는가"(육안)를 한 번에 본다.
const UPSTREAM = process.env.APIA_A2_UPSTREAM || ''
const AI_MODE = process.env.APIA_A2_AI_MODE || 'local'

// 앱이 TTS·모델 다운로드로 새지 않게 최소 설정만.
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ttsEnabled: false, autoBehavior: false, aiMode: UPSTREAM ? AI_MODE : 'local'
}, null, 2), 'utf-8')

// ── 기록용 스텁 백엔드 ──────────────────────────────────────────────────────
const captured = []
const REPLY = '등산이요! 주말마다 다니신다고 하셨잖아요. 이번 주도 가세요?'

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const isChat = req.url?.startsWith('/chat/stream')
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

  // 단언 1 — 설정 창 토글.
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))
  const toggle = await settingsWindow.evaluate(() => {
    const el = document.getElementById('courseware-reference-toggle')
    document.getElementById('courseware-section')?.scrollIntoView({ block: 'center' })
    return { exists: !!el, checked: !!el?.checked }
  })
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'a2_reference_toggle.png') })
  await settingsWindow.close()
  await new Promise((r) => setTimeout(r, 800))

  // 단언 2·3 — 토글 ON 상태로 질문.
  const replyWait = UPSTREAM ? 150000 : 2500 // 진짜 모델은 첫 호출에 로딩까지 한다
  const ask = async (text) => {
    await mainWindow.click('#chat-toggle')
    await new Promise((r) => setTimeout(r, 600))
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    // 마지막 말풍선이 로딩 점(●)에서 실제 답으로 바뀔 때까지.
    await mainWindow.waitForFunction(() => {
      const rows = document.querySelectorAll('#messages .msg-bubble')
      const last = rows[rows.length - 1]
      return !!last && !last.classList.contains('typing') && !last.textContent.includes('●')
    }, null, { timeout: replyWait }).catch(() => {})
    await new Promise((r) => setTimeout(r, 800))
  }
  await ask('지난주에 말한 취미가 뭐였지?')

  const first = captured[0] || {}
  const attached = Array.isArray(first.reference_cards) ? first.reference_cards : null
  const rightCard = attached?.length === 1
    && attached[0].u === '취미가 뭐냐고 물으면?'
    && attached[0].a.includes('등산')

  await mainWindow.screenshot({ path: join(outDir, 'a2_reference_reply.png') })

  // 단언 4 — 토글 OFF 후 같은 질문.
  const settings2 = await openSettingsWindow(app, mainWindow)
  await new Promise((r) => setTimeout(r, 1500))
  await settings2.evaluate(() => {
    document.getElementById('courseware-reference-toggle').checked = false
  })
  await settings2.click('#save-btn')
  await new Promise((r) => setTimeout(r, 2500))
  try { await settings2.close() } catch {}
  await new Promise((r) => setTimeout(r, 800))

  await ask('지난주에 말한 취미가 뭐였지?')
  const second = captured[captured.length - 1] || {}
  const offSkipped = captured.length >= 2 && !('reference_cards' in second)

  // 단언 5 — 관측은 카운트만.
  const statusRaw = await readFile(join(root, 'status.json'), 'utf-8')
  const status = JSON.parse(statusRaw)
  const observedOk = status.referenceAttached === 1
    && status.recentReferences?.[0] === '취미가 뭐냐고 물으면?'
    && !/지난주에 말한|뭐였지/.test(statusRaw)

  console.log(`toggle=${JSON.stringify(toggle)}`)
  console.log(`captured=${JSON.stringify(captured.map((c) => ({
    message: c.message, reference_cards: c.reference_cards
  })), null, 2)}`)
  console.log(`status=${statusRaw.trim()}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshots=${join(outDir, 'a2_reference_toggle.png')} , ${join(outDir, 'a2_reference_reply.png')}`)
  console.log(`\ntoggleOk=${toggle.exists && toggle.checked} attachedOk=${!!attached} `
    + `rightCard=${rightCard} offSkipped=${offSkipped} observedOk=${observedOk} `
    + `noErrors=${pageErrors.length === 0}`)
  ok = toggle.exists && toggle.checked && !!attached && rightCard && offSkipped
    && observedOk && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('A2 REFERENCE CHECK FAILED')
  process.exit(1)
}
console.log('A2 REFERENCE CHECK PASSED')
process.exit(0)
