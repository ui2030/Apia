// "내 파일"(개인 설정) E2E — 실제 백엔드를 띄우고 provider만 가짜(Groq 호환 서버).
//
//   단언 1: 옛 위치(backend-data/persona/persona.md)가 personal/로 1회 이동 + README 생성
//   단언 2: 설정 창 "내 파일" 행 — 경로 표시·"개인 설정 사용 중"·폴더 열기(스텁) 성공
//   단언 3: 채팅 1턴 → provider가 받은 system 프롬프트에 개인 성격 + 기능 규칙이 있고
//           기본 성격('Apia' 정체 문장)은 없다 (electron → PERSONAL_DIR → 백엔드 체인)
//   단언 4: [기본으로 되돌리기] → .bak 남고 "기본 설정 사용 중", 다음 턴은 기본 성격
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SECOND_MONITOR_SEED } from './helpers/secondMonitor.mjs'

const FAKE = '너는 테스트용 캐릭터다. 말끝마다 삐빅을 붙인다.'
const systems = []

const provider = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const sys = (body.messages || []).find((m) => m.role === 'system')
    if (sys) systems.push(sys.content)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '응 삐빅 [EMOTION:happy]' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }))
  })
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))

const userData = await mkdtemp(join(tmpdir(), 'apia-personal-'))
const legacy = join(userData, 'backend-data', 'persona', 'persona.md')
await mkdir(join(userData, 'backend-data', 'persona'), { recursive: true })
await writeFile(legacy, FAKE, 'utf-8')
await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({ ...SECOND_MONITOR_SEED, aiMode: 'groq' }), 'utf-8')

const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: {
    APIA_E2E_DISABLE_BACKEND: '0',
    APIA_AI_MODE: 'groq',
    APIA_GROQ_KEY: 'test-key',
    GROQ_BASE_URL: `http://127.0.0.1:${provider.address().port}`
  }
})

const personalDir = join(userData, 'personal')
let ok = false
try {
  await new Promise((r) => setTimeout(r, 3000))
  const migrated = !existsSync(legacy) &&
    (await readFile(join(personalDir, 'persona.md'), 'utf-8')) === FAKE &&
    existsSync(join(personalDir, 'README.txt'))

  const sw = await openSettingsWindow(app, mainWindow)
  const pageErrors = []
  sw.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1500))
  const row = () => sw.evaluate(() => ({
    dir: document.getElementById('personal-dir')?.textContent,
    state: document.getElementById('personal-state')?.textContent,
    resetDisabled: document.getElementById('personal-reset')?.disabled
  }))
  const before = await row()
  const opened = await sw.evaluate(() => window.api.openPersonalFolder())
  await sw.evaluate(() => document.getElementById('personal-open').scrollIntoView({ block: 'center' }))
  const shotDir = resolve('test-results/personal-folder')
  await mkdir(shotDir, { recursive: true })
  await sw.screenshot({ path: join(shotDir, 'personal-row.png') })
  const rowOk = before.dir === personalDir && /개인 설정 사용 중/.test(before.state) &&
    before.resetDisabled === false && opened?.ok === true

  // 단언 3 — 백엔드가 뜰 때까지 기다리며 한 턴
  let reply = null
  for (let i = 0; i < 30 && !reply?.reply; i++) {
    reply = await mainWindow.evaluate(() => window.api.sendMessage('안녕', [])).catch(() => null)
    if (!reply?.reply) await new Promise((r) => setTimeout(r, 2000))
  }
  const sys1 = systems.at(-1) || ''
  const chatOk = /삐빅/.test(reply?.reply || '') && sys1.startsWith(FAKE) &&
    sys1.includes('[EMOTION:감정]') && !sys1.includes("'Apia'")

  // 단언 4 — 되돌리기
  await sw.click('#personal-reset')
  await new Promise((r) => setTimeout(r, 800))
  const after = await row()
  const baks = (await readdir(personalDir)).filter((n) => n.startsWith('persona.md.bak-'))
  await sw.screenshot({ path: join(shotDir, 'personal-row-reset.png') })
  await mainWindow.evaluate(() => window.api.sendMessage('또 안녕', []))
  const sys2 = systems.at(-1) || ''
  const resetOk = /기본 설정 사용 중/.test(after.state) && after.resetDisabled === true &&
    baks.length === 1 && !existsSync(join(personalDir, 'persona.md')) &&
    !sys2.includes(FAKE) && sys2.includes("'Apia'")

  console.log(JSON.stringify({ migrated, before, opened, reply: reply?.reply, after, baks, pageErrors, turns: systems.length }))
  console.log(`migrate=${migrated} row=${rowOk} chat=${chatOk} reset=${resetOk} pageErrors=${pageErrors.length}`)
  ok = migrated && rowOk && chatOk && resetOk && pageErrors.length === 0
} finally {
  await cleanup()
  provider.close()
}
console.log(ok ? 'PERSONAL_FOLDER_CHECK PASS' : 'PERSONAL_FOLDER_CHECK FAIL')
process.exit(ok ? 0 : 1)
