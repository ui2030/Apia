/**
 * 선톡(먼저 말 걸기) — 하루 1회, Apia가 사용자에게 먼저 한 줄 말을 건다.
 *
 * 이 모듈은 **판단과 상태**만 맡는다. 실제 생성(대화 provider 호출)·표시·무응답
 * 타이머는 main.js가 배선한다. 눈치 원장(topicLedger)·교재 참조(courseware)는
 * 훅 지점만 공유하고 코드는 독립이다.
 *
 * 프라이버시: 이 파일은 대화 원문을 저장하지 않는다. 발송·응답·무시 카운트와
 * 마지막 선톡 시각/화제 id만 JSON 하나에 tmp→rename 원자적으로 남긴다.
 */
const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1

// 빈도별 최소 간격(시간). 하루 1회 상한은 이 간격 + 같은 날짜 차단으로 강제한다.
const GAP_HOURS = Object.freeze({ daily: 20, biDaily: 44 })
// 재석 판정 — 눈치 원장/presenceManager의 '부재' 기준과 같은 5분.
const PRESENT_MAX_IDLE_SEC = 300

function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 선톡에 쓸 화제 하나. thawed(편한 화제) 우선, 그다음 neutral. **frozen(민감)과
 * goldLabel==='sensitive'는 절대 고르지 않는다.** 직전 선톡과 같은 화제는 대안이
 * 있으면 피한다(같은 얘기 반복 방지). 후보가 없으면 null(→ 일반 안부).
 *
 * @param {object} ledgerState  ledger.getState() 스냅샷
 * @param {string|null} lastTopicId
 */
function pickTopic(ledgerState, lastTopicId = null) {
  const rows = (ledgerState?.topics || []).filter((t) =>
    (t.state === 'thawed' || t.state === 'neutral') && t.goldLabel !== 'sensitive'
  )
  if (rows.length === 0) return null
  rows.sort((a, b) => {
    const rank = (s) => (s === 'thawed' ? 0 : 1)
    if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state)
    // 같은 상태면 aversion score가 낮은(더 편한) 화제를 앞세운다.
    return (a.score ?? 1) - (b.score ?? 1)
  })
  if (lastTopicId && rows.length > 1 && rows[0].id === lastTopicId) return rows[1]
  return rows[0]
}

/**
 * 지금 선톡을 쏠지 판단한다. 순수 함수 — 시계·상태를 전부 인자로 받는다.
 *
 * 트리거(발주서 §1.1): 토글 ON + 사용자 재석(유휴 아님) + 대화 중 아님 +
 * 마지막 선톡 후 간격 경과 + 하루 1회 상한.
 *
 * @returns {{fire:boolean, reason:string, topic:({id:string,label:string}|null)}}
 */
function decideOpener({
  now,
  ledgerState,
  lastOpenerAt = null,
  lastTopicId = null,
  midConversation = false,
  idleSec,
  enabled = true,
  frequency = 'daily',
  presentMaxIdleSec = PRESENT_MAX_IDLE_SEC
} = {}) {
  if (!enabled || frequency === 'off') return { fire: false, reason: 'disabled', topic: null }
  if (midConversation) return { fire: false, reason: 'mid-conversation', topic: null }
  if (!Number.isFinite(idleSec) || idleSec >= presentMaxIdleSec) {
    return { fire: false, reason: 'away', topic: null }
  }
  if (lastOpenerAt != null) {
    const gapMs = (GAP_HOURS[frequency] ?? GAP_HOURS.daily) * 3600000
    if (now - lastOpenerAt < gapMs) return { fire: false, reason: 'too-soon', topic: null }
    if (dayKeyOf(now) === dayKeyOf(lastOpenerAt)) return { fire: false, reason: 'daily-cap', topic: null }
  }
  const topic = pickTopic(ledgerState, lastTopicId)
  return { fire: true, reason: topic ? 'topic' : 'generic', topic }
}

function emptyDoc() {
  return {
    schema_version: SCHEMA_VERSION,
    lastOpenerAt: null,
    lastTopicId: null,
    counts: { sent: 0, replied: 0, ignored: 0 }
  }
}

function normalizeDoc(parsed) {
  const doc = emptyDoc()
  if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== SCHEMA_VERSION) return doc
  if (Number.isFinite(parsed.lastOpenerAt)) doc.lastOpenerAt = parsed.lastOpenerAt
  if (typeof parsed.lastTopicId === 'string') doc.lastTopicId = parsed.lastTopicId
  if (parsed.counts && typeof parsed.counts === 'object') {
    for (const k of Object.keys(doc.counts)) {
      if (Number.isFinite(parsed.counts[k])) doc.counts[k] = parsed.counts[k]
    }
  }
  return doc
}

/**
 * 선톡 상태 저장소. 카운트 + 마지막 발송 시각/화제만 남긴다(원문 없음).
 */
function createOpenerStore({ statePath, now = () => Date.now(), fsImpl = fs, log = {} } = {}) {
  if (!statePath) throw new Error('createOpenerStore: statePath required')
  let doc = null

  function load() {
    if (doc) return doc
    try { doc = normalizeDoc(JSON.parse(fsImpl.readFileSync(statePath, 'utf-8'))) } catch { doc = emptyDoc() }
    return doc
  }

  function flush() {
    const d = load()
    const tmpPath = `${statePath}.tmp`
    try {
      fsImpl.mkdirSync(path.dirname(statePath), { recursive: true })
      fsImpl.writeFileSync(tmpPath, JSON.stringify(d, null, 2), 'utf-8')
      fsImpl.renameSync(tmpPath, statePath)
      return { ok: true }
    } catch (error) {
      try { fsImpl.unlinkSync(tmpPath) } catch {}
      log.warn?.('[OPENER_WRITE_FAILED]', error?.message || error)
      return { ok: false, error: error?.message || String(error) }
    }
  }

  function noteSent(topicId) {
    const d = load()
    d.lastOpenerAt = now()
    d.lastTopicId = typeof topicId === 'string' ? topicId : null
    d.counts.sent += 1
    return flush()
  }
  function noteReplied() { const d = load(); d.counts.replied += 1; return flush() }
  function noteIgnored() { const d = load(); d.counts.ignored += 1; return flush() }

  function getState() {
    const d = load()
    return {
      schema_version: d.schema_version,
      lastOpenerAt: d.lastOpenerAt,
      lastTopicId: d.lastTopicId,
      counts: { ...d.counts },
      path: statePath
    }
  }

  return { load, flush, noteSent, noteReplied, noteIgnored, getState }
}

module.exports = {
  SCHEMA_VERSION,
  GAP_HOURS,
  PRESENT_MAX_IDLE_SEC,
  dayKeyOf,
  pickTopic,
  decideOpener,
  createOpenerStore
}
