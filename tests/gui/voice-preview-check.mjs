// 복제 음성 미리듣기 연타 E2E — 중첩 재생이 없는지 실제 IPC+오디오로 본다.
//
//   단언 1: 처음 누르면 재생이 시작되고 버튼이 '정지'로 바뀐다
//   단언 2: 재생 중 다시 누르면 정지(토글) — 두 개가 겹쳐 울지 않는다
//   단언 3: 연타(빠르게 여러 번)해도 살아 있는 오디오는 최대 1개다
//   단언 4: 다른 음성으로 바꾸면 앞 미리듣기가 멈춘다
//
// 가짜 백엔드가 2초짜리 사인파 WAV를 /voices/<id>/preview로 준다 — 실제 재생이
// 도는 동안 눌러야 "중첩"을 볼 수 있으므로 무음이 아니라 길이 있는 소리를 쓴다.
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function sineWav(seconds, sr = 22050, freq = 220) {
  const n = Math.round(seconds * sr)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000), 44 + i * 2)
  }
  return buf
}

const PREVIEW_WAV = sineWav(2.0)
let previewHits = 0

const server = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (/^\/voices\/[^/]+\/preview$/.test(req.url)) {
      previewHits += 1
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      return res.end(PREVIEW_WAV)
    }
    if (req.url === '/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ voices: [] }))
    }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const userData = await mkdtemp(join(tmpdir(), 'apia-preview-'))
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify(SECOND_MONITOR_SEED), 'utf-8')

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_DISABLE_WALLPAPER: '1' }
})

let ok = false
try {
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  await new Promise((r) => setTimeout(r, 1200))

  // custom 음성 두 개를 주입해 미리듣기 행이 뜨게 한다(백엔드 목록 없이).
  await settingsWindow.evaluate(() => {
    const sel = document.getElementById('voice-select')
    for (const id of ['custom:voice_aaaa', 'custom:voice_bbbb']) {
      const o = document.createElement('option')
      o.value = id; o.textContent = id
      sel.appendChild(o)
    }
    sel.value = 'custom:voice_aaaa'
    sel.dispatchEvent(new Event('change'))
  })

  const btnLabel = () => settingsWindow.evaluate(
    () => document.getElementById('voice-clone-preview-btn').textContent
  )
  const playing = () => settingsWindow.evaluate(() => window.__apiaVoiceClone.isPreviewPlaying())
  const click = () => settingsWindow.evaluate(
    () => document.getElementById('voice-clone-preview-btn').click()
  )

  // 단언 1 — 첫 클릭
  await click()
  await new Promise((r) => setTimeout(r, 700))
  const startedOk = (await playing()) === true && (await btnLabel()) === '정지'
  await settingsWindow.screenshot({ path: join('test-results', 'voice-preview-playing.png') })

  // 단언 2 — 재생 중 재클릭 = 정지
  await click()
  await new Promise((r) => setTimeout(r, 300))
  const toggleOffOk = (await playing()) === false && (await btnLabel()) === '미리듣기'

  // 단언 3 — 연타. `new Audio()`를 감싸서 **동시에 울고 있는 개수의 최대값**을
  // 센다. new Audio 객체는 DOM에 안 붙으므로 querySelector로는 셀 수 없고,
  // 이 계측이 "두 겹으로 들린다"를 잡는 유일한 방법이다.
  await settingsWindow.evaluate(() => {
    const Orig = window.Audio
    window.__live = new Set()
    window.__maxLive = 0
    window.Audio = function PatchedAudio(...args) {
      const el = new Orig(...args)
      const origPlay = el.play.bind(el)
      el.play = () => origPlay().then(() => {
        window.__live.add(el)
        window.__maxLive = Math.max(window.__maxLive, window.__live.size)
      })
      const drop = () => window.__live.delete(el)
      el.addEventListener('pause', drop)
      el.addEventListener('ended', drop)
      return el
    }
  })
  const beforeHits = previewHits
  for (let i = 0; i < 5; i++) { await click(); await new Promise((r) => setTimeout(r, 120)) }
  await new Promise((r) => setTimeout(r, 500))
  const maxLive = await settingsWindow.evaluate(() => window.__maxLive)
  // 핸들 하나만 쓰므로 동시 재생은 절대 2가 되지 않는다.
  const noOverlapOk = maxLive === 1 && previewHits > beforeHits

  // 단언 4 — 다른 음성 선택 시 정지
  if (!(await playing())) { await click(); await new Promise((r) => setTimeout(r, 600)) }
  const wasPlaying = await playing()
  await settingsWindow.evaluate(() => {
    const sel = document.getElementById('voice-select')
    sel.value = 'custom:voice_bbbb'
    sel.dispatchEvent(new Event('change'))
  })
  await new Promise((r) => setTimeout(r, 200))
  const switchStopsOk = wasPlaying === true && (await playing()) === false

  console.log(JSON.stringify({
    startedOk, toggleOffOk, noOverlapOk, maxLive, switchStopsOk, previewHits
  }, null, 2))
  ok = startedOk && toggleOffOk && noOverlapOk && switchStopsOk
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) { console.error('VOICE PREVIEW CHECK FAILED'); process.exit(1) }
console.log('VOICE PREVIEW CHECK PASSED')
process.exit(0)
