/**
 * 눈치 원장 계측기 — 원자적 쓰기 / EMA / 무효 조건 5종 / 30교환 시나리오(골든).
 *
 * 계측기는 조용히 틀리는 게 가장 나쁘다(아무도 모르는 채 잘못된 숫자가 쌓인다).
 * 그래서 신호 산출은 전부 결정론적으로 — 시계도 분류기도 주입 — 검사한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const {
  createTopicLedger,
  createExchangeTracker,
  emaStep,
  aversionScore,
  engagementDensity,
  median,
  parseClassification,
  ledgerVeto,
  EMA_ALPHA,
  SCHEMA_VERSION
} = require('../electron/services/topicLedger')

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/topicLedger.golden.json', import.meta.url))
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

let tmpDir
let ledgerPath

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-ledger-'))
  ledgerPath = join(tmpDir, 'apia-topic-ledger.json')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── 1. 원자적 쓰기 ──────────────────────────────────────────────────────────

describe('원자적 쓰기', () => {
  it('정상 쓰기 후 tmp 파일이 남지 않는다', async () => {
    const ledger = createTopicLedger({ ledgerPath })
    expect(ledger.flush()).toEqual({ ok: true })
    const entries = await readdir(tmpDir)
    expect(entries).toEqual(['apia-topic-ledger.json'])
    expect(JSON.parse(await readFile(ledgerPath, 'utf-8')).schema_version).toBe(SCHEMA_VERSION)
  })

  it('쓰기가 중단돼도 기존 파일은 온전하고 tmp 잔해도 없다', async () => {
    const good = createTopicLedger({ ledgerPath })
    good.setGoldLabel('game', 'sensitive')
    const before = await readFile(ledgerPath, 'utf-8')

    // rename 직전(= 전원이 나간 순간)을 흉내낸다. tmp엔 새 내용이 쓰였지만
    // 교체는 일어나지 않았다.
    const brokenFs = {
      ...fs,
      renameSync: () => { throw new Error('simulated power loss') }
    }
    const log = { warn: vi.fn() }
    const broken = createTopicLedger({ ledgerPath, fsImpl: brokenFs, log })
    const result = broken.setGoldLabel('work', 'neutral')

    expect(result.ok).toBe(false)
    expect(log.warn).toHaveBeenCalled()
    expect(await readFile(ledgerPath, 'utf-8')).toBe(before)
    expect(JSON.parse(before).topics.game.goldLabel).toBe('sensitive')
    expect(JSON.parse(before).topics.work).toBeUndefined()
    expect(await readdir(tmpDir)).toEqual(['apia-topic-ledger.json'])
  })

  it('깨진 파일은 빈 원장으로 다시 시작한다', () => {
    fs.writeFileSync(ledgerPath, '{ this is not json', 'utf-8')
    const ledger = createTopicLedger({ ledgerPath })
    expect(ledger.getState().rawCount).toBe(0)
  })
})

// ── 2. EMA / 신호 산출 ──────────────────────────────────────────────────────

describe('EMA와 회피도 산출', () => {
  it('첫 관측은 그대로 시드, 이후는 alpha=0.15로 수렴한다', () => {
    expect(EMA_ALPHA).toBe(0.15)
    expect(emaStep(null, 0.8)).toBe(0.8)
    expect(emaStep(0.8, 0.3)).toBeCloseTo(0.725, 10)
    expect(emaStep(0.725, 0.3)).toBeCloseTo(0.66125, 10)
  })

  it('유효한 성분만 평균한다 — 성분이 없으면 null', () => {
    expect(aversionScore({ engagement: null })).toBeNull()
    // 지연 3s=0, 길이비 1.0=0, 전환 없음=0, 호응 3/100자=0
    expect(aversionScore({
      reply_latency_ms: 3000, reply_len_ratio: 1, topic_shifted: false, engagement: 3
    })).toBe(0)
    // 지연 30s=1, 길이비 0=1, 전환=1, 호응 0=1
    expect(aversionScore({
      reply_latency_ms: 30000, reply_len_ratio: 0, topic_shifted: true, engagement: 0
    })).toBe(1)
    // 성분 2개만 유효하면 그 둘의 평균
    expect(aversionScore({
      reply_latency_ms: null, reply_len_ratio: null, topic_shifted: true, engagement: 0
    })).toBe(1)
  })

  it('호응 밀도는 100자당 표지 개수', () => {
    expect(engagementDensity('')).toBe(0)
    expect(engagementDensity('ㅋㅋ')).toBe(100) // 2표지 / 2자
    expect(engagementDensity('오늘 회의 자료 정리했습니다')).toBe(0)
    expect(engagementDensity('대박!')).toBeGreaterThan(0)
  })

  it('중앙값은 짝수 길이에서 가운데 두 값의 평균', () => {
    expect(median([])).toBe(0)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('분류 raw 파싱 — 목록 밖 id와 비JSON은 버린다', () => {
    expect(parseClassification('{"topic_id":"game","confidence":0.9}')).toEqual({ topic_id: 'game', confidence: 0.9 })
    expect(parseClassification('네 알겠습니다 {"topic_id":"work","confidence":1.4} 끝')).toEqual({ topic_id: 'work', confidence: 1 })
    expect(parseClassification('{"topic_id":"우주","confidence":0.9}')).toBeNull()
    expect(parseClassification('그냥 말')).toBeNull()
    expect(parseClassification(null)).toBeNull()
  })
})

// ── 3. 무효 조건 5종 ────────────────────────────────────────────────────────

function makeTracker({ classify, awayThresholdMs } = {}) {
  const clock = { t: new Date(2026, 0, 5, 9, 0, 0).getTime() }
  const signals = []
  const tracker = createExchangeTracker({
    now: () => clock.t,
    classify: classify || (async () => ({ topic_id: 'work', confidence: 0.9 })),
    onSignal: (s) => signals.push(s),
    awayThresholdMs
  })
  return { clock, signals, tracker }
}

describe('무효 조건', () => {
  it('① confidence < 0.6이면 신호 자체를 폐기한다', async () => {
    const { clock, signals, tracker } = makeTracker({
      classify: async () => ({ topic_id: 'work', confidence: 0.4 })
    })
    tracker.noteUserMessage('첫 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    clock.t += 2000
    tracker.noteUserMessage('둘째 발화')
    await flushMicrotasks()
    expect(signals).toEqual([])
  })

  it('② 응답 대기 중 부재가 관측되면 reply_latency_ms가 무효', async () => {
    const { clock, signals, tracker } = makeTracker()
    tracker.noteUserMessage('첫 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    tracker.notePresence(600) // 10분째 입력 없음 = 부재
    clock.t += 600000
    tracker.noteUserMessage('돌아왔어요')
    tracker.noteReplyDone()   // 확정은 다음 교환의 응답이 끝날 때
    await flushMicrotasks()
    expect(signals).toHaveLength(1)
    expect(signals[0].reply_latency_ms).toBeNull()
  })

  it('② 재석 중이면 응답→입력 시작까지를 잰다 (전송 시점이 아니라)', async () => {
    const { clock, signals, tracker } = makeTracker()
    tracker.noteUserMessage('첫 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    tracker.notePresence(3) // 재석
    clock.t += 4000
    tracker.noteInputStart()  // 여기서 타자 시작
    clock.t += 9000           // 9초 동안 타이핑 — 지연에 포함되면 안 된다
    tracker.noteUserMessage('둘째 발화')
    tracker.noteReplyDone()
    await flushMicrotasks()
    expect(signals[0].reply_latency_ms).toBe(4000)
  })

  it('③ 당일 발화 3건 미만이면 reply_len_ratio가 무효', async () => {
    const { clock, signals, tracker } = makeTracker()
    for (let i = 0; i < 4; i++) {
      tracker.noteUserMessage('발화'.repeat(i + 1))
      clock.t += 1000
      tracker.noteReplyDone()
      clock.t += 1000
    }
    await flushMicrotasks()
    expect(signals).toHaveLength(3)
    expect(signals[0].reply_len_ratio).toBeNull() // 당일 1건째
    expect(signals[1].reply_len_ratio).toBeNull() // 당일 2건째
    expect(signals[2].reply_len_ratio).not.toBeNull() // 3건째부터 유효
  })

  it('④ 대화 종료 직전 교환은 통째로 무효 (종료 ≠ 회피)', async () => {
    const { clock, signals, tracker } = makeTracker()
    tracker.noteUserMessage('첫 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    clock.t += 2000
    tracker.noteUserMessage('둘째 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    tracker.endConversation() // 창을 닫거나 앱 종료
    await flushMicrotasks()
    expect(signals).toHaveLength(1) // 둘째 교환은 남지 않는다
    expect(tracker.hasPending()).toBe(false)
  })

  it('⑤ 다음 발화의 분류 신뢰도가 낮으면 topic_shifted가 무효', async () => {
    const confidences = [0.9, 0.2]
    let i = 0
    const { clock, signals, tracker } = makeTracker({
      classify: async () => ({ topic_id: 'work', confidence: confidences[i++] ?? 0.9 })
    })
    tracker.noteUserMessage('첫 발화')
    clock.t += 1000
    tracker.noteReplyDone()
    clock.t += 2000
    tracker.noteUserMessage('둘째 발화')
    tracker.noteReplyDone()
    await flushMicrotasks()
    expect(signals).toHaveLength(1)
    expect(signals[0].topic_shifted).toBeNull()
  })

  it('응답이 끝나기 전에 연달아 보낸 발화는 신호를 만들지 않는다', async () => {
    const { clock, signals, tracker } = makeTracker()
    tracker.noteUserMessage('첫 발화')
    clock.t += 500
    tracker.noteUserMessage('아 그리고')  // 아직 응답 전
    clock.t += 500
    tracker.noteReplyDone()
    clock.t += 1000
    tracker.noteUserMessage('셋째')
    tracker.noteReplyDone()
    await flushMicrotasks()
    expect(signals).toHaveLength(1)
  })
})

// ── 4. 저장소 규칙 ──────────────────────────────────────────────────────────

describe('원장 저장소', () => {
  it('원문 텍스트는 어떤 경로로도 저장되지 않는다', async () => {
    const ledger = createTopicLedger({ ledgerPath })
    ledger.recordSignal({
      t: Date.now(), topic_id: 'work', conf: 0.9, text: '비밀 이야기',
      reply_latency_ms: 1000, reply_len_ratio: 1, topic_shifted: false, engagement: 0
    })
    const onDisk = await readFile(ledgerPath, 'utf-8')
    expect(onDisk).not.toContain('비밀 이야기')
    expect(onDisk).not.toContain('text')
  })

  it('90일 지난 원시 신호는 폐기된다', () => {
    const now = new Date(2026, 5, 1).getTime()
    const ledger = createTopicLedger({ ledgerPath, now: () => now })
    ledger.recordSignal({ t: now - 91 * 86400000, topic_id: 'work', conf: 0.9, engagement: 0 })
    ledger.recordSignal({ t: now - 10 * 86400000, topic_id: 'work', conf: 0.9, engagement: 0 })
    expect(ledger.getState().rawCount).toBe(1)
  })

  it('수동 라벨은 집계를 다시 돌려도 보존된다', () => {
    const ledger = createTopicLedger({ ledgerPath })
    ledger.setGoldLabel('game', 'joke_ok')
    ledger.recordSignal({ t: Date.now(), topic_id: 'game', conf: 0.9, engagement: 0 })
    ledger.aggregate()
    const row = ledger.getState().topics.find((t) => t.id === 'game')
    expect(row.goldLabel).toBe('joke_ok')
  })

  it('항목 삭제는 그 화제의 원시 신호까지 지운다', () => {
    const ledger = createTopicLedger({ ledgerPath })
    ledger.recordSignal({ t: Date.now(), topic_id: 'game', conf: 0.9, engagement: 0 })
    ledger.recordSignal({ t: Date.now(), topic_id: 'work', conf: 0.9, engagement: 0 })
    ledger.removeTopic('game')
    expect(ledger.getState().rawCount).toBe(1)
  })

  it('전체 초기화는 빈 원장으로 되돌린다', () => {
    const ledger = createTopicLedger({ ledgerPath })
    ledger.recordSignal({ t: Date.now(), topic_id: 'game', conf: 0.9, engagement: 0 })
    ledger.setGoldLabel('work', 'sensitive')
    ledger.reset()
    const state = ledger.getState()
    expect(state.rawCount).toBe(0)
    expect(state.topics).toEqual([])
  })

  it('증거 7건 미만이면 판단 보류 상태로 남는다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const ledger = createTopicLedger({ ledgerPath, now: () => base })
    for (let i = 0; i < 6; i++) {
      ledger.recordSignal({
        t: base + i * 1000, topic_id: 'work', conf: 0.9,
        reply_latency_ms: 30000, reply_len_ratio: 0, topic_shifted: true, engagement: 0
      })
    }
    ledger.aggregate()
    expect(ledger.getState().topics[0].state).toBe('pending')
    ledger.recordSignal({
      t: base + 7000, topic_id: 'work', conf: 0.9,
      reply_latency_ms: 30000, reply_len_ratio: 0, topic_shifted: true, engagement: 0
    })
    ledger.aggregate()
    expect(ledger.getState().topics[0].state).toBe('frozen')
  })
})

// ── 4-B. 응고(consolidation): 원시 신호는 버려도 점수는 잊지 않는다 ──────────

const DAY = 86400000

/** 회피 신호 n건을 t 기준으로 1초 간격으로 넣는다. i가 짝수면 강한 회피, 홀수면 중간. */
function feedAversive(ledger, base, n) {
  for (let i = 0; i < n; i++) {
    ledger.recordSignal({
      t: base + i * 1000, topic_id: 'work', conf: 0.9,
      reply_latency_ms: i % 2 === 0 ? 30000 : 16500,
      reply_len_ratio: i % 2 === 0 ? 0 : 0.4,
      topic_shifted: true,
      engagement: 0
    })
  }
}

describe('응고(consolidation)', () => {
  it('90일이 지나 원시 신호가 폐기돼도 점수·상태가 폐기 전과 같다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base, 12)
    ledger.aggregate()
    const before = ledger.getState().topics.find((t) => t.id === 'work')
    expect(before.state).toBe('frozen')

    clock.t = base + 95 * DAY // 주입 시계로 90일 경과
    ledger.aggregate()        // 내부 prune이 그 날짜를 통째로 폐기한다
    const after = ledger.getState()

    expect(after.rawCount).toBe(0) // 원시 신호는 약속대로 사라졌다
    expect(after.rawDays).toBe(0)
    const work = after.topics.find((t) => t.id === 'work')
    expect(work).toBeDefined()
    expect(work.score).toBe(before.score)
    expect(work.evidence).toBe(before.evidence)
    expect(work.state).toBe(before.state)
    expect(after.events.demote).toBe(1)
  })

  it('점수는 언제 폐기됐는지에 좌우되지 않는다 (점진 응고 == 일괄 응고)', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const end = base + 99 * DAY
    // 100일에 걸친 같은 신호 묶음을 두 원장에 넣는다. 한쪽은 하루씩 시계를 밀며
    // 조금씩 응고하고, 다른 쪽은 마지막 날 시계로 한 번에 응고한다.
    const feed = (ledger, clock) => {
      for (let i = 0; i < 100; i++) {
        if (clock) clock.t = base + i * DAY
        ledger.recordSignal({
          t: base + i * DAY, topic_id: 'work', conf: 0.9,
          reply_latency_ms: i % 3 === 0 ? 30000 : 8000,
          reply_len_ratio: i % 2 === 0 ? 0.2 : 0.9,
          topic_shifted: i % 5 === 0,
          engagement: i % 4
        })
      }
    }
    const gradualClock = { t: base }
    const gradual = createTopicLedger({ ledgerPath, now: () => gradualClock.t })
    feed(gradual, gradualClock)
    gradualClock.t = end
    gradual.aggregate()

    const atOnce = createTopicLedger({ ledgerPath: `${ledgerPath}.2`, now: () => end })
    feed(atOnce, null)
    atOnce.aggregate()

    const a = gradual.getState().topics.find((t) => t.id === 'work')
    const b = atOnce.getState().topics.find((t) => t.id === 'work')
    expect(a.evidence).toBe(100)
    expect(b.evidence).toBe(100)
    expect(a.score).toBe(b.score)
    expect(a.state).toBe(b.state)
  })

  it('응고된 frozen 화제도 새 긍정 신호가 쌓이면 해빙된다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base, 12)
    clock.t = base + 95 * DAY
    ledger.aggregate()
    expect(ledger.getState().topics.find((t) => t.id === 'work').state).toBe('frozen')

    const later = base + 95 * DAY
    for (let i = 0; i < 20; i++) {
      ledger.recordSignal({
        t: later + i * 1000, topic_id: 'work', conf: 0.9,
        reply_latency_ms: 3000, reply_len_ratio: 1, topic_shifted: false, engagement: 3
      })
    }
    ledger.aggregate()
    const work = ledger.getState().topics.find((t) => t.id === 'work')
    expect(work.state).toBe('thawed')
    expect(work.evidence).toBe(32) // 응고분 12 + 새 신호 20
  })

  it('응고 후에도 aggregate 연속 2회 결과가 같고 골드 라벨이 남는다', async () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    ledger.setGoldLabel('work', 'neutral')
    feedAversive(ledger, base, 12)
    clock.t = base + 95 * DAY
    ledger.aggregate()
    const first = await readFile(ledgerPath, 'utf-8')
    ledger.aggregate()
    expect(await readFile(ledgerPath, 'utf-8')).toBe(first)
    expect(ledger.getState().topics.find((t) => t.id === 'work').goldLabel).toBe('neutral')
    expect(ledger.getState().events.falseFreeze).toBe(1)
  })

  it('구버전(v1) 문서는 원시 신호·골드 라벨을 지킨 채 마이그레이션된다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    fs.writeFileSync(ledgerPath, JSON.stringify({
      schema_version: 1,
      raw: { '2026-01-05': [{ t: base, topic_id: 'work', conf: 0.9, reply_latency_ms: 30000, reply_len_ratio: 0, topic_shifted: true, engagement: 0 }] },
      topics: { game: { score: 0.2, evidence: 9, state: 'thawed', goldLabel: 'joke_ok', updatedAt: base } },
      events: { demote: 0, promote: 1, falseFreeze: 0, falseThaw: 0 },
      lastAggregatedAt: base
    }, null, 2), 'utf-8')

    const ledger = createTopicLedger({ ledgerPath, now: () => base + 1000 })
    const state = ledger.getState()
    expect(state.schema_version).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBeGreaterThan(1)
    expect(state.rawCount).toBe(1)
    expect(state.topics.find((t) => t.id === 'game').goldLabel).toBe('joke_ok')
    ledger.aggregate()
    const work = ledger.getState().topics.find((t) => t.id === 'work')
    expect(work.evidence).toBe(1)
    expect(work.score).toBe(1)
  })

  it('저장된 events는 믿지 않는다 — 로드 시 topics 합산으로 재계산돼 유령 카운트가 재시작을 못 넘는다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    // removeTopic 이후 구현 버그 등으로 events만 남은 문서를 흉내 낸다:
    // topics는 비었는데 events.demote=5.
    fs.writeFileSync(ledgerPath, JSON.stringify({
      schema_version: 2,
      raw: {},
      topics: {},
      consolidated: { topics: {} },
      events: { demote: 5, promote: 3, falseFreeze: 2, falseThaw: 1 },
      lastAggregatedAt: base
    }, null, 2), 'utf-8')

    const ledger = createTopicLedger({ ledgerPath, now: () => base + 1000 })
    expect(ledger.getState().events).toEqual({ demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 })
  })

  it('burn-in 경계 — 응고분 6 + 잔존 원시 1건이 7이 되는 순간 전이한다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base, 6)                       // 이 6건만 응고될 것
    feedAversive(ledger, base + 50 * DAY, 1)            // 50일 뒤 1건은 살아남는다
    clock.t = base + 100 * DAY // cutoff = base+10일 → 첫 날만 폐기, 50일차는 보존
    ledger.aggregate()

    const con = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).consolidated.topics.work
    expect(con.evidence).toBe(6)      // 응고분은 아직 판단 보류 상태
    expect(con.state).toBe('pending')
    expect(con.demote).toBe(0)
    const state = ledger.getState()
    expect(state.rawCount).toBe(1)
    const work = state.topics.find((t) => t.id === 'work')
    expect(work.evidence).toBe(7)     // 경계 도달
    expect(work.state).toBe('frozen') // 바로 판정이 내려진다
    expect(state.events.demote).toBe(1)
  })

  it('응고분보다 오래된 t의 늦은 기록도 접히고, 멱등성은 유지된다', async () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base + 10 * DAY, 12)
    clock.t = base + 105 * DAY
    ledger.aggregate()
    const before = ledger.getState().topics.find((t) => t.id === 'work')

    // 응고된 날들보다 더 오래된 신호가 뒤늦게 들어온다(시계 되감김·옛 백업 병합).
    ledger.recordSignal({
      t: base, topic_id: 'work', conf: 0.9,
      reply_latency_ms: 3000, reply_len_ratio: 1, topic_shifted: false, engagement: 3
    })
    ledger.aggregate()
    const after = ledger.getState().topics.find((t) => t.id === 'work')
    expect(after.evidence).toBe(before.evidence + 1) // 버려지지 않고 응고에 접혔다
    expect(ledger.getState().rawCount).toBe(0)       // 원시 신호는 남지 않는다

    const first = await readFile(ledgerPath, 'utf-8')
    ledger.aggregate()
    expect(await readFile(ledgerPath, 'utf-8')).toBe(first)
  })

  it('항목 삭제는 그 화제의 전이 카운트까지 가져간다', () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base, 12)
    clock.t = base + 95 * DAY
    ledger.aggregate()
    expect(ledger.getState().events.demote).toBe(1)

    ledger.removeTopic('work') // 유일한 응고 화제
    expect(ledger.getState().events).toEqual({ demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 })
    ledger.aggregate()
    expect(ledger.getState().events).toEqual({ demote: 0, promote: 0, falseFreeze: 0, falseThaw: 0 })
  })

  it('항목 삭제·초기화는 응고된 점수까지 지운다', async () => {
    const base = new Date(2026, 0, 5, 9, 0, 0).getTime()
    const clock = { t: base }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })
    feedAversive(ledger, base, 12)
    ledger.recordSignal({ t: base, topic_id: 'game', conf: 0.9, reply_latency_ms: 3000, reply_len_ratio: 1, topic_shifted: false, engagement: 3 })
    clock.t = base + 95 * DAY
    ledger.aggregate()
    expect(ledger.getState().topics).toHaveLength(2)

    ledger.removeTopic('work')
    expect(ledger.getState().topics.map((t) => t.id)).toEqual(['game'])
    expect(await readFile(ledgerPath, 'utf-8')).not.toContain('"work"')
    ledger.aggregate() // 지운 화제가 응고분에서 되살아나지 않는다
    expect(ledger.getState().topics.map((t) => t.id)).toEqual(['game'])

    ledger.reset()
    const state = ledger.getState()
    expect(state.topics).toEqual([])
    expect(await readFile(ledgerPath, 'utf-8')).not.toContain('"game"')
  })
})

// ── 5. 시나리오: 가짜 대화 30교환 → 골든 파일 ────────────────────────────────

describe('30교환 시나리오', () => {
  it('기대 원장 상태(golden file)와 일치한다', async () => {
    const clock = { t: new Date(2026, 0, 5, 9, 0, 0).getTime() }
    const ledger = createTopicLedger({ ledgerPath, now: () => clock.t })

    // 화제는 발화 텍스트에서 결정론적으로 정한다(가짜 로컬 분류기).
    const argCounts = []
    const classify = async (...args) => {
      argCounts.push(args.length)
      const [text] = args
      if (text.startsWith('[work]')) return { topic_id: 'work', confidence: 0.92 }
      if (text.startsWith('[game]')) return { topic_id: 'game', confidence: 0.88 }
      return null
    }
    const tracker = createExchangeTracker({
      now: () => clock.t,
      classify,
      onSignal: (s) => ledger.recordSignal(s)
    })

    // 앞 15교환: 게임 얘기엔 빨리·길게·ㅋㅋ 붙여 답한다 → 편안 신호
    // 뒤 15교환: 업무 얘기엔 늦게·짧게·무덤덤하게 답한다 → 회피 신호
    const script = []
    for (let i = 0; i < 15; i++) script.push({ topic: 'game', body: '어제 그 판 진짜 역대급이었어 다시 보고 싶다', latency: 1200, engage: 'ㅋㅋㅋ' })
    for (let i = 0; i < 15; i++) script.push({ topic: 'work', body: '네', latency: 28000, engage: '' })

    for (const step of script) {
      tracker.noteUserMessage(`[${step.topic}] ${step.body}${step.engage}`)
      clock.t += 800                  // 응답 생성
      tracker.noteReplyDone()
      tracker.notePresence(2)         // 계속 자리에 있음
      clock.t += step.latency         // 다음 입력 시작까지
      tracker.noteInputStart()
    }
    tracker.endConversation()         // 마지막 교환은 무효
    await flushMicrotasks()
    ledger.aggregate()

    const actual = JSON.parse(await readFile(ledgerPath, 'utf-8'))
    // 경로/시각은 파일에 안 들어가지만 lastAggregatedAt은 주입 시계라 결정론적.
    if (process.env.UPDATE_LEDGER_GOLDEN === '1') {
      fs.mkdirSync(join(GOLDEN_PATH, '..'), { recursive: true })
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2), 'utf-8')
    }
    const golden = JSON.parse(await readFile(GOLDEN_PATH, 'utf-8'))
    expect(actual).toEqual(golden)
    // 계측 경로는 분류기를 원문 한 인자로만 부른다 — main의 classifyTopic은 옵션
    // ({aiMode})이 없으면 ai_mode를 싣지 않으므로 사용자 발화는 로컬 전용으로 남는다.
    expect(argCounts.length).toBeGreaterThan(0)
    expect(argCounts.every((n) => n === 1)).toBe(true)

    // 골든이 "그냥 현재 동작"이 아니라 기대한 방향인지 한 번 더 못박는다.
    const state = ledger.getState()
    expect(state.rawCount).toBe(29) // 30발화 → 29교환, 마지막은 폐기
    const work = state.topics.find((t) => t.id === 'work')
    const game = state.topics.find((t) => t.id === 'game')
    expect(work.state).toBe('frozen')
    expect(game.state).toBe('thawed')
    expect(work.score).toBeGreaterThan(game.score)
    expect(state.events.demote).toBe(1)
    expect(state.events.promote).toBe(1)
  })
})

// ── 7. 관전 거부권(읽기 전용 결정) ─────────────────────────────────────────

describe('ledgerVeto', () => {
  it('수동 sensitive는 무조건 거부', () => {
    expect(ledgerVeto({ id: 'game', state: 'thawed', goldLabel: 'sensitive' }))
      .toEqual({ veto: true, reason: 'gold-sensitive' })
  })
  it('수동 neutral은 자동 동결보다 우선해 허용', () => {
    expect(ledgerVeto({ id: 'game', state: 'frozen', goldLabel: 'neutral' }))
      .toEqual({ veto: false, reason: 'gold-override' })
  })
  it('수동 joke_ok도 자동 동결보다 우선해 허용', () => {
    expect(ledgerVeto({ id: 'game', state: 'frozen', goldLabel: 'joke_ok' }))
      .toEqual({ veto: false, reason: 'gold-override' })
  })
  it('frozen이면 거부', () => {
    expect(ledgerVeto({ id: 'game', state: 'frozen', goldLabel: null }))
      .toEqual({ veto: true, reason: 'frozen' })
  })
  it('thawed·neutral·pending·행 없음은 허용', () => {
    for (const state of ['thawed', 'neutral', 'pending']) {
      expect(ledgerVeto({ id: 'game', state, goldLabel: null }).veto).toBe(false)
    }
    expect(ledgerVeto(undefined)).toEqual({ veto: false, reason: 'no-row' })
  })
  it('분류 실패(null)는 허용 — fail-open', () => {
    expect(ledgerVeto(null)).toEqual({ veto: false, reason: 'unclassified' })
  })
})
