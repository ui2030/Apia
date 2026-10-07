// 발주서 16 — 자동 모드 채팅이 실제로 **점진 갱신**되는가 + 폴백 안내 하루 1회.
//
// 백엔드는 이 파일이 띄우는 SSE 스텁이다(파이썬 백엔드는 꺼진 채). 델타를 시간차로
// 흘려 보내고, 말풍선 길이를 중간에 찍어 늘어나는지 본다. 마지막 final 프레임에
// fallback='local'을 실어 안내 말풍선이 첫 답에만 붙는지도 본다.
//
//   단언 1: 스트리밍 중 스냅샷 길이가 2회 이상 증가
//   단언 2: 최종 답으로 확정(typing 해제)
//   단언 3: 요청 body의 ai_mode가 auto
//   단언 4: 폴백 안내는 첫 답 뒤 1번만(두 번째 답엔 없음)
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
const userData = await mkdtemp(join(tmpdir(), 'apia-ds-e2e-'))
await mkdir(outDir, { recursive: true })

await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ...SECOND_MONITOR_SEED, ttsEnabled: false, autoBehavior: false, aiMode: 'auto'
}, null, 2), 'utf-8')

const PIECES = ['안녕하세요! ', '오늘은 ', '날씨가 ', '꽤 맑네요. ', '산책 어때요?']
const REPLY = PIECES.join('')
const NOTICE = '오늘 사용 한도를 다 써서 클라우드 모델 대신 로컬 모델이 답해요'
const captured = []

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    if (req.url?.startsWith('/chat/stream')) {
      try { captured.push(JSON.parse(raw)) } catch { captured.push({}) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const text of PIECES) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`)
        await new Promise((r) => setTimeout(r, 450))
      }
      res.write(`data: ${JSON.stringify({
        type: 'final', reply: REPLY, emotion: 'happy', citations: [],
        fallback: 'local', fallback_reason: 'budget'
      })}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', ai_mode: 'auto', modes: ['local'] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const { mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl }
})

const pageErrors = []
let ok = false
try {
  mainWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 4000))
  await mainWindow.click('#chat-toggle')
  await new Promise((r) => setTimeout(r, 600))

  const lastAi = () => mainWindow.evaluate(() => {
    const rows = [...document.querySelectorAll('#messages .msg-row.ai .msg-bubble')]
    const last = rows[rows.length - 1]
    return { text: last?.textContent || '', typing: !!last?.classList.contains('typing'), count: rows.length }
  })
  const ask = async (text) => {
    await mainWindow.fill('#chat-input', text)
    await mainWindow.press('#chat-input', 'Enter')
    const snaps = []
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250))
      snaps.push((await lastAi()).text.length)
    }
    await mainWindow.waitForFunction(() => {
      const rows = document.querySelectorAll('#messages .msg-row.ai .msg-bubble')
      const last = rows[rows.length - 1]
      return !!last && !last.classList.contains('typing') && !last.textContent.includes('●')
    }, null, { timeout: 15000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 600))
    return snaps
  }

  const snaps = await ask('안녕')
  await mainWindow.screenshot({ path: join(outDir, 'ds_stream_reply.png') })
  const growth = snaps.filter((n, i) => i > 0 && n > snaps[i - 1] && snaps[i - 1] > 0).length
  const bubbles1 = await mainWindow.evaluate(() =>
    [...document.querySelectorAll('#messages .msg-row.ai .msg-bubble')].map((b) => b.textContent))
  await ask('또 안녕')
  const bubbles2 = await mainWindow.evaluate(() =>
    [...document.querySelectorAll('#messages .msg-row.ai .msg-bubble')].map((b) => b.textContent))

  const finalOk = bubbles1.includes(REPLY)
  const noticeCount = bubbles2.filter((t) => t === NOTICE).length
  const noticeAfterFirst = bubbles1[bubbles1.length - 1] === NOTICE
  const modeOk = captured.length === 2 && captured.every((c) => c.ai_mode === 'auto')

  console.log(`snapshots=${JSON.stringify(snaps)}`)
  console.log(`bubbles=${JSON.stringify(bubbles2)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`\ngrowth=${growth} finalOk=${finalOk} modeOk=${modeOk} `
    + `noticeAfterFirst=${noticeAfterFirst} noticeCount=${noticeCount} noErrors=${pageErrors.length === 0}`)
  ok = growth >= 2 && finalOk && modeOk && noticeAfterFirst && noticeCount === 1 && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('DEEPSEEK STREAM CHECK FAILED')
  process.exit(1)
}
console.log('DEEPSEEK STREAM CHECK PASSED')
process.exit(0)
