// 실기(A-4 §6.3) — **진짜** 백엔드 + 진짜 로컬 모델 + 진짜 LoRA 델타로
// 승격 서빙이 사용자 화면까지 가는지 본다. 가짜 서버가 없는 유일한 하네스다.
//
// 전제(하네스가 만들지 않는 것): 델타 한 장. `--delta <dir>`로 받는다 —
// 실제 야간 학습 산출물이거나, 학습 없이 PEFT로 초기화만 한 진짜 어댑터.
//
//   1. 백엔드를 Apia가 직접 띄운다(토큰이 env로 흘러야 /training/*가 열린다)
//   2. 승격 OFF 상태로 한 번 대화 → 로컬 모델이 VRAM에 **상주**한다
//   3. 관제판에서 greeting 승격 ON
//   4. "안녕" → 응답이 로컬 델타에서 나온다(status.json serving.local 증가)
//   5. 품질 필터 실동작: 마크다운을 유도하는 발화 → 필터가 걸고 API로 폴백
//
// 창은 모니터 2. userData는 tmp라 사용자의 %APPDATA%\apia는 읽지도 쓰지도 않는다.
import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'
import { mkdtemp, rm, writeFile, readFile, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(projectRoot, 'render-shots')
const deltaSource = process.argv[process.argv.indexOf('--delta') + 1]
if (!deltaSource || deltaSource.startsWith('--')) {
  console.error('usage: node tests/gui/promotion-live-check.mjs --delta <adapter-dir>')
  process.exit(2)
}

const userData = await mkdtemp(join(tmpdir(), 'apia-promotion-live-'))
const trainingDir = join(userData, 'courseware', 'training')
const statusPath = join(trainingDir, 'status.json')
const version = 'live-delta'
const anchorDir = join(trainingDir, 'anchors', version)
const MONITOR2_ANCHOR = { x: -1098, y: 287 }

const dayKey = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const today = dayKey(Date.now())

await mkdir(dirname(anchorDir), { recursive: true })
await cp(deltaSource, anchorDir, { recursive: true })
await mkdir(outDir, { recursive: true })

// greeting과 general 둘 다 추천 조건을 채워 둔다 — 하나는 정상 서빙, 하나는
// 품질 필터가 실제로 거는 걸 보기 위한 자리다.
const typeStat = (n, sim) => ({ attempts: n, simSum: n * sim, lenSum: n * 0.9 })
await writeFile(statusPath, JSON.stringify({
  schema_version: 1,
  lastRunAt: Date.now() - 3600000,
  lastStatus: 'passed',
  lastReason: '통과',
  lastSuccessAt: Date.now() - 3600000,
  cardsAtLastSuccess: 30,
  adopted: { version, dir: anchorDir, adoptedAt: Date.now() - 3600000, gate: { passed: true } },
  anchors: [version],
  teacherSpentWeek: 0,
  shadow: {
    [today]: {
      attempts: 80, simSum: 40 * 0.72 + 40 * 0.6, lenSum: 72,
      types: { greeting: typeStat(40, 0.72), general: typeStat(40, 0.6) }
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
  aiMode: 'local',
  coursewareReferenceEnabled: false   // 참조 카드가 붙으면 personal로 분류된다
}, null, 2), 'utf-8')

const readStatus = async () => JSON.parse(await readFile(statusPath, 'utf-8'))
const servingOf = async () => (await readStatus()).serving?.[today] || { local: 0, api: 0, reasons: {} }
const shadowTotal = async () => Object.values((await readStatus()).shadow || {})
  .reduce((n, b) => n + (b.attempts || 0), 0)

/**
 * API로 답한 교환 뒤에는 **그림자(A-3)가 같은 로컬 경로를 수십 초 붙잡는다**.
 * 그 사이에 승격 발화가 들어오면 서빙은 'local path busy'로 API에 양보한다 —
 * 설계대로의 폴백이지만, 실기에서 로컬 서빙을 보려면 그림자가 끝나길 기다려야
 * 한다. 그림자 한 건이 집계에 들어오거나(=끝났다) 상한까지 기다린다.
 */
async function waitForLocalIdle(limitMs = 120000) {
  const before = await shadowTotal()
  const dormantBefore = (await readStatus()).shadowDormant
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await readStatus()
    const total = Object.values(s.shadow || {}).reduce((n, b) => n + (b.attempts || 0), 0)
    // 그림자가 **끝났다**는 신호는 둘뿐이다: 점수가 하나 늘었거나, 휴면 사유가
    // 새로 적혔거나. 이미 적혀 있던 사유를 끝남으로 읽으면 기다리지 않게 된다.
    if (total > before || (s.shadowDormant && s.shadowDormant !== dormantBefore)) return Date.now() - t0
  }
  return -1
}

const pageErrors = []
let ok = false
const { app, mainWindow, cleanup } = await launchApia({
  existingUserData: userData,
  // 진짜 백엔드를 Apia가 스폰해야 학습 토큰이 env로 흘러 /training/shadow가 열린다.
  extraEnv: { APIA_E2E_DISABLE_BACKEND: '0', APIA_E2E_DISABLE_WALLPAPER: '1' }
})

const say = (msg) => mainWindow.evaluate((m) => window.api.sendMessage(m, [], {}), msg)

try {
  await new Promise((r) => setTimeout(r, 6000))

  // ── 로컬 모델 상주시키기 (승격 OFF 상태의 평범한 대화 한 번) ───────────────
  let warm = null
  const warmStart = Date.now()
  for (let i = 0; i < 6 && !warm?.reply; i += 1) {
    warm = await say('자기소개를 한 문장으로 해줘')
    if (!warm?.reply) await new Promise((r) => setTimeout(r, 10000))
  }
  const warmMs = Date.now() - warmStart
  const warmOk = Boolean(warm?.reply)
  const servingAfterWarm = await servingOf()
  // 승격 OFF라 게이트는 아무것도 세지 않는다 = 기존 경로 그대로.
  const offUncountedOk = servingAfterWarm.local === 0 && servingAfterWarm.api === 0

  // ── 관제판에서 승격 ON ────────────────────────────────────────────────────
  const settingsWindow = await openSettingsWindow(app, mainWindow)
  settingsWindow.on('pageerror', (e) => pageErrors.push(String(e)))
  await new Promise((r) => setTimeout(r, 1800))
  const enabled = await settingsWindow.evaluate(() => {
    const rows = [...document.getElementById('growth-promotion').children]
    const out = []
    for (const r of rows) {
      const box = r.querySelector('input[type=checkbox]')
      if (!box.disabled) { box.click(); out.push(r.querySelector('.row-label').textContent) }
    }
    return out
  })
  await new Promise((r) => setTimeout(r, 1500))
  const promoted = (await readStatus()).promotion
  await settingsWindow.evaluate(() => document.getElementById('growth-promotion')?.scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'live_promotion_on.png') })

  // ── 실기 ①: greeting → 로컬 델타가 답한다 ────────────────────────────────
  //
  // aiMode=local로 돌리는 이 하네스에서는 대화·눈치 원장 분류·디렉터·그림자가
  // **전부 같은 로컬 경로**를 쓴다. 승격 서빙은 그 경로가 바쁘면 기다리지 않고
  // API에 양보하므로(대화 지연을 만들지 않는 게 우선) 한 번에 잡히지 않을 수
  // 있다. 실기는 "로컬이 한 번이라도 사용자 화면까지 간다"를 보는 자리라
  // 틈이 날 때까지 몇 번 시도하고, 그 분포도 그대로 보고한다.
  const idleWait = await waitForLocalIdle()   // 워밍업 교환의 그림자가 끝나길
  const greetAttempts = []
  let greeted = null
  for (let i = 0; i < 8; i += 1) {
    const before = await servingOf()
    const t0 = Date.now()
    const r = await say('안녕')
    const ms = Date.now() - t0
    await new Promise((x) => setTimeout(x, 1500))
    const after = await servingOf()
    const source = after.local > before.local ? 'local' : 'api'
    greetAttempts.push({ ms, source, reply: r?.reply, reasons: after.reasons })
    if (source === 'local') { greeted = r; break }
    await new Promise((x) => setTimeout(x, 8000))   // 로컬 경로가 비도록 숨 돌리기
  }
  const greetMs = greetAttempts.at(-1)?.ms
  const afterGreet = await servingOf()
  const localServedOk = afterGreet.local >= 1 && Boolean(greeted?.reply)

  // ── 실기 ②: 품질 필터 실동작 — 마크다운을 유도해 걸리게 한다 ──────────────
  // 로컬 모델이 목록으로 답하기 쉬운 발화. 걸리면 사용자는 폴백 답을 받는다.
  const probes = [
    '오늘 할 일 세 가지만 목록으로 정리해줘',
    '장점 세 가지를 번호 붙여서 알려줘',
    '준비물 목록을 불릿으로 써줘'
  ]
  const probeResults = []
  for (const p of probes) {
    await waitForLocalIdle()
    const before = await servingOf()
    const r = await say(p)
    await new Promise((x) => setTimeout(x, 1200))
    const after = await servingOf()
    probeResults.push({
      ask: p,
      replied: Boolean(r?.reply),
      deltaLocal: after.local - before.local,
      deltaApi: after.api - before.api,
      reasons: after.reasons
    })
    if (after.api > before.api) break   // 한 건이면 충분하다
  }
  const finalServing = await servingOf()
  const filterOk = Object.keys(finalServing.reasons).length > 0

  // ── 관제판 재렌더 + 대화창 스크린샷 ───────────────────────────────────────
  await settingsWindow.evaluate(() => window.api.nightSchool.getState().then(renderNightSchool))
  await new Promise((r) => setTimeout(r, 800))
  await settingsWindow.evaluate(() => document.getElementById('growth-serving')?.scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 400))
  await settingsWindow.screenshot({ path: join(outDir, 'live_serving_stats.png') })
  await mainWindow.screenshot({ path: join(outDir, 'live_chat.png') })

  console.log(`warm=${JSON.stringify(warm)} (${warmMs}ms)`)
  console.log(`승격 OFF 집계=${JSON.stringify(servingAfterWarm)}`)
  console.log(`승격됨=${JSON.stringify(enabled)} / 디스크=${JSON.stringify(promoted)}`)
  console.log(`그림자 대기=${idleWait}ms`)
  console.log(`greeting 시도=${JSON.stringify(greetAttempts, null, 2)}`)
  console.log(`greeting 실기 응답=${JSON.stringify(greeted)} (${greetMs}ms)`)
  console.log(`greeting 이후 집계=${JSON.stringify(afterGreet)}`)
  console.log(`품질 필터 프로브=${JSON.stringify(probeResults, null, 2)}`)
  console.log(`최종 서빙=${JSON.stringify(finalServing)}`)
  console.log(`pageErrors=${JSON.stringify(pageErrors)}`)
  console.log(`\nwarmOk=${warmOk} offUncountedOk=${offUncountedOk} localServedOk=${localServedOk} filterOk=${filterOk} noErrors=${pageErrors.length === 0}`)
  ok = warmOk && offUncountedOk && localServedOk && filterOk && pageErrors.length === 0
} finally {
  await cleanup()
  await new Promise((r) => setTimeout(r, 2000))
  await rm(userData, { recursive: true, force: true })
}

if (!ok) {
  console.error('PROMOTION LIVE CHECK FAILED')
  process.exit(1)
}
console.log('PROMOTION LIVE CHECK PASSED')
process.exit(0)
