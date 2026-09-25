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
const {
  TYPES,
  DEMOTION_WINDOW: DEMOTION_WINDOW_SIZE,
  recommendPromotion,
  demotionVerdict
} = require('./promotion')

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
// 보존은 표시 창의 두 배다 — 승격 추천의 "최근 추세"가 최근 7일과 그 이전
// 7일을 비교하기 때문(A-4 §2). 보존을 7일로 두면 비교 대상이 영원히 없다.
const SHADOW_RETAIN_DAYS = SHADOW_WINDOW_DAYS * 2
const SERVING_WINDOW_DAYS = 7  // 관제판 "최근 7일 로컬/API 비율"
const DEMOTION_HISTORY_KEEP = 10
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
    // 그림자 집계 — dayKey -> { attempts, simSum, lenSum, types: { <type>: {...} } }.
    // 원문은 없다. types는 A-4에서 붙었다 — 없는(=A-3 시절) 버킷은 유형 미상으로
    // 남고 총계에만 들어간다(마이그레이션 없음, 스키마 버전도 그대로).
    shadow: {},
    shadowDormant: null,   // 마지막 휴면 사유(관측용)
    // ── A-4 승격 ──
    promotion: {},         // type -> { enabled, at }  (수동 토글만이 여기를 켠다)
    demotions: [],         // { type, at, reason } 최신이 앞. 자동 강등 이력.
    serving: {},           // dayKey -> { local, api, reasons: { <사유>: n } }
    servingRecent: {}      // type -> [0|1, ...] 최근 20회 품질 판정(1 = 미달)
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
   * type은 A-4의 유형 태그(분류는 호출자가 순수 함수로 끝내고 결과만 넘긴다).
   */
  function noteShadow({ similarity: sim, lengthRatio: len, type } = {}) {
    if (!Number.isFinite(sim)) return
    const s = loadStatus()
    const day = dayKeyOf(now())
    const bucket = s.shadow[day] || { attempts: 0, simSum: 0, lenSum: 0 }
    bucket.attempts += 1
    bucket.simSum += sim
    bucket.lenSum += Number.isFinite(len) ? len : 0
    if (TYPES.includes(type)) {
      const types = bucket.types || (bucket.types = {})
      const t = types[type] || { attempts: 0, simSum: 0, lenSum: 0 }
      t.attempts += 1
      t.simSum += sim
      t.lenSum += Number.isFinite(len) ? len : 0
      types[type] = t
    }
    s.shadow[day] = bucket
    const keep = new Set(
      Array.from({ length: SHADOW_RETAIN_DAYS }, (_, i) => dayKeyOf(now() - i * DAY_MS))
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

  /** 최근 n일의 dayKey 집합(오늘 포함). offset일 전부터 센다. */
  function dayWindow(count, offset = 0) {
    return new Set(
      Array.from({ length: count }, (_, i) => dayKeyOf(now() - (i + offset) * DAY_MS))
    )
  }

  function shadowSummary() {
    const s = loadStatus()
    const week = dayWindow(SHADOW_WINDOW_DAYS)
    let attempts = 0
    let simSum = 0
    let lenSum = 0
    for (const [day, bucket] of Object.entries(s.shadow)) {
      if (!week.has(day)) continue // 보존은 14일, 표시는 7일
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

  /**
   * 유형별 그림자 집계 + 승격 추천(표시용). 추천이 true여도 **아무것도 승격되지
   * 않는다** — 관제판 토글의 잠금을 푸는 것뿐이다.
   */
  function shadowByType() {
    const s = loadStatus()
    const recentDays = dayWindow(SHADOW_WINDOW_DAYS)
    const priorDays = dayWindow(SHADOW_WINDOW_DAYS, SHADOW_WINDOW_DAYS)
    const acc = {}
    for (const type of TYPES) {
      acc[type] = { attempts: 0, simSum: 0, recent: { n: 0, sum: 0 }, prior: { n: 0, sum: 0 } }
    }
    for (const [day, bucket] of Object.entries(s.shadow)) {
      for (const [type, t] of Object.entries(bucket.types || {})) {
        const a = acc[type]
        if (!a) continue
        // 시도 수·평균은 보존 창(14일) 전체. 추세만 7일씩 갈라 본다.
        a.attempts += t.attempts || 0
        a.simSum += t.simSum || 0
        if (recentDays.has(day)) { a.recent.n += t.attempts || 0; a.recent.sum += t.simSum || 0 }
        else if (priorDays.has(day)) { a.prior.n += t.attempts || 0; a.prior.sum += t.simSum || 0 }
      }
    }
    const out = {}
    for (const type of TYPES) {
      const a = acc[type]
      const stats = {
        attempts: a.attempts,
        avgSimilarity: a.attempts ? a.simSum / a.attempts : null,
        recentAvg: a.recent.n ? a.recent.sum / a.recent.n : null,
        priorAvg: a.prior.n ? a.prior.sum / a.prior.n : null
      }
      out[type] = { ...stats, ...recommendPromotion(stats) }
    }
    return out
  }

  // ── A-4 승격 ──────────────────────────────────────────────────────────────

  /** 하나라도 승격돼 있는가. 대화 경로의 첫 관문이라 디스크를 보지 않는다(캐시된 status). */
  function hasPromotion() {
    const p = loadStatus().promotion || {}
    return TYPES.some((t) => p[t]?.enabled === true)
  }

  function isPromoted(type) {
    return loadStatus().promotion?.[type]?.enabled === true
  }

  /**
   * 승격 토글. **사용자 승인 경로 전용** — 코드가 스스로 true로 부르는 자리는
   * 어디에도 없다(강등은 noteServing이 false로만 부른다).
   */
  function setPromotion(type, enabled) {
    if (!TYPES.includes(type)) return { ok: false, error: `unknown type: ${type}` }
    const s = loadStatus()
    s.promotion = { ...s.promotion, [type]: { enabled: Boolean(enabled), at: now() } }
    if (enabled) s.servingRecent = { ...s.servingRecent, [type]: [] } // 창을 비우고 새로 센다
    const saved = saveStatus()
    return saved.ok ? { ok: true, type, enabled: Boolean(enabled) } : { ok: false, error: saved.error }
  }

  /**
   * 서빙 1건. 로컬이 답했으면 source='local', 폴백이면 'api'+사유.
   * quality=true(품질 필터 미달)일 때만 강등 창에 1을 밀어 넣는다 — 미상주·
   * 타임아웃은 환경 탓이라 모델을 벌하지 않는다.
   *
   * @returns {{demoted?: {type, reason}}}
   */
  function noteServing({ type, source, reason, quality = false } = {}) {
    const s = loadStatus()
    const day = dayKeyOf(now())
    const bucket = s.serving[day] || { local: 0, api: 0, reasons: {} }
    if (source === 'local') bucket.local += 1
    else bucket.api += 1
    if (reason) bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1
    s.serving[day] = bucket
    const keep = dayWindow(SERVING_WINDOW_DAYS)
    for (const key of Object.keys(s.serving)) if (!keep.has(key)) delete s.serving[key]

    let demoted = null
    if (TYPES.includes(type) && (source === 'local' || quality)) {
      const window = (s.servingRecent[type] || []).concat(quality ? 1 : 0).slice(-DEMOTION_WINDOW_SIZE)
      s.servingRecent[type] = window
      const verdict = demotionVerdict(window)
      if (verdict.demote && isPromoted(type)) {
        s.promotion = { ...s.promotion, [type]: { enabled: false, at: now() } }
        s.servingRecent[type] = []
        s.demotions = [{ type, at: now(), reason: verdict.reason }, ...s.demotions].slice(0, DEMOTION_HISTORY_KEEP)
        demoted = { type, reason: verdict.reason }
      }
    }
    saveStatus()
    return demoted ? { demoted } : {}
  }

  /** 관제판 표시용 — 승격 상태·강등 이력·최근 7일 서빙 비율. */
  function servingSummary() {
    const s = loadStatus()
    const week = dayWindow(SERVING_WINDOW_DAYS)
    let local = 0
    let api = 0
    const reasons = {}
    for (const [day, bucket] of Object.entries(s.serving)) {
      if (!week.has(day)) continue
      local += bucket.local || 0
      api += bucket.api || 0
      for (const [r, n] of Object.entries(bucket.reasons || {})) reasons[r] = (reasons[r] || 0) + n
    }
    return {
      local,
      api,
      total: local + api,
      topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([reason, count]) => ({ reason, count }))
    }
  }

  /**
   * 되감기 — 보관 중인 앵커로 채택 델타를 되돌린다. 쓰기는 adopt와 같은
   * status.json tmp→rename 하나라 중간 상태가 없고, 앵커 디렉터리는 건드리지
   * 않는다(되감은 뒤 다시 앞으로 감을 수 있어야 한다).
   */
  function rewind(version) {
    const s = loadStatus()
    if (!s.anchors.includes(version)) return { ok: false, error: '보관 목록에 없는 앵커' }
    const target = path.join(anchorsDir, version)
    if (!isUsableDelta(target)) return { ok: false, error: '앵커 델타가 손상됐거나 사라졌어요' }
    const previous = s.adopted
    s.adopted = { version, dir: target, adoptedAt: now(), gate: previous?.gate || null, rewound: true }
    const saved = saveStatus()
    if (!saved.ok) {
      s.adopted = previous
      return { ok: false, error: saved.error }
    }
    return { ok: true, version }
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
      anchors: s.anchors.slice(),
      teacherSpentWeek: s.teacherSpentWeek || 0,
      shadow: shadowSummary(),
      // A-4 관제판 — 유형별 그림자·승격 상태·강등 이력·서빙 비율.
      byType: shadowByType(),
      promotion: Object.fromEntries(TYPES.map((t) => [t, isPromoted(t)])),
      demotions: (s.demotions || []).slice(),
      serving: servingSummary(),
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
    rewind,
    pruneAnchors,
    noteRun,
    discardCandidate,
    noteShadow,
    noteShadowDormant,
    shadowSummary,
    shadowByType,
    hasPromotion,
    isPromoted,
    setPromotion,
    noteServing,
    servingSummary,
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
  SHADOW_WINDOW_DAYS,
  SHADOW_RETAIN_DAYS,
  awaitChildExit,
  evaluateTrigger,
  similarity,
  lengthRatio,
  createNightSchoolStore,
  createNightSchoolJob
}
