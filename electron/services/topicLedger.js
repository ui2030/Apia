/**
 * 눈치 원장 계측기 — 화제별 신호 수집 · 저장 · 집계.
 *
 * **계측 전용**이다. 이 모듈이 내는 어떤 값도 캐릭터의 발화·화제 선택·알림에
 * 연결돼 있지 않다(연결은 2단계 몫). 여기서 하는 일은 수집/집계/열람뿐.
 *
 * 프라이버시 원칙: 원장에는 **대화 원문을 절대 저장하지 않는다**. 분류기가 돌려준
 * topic_id와 수치만 남는다. 분류에 쓰인 원문은 로컬 백엔드로만 나가고 버려진다.
 *
 * 파일 하나(JSON) + tmp→rename 원자적 쓰기. 스키마는 `schema_version`으로 고정.
 */
const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1

// ── 고정 화제 분류(26) ──────────────────────────────────────────────────────
// 분류기 프롬프트와 열람 UI가 같은 출처를 쓴다. 목록을 바꾸면 이미 쌓인 원시
// 신호의 topic_id가 고아가 되므로(집계에서 무시된다) 함부로 손대지 않는다.
const TOPICS = Object.freeze([
  { id: 'daily_life', label: '일상' },
  { id: 'small_talk', label: '가벼운 잡담' },
  { id: 'joke', label: '농담·장난' },
  { id: 'work', label: '업무·일' },
  { id: 'study', label: '공부·학습' },
  { id: 'career', label: '진로·이직' },
  { id: 'money', label: '돈·재정' },
  { id: 'game', label: '게임' },
  { id: 'hobby', label: '취미' },
  { id: 'music', label: '음악' },
  { id: 'movie_tv', label: '영화·드라마' },
  { id: 'book', label: '책' },
  { id: 'tech', label: '기술·컴퓨터' },
  { id: 'news_society', label: '뉴스·사회' },
  { id: 'travel', label: '여행' },
  { id: 'food', label: '음식' },
  { id: 'health', label: '건강' },
  { id: 'mental', label: '마음·스트레스' },
  { id: 'sleep', label: '수면' },
  { id: 'exercise', label: '운동' },
  { id: 'appearance', label: '외모' },
  { id: 'family', label: '가족' },
  { id: 'romance', label: '연애' },
  { id: 'friends', label: '친구·인간관계' },
  { id: 'pet', label: '반려동물' },
  { id: 'future_plan', label: '계획·미래' }
])
const TOPIC_IDS = Object.freeze(TOPICS.map((t) => t.id))

// ── 집계 상수 (발주서 §3 확정값) ────────────────────────────────────────────
// 사후 튜닝으로 지표 **정의**를 바꾸지 않는다. 값만 이 표에서 움직인다.
const EMA_ALPHA = 0.15
const BURN_IN = 7            // 증거 이만큼 전엔 '판단 보류'
const TH_LO = 0.30           // 이하로 내려오면 해빙
const TH_HI = 0.60           // 이상 올라가면 동결
const DEMOTE_STEP = 0.3      // 기록용 상수 — MVP에선 행동에 쓰지 않는다
const PROMOTE_STEP = -0.05   // 기록용 상수 — MVP에선 행동에 쓰지 않는다
const MIN_CONFIDENCE = 0.6   // 분류 confidence 미만이면 신호 폐기
const RAW_RETENTION_DAYS = 90
const MIN_DAILY_UTTERANCES = 3 // 당일 발화 이보다 적으면 reply_len_ratio 무효
const AWAY_THRESHOLD_MS = 300000 // presenceManager의 '부재' 기준과 같은 5분

// 수동(골드) 라벨 — 사용자가 직접 찍는 정답. 자동 점수와 **별도 필드**에 보존한다.
const GOLD_LABELS = Object.freeze(['sensitive', 'neutral', 'joke_ok'])

// ── 순수 신호 산출 ──────────────────────────────────────────────────────────

const ENGAGEMENT_RE = /[ㅋㅎ]|\p{Extended_Pictographic}|[!！]|~|(와|우와|오오|헐|대박|역시|진짜)/gu

/** 호응 표지 밀도 — 100자당 개수. 빈 문자열이면 0. */
function engagementDensity(text) {
  const s = String(text == null ? '' : text)
  const len = s.length
  if (len === 0) return 0
  const hits = s.match(ENGAGEMENT_RE)
  return ((hits ? hits.length : 0) * 100) / len
}

function median(nums) {
  const sorted = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function clamp01(v) { return Math.min(1, Math.max(0, v)) }

/**
 * 교환 1건의 **회피도**(0=편하게 반응, 1=피하는 기색). 유효한 성분만 평균한다.
 * 성분이 하나도 없으면 null(집계에서 제외).
 *
 * 성분 정의는 발주서 §2의 필드에서 기계적으로 나온다:
 *  - 응답 지연: 3초 이내 0, 30초 이상 1 (선형)
 *  - 발화 길이비: 중앙값 이상이면 0, 0이면 1 (1 - ratio)
 *  - 화제 전환: 전환했으면 1
 *  - 호응 밀도: 100자당 3개 이상이면 0, 0개면 1
 */
function aversionScore(signal) {
  const parts = []
  if (Number.isFinite(signal.reply_latency_ms)) {
    parts.push(clamp01((signal.reply_latency_ms - 3000) / 27000))
  }
  if (Number.isFinite(signal.reply_len_ratio)) {
    parts.push(clamp01(1 - signal.reply_len_ratio))
  }
  if (typeof signal.topic_shifted === 'boolean') {
    parts.push(signal.topic_shifted ? 1 : 0)
  }
  if (Number.isFinite(signal.engagement)) {
    parts.push(clamp01(1 - signal.engagement / 3))
  }
  if (parts.length === 0) return null
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

/** EMA 한 걸음. 첫 관측은 그대로 시드로 앉힌다(0.5 사전값이 초반을 끌지 않게). */
function emaStep(prev, x) {
  return prev == null ? x : prev + EMA_ALPHA * (x - prev)
}

/**
 * 분류기 raw 문자열 → {topic_id, confidence} 또는 null.
 * LLM이 앞뒤로 말을 붙여도 첫 JSON 오브젝트만 뽑는다. 목록에 없는 id는 버린다.
 */
function parseClassification(raw, topicIds = TOPIC_IDS) {
  if (typeof raw !== 'string') return null
  const match = raw.match(/\{[\s\S]*?\}/)
  if (!match) return null
  let obj
  try { obj = JSON.parse(match[0]) } catch { return null }
  const id = typeof obj?.topic_id === 'string' ? obj.topic_id.trim() : ''
  if (!topicIds.includes(id)) return null
  const conf = Number(obj?.confidence)
  if (!Number.isFinite(conf)) return null
  return { topic_id: id, confidence: clamp01(conf) }
}

function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── 원장 저장소 ─────────────────────────────────────────────────────────────

function emptyDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    raw: {},          // dayKey -> [signal]
    topics: {},       // topic_id -> { score, evidence, state, goldLabel, updatedAt }
    events: { demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 },
    lastAggregatedAt: null
  }
}

function normalizeDoc(parsed) {
  const doc = emptyDoc()
  if (!parsed || typeof parsed !== 'object') return doc
  if (parsed.schema_version !== SCHEMA_VERSION) return doc // 구버전은 버리고 새로 센다
  if (parsed.raw && typeof parsed.raw === 'object') {
    for (const [day, list] of Object.entries(parsed.raw)) {
      if (Array.isArray(list)) doc.raw[day] = list.filter((s) => s && typeof s === 'object')
    }
  }
  if (parsed.topics && typeof parsed.topics === 'object') {
    for (const [id, t] of Object.entries(parsed.topics)) {
      if (!TOPIC_IDS.includes(id) || !t || typeof t !== 'object') continue
      doc.topics[id] = {
        score: Number.isFinite(t.score) ? t.score : null,
        evidence: Number.isFinite(t.evidence) ? t.evidence : 0,
        state: ['frozen', 'thawed', 'neutral'].includes(t.state) ? t.state : 'pending',
        goldLabel: GOLD_LABELS.includes(t.goldLabel) ? t.goldLabel : null,
        updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : null
      }
    }
  }
  if (parsed.events && typeof parsed.events === 'object') {
    for (const k of Object.keys(doc.events)) {
      if (Number.isFinite(parsed.events[k])) doc.events[k] = parsed.events[k]
    }
  }
  if (Number.isFinite(parsed.lastAggregatedAt)) doc.lastAggregatedAt = parsed.lastAggregatedAt
  return doc
}

/**
 * @param {object} deps
 * @param {string} deps.ledgerPath  JSON 파일 경로 (Apia userData 안)
 * @param {() => number} [deps.now]
 * @param {object} [deps.fsImpl]    테스트에서 쓰기 실패를 주입하기 위한 seam
 */
function createTopicLedger({ ledgerPath, now = () => Date.now(), fsImpl = fs, log = {} } = {}) {
  if (!ledgerPath) throw new Error('createTopicLedger: ledgerPath required')

  let doc = null

  function load() {
    if (doc) return doc
    try {
      doc = normalizeDoc(JSON.parse(fsImpl.readFileSync(ledgerPath, 'utf-8')))
    } catch {
      doc = emptyDoc() // 없거나 깨졌으면 새로 시작 — 계측 데이터라 복구할 것이 없다
    }
    return doc
  }

  /** tmp→rename 원자적 쓰기. 실패하면 **기존 파일을 그대로 두고** ok:false. */
  function flush() {
    const d = load()
    const tmpPath = `${ledgerPath}.tmp`
    try {
      fsImpl.mkdirSync(path.dirname(ledgerPath), { recursive: true })
      fsImpl.writeFileSync(tmpPath, JSON.stringify(d, null, 2), 'utf-8')
      fsImpl.renameSync(tmpPath, ledgerPath)
      return { ok: true }
    } catch (error) {
      // 중단된 쓰기의 잔해를 남기지 않는다 — 다음 로드가 tmp를 볼 일은 없지만,
      // 반쯤 쓰인 파일이 디스크에 굴러다니는 것 자체가 사고의 씨앗이다.
      try { fsImpl.unlinkSync(tmpPath) } catch {}
      log.warn?.('[LEDGER_WRITE_FAILED]', error?.message || error)
      return { ok: false, error: error?.message || String(error) }
    }
  }

  /** 원시 신호 1건 기록. conf 미달/미분류는 호출자가 이미 걸렀다고 본다. */
  function recordSignal(signal) {
    const d = load()
    const t = Number.isFinite(signal?.t) ? signal.t : now()
    if (!TOPIC_IDS.includes(signal?.topic_id)) return { ok: false, error: 'unknown topic' }
    if (!(Number(signal.conf) >= MIN_CONFIDENCE)) return { ok: false, error: 'low confidence' }
    const day = dayKeyOf(t)
    if (!d.raw[day]) d.raw[day] = []
    d.raw[day].push({
      t,
      topic_id: signal.topic_id,
      conf: Number(signal.conf),
      reply_latency_ms: Number.isFinite(signal.reply_latency_ms) ? signal.reply_latency_ms : null,
      reply_len_ratio: Number.isFinite(signal.reply_len_ratio) ? signal.reply_len_ratio : null,
      topic_shifted: typeof signal.topic_shifted === 'boolean' ? signal.topic_shifted : null,
      engagement: Number.isFinite(signal.engagement) ? signal.engagement : 0
    })
    prune()
    return flush()
  }

  /** 90일 지난 일자 통째 폐기. */
  function prune() {
    const d = load()
    const cutoff = now() - RAW_RETENTION_DAYS * 86400000
    for (const day of Object.keys(d.raw)) {
      const list = d.raw[day].filter((s) => Number.isFinite(s.t) && s.t >= cutoff)
      if (list.length === 0) delete d.raw[day]
      else d.raw[day] = list
    }
  }

  /**
   * 일일 집계 — 보존 중인 원시 신호 전체를 시간순으로 다시 훑어 화제별 EMA와
   * 4지표를 재계산한다. 증분이 아니라 **재계산**이라 언제 몇 번 돌려도 같은
   * 결과가 나온다(골든 파일 테스트와 수동 '지금 집계' 버튼이 같은 값을 본다).
   */
  function aggregate() {
    const d = load()
    prune()

    const gold = {}
    for (const [id, t] of Object.entries(d.topics)) gold[id] = t.goldLabel || null

    const all = []
    for (const list of Object.values(d.raw)) all.push(...list)
    all.sort((a, b) => a.t - b.t)

    const topics = {}
    const events = { demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 }

    for (const sig of all) {
      if (!TOPIC_IDS.includes(sig.topic_id)) continue
      const av = aversionScore(sig)
      if (av == null) continue
      const cur = topics[sig.topic_id] || (topics[sig.topic_id] = {
        score: null, evidence: 0, state: 'pending', goldLabel: gold[sig.topic_id] || null, updatedAt: null
      })
      cur.score = emaStep(cur.score, av)
      cur.evidence += 1
      cur.updatedAt = sig.t
      if (cur.evidence < BURN_IN) continue // 판단 보류 — 전이도 세지 않는다
      // burn-in을 넘긴 순간의 출발점은 'neutral'이다. TH_LO~TH_HI 사이는
      // 히스테리시스 구간이라 직전 상태를 유지한다.
      const before = cur.state === 'pending' ? 'neutral' : cur.state
      let next = before
      if (cur.score >= TH_HI) next = 'frozen'
      else if (cur.score <= TH_LO) next = 'thawed'
      cur.state = next
      if (next !== before) {
        if (next === 'frozen') events.demote += 1
        else if (next === 'thawed') events.promote += 1
      }
    }

    // 수동 라벨만 있고 신호가 아직 없는 화제도 목록에 남긴다(라벨 보존).
    for (const [id, label] of Object.entries(gold)) {
      if (!label) continue
      if (!topics[id]) topics[id] = { score: null, evidence: 0, state: 'pending', goldLabel: label, updatedAt: null }
    }

    for (const [id, t] of Object.entries(topics)) {
      const label = gold[id] || null
      t.goldLabel = label
      if (!label || t.state === 'pending') continue
      if (t.state === 'frozen' && (label === 'neutral' || label === 'joke_ok')) events.falseFreeze += 1
      if (t.state === 'thawed' && label === 'sensitive') events.falseThaw += 1
    }

    d.topics = topics
    d.events = events
    d.lastAggregatedAt = now()
    return flush()
  }

  function setGoldLabel(topicId, label) {
    const d = load()
    if (!TOPIC_IDS.includes(topicId)) return { ok: false, error: 'unknown topic' }
    const normalized = GOLD_LABELS.includes(label) ? label : null
    if (!d.topics[topicId]) {
      d.topics[topicId] = { score: null, evidence: 0, state: 'pending', goldLabel: null, updatedAt: null }
    }
    d.topics[topicId].goldLabel = normalized
    return flush()
  }

  /** 항목 삭제 — 그 화제의 원시 신호와 집계 결과를 함께 지운다. */
  function removeTopic(topicId) {
    const d = load()
    delete d.topics[topicId]
    for (const day of Object.keys(d.raw)) {
      d.raw[day] = d.raw[day].filter((s) => s.topic_id !== topicId)
      if (d.raw[day].length === 0) delete d.raw[day]
    }
    return flush()
  }

  function reset() {
    doc = emptyDoc()
    return flush()
  }

  /** 열람 UI용 스냅샷. */
  function getState() {
    const d = load()
    let rawCount = 0
    for (const list of Object.values(d.raw)) rawCount += list.length
    const rows = TOPICS
      .map((t) => {
        const cur = d.topics[t.id]
        if (!cur) return null
        return {
          id: t.id,
          label: t.label,
          score: cur.score,
          evidence: cur.evidence,
          state: cur.evidence < BURN_IN ? 'pending' : cur.state,
          goldLabel: cur.goldLabel
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    return {
      schema_version: d.schema_version,
      topics: rows,
      events: { ...d.events },
      rawCount,
      rawDays: Object.keys(d.raw).length,
      lastAggregatedAt: d.lastAggregatedAt,
      params: { EMA_ALPHA, BURN_IN, TH_LO, TH_HI, DEMOTE_STEP, PROMOTE_STEP, RAW_RETENTION_DAYS },
      path: ledgerPath
    }
  }

  return { load, flush, recordSignal, aggregate, setGoldLabel, removeTopic, reset, getState }
}

// ── 교환 추적기 ─────────────────────────────────────────────────────────────

/**
 * 채팅 교환(사용자 발화 ↔ 응답)에서 신호를 뽑아낸다.
 *
 * 한 교환의 신호는 **다음 교환의 응답이 끝나야** 확정된다(응답 지연도 화제
 * 전환도 다음 발화가 있어야 정의되고, 그 발화의 화제 분류는 응답 뒤에 시작한다
 * — A-4 승격 서빙과 로컬 경로를 다투지 않으려고). 다음 발화 없이 대화가 끝나면
 * 그 교환은 통째로 버린다 — 종료는 회피가 아니다(발주서 §2).
 *
 * 순수 상태기계: 시계(now)와 분류기(classify)를 주입받고 I/O를 하지 않는다.
 */
function createExchangeTracker({
  now = () => Date.now(),
  classify,                     // (text) => Promise<{topic_id, confidence}|null>
  onSignal,                     // (signal) => void
  awayThresholdMs = AWAY_THRESHOLD_MS
} = {}) {
  let pending = null
  // 확정을 기다리는 직전 교환. 확정에는 **다음 교환의 화제**가 필요한데, 분류는
  // 그 교환의 응답이 끝난 뒤에야 시작하므로(아래 noteReplyDone 주석) 확정 시점도
  // 발화 도착이 아니라 다음 응답 완료로 미뤄진다.
  let awaiting = null
  let dayKey = null
  let dayLengths = []

  function noteUserMessage(text) {
    const t = now()
    const key = dayKeyOf(t)
    if (key !== dayKey) { dayKey = key; dayLengths = [] }

    const len = String(text == null ? '' : text).length
    dayLengths.push(len)
    const med = median(dayLengths)

    const current = {
      at: t,
      replyAt: null,
      inputStartAt: null,
      absent: false,
      engagement: engagementDensity(text),
      // 당일 발화 3건 미만이면 중앙값이 통계가 아니다 → 무효
      lenRatio: dayLengths.length >= MIN_DAILY_UTTERANCES && med > 0 ? len / med : null,
      text,
      // 분류는 **응답이 끝난 뒤에** 시작한다(noteReplyDone). 분류기는 로컬 모델
      // 전용이고, A-4의 승격 서빙도 같은 로컬 경로를 쓴다 — 발화 직후에 분류를
      // 걸면 서빙이 매번 "local path busy"로 API에 양보해 승격이 사실상 죽는다.
      // 이 교환의 화제는 **다음 발화가 와야** 쓰이므로 늦게 시작해도 늦지 않다.
      topic: Promise.resolve(null)
    }

    const prev = pending
    pending = current
    // 응답이 끝나지 않은 교환은 신호를 못 만든다(사용자가 답을 기다리지 않고
    // 연달아 보낸 경우) — 조용히 버린다.
    awaiting = prev && prev.replyAt != null ? prev : null
  }

  function noteReplyDone() {
    if (pending && pending.replyAt == null) {
      const cur = pending // 다음 발화가 pending을 갈아끼워도 이 교환을 분류한다
      cur.replyAt = now()
      cur.topic = Promise.resolve()
        .then(() => (classify ? classify(cur.text) : null))
        .catch(() => null)
      // 직전 교환은 이제야 확정된다 — 화제 전환 신호가 이 교환의 화제를 쓴다.
      if (awaiting) { finalize(awaiting, cur); awaiting = null }
    }
  }

  /** 응답 직후 사용자가 처음 키를 누른 순간. 지연의 끝점은 전송이 아니라 입력 시작. */
  function noteInputStart() {
    if (pending && pending.replyAt != null && pending.inputStartAt == null) {
      pending.inputStartAt = now()
    }
  }

  /** 시스템 유휴초 피드(5s). 응답 대기 중에 부재가 관측되면 지연 신호를 무효화한다. */
  function notePresence(idleSec) {
    if (!Number.isFinite(idleSec)) return
    if (pending && pending.replyAt != null && idleSec * 1000 >= awayThresholdMs) {
      pending.absent = true
    }
  }

  /** 대화 종료(창 닫힘·앱 종료). 확정되지 않은 마지막 교환은 폐기. */
  function endConversation() { pending = null; awaiting = null }

  async function finalize(prev, next) {
    try {
      const [a, b] = await Promise.all([prev.topic, next.topic])
      if (!a || !(a.confidence >= MIN_CONFIDENCE)) return // 분류 실패/저신뢰 → 폐기
      const end = prev.inputStartAt != null ? prev.inputStartAt : next.at
      const latency = prev.absent ? null : Math.max(0, end - prev.replyAt)
      const shifted = b && b.confidence >= MIN_CONFIDENCE ? b.topic_id !== a.topic_id : null
      onSignal?.({
        t: prev.at,
        topic_id: a.topic_id,
        conf: a.confidence,
        reply_latency_ms: latency,
        reply_len_ratio: prev.lenRatio,
        topic_shifted: shifted,
        engagement: prev.engagement
      })
    } catch {
      // 계측 실패는 조용히 버린다 — 대화 경로에 아무 영향도 주지 않는다.
    }
  }

  return {
    noteUserMessage,
    noteReplyDone,
    noteInputStart,
    notePresence,
    endConversation,
    hasPending: () => pending != null
  }
}

module.exports = {
  SCHEMA_VERSION,
  TOPICS,
  TOPIC_IDS,
  GOLD_LABELS,
  EMA_ALPHA,
  BURN_IN,
  TH_LO,
  TH_HI,
  DEMOTE_STEP,
  PROMOTE_STEP,
  MIN_CONFIDENCE,
  RAW_RETENTION_DAYS,
  engagementDensity,
  median,
  aversionScore,
  emaStep,
  parseClassification,
  dayKeyOf,
  createTopicLedger,
  createExchangeTracker
}
