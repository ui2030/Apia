/**
 * 야간 학습기(A-3) — 트리거 조건 / 델타 교체 원자성 / 앵커 보존 / 그림자 집계.
 *
 * 이 파일의 존재 이유는 두 번째 그룹이다: **게이트를 통과하지 못한 델타는 절대
 * 채택되지 않고, 채택 실패는 이전 델타를 건드리지 않는다.** 학습이 망가지는 건
 * 괜찮지만(다음 주에 다시 한다) 잘 배운 델타를 잃거나 못 배운 델타로 갈아끼우는
 * 건 되돌릴 수 없다. 쓰기 실패·중단·폐기 경로마다 이전 델타가 살아 있음을 본다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const {
  evaluateTrigger,
  similarity,
  lengthRatio,
  createNightSchoolStore,
  createNightSchoolJob,
  awaitChildExit,
  ANCHOR_KEEP,
  IDLE_SEC,
  RENDER_AWAY_SEC
} = require('../electron/services/nightSchool')

let dir
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'apia-nightschool-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const brokenFs = (overrides) => new Proxy(fs, {
  get: (target, prop) => (prop in overrides ? overrides[prop] : target[prop])
})

/** 최소한의 "쓸 수 있는 LoRA 델타" — adapter_config.json + adapter_model.*. */
function makeDelta(target) {
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'adapter_config.json'), '{"peft_type":"LORA"}', 'utf-8')
  writeFileSync(join(target, 'adapter_model.safetensors'), 'weights', 'utf-8')
  return target
}

const DAY = 86400000
const OK = {
  pythonOk: true,
  scriptOk: true,
  idleSec: IDLE_SEC,
  vramFreeGb: 11,
  lastSuccessAt: null,
  totalCards: 30,
  cardsAtLastSuccess: 0,
  now: Date.now()
}

describe('트리거 — 다섯 조건 각각이 단독으로 학습을 막는다', () => {
  it('전부 충족하면 통과', () => {
    const v = evaluateTrigger(OK)
    expect(v.ok).toBe(true)
    expect(v.newCards).toBe(30)
  })

  it('파이썬 경로가 없으면 조용히 비활성', () => {
    expect(evaluateTrigger({ ...OK, pythonOk: false })).toMatchObject({ ok: false })
    expect(evaluateTrigger({ ...OK, pythonOk: false }).reason).toContain('파이썬')
  })

  it('학습 스크립트가 없으면 비활성 (패키징 빌드)', () => {
    expect(evaluateTrigger({ ...OK, scriptOk: false }).reason).toContain('스크립트')
  })

  it('유휴 15분 미만이면 거절 — "지금 시작" 버튼도 면제받지 않는다', () => {
    const v = evaluateTrigger({ ...OK, idleSec: IDLE_SEC - 1 })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('유휴')
  })

  it('렌더 일시정지 기준(5분)보다 짧으면 거절', () => {
    const v = evaluateTrigger({ ...OK, idleSec: RENDER_AWAY_SEC - 1 })
    expect(v.ok).toBe(false)
  })

  it('VRAM 여유 8GB 미만이면 거절 — 게임 중 침범 금지', () => {
    const v = evaluateTrigger({ ...OK, vramFreeGb: 7.9 })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('VRAM')
  })

  it('마지막 성공 후 7일이 안 됐으면 거절', () => {
    const now = Date.now()
    expect(evaluateTrigger({ ...OK, now, lastSuccessAt: now - 6.9 * DAY }).ok).toBe(false)
    expect(evaluateTrigger({ ...OK, now, lastSuccessAt: now - 7.1 * DAY }).ok).toBe(true)
  })

  it('신규 교재 10장 미만이면 거절', () => {
    expect(evaluateTrigger({ ...OK, totalCards: 39, cardsAtLastSuccess: 30 }).ok).toBe(false)
    expect(evaluateTrigger({ ...OK, totalCards: 40, cardsAtLastSuccess: 30 }).ok).toBe(true)
  })
})

describe('유사도 산식 — night_trainer.similarity와 같은 자', () => {
  it('같은 문장은 1, 겹치지 않으면 0', () => {
    expect(similarity('고양이 이름은 모루', '고양이 이름은 모루')).toBe(1)
    expect(similarity('가나다', 'ABCDE')).toBe(0)
  })
  it('빈 문자열은 0 (0으로 나누지 않는다)', () => {
    expect(similarity('', '가나다')).toBe(0)
    expect(lengthRatio('', 'x')).toBe(0)
  })
  it('부분 겹침은 0과 1 사이', () => {
    const s = similarity('고양이 이름은 모루다', '고양이는 모루라고 불러')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })
  it('길이비는 짧은 쪽/긴 쪽', () => {
    expect(lengthRatio('abcd', 'ab')).toBe(0.5)
    expect(lengthRatio('ab', 'ab')).toBe(1)
  })
})

describe('델타 교체 — 원자성과 앵커 보존', () => {
  it('쓸 수 없는 후보는 채택하지 않는다 (빈 폴더)', () => {
    const store = createNightSchoolStore({ dir })
    const empty = join(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(store.adopt('v1', empty).ok).toBe(false)
    expect(store.adoptedDelta()).toBe(null)
  })

  it('채택하면 앵커로 옮겨지고 포인터가 그걸 가리킨다', () => {
    const store = createNightSchoolStore({ dir })
    const cand = makeDelta(join(dir, 'work', 'candidate'))
    const res = store.adopt('v1', cand, { passed: true }, 30)
    expect(res.ok).toBe(true)
    expect(existsSync(cand)).toBe(false)           // 후보는 남지 않는다
    expect(store.adoptedDelta().version).toBe('v1')
    expect(store.getState().cardsAtLastSuccess).toBe(30)
  })

  it('포인터 쓰기가 실패하면 이전 채택 델타가 그대로 남는다', () => {
    const store = createNightSchoolStore({ dir })
    store.adopt('v1', makeDelta(join(dir, 'work', 'c1')), null, 10)

    // status.json 쓰기만 깨뜨린다 — 앵커 이동은 이미 끝난 뒤의 실패를 만든다.
    const broken = createNightSchoolStore({
      dir,
      fsImpl: brokenFs({ writeFileSync: () => { throw new Error('disk full') } })
    })
    const res = broken.adopt('v2', makeDelta(join(dir, 'work', 'c2')), null, 20)
    expect(res.ok).toBe(false)

    // 새 인스턴스가 디스크에서 다시 읽으면 여전히 v1이다.
    const reread = createNightSchoolStore({ dir })
    expect(reread.adoptedDelta().version).toBe('v1')
    expect(reread.getState().cardsAtLastSuccess).toBe(10)
  })

  it('앵커는 최근 8개만 남고, 채택 중인 것은 절대 지우지 않는다', () => {
    const store = createNightSchoolStore({ dir })
    for (let i = 1; i <= ANCHOR_KEEP + 3; i += 1) {
      store.adopt(`v${i}`, makeDelta(join(dir, 'work', `c${i}`)), null, i)
    }
    const kept = readdirSync(store.paths.anchorsDir).sort()
    expect(kept.length).toBe(ANCHOR_KEEP)
    expect(kept).toContain(`v${ANCHOR_KEEP + 3}`)       // 현재 채택분
    expect(kept).not.toContain('v1')                     // 가장 오래된 건 정리
    expect(store.adoptedDelta().version).toBe(`v${ANCHOR_KEEP + 3}`)
  })

  it('포인터가 가리키지 않는 고아 앵커를 시작 시 정리한다', () => {
    // 앵커 이동 직후 status.json 쓰기 전에 죽으면 이런 디렉터리가 남는다.
    const store = createNightSchoolStore({ dir })
    store.adopt('v1', makeDelta(join(dir, 'work', 'c1')), null, 10)
    makeDelta(join(store.paths.anchorsDir, 'orphan-2026-09-26T03-00'))

    const removed = createNightSchoolStore({ dir }).pruneAnchors()
    expect(removed).toBe(1)
    expect(readdirSync(store.paths.anchorsDir)).toEqual(['v1'])
    expect(store.adoptedDelta().version).toBe('v1')   // 채택분은 그대로
  })

  it('앵커 디렉터리가 사라지면 채택 델타는 없는 것으로 본다 (그림자 휴면)', () => {
    const store = createNightSchoolStore({ dir })
    store.adopt('v1', makeDelta(join(dir, 'work', 'c1')), null, 10)
    fs.rmSync(store.adoptedDelta().dir, { recursive: true, force: true })
    expect(store.adoptedDelta()).toBe(null)
  })
})

describe('그림자 집계 — 점수만 남는다', () => {
  it('시도를 세고 7일 평균을 낸다', () => {
    const store = createNightSchoolStore({ dir })
    store.noteShadow({ similarity: 0.4, lengthRatio: 0.8 })
    store.noteShadow({ similarity: 0.6, lengthRatio: 0.6 })
    const s = store.shadowSummary()
    expect(s.attempts7d).toBe(2)
    expect(s.avgSimilarity).toBeCloseTo(0.5, 6)
    expect(s.avgLengthRatio).toBeCloseTo(0.7, 6)
  })

  it('7일 창 밖의 기록은 버린다', () => {
    let clock = new Date('2026-01-10T12:00:00Z').getTime()
    const store = createNightSchoolStore({ dir, now: () => clock })
    store.noteShadow({ similarity: 1, lengthRatio: 1 })
    clock += 9 * DAY
    store.noteShadow({ similarity: 0.2, lengthRatio: 0.2 })
    const s = store.shadowSummary()
    expect(s.attempts7d).toBe(1)
    expect(s.avgSimilarity).toBeCloseTo(0.2, 6)
  })

  it('디스크에 남는 건 숫자뿐 — 원문이 들어갈 자리가 없다', () => {
    const store = createNightSchoolStore({ dir })
    store.noteShadow({ similarity: 0.5, lengthRatio: 0.5 })
    const raw = fs.readFileSync(store.paths.statusPath, 'utf-8')
    expect(raw).not.toContain('reply')
    expect(JSON.parse(raw).shadow).toBeTruthy()
  })

  it('휴면 사유는 같은 값으로 반복 기록하지 않는다', () => {
    const store = createNightSchoolStore({ dir })
    store.noteShadowDormant('채택 델타 없음')
    const first = fs.statSync(store.paths.statusPath).mtimeMs
    store.noteShadowDormant('채택 델타 없음')
    expect(fs.statSync(store.paths.statusPath).mtimeMs).toBe(first)
  })
})

describe('종료 — 학습 자식을 유령으로 남기지 않는다', () => {
  /** child_process 핸들의 최소 흉내 — close 이벤트와 exitCode/kill만 있으면 된다. */
  function fakeChild() {
    const handlers = {}
    return {
      exitCode: null,
      signalCode: null,
      killed: false,
      once: (name, fn) => { handlers[name] = fn },
      kill () { this.killed = true },
      exit () { this.exitCode = 0; handlers.close?.(0) }
    }
  }

  it('자식이 스스로 끝나면 그걸 기다렸다가 끝난다 (kill 없음)', async () => {
    const child = fakeChild()
    const done = awaitChildExit(child, 5000)
    child.exit()
    expect(await done).toBe('exited')
    expect(child.killed).toBe(false)
  })

  it('유예 안에 안 끝나면 kill한다', async () => {
    const child = fakeChild()
    let warned = 0
    expect(await awaitChildExit(child, 10, () => { warned += 1 })).toBe('killed')
    expect(child.killed).toBe(true)
    expect(warned).toBe(1)
  })

  it('이미 끝난 자식/없는 자식은 즉시 — 종료가 유예만큼 멈추면 안 된다', async () => {
    expect(await awaitChildExit(null, 60000)).toBe('already exited')
    const dead = fakeChild()
    dead.exitCode = 0
    expect(await awaitChildExit(dead, 60000)).toBe('already exited')
  })
})

describe('학습 잡 — 게이트 폐기 경로', () => {
  const probeOk = async () => ({
    idleSec: IDLE_SEC, vramFreeGb: 11, totalCards: 30, pythonOk: true, scriptOk: true
  })

  it('통과하면 채택한다', async () => {
    const store = createNightSchoolStore({ dir })
    const job = createNightSchoolJob({
      store,
      probe: probeOk,
      runTrainer: async ({ version }) => ({
        status: 'passed',
        candidate: makeDelta(join(dir, 'work', `cand-${version}`)),
        gate: { passed: true, general_after: 80, recall_after: 60 }
      })
    })
    const res = await job.runOnce({ force: true })
    expect(res.status).toBe('adopted')
    expect(store.adoptedDelta()).toBeTruthy()
  })

  it('게이트 미달이면 후보를 지우고 이전 채택 델타를 유지한다', async () => {
    let clock = Date.now()
    const store = createNightSchoolStore({ dir, now: () => clock })
    store.adopt('old', makeDelta(join(dir, 'work', 'old')), { passed: true }, 10)
    clock += 8 * DAY // 주기 조건을 지나야 학습이 돈다

    const candidate = makeDelta(join(dir, 'work', 'bad'))
    const job = createNightSchoolJob({
      store,
      probe: probeOk,
      now: () => clock,
      runTrainer: async () => ({
        status: 'discarded', reason: '일반 능력 80→30 (50.0p 하락)', candidate
      })
    })
    const res = await job.runOnce({ force: true })
    expect(res.status).toBe('discarded')
    expect(existsSync(candidate)).toBe(false)          // 못 쓴 델타는 남기지 않는다
    expect(store.adoptedDelta().version).toBe('old')   // 이전 델타 그대로
    expect(store.getState().lastReason).toContain('일반 능력')
  })

  it('중단된 학습도 이전 델타를 건드리지 않는다', async () => {
    let clock = Date.now()
    const store = createNightSchoolStore({ dir, now: () => clock })
    store.adopt('old', makeDelta(join(dir, 'work', 'old')), null, 10)
    clock += 8 * DAY
    const job = createNightSchoolJob({
      store,
      probe: probeOk,
      now: () => clock,
      runTrainer: async () => ({ status: 'interrupted', reason: 'user returned' })
    })
    const res = await job.runOnce({ force: true })
    expect(res.status).toBe('interrupted')
    expect(store.adoptedDelta().version).toBe('old')
    expect(store.getState().lastStatus).toBe('interrupted')
  })

  it('조건 미충족이면 학습기를 부르지도 않는다', async () => {
    const store = createNightSchoolStore({ dir })
    let called = 0
    const job = createNightSchoolJob({
      store,
      probe: async () => ({ ...(await probeOk()), idleSec: 5 }),
      runTrainer: async () => { called += 1; return { status: 'passed' } }
    })
    const res = await job.runOnce({ force: true })
    expect(called).toBe(0)
    expect(res.skipped).toBe('trigger')
    expect(store.getState().lastStatus).toBe('deferred') // 버튼으로 불렀으니 사유는 남는다
  })

  it('폴링(force 아님)은 거절 사유로 마지막 학습 기록을 덮어쓰지 않는다', async () => {
    const store = createNightSchoolStore({ dir })
    store.noteRun({ status: 'passed', reason: '통과' })
    const job = createNightSchoolJob({
      store,
      probe: async () => ({ ...(await probeOk()), idleSec: 5 }),
      runTrainer: async () => ({ status: 'passed' })
    })
    await job.runOnce()
    expect(store.getState().lastStatus).toBe('passed')
  })
})
