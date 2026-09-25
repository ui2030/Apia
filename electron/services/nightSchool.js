/**
 * 야간 학습기(A-3) — 교재를 로컬 학생 모델 몸에 새기고, 그 학생을 사용자 몰래 평가한다.
 *
 * 이 모듈이 하는 일은 셋이다.
 *   1. **트리거**: 지금 학습을 시작해도 되는지 판정한다(순수 함수 — 조건이 늘면
 *      여기만 본다).
 *   2. **델타 보관**: 학습 산출물인 LoRA 델타를 앵커로 쌓고, 게이트를 통과한
 *      것만 "채택 델타"로 가리킨다. 교체는 status.json 한 파일의 tmp→rename —
 *      포인터를 갈아끼우는 쓰기가 원자적이라 중간 상태가 디스크에 남지 않는다.
 *   3. **그림자 집계**: 로컬 학생의 답과 API 답의 유사도를 **점수로만** 적는다.
 *      두 원문은 이 파일을 지나가지도 않는다(호출자가 점수로 바꿔서 넘긴다).
 *
 * 학습 자체는 하지 않는다. 별도 파이썬 프로세스(backend/training/night_trainer.py)를
 * 스폰할 뿐이고, 그 프로세스의 인터프리터는 설정값 `trainingPythonPath`다 — Apia
 * 백엔드 venv에 torch/unsloth를 또 깔지 않으려는 의도적 경계다(6.9GB 중복 회피).
 * 경로가 없으면 기능 전체가 조용히 비활성이고 상태에 사유가 남는다.
 *
 * 저장 위치는 courseware/training/ — 교재와 같은 소유자(Electron), 같은 규약.
 */
const fs = require('fs')
const path = require('path')

const { grams, dayKeyOf } = require('./courseware')

const SCHEMA_VERSION = 1

// 트리거 기본값. env는 검증(dry-run)과 실기 튜닝을 위한 손잡이다 — 코드에
// 테스트 전용 분기를 만들지 않으려고 상수 자체를 바깥으로 뺐다.
function envNum(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) ? raw : fallback
}

const IDLE_SEC = envNum('APIA_TRAINING_IDLE_SEC', 900)        // 유휴 15분
const VRAM_MIN_GB = envNum('APIA_TRAINING_VRAM_MIN_GB', 8)    // 여유 8GB
const INTERVAL_DAYS = envNum('APIA_TRAINING_INTERVAL_DAYS', 7)
const MIN_NEW_CARDS = envNum('APIA_TRAINING_MIN_CARDS', 10)
const DEADLINE_SEC = envNum('APIA_TRAINING_DEADLINE_SEC', 7200) // 2시간 상한
// 학습 중 사용자가 돌아왔다고 보는 기준. 유휴 15분에 시작했으니 이 아래로
// 떨어졌다는 건 키보드/마우스를 다시 만졌다는 뜻이다.
const RETURN_IDLE_SEC = envNum('APIA_TRAINING_RETURN_IDLE_SEC', 60)
// 중단 신호(STOP·종료)를 보낸 뒤 자진 종료를 기다리는 상한. 학습기는 스텝마다
// 신호를 보므로 실제로는 몇 초다 — 이건 멈춰 버린 경우의 천장이다.
const DEADLINE_GRACE_MS = envNum('APIA_TRAINING_GRACE_MS', 30000)
// 렌더 일시정지 기준 — 렌더러(src/main.js)가 presence 'away'에서 rAF를 끊는 값.
const RENDER_AWAY_SEC = 300

const ANCHOR_KEEP = 8          // 주간 앵커 보관 개수
const SHADOW_WINDOW_DAYS = 7
const DAY_MS = 86400000

/**
 * 지금 학습을 시작해도 되는가. 발주서의 다섯 조건을 **그대로** 검사한다.
 * 순수 함수 — 시계도 디스크도 보지 않는다(전부 인자).
 *
 * `force`("지금 시작" 버튼)는 조건을 **면제하지 않는다**. 버튼이 하는 일은
 * 15분 폴링을 기다리지 않고 지금 판정하는 것뿐이다. 면제해 버리면 게임 중에
 * 눌러서 VRAM을 뺏는 길이 생긴다.
 */
function evaluateTrigger({
  pythonOk = false,
  scriptOk = false,
  idleSec = 0,
  vramFreeGb = 0,
  lastSuccessAt = null,
  totalCards = 0,
  cardsAtLastSuccess = 0,
  now = Date.now()
} = {}) {
  if (!pythonOk) return { ok: false, reason: '학습용 파이썬 경로 없음' }
  if (!scriptOk) return { ok: false, reason: '학습 스크립트 없음' }
  if (idleSec < IDLE_SEC) {
    return { ok: false, reason: `유휴 ${Math.floor(idleSec / 60)}분 (${IDLE_SEC / 60}분 필요)` }
  }
  // 렌더 일시정지는 렌더러가 유휴 5분에 스스로 한다. 유휴 조건이 그보다 길어
  // 사실상 함께 충족되지만, 발주서가 따로 세는 조건이라 따로 센다 — 렌더러가
  // 죽어 있거나 창이 없으면 idleSec 자체가 안 올라오므로 여기서 걸린다.
  if (idleSec < RENDER_AWAY_SEC) return { ok: false, reason: '렌더링 일시정지 전' }
  if (!(vramFreeGb >= VRAM_MIN_GB)) {
    return { ok: false, reason: `VRAM 여유 ${vramFreeGb.toFixed(1)}GB (${VRAM_MIN_GB}GB 필요)` }
  }
  if (lastSuccessAt) {
    const days = (now - lastSuccessAt) / DAY_MS
    if (days < INTERVAL_DAYS) {
      return { ok: false, reason: `마지막 학습 ${days.toFixed(1)}일 전 (${INTERVAL_DAYS}일 주기)` }
    }
  }
  const fresh = Math.max(0, totalCards - cardsAtLastSuccess)
  if (fresh < MIN_NEW_CARDS) {
    return { ok: false, reason: `신규 교재 ${fresh}장 (${MIN_NEW_CARDS}장 필요)` }
  }
  return { ok: true, reason: '조건 충족', newCards: fresh }
}

/** 문자 2-gram Jaccard. night_trainer.similarity와 같은 자를 쓴다. */
function similarity(a, b) {
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter += 1
  return inter / (ga.size + gb.size - inter)
}

/** 길이비 — 짧은 쪽/긴 쪽. 1에 가까울수록 비슷한 분량. */
function lengthRatio(a, b) {
  const la = String(a || '').length
  const lb = String(b || '').length
  if (la === 0 || lb === 0) return 0
  return Math.min(la, lb) / Math.max(la, lb)
}

/**
 * 학습 자식이 실제로 끝날 때까지 기다린다. 유예를 넘기면 kill하고 끝낸다.
 *
 * 기다리는 게 핵심이다 — STOP 파일만 쓰고 Electron이 먼저 죽으면 학습이
 * 유령으로 남아 GPU를 계속 문다. 이미 끝난 자식은 즉시 resolve한다(close
 * 이벤트는 다시 오지 않으므로 여기서 걸러야 종료가 유예만큼 멈추지 않는다).
 */
function awaitChildExit(child, graceMs = DEADLINE_GRACE_MS, onKill) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve('already exited')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onKill?.()
      try { child.kill() } catch {}
      resolve('killed')
    }, graceMs)
    child.once('close', () => { clearTimeout(timer); resolve('exited') })
  })
}

function emptyStatus() {
  return {
    schema_version: SCHEMA_VERSION,
    lastRunAt: null,
    lastStatus: null,      // passed | discarded | interrupted | deferred | failed
    lastReason: null,
    lastSuccessAt: null,   // 채택에 성공한 시각 — 7일 주기의 기준
    cardsAtLastSuccess: 0,
    // 채택 델타 포인터. 이 객체를 통째로 바꾸는 쓰기 하나가 "델타 교체"다.
    adopted: null,         // { version, dir, adoptedAt, gate }
    anchors: [],           // 최근 채택 델타 version들(최신이 앞)
    teacherSpentWeek: 0,
    // 그림자 집계 — dayKey -> { attempts, simSum, lenSum }. 원문은 없다.
    shadow: {},
    shadowDormant: null    // 마지막 휴면 사유(관측용)
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dir     courseware/training 루트
 * @param {() => number} [deps.now]
 * @param {object} [deps.fsImpl] 테스트에서 쓰기 실패를 주입하는 seam
 */
function createNightSchoolStore({ dir, now = () => Date.now(), fsImpl = fs, log = {} } = {}) {
  if (!dir) throw new Error('createNightSchoolStore: dir required')

  const anchorsDir = path.join(dir, 'anchors')
  const workDir = path.join(dir, 'work')
  const statusPath = path.join(dir, 'status.json')
  const stopPath = path.join(workDir, 'STOP')
  const resultPath = path.join(workDir, 'result.json')
  const logPath = path.join(dir, 'last-run.log')

  let status = null

  function loadStatus() {
    if (status) return status
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(statusPath, 'utf-8'))
      status = parsed?.schema_version === SCHEMA_VERSION
        ? { ...emptyStatus(), ...parsed }
        : emptyStatus()
    } catch {
      status = emptyStatus()
    }
    return status
  }

  /** tmp→rename 원자적 쓰기. 실패하면 기존 status.json(=이전 채택 델타)이 그대로 남는다. */
  function saveStatus() {
    const s = loadStatus()
    const tmpPath = `${statusPath}.tmp`
    try {
      fsImpl.mkdirSync(dir, { recursive: true })
      fsImpl.writeFileSync(tmpPath, JSON.stringify(s, null, 2), 'utf-8')
      fsImpl.renameSync(tmpPath, statusPath)
      return { ok: true }
    } catch (error) {
      try { fsImpl.unlinkSync(tmpPath) } catch {}
      log.warn?.('[TRAINING_STATUS_WRITE_FAILED]', error?.message || error)
      return { ok: false, error: error?.message || String(error) }
    }
  }

  /** 델타 디렉터리가 실제로 쓸 수 있는 어댑터인가. 빈 폴더를 채택하는 걸 막는다. */
  function isUsableDelta(target) {
    try {
      if (!fsImpl.existsSync(path.join(target, 'adapter_config.json'))) return false
      return fsImpl.readdirSync(target).some((name) => /^adapter_model\./.test(name))
    } catch {
      return false
    }
  }

  /** 지금 채택된 델타(없으면 null). 디렉터리가 사라졌으면 없는 것으로 본다. */
  function adoptedDelta() {
    const s = loadStatus()
    if (!s.adopted?.dir) return null
    return isUsableDelta(s.adopted.dir) ? s.adopted : null
  }

  /**
   * 앵커 정리. 보관 목록(최근 8개)에도 채택 포인터에도 없는 디렉터리를 지운다 —
   * 초과분뿐 아니라 **앵커 이동 도중 크래시로 남은 고아**도 같은 규칙에 걸린다
   * (포인터가 가리키지 않는 델타는 존재 이유가 없다). 시작 시 한 번 부른다.
   */
  function pruneAnchors() {
    const s = loadStatus()
    const keep = new Set(s.anchors.slice(0, ANCHOR_KEEP))
    if (s.adopted?.version) keep.add(s.adopted.version)
    let removed = 0
    let names = []
    try { names = fsImpl.readdirSync(anchorsDir) } catch { return 0 }
    for (const name of names) {
      if (keep.has(name)) continue
      try {
        fsImpl.rmSync(path.join(anchorsDir, name), { recursive: true, force: true })
        removed += 1
      } catch (error) {
        log.warn?.('[TRAINING_ANCHOR_PRUNE_FAILED]', name, error?.message || error)
      }
    }
    if (s.anchors.length > ANCHOR_KEEP) {
      s.anchors = s.anchors.slice(0, ANCHOR_KEEP)
      saveStatus()
    }
    return removed
  }

  /**
   * 후보 델타를 채택한다. 순서가 계약이다.
   *   (1) 쓸 수 있는 어댑터인지 확인 — 아니면 아무것도 건드리지 않는다.
   *   (2) anchors/<version>으로 이동(같은 볼륨 rename).
   *   (3) 포인터를 담은 status.json을 tmp→rename으로 통째 교체.
   * (3)이 실패하면 메모리 포인터를 되돌린다 — 디스크의 이전 채택 델타가 그대로
   * 살아 있으므로 다음 실행도 이전 델타로 계속 답한다.
   */
  function adopt(version, sourceDir, gate = null, totalCards = 0) {
    if (!isUsableDelta(sourceDir)) {
      return { ok: false, error: 'candidate is not a usable adapter' }
    }
    const target = path.join(anchorsDir, version)
    try {
      fsImpl.mkdirSync(anchorsDir, { recursive: true })
      fsImpl.rmSync(target, { recursive: true, force: true })
      fsImpl.renameSync(sourceDir, target)
    } catch (error) {
      return { ok: false, error: `anchor move failed: ${error?.message || error}` }
    }

    const s = loadStatus()
    const previous = { adopted: s.adopted, anchors: s.anchors, lastSuccessAt: s.lastSuccessAt, cardsAtLastSuccess: s.cardsAtLastSuccess }
    s.adopted = { version, dir: target, adoptedAt: now(), gate }
    s.anchors = [version, ...s.anchors.filter((v) => v !== version)]
    s.lastSuccessAt = now()
    s.cardsAtLastSuccess = totalCards
    const saved = saveStatus()
    if (!saved.ok) {
      Object.assign(s, previous) // 이전 채택 델타 유지 — 실패한 교체는 없던 일로
      return { ok: false, error: saved.error }
    }
    pruneAnchors()
    return { ok: true, version, dir: target }
  }

  /** 한 번의 학습 시도 결과를 적는다(채택 여부와 무관). 아침 리포트의 원천. */
  function noteRun(result = {}) {
    const s = loadStatus()
    s.lastRunAt = now()
    s.lastStatus = result.status || 'failed'
    s.lastReason = String(result.reason || '').slice(0, 300)
    if (Number.isFinite(result.teacher_spent_week)) s.teacherSpentWeek = result.teacher_spent_week
    saveStatus()
    return { ...s }
  }

  /** 게이트 탈락·중단으로 버려진 후보 정리. 채택 경로를 지나지 않은 델타는 남기지 않는다. */
  function discardCandidate(candidateDir) {
    if (!candidateDir) return
    try { fsImpl.rmSync(candidateDir, { recursive: true, force: true }) } catch {}
  }

  /**
   * 그림자 1건. **점수만** 받는다 — 사용자 발화도 두 응답 원문도 인자에 없다.
   */
  function noteShadow({ similarity: sim, lengthRatio: len } = {}) {
    if (!Number.isFinite(sim)) return
    const s = loadStatus()
    const day = dayKeyOf(now())
    const bucket = s.shadow[day] || { attempts: 0, simSum: 0, lenSum: 0 }
    bucket.attempts += 1
    bucket.simSum += sim
    bucket.lenSum += Number.isFinite(len) ? len : 0
    s.shadow[day] = bucket
    const keep = new Set(
      Array.from({ length: SHADOW_WINDOW_DAYS }, (_, i) => dayKeyOf(now() - i * DAY_MS))
    )
    for (const key of Object.keys(s.shadow)) if (!keep.has(key)) delete s.shadow[key]
    s.shadowDormant = null
    saveStatus()
  }

  /** 그림자가 쉰 이유(관측용). 카운트는 올리지 않는다 — 시도가 아니었으니까. */
  function noteShadowDormant(reason) {
    const s = loadStatus()
    const next = String(reason || '').slice(0, 120)
    if (s.shadowDormant === next) return // 매 교환 같은 사유로 디스크를 때리지 않는다
    s.shadowDormant = next
    saveStatus()
  }

  function shadowSummary() {
    const s = loadStatus()
    let attempts = 0
    let simSum = 0
    let lenSum = 0
    for (const bucket of Object.values(s.shadow)) {
      attempts += bucket.attempts || 0
      simSum += bucket.simSum || 0
      lenSum += bucket.lenSum || 0
    }
    return {
      attempts7d: attempts,
      avgSimilarity: attempts ? simSum / attempts : null,
      avgLengthRatio: attempts ? lenSum / attempts : null,
      dormantReason: s.shadowDormant
    }
  }

  /** 설정 창 표시용 스냅샷. */
  function getState() {
    const s = loadStatus()
    const adopted = adoptedDelta()
    return {
      schema_version: s.schema_version,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      lastReason: s.lastReason,
      lastSuccessAt: s.lastSuccessAt,
      cardsAtLastSuccess: s.cardsAtLastSuccess,
      adoptedVersion: adopted?.version || null,
      adoptedAt: adopted?.adoptedAt || null,
      gate: adopted?.gate || null,
      anchorCount: s.anchors.length,
      teacherSpentWeek: s.teacherSpentWeek || 0,
      shadow: shadowSummary(),
      path: dir
    }
  }

  return {
    loadStatus,
    saveStatus,
    getState,
    adoptedDelta,
    isUsableDelta,
    adopt,
    pruneAnchors,
    noteRun,
    discardCandidate,
    noteShadow,
    noteShadowDormant,
    shadowSummary,
    paths: { dir, anchorsDir, workDir, statusPath, stopPath, resultPath, logPath }
  }
}

/**
 * 학습 잡 — 조건을 재고, 통과하면 학습 프로세스를 한 번 돌리고, 결과를 반영한다.
 *
 * @param {object} deps
 * @param {() => Promise<object>} deps.probe  { idleSec, vramFreeGb, totalCards, pythonOk, scriptOk }
 * @param {(opts) => Promise<object>} deps.runTrainer  프로세스 스폰 — 결과 JSON을 돌려준다
 */
function createNightSchoolJob({ store, probe, runTrainer, now = () => Date.now(), log = {} } = {}) {
  if (!store || typeof probe !== 'function' || typeof runTrainer !== 'function') {
    throw new Error('createNightSchoolJob: store, probe, runTrainer required')
  }
  let running = false

  async function runOnce({ force = false } = {}) {
    if (running) return { skipped: 'running' }
    const signals = await probe()
    const s = store.loadStatus()
    const verdict = evaluateTrigger({
      ...signals,
      lastSuccessAt: s.lastSuccessAt,
      cardsAtLastSuccess: s.cardsAtLastSuccess,
      now: now()
    })
    if (!verdict.ok) {
      // 버튼으로 부른 경우에만 사유를 남긴다 — 15분 폴링이 매번 같은 줄을
      // 덮어쓰면 "지난밤에 실제로 무슨 일이 있었는지"가 지워진다.
      if (force) store.noteRun({ status: 'deferred', reason: verdict.reason })
      return { skipped: 'trigger', reason: verdict.reason }
    }

    running = true
    try {
      const version = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 16)
      const result = await runTrainer({
        version,
        adoptedDelta: store.adoptedDelta()?.dir || '',
        since: s.lastSuccessAt ? dayKeyOf(s.lastSuccessAt) : ''
      })
      store.noteRun(result)

      if (result?.status === 'passed' && result.candidate) {
        const adopted = store.adopt(version, result.candidate, result.gate, signals.totalCards)
        if (!adopted.ok) {
          log.warn?.('[TRAINING_ADOPT_FAILED]', adopted.error)
          store.discardCandidate(result.candidate)
          return { status: 'failed', reason: `adopt failed: ${adopted.error}` }
        }
        return { status: 'adopted', version, gate: result.gate }
      }
      // 통과하지 못한 델타는 남기지 않는다. 이전 채택 델타는 손대지 않았다.
      store.discardCandidate(result?.candidate || result?.train?.candidate)
      return { status: result?.status || 'failed', reason: result?.reason }
    } finally {
      running = false
    }
  }

  return { runOnce, isRunning: () => running }
}

module.exports = {
  SCHEMA_VERSION,
  IDLE_SEC,
  VRAM_MIN_GB,
  INTERVAL_DAYS,
  MIN_NEW_CARDS,
  DEADLINE_SEC,
  RETURN_IDLE_SEC,
  RENDER_AWAY_SEC,
  DEADLINE_GRACE_MS,
  ANCHOR_KEEP,
  awaitChildExit,
  evaluateTrigger,
  similarity,
  lengthRatio,
  createNightSchoolStore,
  createNightSchoolJob
}
