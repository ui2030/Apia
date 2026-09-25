// 계단식 승격 + 성장 관제판(A-4) 배선 검증 (7단언) + 스크린샷.
//
// 백엔드는 **가짜**다 — 가짜 API(/chat)와 가짜 로컬 학생(/training/shadow)을
// 한 서버가 흉내 내고, 하네스가 로컬의 답을 마음대로 바꿔 가며 승격의 수명을
// 전부 돌린다. 이 하네스의 존재 이유는 하나다: **로컬이 낸 답이 실제로 사용자
// 화면까지 가고, 품질이 무너지면 사용자가 모르는 새 API로 되돌아간다.**
//
//   단언 1: 관제판 4구획(학습·그림자·승격·서빙) 요소가 전부 있다
//   단언 2: 추천 배지 없는 유형의 토글은 잠겨 있다(자동 승격이 없는 대신
//           사용자 승인도 검증된 유형에만 열린다)
//   단언 3: 승격 OFF면 첫 백엔드 요청이 /chat이다 = 기존 경로 그대로(지연 0)
//   단언 4: 승격 ON → greeting 발화의 응답이 **로컬 원문**이고 /chat을 타지 않는다
//   단언 5: 품질 미달을 주입하면 사용자는 API 답을 받는다(폴백 투명)
//   단언 6: 20회 중 30% 초과 → 자동 강등되고 관제판에 사유가 뜬다
//   단언 7: 설정 창 콘솔 페이지 에러 0건
//
// 창은 **모니터 2**에 띄운다 — 사용자가 주 모니터에서 작업 중이다. 창 위치는
// 격리된 tmp userData의 windowAnchor로만 지정하므로 사용자의 실제 설정
// (%APPDATA%\apia\apia-settings.json)은 읽지도 쓰지도 않는다.
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const userData = await mkdtemp(join(tmpdir(), 'apia-promotion-e2e-'))
const trainingDir = join(userData, 'courseware', 'training')
const statusPath = join(trainingDir, 'status.json')

// 모니터 2 (실측: screen.getAllDisplays — bounds x=-2195 y=-306 2195x1235).
// 주 모니터는 0,0 1920x1080이라 음수 x는 전부 모니터 2 영역이다.
const MONITOR2_ANCHOR = { x: -1098, y: 287 }

const API_REPLY = '안녕하세요! 오늘도 반가워요.'
const GOOD_LOCAL = '안녕! 오늘도 잘 부탁해.'
const BAD_LOCAL = '**안녕하세요** 晴天입니다'   // 마크다운 + 한자 — 품질 필터 두 겹

const dayKey = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── 승격 추천이 이미 나와 있는 상태를 심는다 ─────────────────────────────────
const anchors = ['2026-09-18T02-00', '2026-09-25T02-00']
for (const v of anchors) {
  const d = join(trainingDir, 'anchors', v)
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'adapter_config.json'), '{"peft_type":"LORA"}', 'utf-8')
  await writeFile(join(d, 'adapter_model.safetensors'), 'fake-weights', 'utf-8')
}
await mkdir(outDir, { recursive: true })
const today = dayKey(Date.now())
await writeFile(statusPath, JSON.stringify({
  schema_version: 1,
  lastRunAt: Date.now() - 3600000,
  lastStatus: 'passed',
  lastReason: '통과',
  lastSuccessAt: Date.now() - 3600000,
  cardsAtLastSuccess: 30,
  adopted: {
    version: anchors[1],
    dir: join(trainingDir, 'anchors', anchors[1]),
    adoptedAt: Date.now() - 3600000,
    gate: { passed: true }
  },
  anchors: [anchors[1], anchors[0]],
  teacherSpentWeek: 0.0021,
  shadow: {
    // greeting만 추천 조건 충족(40회 / 0.72). reaction은 시도 부족, general은 유사도 부족.
    [today]: {
      attempts: 62, simSum: 40 * 0.72 + 12 * 0.6 + 10 * 0.3, lenSum: 55,
      types: {
        greeting: { attempts: 40, simSum: 40 * 0.72, lenSum: 36 },
        reaction: { attempts: 12, simSum: 12 * 0.6, lenSum: 10 },
        general: { attempts: 10, simSum: 10 * 0.3, lenSum: 8 }
      }
    }
  },
  shadowDormant: null,
  promotion: {},
  demotions: [],
  serving: {},
  servingRecent: {}
}, null, 2), 'utf-8')

await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
  windowAnchor: MONITOR2_ANCHOR,
  trainingPythonPath: join(userData, 'no-such-python.exe')
}, null, 2), 'utf-8')

// ── 가짜 백엔드 ─────────────────────────────────────────────────────────────
let localReply = GOOD_LOCAL
const hits = []          // 요청 순서 — "승격 OFF면 첫 요청이 /chat" 단언의 근거
// 눈치 원장의 /classify가 같은 교환에 섞여 들어온다. 대화 본체의 분기만 보려면
// 두 엔드포인트로 좁혀야 한다.
const CHAT_PATHS = new Set(['/chat', '/training/shadow'])
const chatHits = () => hits.filter((u) => CHAT_PATHS.has(u))
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    hits.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/chat') return res.end(JSON.stringify({ reply: API_REPLY, emotion: 'happy' }))
    if (req.url === '/training/shadow') {
      const parsed = JSON.parse(body || '{}')
      if (!parsed.delta_dir) return res.end(JSON.stringify({ status: 'dormant', reason: 'no delta' }))
      return res.end(JSON.stringify({ status: 'ok', reply: localReply }))
    }
    res.end(JSON.stringify({}))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const backendUrl = `http://127.0.0.1:${server.address().port}`

const readStatus = async () => JSON.parse(await readFile(statusPath, 'utf-8'))

const pageErrors = []
let ok = false
const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  extraEnv: { APIA_BACKEND_URL: backendUrl, APIA_E2E_DISABLE_WALLPAPER: '1' }
})

try {
  await new Promise((r) => setTimeout(r, 3000))

  // 창이 정말 모니터 2에 있는지 — 음수 x면 주 모니터 밖이다.
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.getBounds()))
  // 창 중심이 음수 x면 모니터 2다(주 모니터는 0,0부터 시작).
  const onMonitor2 = bounds.every((b) => b.x + b.width / 2 < 0)

  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1800))

  const settingsBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.getBounds()))

  // ── 단언 1: 관제판 4구획 ─────────────────────────────────────────────────
  const elements = await settingsWindow.evaluate(() => ({
    section: !!document.getElementById('growth-section'),
    learn: !!document.getElementById('training-last'),
    next: !!document.getElementById('training-next'),
    anchorSelect: !!document.getElementById('training-anchor-select'),
    rewind: !!document.getElementById('training-rewind-btn'),
    shadowTable: (document.getElementById('growth-shadow-table')?.children.length || 0) === 4,
    promotion: (document.getElementById('growth-promotion')?.children.length || 0) === 4,
    serving: !!document.getElementById('growth-serving')
  }))
  const elementsOk = Object.values(elements).every(Boolean)

  await settingsWindow.evaluate(() => document.getElementById('growth-section')?.scrollIntoView({ block: 'start' }))
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'growth_panel_top.png') })
  await settingsWindow.evaluate(() => document.getElementById('growth-serving')?.scrollIntoView({ block: 'end' }))
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'growth_panel_bottom.png') })
  await settingsWindow.screenshot({ path: join(outDir, 'growth_panel_full.png'), fullPage: true })

  // ── 단언 2: 추천 없는 유형은 토글이 잠겨 있다 ─────────────────────────────
  const toggles = await settingsWindow.evaluate(() => {
    const rows = [...document.getElementById('growth-promotion').children]
    return rows.map((r) => ({
      label: r.querySelector('.row-label').textContent,
      disabled: r.querySelector('input[type=checkbox]').disabled
    }))
  })
  const badges = await settingsWindow.evaluate(() =>
    [...document.getElementById('growth-shadow-table').children].map((r) => r.lastChild.textContent))
  const gateOk = toggles[0].disabled === false      // greeting — 추천됨
    && toggles[1].disabled === true                 // reaction — 시도 부족
    && toggles[2].disabled === true                 // personal — 시도 0
    && toggles[3].disabled === true                 // general — 유사도 부족
    && badges[0] === '승격 추천'

  // ── 단언 3: 승격 OFF — 첫 요청이 /chat, 응답은 API ────────────────────────
  hits.length = 0
  const offTimings = []
  for (let i = 0; i < 5; i += 1) {
    const t0 = Date.now()
    const r = await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
    offTimings.push(Date.now() - t0)
    if (r?.reply !== API_REPLY) throw new Error(`승격 OFF인데 API 답이 아니다: ${r?.reply}`)
  }
  const offFirstHit = chatHits()[0]
  const offOk = offFirstHit === '/chat'   // 대화 앞에 로컬 왕복이 끼지 않았다
  await new Promise((r) => setTimeout(r, 2000)) // 뒤따르는 그림자(비동기) 정리

  // ── 단언 4: 승격 ON → 로컬이 사용자 화면까지 ──────────────────────────────
  await settingsWindow.evaluate(() =>
    document.querySelector('#growth-promotion input[type=checkbox]').click())
  await new Promise((r) => setTimeout(r, 1200))
  const promotedOnDisk = (await readStatus()).promotion?.greeting?.enabled === true
  await settingsWindow.evaluate(() => document.getElementById('growth-promotion')?.scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 300))
  await settingsWindow.screenshot({ path: join(outDir, 'growth_promotion_on.png') })

  const shadowBefore = Object.values((await readStatus()).shadow)
    .reduce((n, b) => n + (b.types?.greeting?.attempts || 0), 0)
  hits.length = 0
  const servedLocal = await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
  await new Promise((r) => setTimeout(r, 800))
  const localOk = servedLocal?.reply === GOOD_LOCAL
    && chatHits()[0] === '/training/shadow'
    && !chatHits().includes('/chat')                 // API를 아예 부르지 않았다
    && (await readStatus()).serving?.[today]?.local === 1
    && promotedOnDisk

  // 승격 유형은 교재·그림자로 되먹이지 않는다 — 자기 출력 자가학습 방지.
  const shadowAfter = Object.values((await readStatus()).shadow)
    .reduce((n, b) => n + (b.types?.greeting?.attempts || 0), 0)
  const noFeedbackOk = shadowAfter === shadowBefore

  // ── 단언 5: 품질 미달 → 사용자는 API 답을 본다 ───────────────────────────
  localReply = BAD_LOCAL
  hits.length = 0
  const fellBack = await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
  await new Promise((r) => setTimeout(r, 2000))
  const s5 = await readStatus()
  const fallbackOk = fellBack?.reply === API_REPLY
    && chatHits().includes('/training/shadow') && chatHits().includes('/chat')
    && Object.keys(s5.serving[today].reasons).some((r) => /마크다운|한자/.test(r))

  // ── 단언 6: 30% 초과 → 자동 강등 ──────────────────────────────────────────
  // 창에 이미 통과 1 + 미달 1. 미달 6개를 더 채우고(=7/20) 나머지는 통과로
  // 채워 창을 20개로 만든다.
  for (let i = 0; i < 6; i += 1) {
    await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
  }
  const midway = await readStatus()
  const notYetDemoted = midway.promotion?.greeting?.enabled === true // 창이 아직 8개
  localReply = GOOD_LOCAL
  for (let i = 0; i < 12; i += 1) {
    await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
  }
  await new Promise((r) => setTimeout(r, 2500))
  const demoted = await readStatus()
  const demoteOk = notYetDemoted
    && demoted.promotion?.greeting?.enabled === false
    && demoted.demotions?.[0]?.type === 'greeting'

  // 강등 후 첫 발화는 다시 기존 경로.
  hits.length = 0
  const afterDemotion = await mainWindow.evaluate(() => window.api.sendMessage('안녕', [], {}))
  const backToApiOk = afterDemotion?.reply === API_REPLY && chatHits()[0] === '/chat'
  await new Promise((r) => setTimeout(r, 2000))

  // ── 관제판 재렌더: 강등 이력 + 서빙 통계 ──────────────────────────────────
  await settingsWindow.evaluate(() => window.api.nightSchool.getState().then(renderNightSchool))
  await new Promise((r) => setTimeout(r, 800))
  const panelAfter = await settingsWindow.evaluate(() => ({
    demotions: document.getElementById('growth-demotions').textContent,
    demotionsVisible: document.getElementById('growth-demotions').style.display !== 'none',
    serving: document.getElementById('growth-serving').textContent,
    reasons: document.getElementById('growth-serving-reasons').textContent,
    greetingToggle: document.querySelector('#growth-promotion input[type=checkbox]').checked
  }))
  const panelOk = panelAfter.demotionsVisible
    && panelAfter.demotions.includes('자동 강등')
    && /로컬 \d+회 \/ API \d+회/.test(panelAfter.serving)
    && panelAfter.greetingToggle === false
  await settingsWindow.evaluate(() => document.getElementById('growth-promotion')?.scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 300))
  await settingsWindow.screenshot({ path: join(outDir, 'growth_demoted.png') })

  // ── 되감기 확인 다이얼로그 ────────────────────────────────────────────────
  //
  // 확인은 **main 프로세스의 네이티브 다이얼로그**다(렌더러 confirm은 IPC를
  // 직접 부르면 우회되므로 제거했다). 자동화로는 네이티브 위젯을 못 누르니
  // main에서 showMessageBox를 가로채 응답을 주입하고, 취소/확인 두 갈래를
  // 각각 확인한다 — 취소가 진짜 no-op인지가 이 단언의 핵심이다.
  const dialogCalls = await app.evaluate(({ dialog }) => {
    globalThis.__apiaDialogCalls = []
    globalThis.__apiaDialogResponse = 0   // 0 = 취소
    dialog.showMessageBox = async (_win, opts) => {
      globalThis.__apiaDialogCalls.push(`${opts.message} ${opts.detail || ''}`)
      return { response: globalThis.__apiaDialogResponse }
    }
    return globalThis.__apiaDialogCalls
  })
  void dialogCalls
  await settingsWindow.evaluate((v) => {
    const sel = document.getElementById('training-anchor-select')
    sel.value = v
    document.getElementById('training-rewind-btn').scrollIntoView({ block: 'center' })
  }, anchors[0])

  // ① 취소 → 아무 일도 없어야 한다
  await settingsWindow.click('#training-rewind-btn')
  await new Promise((r) => setTimeout(r, 1500))
  const afterCancel = await readStatus()
  const cancelOk = afterCancel.adopted?.version === anchors[1]

  // ② 확인 → 되감긴다. (취소 뒤 패널이 다시 렌더되면서 드롭다운이 현재
  //    채택본으로 돌아가므로 고를 앵커를 다시 지정한다.)
  await app.evaluate(() => { globalThis.__apiaDialogResponse = 1 })
  await settingsWindow.evaluate((v) => { document.getElementById('training-anchor-select').value = v }, anchors[0])
  await settingsWindow.click('#training-rewind-btn')
  await new Promise((r) => setTimeout(r, 2000))
  const prompts = await app.evaluate(() => globalThis.__apiaDialogCalls)
  const rewindMessage = prompts.join(' | ')
  const rewound = await readStatus()
  const rewindOk = prompts.length === 2
    && prompts.every((m) => m.includes(anchors[0]))
    && cancelOk
    && rewound.adopted?.version === anchors[0]
    && rewound.anchors.includes(anchors[1])     // 앞으로 감을 길이 남아 있다
  await settingsWindow.screenshot({ path: join(outDir, 'growth_rewound.png') })

  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  console.log(`onMonitor2=${onMonitor2} windows=${JSON.stringify(bounds)} settings=${JSON.stringify(settingsBounds)}`)
  console.log(`elements=${JSON.stringify(elements)}`)
  console.log(`toggles=${JSON.stringify(toggles)}`)
  console.log(`badges=${JSON.stringify(badges)}`)
  console.log(`승격OFF 왕복(ms)=${JSON.stringify(offTimings)} median=${median(offTimings)} firstHit=${offFirstHit}`)
  console.log(`servedLocal=${JSON.stringify(servedLocal)}`)
  console.log(`fellBack=${JSON.stringify(fellBack)}`)
  console.log(`serving=${JSON.stringify(demoted.serving)}`)
  console.log(`demotions=${JSON.stringify(demoted.demotions)}`)
  console.log(`panelAfter=${JSON.stringify(panelAfter)}`)
  console.log(`rewindMessage=${JSON.stringify(rewindMessage)} adopted=${rewound.adopted?.version}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`screenshots=${outDir}`)
  console.log(`\nelementsOk=${elementsOk} gateOk=${gateOk} offOk=${offOk} localOk=${localOk} noFeedbackOk=${noFeedbackOk} fallbackOk=${fallbackOk} demoteOk=${demoteOk} backToApiOk=${backToApiOk} panelOk=${panelOk} rewindOk=${rewindOk} onMonitor2=${onMonitor2} noErrors=${pageErrors.length === 0}`)
  ok = elementsOk && gateOk && offOk && localOk && noFeedbackOk && fallbackOk
    && demoteOk && backToApiOk && panelOk && rewindOk && onMonitor2 && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => server.close(r))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('PROMOTION UI CHECK FAILED')
  process.exit(1)
}
console.log('PROMOTION UI CHECK PASSED')
process.exit(0)
