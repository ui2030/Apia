// 발주15 관전 코멘트 원장 거부권 — 실제 앱에서 관전 한 사이클을 강제로 돌린다.
//
// 구조는 spectate-chat-check.mjs와 같다: 이 파일이 띄우는 **기록용 스텁 백엔드**
// (파이썬 백엔드는 꺼진 채)가 /spectate에 게임 코멘트를, /classify에 game을 돌려준다.
// 캡처는 진짜 창 하나를 잡는다(이미지는 로컬 스텁으로만 가고 버려진다).
//
//   단언 1: 원장 game=frozen → 발화 0, veto 로그 1
//   단언 2: 같은 조건에 goldLabel joke_ok → 발화 1
//   단언 3: 거부권 분류 요청엔 관전 ai_mode가 실린다
//   단언 4: 관제판 상태에 lastVeto(사유·화제만, 원문 없음)
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
const userData = await mkdtemp(join(tmpdir(), 'apia-spectate-veto-'))
await mkdir(outDir, { recursive: true })

const COMMENT = '와 보스전이다! 이 게임 진짜 어렵겠다'

await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  ...SECOND_MONITOR_SEED,
  ttsEnabled: false,
  autoBehavior: false,
  aiMode: 'groq'                  // 관전 ai_mode = groq (aiModeSpectate 미지정)
}, null, 2), 'utf-8')

// 원장: game이 burn-in을 넘겨 frozen. 집계가 돌아도 같은 값이 나오게 응고분에도 넣는다.
const frozenGame = { score: 0.8, evidence: 10, state: 'frozen', demote: 1, promote: 0, updatedAt: Date.now() }
await writeFile(join(userData, 'apia-topic-ledger.json'), JSON.stringify({
  schema_version: 2,
  raw: {},
  topics: { game: { ...frozenGame, goldLabel: null } },
  consolidated: { topics: { game: frozenGame } },
  events: { demote: 1, promote: 0, falseFreeze: 0, falseThaw: 0 },
  lastAggregatedAt: Date.now()
}, null, 2), 'utf-8')

// ── 기록용 스텁 백엔드 ──────────────────────────────────────────────────────
const classifyBodies = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/classify') {
      try { classifyBodies.push(JSON.parse(raw)) } catch {}
      return res.end(JSON.stringify({ raw: '{"topic_id":"game","confidence":0.9}' }))
    }
    if (req.url === '/spectate') {
      return res.end(JSON.stringify({
        raw: JSON.stringify({ summary: '게임 보스전 화면', comment: COMMENT, emotion: 'surprised', interest: 0.9 })
      }))
    }
    res.end(JSON.stringify({ status: 'ok', ai_mode: 'groq', modes: ['groq'] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const { mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const pageErrors = []
const logs = []
let ok = false
try {
  mainWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  mainWindow.on('console', (m) => logs.push(m.text()))
  await new Promise((r) => setTimeout(r, 4000))

  const count = (prefix) => logs.filter((l) => l.startsWith(prefix)).length

  // 캡처되는 창을 하나 찾을 때까지 관전 한 사이클을 강제한다. setSource가 캡처
  // 게이트를 비우므로 첫 프레임은 항상 '새 화면'이다(검은 창은 dead-frame으로 넘긴다).
  let source = null
  const forceOnce = async () => mainWindow.evaluate(async (src) => {
    await window.api.spectateSetSource(src.id, src.name)
    return window.__spectateForce()
  }, source)
  const windowsList = await mainWindow.evaluate(() => window.api.spectateListWindows())
  let first = null
  for (const w of windowsList.slice(0, 8)) {
    source = { id: w.id, name: w.name }
    first = await forceOnce()
    if (first?.status === 'ok') break
  }
  await new Promise((r) => setTimeout(r, 500))
  const spoke1 = count('[spectate] comment:')
  const veto1 = logs.filter((l) => l.startsWith('[spectate] veto:'))
  const state1 = await mainWindow.evaluate(() => window.api.spectateState())
  await mainWindow.screenshot({ path: join(outDir, 'spectate_veto_frozen.png') })

  // 단언 2 — 사용자가 game에 joke_ok를 찍었다. 렌더러 게이트(45s 간격·중복)를
  // 비우려고 페이지만 다시 띄운다(원장·main 상태는 그대로).
  await mainWindow.evaluate(() => window.api.ledger.setGold('game', 'joke_ok'))
  await mainWindow.reload()
  await new Promise((r) => setTimeout(r, 4000))
  const before2 = count('[spectate] comment:')
  const second = await forceOnce()
  await new Promise((r) => setTimeout(r, 500))
  const spoke2 = count('[spectate] comment:') - before2
  await mainWindow.screenshot({ path: join(outDir, 'spectate_veto_jokeok.png') })

  const frozenOk = first?.status === 'ok' && first?.verdict?.speak === true
    && first?.vetoed === true && spoke1 === 0 && veto1.length === 1 && veto1[0] === '[spectate] veto: frozen/game'
  const jokeOk = second?.status === 'ok' && second?.vetoed === false && spoke2 === 1
  const aiModeOk = classifyBodies.length >= 2 && classifyBodies.every((b) => b.ai_mode === 'groq')
  const lv = state1?.lastVeto
  const lastVetoOk = lv?.reason === 'frozen' && lv?.topicId === 'game' && Number.isFinite(lv?.at)
    && !JSON.stringify(state1).includes(COMMENT)

  console.log(JSON.stringify({
    source: source?.name,
    first: { status: first?.status, speak: first?.verdict?.speak, vetoed: first?.vetoed },
    second: { status: second?.status, speak: second?.verdict?.speak, vetoed: second?.vetoed },
    spoke1, veto1, spoke2,
    classifyBodies: classifyBodies.map((b) => ({ ai_mode: b.ai_mode, topics: b.topics?.length })),
    lastVeto: lv,
    pageErrors
  }, null, 2))
  console.log(`screenshots=${join(outDir, 'spectate_veto_frozen.png')} , ${join(outDir, 'spectate_veto_jokeok.png')}`)
  console.log(`\nfrozenOk=${frozenOk} jokeOk=${jokeOk} aiModeOk=${aiModeOk} lastVetoOk=${lastVetoOk} noErrors=${pageErrors.length === 0}`)
  ok = frozenOk && jokeOk && aiModeOk && lastVetoOk && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('SPECTATE VETO CHECK FAILED')
  process.exit(1)
}
console.log('SPECTATE VETO CHECK PASSED')
process.exit(0)
