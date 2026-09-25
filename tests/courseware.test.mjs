/**
 * 교재 파이프라인 — 폐기 규칙 / 비용 창 / 원자적 쓰기 / 일자 경계 / E2E(가짜 교사).
 *
 * 이 파일의 존재 이유는 첫 번째 그룹이다: **원본 삭제는 교재 변환 성공이 디스크에
 * 확정된 뒤에만**. 쓰기 실패·되읽기 불일치·교사 실패·교사 연기 — 어떤 경로로도
 * 버퍼가 사라지면 안 된다. 실패 경로마다 파일이 살아 있음을 직접 확인한다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const {
  createCoursewareStore,
  createCoursewareJob,
  dayKeyOf,
  searchCards,
  attachReferenceCards,
  FAILURE_WARN_STREAK
} = require('../electron/services/courseware')

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/courseware.golden.json', import.meta.url))
const REFERENCE_GOLDEN_PATH = fileURLToPath(
  new URL('./fixtures/courseware.reference.golden.json', import.meta.url)
)

let dir
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'apia-courseware-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const at = (iso) => new Date(iso).getTime()
/** 지정한 fs 메서드만 던지게 만드는 seam. 나머지는 진짜 fs. */
const brokenFs = (overrides) => new Proxy(fs, {
  get: (target, prop) => (prop in overrides ? overrides[prop] : target[prop])
})

async function seedBuffer(store, day, rows) {
  for (const [i, row] of rows.entries()) {
    await store.appendExchange({ ...row, t: at(`${day}T10:0${i}:00`) })
  }
}

// ── 1. 폐기 규칙 ────────────────────────────────────────────────────────────

describe('폐기 규칙 — 원본 삭제는 변환 성공 확정 후에만', () => {
  it('성공: 교재가 디스크에 남은 뒤 원본 버퍼가 사라진다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)

    const res = store.commitCourseware('2026-09-01', [{ u: '인사는?', a: '반갑게 합니다' }])
    expect(res).toMatchObject({ ok: true, day: '2026-09-01', cards: 1 })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(false)
    const written = await readFile(store.paths.cardsPath('2026-09-01'), 'utf-8')
    expect(JSON.parse(written.trim())).toEqual({ day: '2026-09-01', u: '인사는?', a: '반갑게 합니다' })
  })

  it('교재 쓰기가 실패하면 원본 버퍼가 그대로 남는다', async () => {
    const fsImpl = brokenFs({ openSync: () => { throw new Error('disk full') } })
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00'), fsImpl })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])

    const res = store.commitCourseware('2026-09-01', [{ u: 'q', a: 'a' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/disk full/)
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
    expect(existsSync(store.paths.cardsPath('2026-09-01'))).toBe(false)
  })

  it('rename은 됐는데 되읽기가 어긋나면 원본을 지우지 않는다', async () => {
    // 디스크가 다른 내용을 돌려주는 상황(조용한 손상)을 흉내낸다.
    const fsImpl = brokenFs({
      readFileSync: (p, ...rest) => (String(p).endsWith('cards\\2026-09-01.jsonl') || String(p).endsWith('cards/2026-09-01.jsonl')
        ? '깨진 내용\n'
        : fs.readFileSync(p, ...rest))
    })
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00'), fsImpl })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])

    const res = store.commitCourseware('2026-09-01', [{ u: 'q', a: 'a' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/readback mismatch/)
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
  })

  it('교사 실패(job 경로)도 원본을 보존하고 실패만 센다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    const job = createCoursewareJob({
      store,
      convert: async () => ({ status: 'failed', reason: 'HTTP 500' })
    })

    const res = await job.runOnce({ force: true })
    expect(res).toMatchObject({ ok: false, day: '2026-09-01', streak: 1 })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
    expect(store.getState().pendingDays).toBe(1)
  })

  it('백엔드 미가동(던지는 convert)은 조용한 연기 — 실패로 세지 않는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    const job = createCoursewareJob({
      store,
      convert: async () => { throw new Error('fetch failed') }
    })

    const res = await job.runOnce({ force: true })
    expect(res).toMatchObject({ ok: false, deferred: true })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
    const status = JSON.parse(await readFile(store.paths.statusPath, 'utf-8'))
    expect(status.failures).toEqual({})
    expect(status.warnings).toEqual([])
  })

  it('예산 소진(deferred)도 연기 — 원본 보존, 실패 0', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    const job = createCoursewareJob({
      store,
      convert: async () => ({ status: 'deferred', reason: 'daily budget reached', spent_today: 0.07 })
    })

    await job.runOnce({ force: true })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
    const state = store.getState()
    expect(state.spend7d).toBeCloseTo(0.07, 6)
    expect(state.lastError.message).toMatch(/budget/)
  })

  it('7일 연속 실패하면 원본을 유지한 채 상태 파일에 경고가 남는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    const job = createCoursewareJob({ store, convert: async () => ({ status: 'failed', reason: 'HTTP 500' }) })

    for (let i = 0; i < FAILURE_WARN_STREAK - 1; i += 1) {
      await job.runOnce({ force: true })
      expect(store.getState().warnings).toEqual([])
    }
    await job.runOnce({ force: true })

    const state = store.getState()
    expect(state.warnings).toEqual([
      { day: '2026-09-01', streak: FAILURE_WARN_STREAK, at: at('2026-09-02T09:00:00') }
    ])
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
  })

  it('실패 뒤 성공하면 경고와 실패 카운트가 걷힌다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    let ok = false
    const job = createCoursewareJob({
      store,
      convert: async () => (ok ? { status: 'ok', cards: [{ u: 'q', a: 'a' }] } : { status: 'failed', reason: 'boom' })
    })
    for (let i = 0; i < FAILURE_WARN_STREAK; i += 1) await job.runOnce({ force: true })
    expect(store.getState().warnings).toHaveLength(1)

    ok = true
    await job.runOnce({ force: true })
    const state = store.getState()
    expect(state.warnings).toEqual([])
    expect(state.lastError).toBe(null)
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(false)
  })
})

// ── 1-b. 변환 중 들어온 늦은 기록 (회귀) ────────────────────────────────────
//
// 변환은 수십 초짜리 왕복이다. 그 사이 도착한 같은 일자 기록이 unlink 뒤에
// 디스크에 닿으면 옛 버퍼가 되살아나고, 다음 실행이 그 하루치 교재를 늦은 한
// 건만으로 덮어쓴다 — 하루가 통째로 날아간다.

describe('변환 중 append 직렬화', () => {
  it('큐에만 있고 아직 디스크에 없는 기록도 변환 입력에 들어간다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    // 대화 경로가 그러듯 await하지 않고 던져둔 채 바로 잡을 돌린다.
    store.appendExchange({ u: '아직 디스크에 없음', a: '네', t: at('2026-09-01T22:00:00') })
    let seen = null
    const job = createCoursewareJob({
      store,
      convert: async (_day, exchanges) => {
        seen = exchanges
        return { status: 'ok', cards: [{ u: 'q', a: 'a' }] }
      }
    })

    expect(await job.runOnce({ force: true })).toMatchObject({ ok: true, cards: 1 })
    expect(seen.map((e) => e.u)).toEqual(['아직 디스크에 없음'])
  })

  it('변환 중 도착한 같은 일자 기록은 옛 버퍼를 되살리지 않고 오늘자로 간다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '초저녁', a: '네' }])
    const job = createCoursewareJob({
      store,
      convert: async (_day, exchanges) => {
        // 교사 왕복 도중 자정 직전 교환이 뒤늦게 큐에 들어온다.
        await store.appendExchange({ u: '막차', a: '조심히요', t: at('2026-09-01T23:59:58') })
        return { status: 'ok', cards: exchanges.map((e) => ({ u: e.u, a: e.a })) }
      }
    })

    expect(await job.runOnce({ force: true })).toMatchObject({ ok: true, day: '2026-09-01', cards: 1 })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(false) // 되살아나지 않았다
    expect(store.readBuffer('2026-09-02').map((r) => r.u)).toEqual(['막차']) // 오늘자로 승격
    // 원래 시각은 줄 안에 그대로 — 기록 자체를 잃지 않는다.
    expect(store.readBuffer('2026-09-02')[0].t).toBe(at('2026-09-01T23:59:58'))
  })

  it('변환이 끝나면 그 일자로 다시 기록할 수 있다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: 'a', a: 'b' }])
    const job = createCoursewareJob({ store, convert: async () => ({ status: 'ok', cards: [] }) })
    await job.runOnce({ force: true })

    await store.appendExchange({ u: '뒤늦게', a: '네', t: at('2026-09-01T12:00:00') })
    expect(store.readBuffer('2026-09-01').map((r) => r.u)).toEqual(['뒤늦게'])
  })
})

// ── 1-c. 재실행 멱등성 (회귀) ───────────────────────────────────────────────

describe('교재가 이미 확정된 날의 재실행', () => {
  // buffers/ 아래 파일만 못 지우게 막는다 = 확정 직후 크래시/EBUSY 재현.
  const unlinkBlockedFs = brokenFs({
    unlinkSync: (p, ...rest) => {
      if (String(p).includes('buffers')) throw new Error('EBUSY')
      return fs.unlinkSync(p, ...rest)
    }
  })

  it('교사를 다시 부르지 않고 버퍼만 닫으며, 카드를 이중 집계하지 않는다', async () => {
    const now = () => at('2026-09-02T09:00:00')
    const seed = createCoursewareStore({ dir, now })
    await seedBuffer(seed, '2026-09-01', [{ u: 'a', a: 'b' }])

    const crashed = createCoursewareStore({ dir, now, fsImpl: unlinkBlockedFs })
    expect(crashed.commitCourseware('2026-09-01', [{ u: 'q1', a: 'a1' }, { u: 'q2', a: 'a2' }]))
      .toMatchObject({ ok: true, cards: 2 })
    expect(existsSync(seed.paths.bufferPath('2026-09-01'))).toBe(true) // 버퍼가 남았다
    expect(crashed.getState().totalCards).toBe(2)

    const restarted = createCoursewareStore({ dir, now })
    const job = createCoursewareJob({
      store: restarted,
      convert: async () => { throw new Error('교사를 불러선 안 된다') }
    })
    expect(await job.runOnce({ force: true }))
      .toMatchObject({ ok: true, day: '2026-09-01', cards: 2, reconciled: true })
    expect(existsSync(seed.paths.bufferPath('2026-09-01'))).toBe(false)
    expect(restarted.getState().totalCards).toBe(2) // 4가 아니다
    expect(restarted.getState().pendingDays).toBe(0)
  })

  it('교재 파일이 깨져 있으면 정상 변환 경로로 간다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: 'a', a: 'b' }])
    fs.mkdirSync(store.paths.cardsDir, { recursive: true })
    fs.writeFileSync(store.paths.cardsPath('2026-09-01'), '{"u":"반쪽만\n', 'utf-8')
    expect(store.verifiedCardCount('2026-09-01')).toBe(null)

    const job = createCoursewareJob({ store, convert: async () => ({ status: 'ok', cards: [{ u: 'q', a: 'a' }] }) })
    expect(await job.runOnce({ force: true })).toMatchObject({ ok: true, cards: 1 })
    expect(store.verifiedCardCount('2026-09-01')).toBe(1)
  })

  it('같은 날을 두 번 확정해도 카드 수가 더해지지 않는다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    const cards = [{ u: 'q1', a: 'a1' }, { u: 'q2', a: 'a2' }]
    store.commitCourseware('2026-09-01', cards)
    store.commitCourseware('2026-09-01', cards)
    expect(store.getState().totalCards).toBe(2)
  })

  it('빈 교재(잡담뿐이던 날)도 확정으로 인정한다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: 'a', a: 'b' }])
    store.commitCourseware('2026-09-01', [])
    expect(store.verifiedCardCount('2026-09-01')).toBe(0)
  })
})

// ── 2. 비용 창 ──────────────────────────────────────────────────────────────

describe('비용 기록', () => {
  it('교사가 돌려준 당일 누계를 적고 7일보다 오래된 날은 버린다', () => {
    let clock = at('2026-09-10T12:00:00')
    const store = createCoursewareStore({ dir, now: () => clock })
    store.noteSpend(0.01)
    clock = at('2026-09-14T12:00:00'); store.noteSpend(0.02)
    clock = at('2026-09-20T12:00:00'); store.noteSpend(0.03)

    const state = store.getState()
    expect(Object.keys(state.spend).sort()).toEqual(['2026-09-14', '2026-09-20'])
    expect(state.spend7d).toBeCloseTo(0.05, 6)
  })

  it('잡은 convert가 준 spent_today만 기록한다(스스로 요금을 계산하지 않는다)', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    const job = createCoursewareJob({
      store,
      convert: async () => ({ status: 'ok', cards: [{ u: 'q', a: 'a' }], spent_today: 0.0123 })
    })
    await job.runOnce({ force: true })
    expect(store.getState().spend7d).toBeCloseTo(0.0123, 6)
  })
})

// ── 3. 원자적 쓰기 ──────────────────────────────────────────────────────────

describe('원자적 쓰기', () => {
  it('정상 경로는 tmp 잔해를 남기지 않는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    store.commitCourseware('2026-09-01', [{ u: 'q', a: 'a' }])

    expect((await readdir(dir)).sort()).toEqual(['README.txt', 'buffers', 'cards', 'status.json'])
    expect(await readdir(store.paths.cardsDir)).toEqual(['2026-09-01.jsonl'])
  })

  it('status.json 쓰기가 rename 직전에 끊겨도 기존 파일이 온전하고 tmp도 안 남는다', async () => {
    const good = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    good.noteSpend(0.001)
    const before = await readFile(good.paths.statusPath, 'utf-8')

    const fsImpl = brokenFs({ renameSync: () => { throw new Error('power loss') } })
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00'), fsImpl })
    store.noteSpend(0.9)

    expect(await readFile(good.paths.statusPath, 'utf-8')).toBe(before)
    expect(existsSync(`${good.paths.statusPath}.tmp`)).toBe(false)
  })

  it('깨진 status.json은 빈 상태로 시작한다(버퍼·교재는 파일이 정본)', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await writeFile(store.paths.statusPath, '{ not json', 'utf-8')
    const fresh = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    expect(fresh.getState()).toMatchObject({ totalCards: 0, warnings: [], lastError: null })
  })
})

// ── 4. 버퍼 일자 경계 ───────────────────────────────────────────────────────

describe('버퍼 일자 경계', () => {
  it('자정을 넘기면 다른 파일로 간다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T00:00:01') })
    await store.appendExchange({ u: '늦었네', a: '그러게요', t: at('2026-09-01T23:59:59') })
    await store.appendExchange({ u: '새 날', a: '그렇네요', t: at('2026-09-02T00:00:01') })

    expect((await readdir(store.paths.buffersDir)).sort()).toEqual(['2026-09-01.jsonl', '2026-09-02.jsonl'])
    expect(store.readBuffer('2026-09-01')).toEqual([
      { t: at('2026-09-01T23:59:59'), u: '늦었네', a: '그러게요' }
    ])
  })

  it('오늘 버퍼는 변환 대기에 들어가지 않는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    await store.appendExchange({ u: 'a', a: 'b', t: at('2026-09-01T10:00:00') })
    await store.appendExchange({ u: 'c', a: 'd', t: at('2026-09-02T10:00:00') })
    expect(store.pendingDays()).toEqual(['2026-09-01'])
  })

  it('기록 시각의 일자로 확정된다 — 자정 뒤에 flush돼도 어제 파일', async () => {
    let clock = at('2026-09-01T23:59:59')
    const store = createCoursewareStore({ dir, now: () => clock })
    const pending = store.appendExchange({ u: '막차', a: '조심히요' })
    clock = at('2026-09-02T00:00:05') // flush 되기 전에 날이 바뀐다
    await pending
    expect(await readdir(store.paths.buffersDir)).toEqual(['2026-09-01.jsonl'])
  })

  it('dayKeyOf는 로컬 자정에서 끊긴다', () => {
    expect(dayKeyOf(at('2026-09-01T23:59:59.999'))).toBe('2026-09-01')
    expect(dayKeyOf(at('2026-09-02T00:00:00.000'))).toBe('2026-09-02')
  })
})

// ── 5. E2E (가짜 교사) ──────────────────────────────────────────────────────

describe('E2E — 가짜 대화 2일치 → 변환 잡 → 교재/폐기/상태 골든', () => {
  it('오래된 날부터 하루씩 변환하고 원본을 지운다', async () => {
    let clock = at('2026-09-03T04:00:00')
    const store = createCoursewareStore({ dir, now: () => clock })
    await seedBuffer(store, '2026-09-01', [
      { u: '오늘 커피 두 잔 마셨어', a: '카페인 좀 줄여봐요' },
      { u: '주말엔 등산 갈까 해', a: '날씨 좋대요' }
    ])
    await seedBuffer(store, '2026-09-02', [
      { u: '등산화 새로 샀어', a: '잘 맞던가요?' }
    ])

    // 가짜 교사 — 교환을 그대로 카드로 바꾸고 호출마다 1센트를 쓴 척한다.
    let spent = 0
    const calls = []
    const job = createCoursewareJob({
      store,
      isIdle: () => true,
      convert: async (day, exchanges) => {
        calls.push({ day, count: exchanges.length })
        spent += 0.01
        return {
          status: 'ok',
          spent_today: spent,
          cards: exchanges.map((e) => ({ u: `${e.u}에 대해 물으면?`, a: e.a }))
        }
      }
    })

    expect(await job.runOnce()).toMatchObject({ ok: true, day: '2026-09-01', cards: 2 })
    expect(await job.runOnce()).toMatchObject({ ok: true, day: '2026-09-02', cards: 1 })
    expect(await job.runOnce()).toEqual({ skipped: 'none' })

    expect(calls).toEqual([
      { day: '2026-09-01', count: 2 },
      { day: '2026-09-02', count: 1 }
    ])
    expect(await readdir(store.paths.buffersDir)).toEqual([])

    const cards = {}
    for (const name of (await readdir(store.paths.cardsDir)).sort()) {
      cards[name] = (await readFile(join(store.paths.cardsDir, name), 'utf-8'))
        .trim().split('\n').map((l) => JSON.parse(l))
    }
    const status = JSON.parse(await readFile(store.paths.statusPath, 'utf-8'))
    // 골든이 경로를 품으면 tmp 디렉터리가 바뀔 때마다 깨진다 — path는 따로 본다.
    const { path: statePath, ...state } = store.getState()
    expect(statePath).toBe(dir)
    const snapshot = { cards, status, state }

    if (process.env.UPDATE_GOLDEN === '1') {
      await writeFile(GOLDEN_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
    }
    expect(snapshot).toEqual(JSON.parse(await readFile(GOLDEN_PATH, 'utf-8')))
    void clock
  })

  it('사용자가 쓰는 중이면(유휴 아님) 손대지 않는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: 'a', a: 'b' }])
    const job = createCoursewareJob({
      store,
      isIdle: () => false,
      convert: async () => { throw new Error('교사를 불러선 안 된다') }
    })
    expect(await job.runOnce()).toEqual({ skipped: 'busy' })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(true)
  })

  it('빈 버퍼는 교사를 부르지 않고 닫는다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    fs.mkdirSync(store.paths.buffersDir, { recursive: true })
    fs.writeFileSync(store.paths.bufferPath('2026-09-01'), '', 'utf-8')
    const job = createCoursewareJob({
      store,
      convert: async () => { throw new Error('교사를 불러선 안 된다') }
    })
    expect(await job.runOnce({ force: true })).toMatchObject({ ok: true, cards: 0 })
    expect(existsSync(store.paths.bufferPath('2026-09-01'))).toBe(false)
  })
})

// ── 6. 비차단 ───────────────────────────────────────────────────────────────

describe('버퍼 기록은 대화를 막지 않는다', () => {
  it('appendExchange는 디스크 쓰기 전에 즉시 반환한다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    const promise = store.appendExchange({ u: '빠르게', a: '네' })
    // 동기 구간이 끝난 직후엔 아직 파일이 없다 = 호출자가 쓰기를 기다리지 않았다.
    expect(existsSync(store.paths.bufferPath('2026-09-02'))).toBe(false)
    await promise
    expect(existsSync(store.paths.bufferPath('2026-09-02'))).toBe(true)
  })

  it('연달아 들어온 교환의 순서가 유지된다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-02T09:00:00') })
    for (let i = 0; i < 20; i += 1) store.appendExchange({ u: `u${i}`, a: `a${i}` })
    await store.appendExchange({ u: 'last', a: 'done' })
    const rows = store.readBuffer('2026-09-02')
    expect(rows).toHaveLength(21)
    expect(rows.map((r) => r.u)).toEqual([...Array(20).keys()].map((i) => `u${i}`).concat('last'))
  })
})

// ── 7. A-2 검색 참조 ────────────────────────────────────────────────────────
//
// 검색기 자체는 순수 함수라 파일 없이 본다. 그 다음이 "언제 붙느냐"(첨부 조건·
// 토글)이고, 마지막이 실제 채팅 요청 body 골든이다.

const CARD = (u, a, day = '2026-09-01') => ({ day, u, a })

describe('검색기 — 문자 2-gram 겹침 상위 3장', () => {
  const cards = [
    CARD('주말에 뭘 하냐고 물으면?', '등산을 간다고 했어요'),
    CARD('커피를 얼마나 마시냐고 물으면?', '하루 두 잔이라고 했어요'),
    CARD('새로 산 게 뭐냐고 물으면?', '등산화를 샀다고 했어요'),
    CARD('좋아하는 계절을 물으면?', '가을이라고 했어요')
  ]

  it('겹침이 많은 순으로 준다 (한국어, 형태소 분석 없이)', () => {
    const hit = searchCards('지난주에 말한 등산 얘기 뭐였지?', cards)
    expect(hit.length).toBeGreaterThan(0)
    // "등산"이 든 두 장이 안 든 장보다 먼저 온다.
    expect(hit[0].a).toMatch(/등산/)
    expect(hit.slice(0, 2).every((c) => /등산/.test(c.a))).toBe(true)
  })

  it('겹치는 2-gram이 하나도 없으면 0장', () => {
    expect(searchCards('xyzzy plugh', cards)).toEqual([])
    expect(searchCards('', cards)).toEqual([])
    expect(searchCards('가', cards)).toEqual([]) // 1글자는 2-gram이 안 나온다
  })

  it('최대 3장 + 동점은 카드 순서 유지', () => {
    const many = Array.from({ length: 10 }, (_, i) => CARD(`취미를 물으면?${i}`, '등산이요'))
    const hit = searchCards('취미를 물으면?', many)
    expect(hit).toHaveLength(3)
    expect(hit.map((c) => c.u)).toEqual(['취미를 물으면?0', '취미를 물으면?1', '취미를 물으면?2'])
  })

  it('u/a 양쪽을 다 본다', () => {
    const only = [CARD('그때 뭐라고 했냐면', '토요일에 낚시를 간다고 했어요')]
    expect(searchCards('낚시 얘기', only)).toHaveLength(1)
  })

  it('카드 1천 장 선형 스캔 소요시간', () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      CARD(`${i}번 대화에서 사용자가 말한 것을 물으면?`,
        `${i}번 답변: 등산과 커피와 가을에 대한 이야기였어요`))
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    store.commitCourseware('2026-09-01', many)
    store.findReferences('warmup') // 인덱스 빌드는 측정에서 뺀다(최초 1회)
    const t0 = performance.now()
    for (let i = 0; i < 100; i += 1) store.findReferences('지난주에 말한 등산 얘기가 뭐였지?')
    const per = (performance.now() - t0) / 100
    console.log(`[A-2] 카드 1000장 검색 ${per.toFixed(3)}ms/회`)
    expect(per).toBeLessThan(20) // 대화 경로에 얹으므로 넉넉잡아도 이 아래여야 한다
  })
})

describe('첨부 조건 — attachReferenceCards', () => {
  const seed = (store) => store.commitCourseware('2026-09-01', [
    { u: '취미가 뭐냐고 물으면?', a: '등산이라고 했어요' },
    { u: '커피를 얼마나 마시냐고 물으면?', a: '하루 두 잔이라고 했어요' }
  ])

  it('관련 카드가 있으면 reference_cards를 붙인다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    seed(store)
    const body = attachReferenceCards({ message: '내 취미가 뭐였더라?' }, store, true)
    expect(body.reference_cards).toEqual([{ u: '취미가 뭐냐고 물으면?', a: '등산이라고 했어요' }])
  })

  it('겹치는 카드가 없으면 body를 그대로(같은 객체) 돌려준다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    seed(store)
    const body = { message: 'xyzzy plugh' }
    expect(attachReferenceCards(body, store, true)).toBe(body)
  })

  it('토글 OFF면 검색조차 하지 않는다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    seed(store)
    let searched = 0
    const spy = {
      ...store,
      findReferences: (...args) => { searched += 1; return store.findReferences(...args) }
    }
    const body = { message: '내 취미가 뭐였더라?' }
    expect(attachReferenceCards(body, spy, false)).toBe(body)
    expect(searched).toBe(0)
    expect(store.getState().referenceAttached).toBe(0)
  })

  it('검색이 던져도 대화는 그대로 나간다', () => {
    const body = { message: '내 취미가 뭐였더라?' }
    const broken = { findReferences: () => { throw new Error('index blew up') } }
    expect(attachReferenceCards(body, broken, true)).toBe(body)
  })

  it('첨부 수와 최근 예시만 status에 센다 (발화 원문은 안 남는다)', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    seed(store)
    attachReferenceCards({ message: '내 취미가 뭐였더라?' }, store, true)
    attachReferenceCards({ message: '커피 얼마나 마신댔지' }, store, true)
    const state = store.getState()
    expect(state.referenceAttached).toBe(2)
    expect(state.recentReferences[0]).toBe('커피를 얼마나 마시냐고 물으면?')
    const raw = fs.readFileSync(store.paths.statusPath, 'utf-8')
    expect(raw).not.toMatch(/뭐였더라|마신댔지/)
  })

  it('새 카드가 확정되면 다음 검색이 그것까지 본다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    seed(store)
    expect(attachReferenceCards({ message: '낚시 얘기' }, store, true).reference_cards).toBeUndefined()
    store.commitCourseware('2026-09-02', [{ u: '주말 계획을 물으면?', a: '낚시를 간다고 했어요' }])
    expect(attachReferenceCards({ message: '낚시 얘기' }, store, true).reference_cards)
      .toEqual([{ u: '주말 계획을 물으면?', a: '낚시를 간다고 했어요' }])
  })
})

describe('E2E — 가짜 카드를 심고 "지난주에 말한 취미" 질의 (백엔드는 가짜)', () => {
  it('채팅 요청 body 골든', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-10T09:00:00') })
    store.commitCourseware('2026-09-01', [
      // 이 질의가 찾아야 할 카드.
      { u: '취미가 뭐냐고 물으면?', a: '주말마다 등산을 간다고 했어요' },
      { u: '커피를 얼마나 마시냐고 물으면?', a: '하루 두 잔이라고 했어요' }
    ])
    store.commitCourseware('2026-09-02', [
      // 미끼 1: 같은 등산 얘기지만 "취미"라는 글자가 없다.
      { u: '새로 산 게 뭐냐고 물으면?', a: '등산화를 샀다고 했어요' },
      // 미끼 2: 아예 상관없는 카드.
      { u: '좋아하는 계절을 물으면?', a: '가을이라고 했어요' }
    ])

    // 가짜 백엔드 — main.js의 두 초크포인트가 만드는 body를 그대로 받는다.
    const sent = []
    const fakeBackend = async (body) => { sent.push(body); return { reply: '그 등산 얘기요?' } }

    const message = '지난주에 말한 취미가 뭐였지?'
    const chatBody = () => ({
      message, history: [], ai_mode: 'claude', memory_turns: 10, use_web: false
    })
    await fakeBackend(attachReferenceCards(chatBody(), store, true))
    // 토글 OFF인 두 번째 교환은 키 자체가 붙지 않는다.
    await fakeBackend(attachReferenceCards(chatBody(), store, false))

    // 골든이 "우연히 빈 결과"로 굳는 걸 막는 산 증인.
    expect(sent[0].reference_cards).toBeDefined()
    expect(sent[1].reference_cards).toBeUndefined()

    const { path: statePath, ...state } = store.getState()
    expect(statePath).toBe(dir)
    const snapshot = { sent, state }
    if (process.env.UPDATE_GOLDEN === '1') {
      await writeFile(REFERENCE_GOLDEN_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
    }
    expect(snapshot).toEqual(JSON.parse(await readFile(REFERENCE_GOLDEN_PATH, 'utf-8')))
  })
})

// ── 8. 부수 정리 2건 ────────────────────────────────────────────────────────

describe('verifiedCardCount — day 필드까지 검증', () => {
  const strayCard = (store, day) => {
    fs.mkdirSync(store.paths.cardsDir, { recursive: true })
    fs.writeFileSync(
      store.paths.cardsPath(day),
      `${JSON.stringify({ day: '2026-08-30', u: 'q', a: 'a' })}\n`,
      'utf-8'
    )
  }

  it('행의 day가 파일명 일자와 다르면 없는 셈 친다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    strayCard(store, '2026-09-01')
    expect(store.verifiedCardCount('2026-09-01')).toBe(null)
  })

  it('잘못 놓인 카드 파일이 재변환을 막지 못한다', async () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    await seedBuffer(store, '2026-09-01', [{ u: '안녕', a: '안녕하세요' }])
    strayCard(store, '2026-09-01')
    expect(store.reconcileExisting('2026-09-01')).toBe(null)
    let called = 0
    const job = createCoursewareJob({
      store,
      convert: async () => {
        called += 1
        return { status: 'ok', cards: [{ u: '인사는?', a: '반갑게' }] }
      }
    })
    expect(await job.runOnce({ force: true })).toMatchObject({ ok: true, cards: 1 })
    expect(called).toBe(1)
  })

  it('제 일자의 카드는 그대로 화해된다', () => {
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    store.commitCourseware('2026-09-01', [{ u: 'q', a: 'a' }])
    expect(store.verifiedCardCount('2026-09-01')).toBe(1)
  })
})

describe('reconcileExisting — saveStatus 실패를 로깅한다', () => {
  it('상태 쓰기가 실패하면 경고가 남고 결과는 ok', async () => {
    const warns = []
    const store = createCoursewareStore({ dir, now: () => at('2026-09-03T04:00:00') })
    store.commitCourseware('2026-09-01', [{ u: 'q', a: 'a' }])
    await seedBuffer(store, '2026-09-01', [{ u: '늦게 도착', a: '네' }])

    // 카드는 멀쩡한데 status.json만 못 쓰는 상황.
    const broken = createCoursewareStore({
      dir,
      now: () => at('2026-09-03T04:00:00'),
      fsImpl: brokenFs({ writeFileSync: () => { throw new Error('status readonly') } }),
      log: { warn: (...args) => warns.push(args.join(' ')) }
    })
    expect(broken.reconcileExisting('2026-09-01')).toMatchObject({ ok: true, reconciled: true })
    expect(warns.join('\n')).toMatch(/COURSEWARE_RECONCILE_STATUS_FAILED.*2026-09-01/)
  })
})
