/**
 * 눈치 원장 계측기 — 화제별 신호 수집 · 저장 · 집계.
 *
 * **계측 전용**이다. 이 모듈이 내는 어떤 값도 캐릭터의 발화·화제 선택·알림에
 * 연결돼 있지 않다(연결은 2단계 몫). 여기서 하는 일은 수집/집계/열람뿐.
 *
 * 프라이버시 원칙: 원장에는 **대화 원문을 절대 저장하지 않는다**. 분류기가 돌려준
 * topic_id와 수치만 남는다. 분류에 쓰인 원문은 로컬 백엔드로만 나가고 버려진다.
 *
 * 영구 보존(응고): 원시 신호는 90일에 폐기하지만 **눈치는 잊지 않는다**. prune()이
 * 일자를 버리기 전에 그 신호들을 `consolidated` 스냅샷에 접어 넣고, aggregate()는
 * 빈 상태가 아니라 그 스냅샷에서 출발해 남은 원시 신호를 다시 훑는다. 폐기 전과
 * 폐기 후의 점수·상태가 같고, 몇 번 돌려도 같다.
 *
 * 파일 하나(JSON) + tmp→rename 원자적 쓰기. 스키마는 `schema_version`으로 고정.
 */
const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 2

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

/**
 * 시간순 신호들을 화제 상태에 제자리로 접어 넣는다. 집계와 응고가 **같은** 이
 * 함수를 쓰기 때문에, 신호를 언제 폐기하든 최종 값이 달라지지 않는다:
 * fold(빈 상태, s1..sn) === fold(fold(빈 상태, s1..sk), s(k+1)..sn).
 *
 * 전이 카운트(demote/promote)는 **화제별로 귀속**한다. 전역 카운터에 더해 버리면
 * 그 화제를 삭제해도 카운트가 유령으로 남아 사용자의 삭제권이 반쪽이 된다.
 *
 * @param {object} topics  topic_id -> { score, evidence, state, demote, promote, updatedAt } (변경됨)
 * @param {Array} signals  t 오름차순으로 정렬된 원시 신호
 */
function foldSignals(topics, signals) {
  for (const sig of signals) {
    if (!TOPIC_IDS.includes(sig.topic_id)) continue
    const av = aversionScore(sig)
    if (av == null) continue
    const cur = topics[sig.topic_id] || (topics[sig.topic_id] = {
      score: null, evidence: 0, state: 'pending', demote: 0, promote: 0, updatedAt: null
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
      if (next === 'frozen') cur.demote += 1
      else if (next === 'thawed') cur.promote += 1
    }
  }
  return topics
}

/** 전역 4지표는 화제별 카운트의 **합산 파생**이다. 화제가 사라지면 몫도 사라진다. */
function eventsFrom(topics) {
  const events = { demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 }
  for (const t of Object.values(topics)) {
    events.demote += t.demote || 0
    events.promote += t.promote || 0
    const label = t.goldLabel
    if (!label || t.state === 'pending') continue
    if (t.state === 'frozen' && (label === 'neutral' || label === 'joke_ok')) events.falseFreeze += 1
    if (t.state === 'thawed' && label === 'sensitive') events.falseThaw += 1
  }
  return events
}

// ── 원장 저장소 ─────────────────────────────────────────────────────────────

function emptyDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    raw: {},          // dayKey -> [signal]
    topics: {},       // topic_id -> { score, evidence, state, demote, promote, goldLabel, updatedAt }
    // 폐기된 원시 신호까지 반영된 영구 스냅샷. 집계의 출발점이다. 전이 카운트도
    // 화제별로 여기 들어 있어서, 화제를 지우면 그 몫이 함께 사라진다.
    consolidated: { topics: {} },
    events: { demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 }, // topics 합산 파생
    lastAggregatedAt: null
  }
}

function emptyTopic() {
  return { score: null, evidence: 0, state: 'pending', demote: 0, promote: 0, updatedAt: null, goldLabel: null }
}

function normalizeTopic(t) {
  return {
    score: Number.isFinite(t.score) ? t.score : null,
    evidence: Number.isFinite(t.evidence) ? t.evidence : 0,
    state: ['frozen', 'thawed', 'neutral'].includes(t.state) ? t.state : 'pending',
    demote: Number.isFinite(t.demote) ? t.demote : 0,
    promote: Number.isFinite(t.promote) ? t.promote : 0,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : null
  }
}

function normalizeDoc(parsed) {
  const doc = emptyDoc()
  if (!parsed || typeof parsed !== 'object') return doc
  // v1 → v2 마이그레이션: v1의 점수는 어차피 '보존 중인 원시 신호만' 반영한 값이라
  // consolidated를 비운 채 다음 집계에 맡기면 값이 그대로 재현된다(손실 0). 원시
  // 신호와 골드 라벨은 그대로 물려받는다. 그보다 옛 버전은 없다.
  if (parsed.schema_version !== SCHEMA_VERSION && parsed.schema_version !== 1) return doc
  if (parsed.raw && typeof parsed.raw === 'object') {
    for (const [day, list] of Object.entries(parsed.raw)) {
      if (Array.isArray(list)) doc.raw[day] = list.filter((s) => s && typeof s === 'object')
    }
  }
  if (parsed.topics && typeof parsed.topics === 'object') {
    for (const [id, t] of Object.entries(parsed.topics)) {
      if (!TOPIC_IDS.includes(id) || !t || typeof t !== 'object') continue
      doc.topics[id] = {
        ...normalizeTopic(t),
        goldLabel: GOLD_LABELS.includes(t.goldLabel) ? t.goldLabel : null
      }
    }
  }
  const con = parsed.consolidated
  if (con && typeof con === 'object' && con.topics && typeof con.topics === 'object') {
    for (const [id, t] of Object.entries(con.topics)) {
      if (!TOPIC_IDS.includes(id) || !t || typeof t !== 'object') continue
      doc.consolidated.topics[id] = normalizeTopic(t)
    }
  }
  // 저장된 events는 믿지 않는다 — topics 합산 파생이 정의라, 로드 시점에 항상
  // 재계산해야 (removeTopic 등 이후 죽은) 유령 카운트가 재시작을 넘어 살아남지 못한다.
  doc.events = eventsFrom(doc.topics)
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

  /**
   * 90일 지난 신호 폐기 — **버리기 전에 consolidated에 접어 넣는다**(응고).
   * cutoff는 단조 증가하므로 폐기되는 신호는 항상 남는 신호보다 오래됐고, 따라서
   * 응고 순서가 전체 재계산 순서와 어긋나지 않는다.
   *
   * 방침: 이미 응고된 날들보다 **오래된 t를 가진 늦은 기록**(시계 되감김·옛 백업
   * 병합 같은 예외 경로)도 그대로 consolidated에 접는다 — 의도된 동작이다. 관측된
   * 눈치를 버리지 않는다는 원칙이 우선이고, 접히는 위치가 스냅샷 끝이라 EMA 순서만
   * 조금 흔들릴 뿐 집계 멱등성은 깨지지 않는다(응고는 한 번, 이후 재계산은 같은
   * 스냅샷에서 출발). 실제 수집 경로(createExchangeTracker)는 항상 현재 시각을
   * 쓰므로 이 경로로 들어오는 일이 없다.
   */
  function prune() {
    const d = load()
    const cutoff = now() - RAW_RETENTION_DAYS * 86400000
    const expired = []
    for (const day of Object.keys(d.raw)) {
      const keep = []
      for (const s of d.raw[day]) {
        if (!Number.isFinite(s.t)) continue // 시각 없는 신호는 응고도 보존도 못 한다
        if (s.t >= cutoff) keep.push(s)
        else expired.push(s)
      }
      if (keep.length === 0) delete d.raw[day]
      else d.raw[day] = keep
    }
    if (expired.length === 0) return
    expired.sort((a, b) => a.t - b.t)
    foldSignals(d.consolidated.topics, expired)
  }

  /**
   * 일일 집계 — **응고 스냅샷에서 출발해** 보존 중인 원시 신호 전체를 시간순으로
   * 다시 훑어 화제별 EMA와 4지표를 재계산한다. 증분이 아니라 재계산이라 언제 몇
   * 번 돌려도 같은 결과가 나온다(골든 파일 테스트와 수동 '지금 집계' 버튼이 같은
   * 값을 본다). 폐기된 신호의 기여는 스냅샷에 이미 들어 있으니 잊히지 않는다.
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
    for (const [id, t] of Object.entries(d.consolidated.topics)) topics[id] = { ...t, goldLabel: null }

    foldSignals(topics, all)

    // 수동 라벨만 있고 신호가 아직 없는 화제도 목록에 남긴다(라벨 보존).
    for (const [id, label] of Object.entries(gold)) {
      if (!label) continue
      if (!topics[id]) topics[id] = emptyTopic()
    }
    for (const [id, t] of Object.entries(topics)) t.goldLabel = gold[id] || null

    d.topics = topics
    d.events = eventsFrom(topics)
    d.lastAggregatedAt = now()
    return flush()
  }

  function setGoldLabel(topicId, label) {
    const d = load()
    if (!TOPIC_IDS.includes(topicId)) return { ok: false, error: 'unknown topic' }
    const normalized = GOLD_LABELS.includes(label) ? label : null
    if (!d.topics[topicId]) d.topics[topicId] = emptyTopic()
    d.topics[topicId].goldLabel = normalized
    d.events = eventsFrom(d.topics) // 라벨이 바뀌면 falseFreeze/falseThaw도 바뀐다
    return flush()
  }

  /**
   * 항목 삭제 — 그 화제의 원시 신호·집계 결과·응고분을 함께 지운다(삭제권).
   * 전이 카운트는 화제별로 귀속돼 있으므로 전역 events를 다시 합산하면 삭제된
   * 화제의 몫이 유령으로 남지 않는다.
   */
  function removeTopic(topicId) {
    const d = load()
    delete d.topics[topicId]
    delete d.consolidated.topics[topicId]
    for (const day of Object.keys(d.raw)) {
      d.raw[day] = d.raw[day].filter((s) => s.topic_id !== topicId)
      if (d.raw[day].length === 0) delete d.raw[day]
    }
    d.events = eventsFrom(d.topics)
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

// ── 원장 거부권 (읽기 전용) ─────────────────────────────────────────────────

/**
 * 관전 코멘트를 말하기 직전, 그 화제 행(getState().topics의 한 줄)을 보고 입을
 * 다물지 정한다. 원장을 바꾸지 않는 순수 함수다.
 *  - 수동 라벨이 자동 상태보다 우선: sensitive면 거부, neutral/joke_ok면 허용.
 *  - frozen이면 거부. 그 외(pending/neutral/thawed/행 없음)는 허용.
 *  - 분류 실패(null)는 허용 — fail-open. 관전은 보조 기능이라 분류가 죽어
 *    영영 벙어리가 되는 쪽이 더 조잡하다.
 * @param {object|null|undefined} topicRow  null = 분류 실패, undefined = 행 없음
 * @returns {{veto:boolean, reason:string}}
 */
function ledgerVeto(topicRow) {
  if (topicRow === null) return { veto: false, reason: 'unclassified' }
  const gold = topicRow?.goldLabel
  if (gold === 'sensitive') return { veto: true, reason: 'gold-sensitive' }
  if (gold === 'neutral' || gold === 'joke_ok') return { veto: false, reason: 'gold-override' }
  if (topicRow?.state === 'frozen') return { veto: true, reason: 'frozen' }
  return { veto: false, reason: topicRow?.state || 'no-row' }
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
      // 그림자가 이 분류 **뒤에** 돌도록 promise를 내준다. 둘은 같은 로컬 잠금을
      // 쓰므로 동시에 들어가면 그림자가 "local path busy"로 버려진다. 화제도
      // 여기서 재사용한다(분류 추가 비용 0).
      return cur.topic
    }
    return null
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
  createExchangeTracker,
  ledgerVeto
}
