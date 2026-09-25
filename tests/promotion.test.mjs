/**
 * 계단식 승격(A-4) — 유형 분류 / 승격 추천 / 품질 필터 / 자동 강등 / 서빙 분기.
 *
 * 이 파일이 지키는 불변식은 하나다: **승격은 사용자만, 강등은 코드가.**
 * 어떤 경로로도 코드가 스스로 유형을 켜지 못하고, 품질 미달은 사용자가 보기
 * 전에 API로 새는 것까지가 한 세트다. 마지막 describe가 그 전체 수명을
 * 가짜 로컬·가짜 API로 한 번에 돌리는 golden이다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  classifyUtterance,
  recommendPromotion,
  qualityVerdict,
  demotionVerdict,
  createServingGate,
  DEMOTION_WINDOW,
  RECOMMEND_MIN_ATTEMPTS,
  RECOMMEND_MIN_SIMILARITY
} = require('../electron/services/promotion')
const { createNightSchoolStore } = require('../electron/services/nightSchool')

describe('유형 분류 — 길이·패턴·참조 유무만 본다 (LLM 없음)', () => {
  it('인사는 greeting', () => {
    expect(classifyUtterance('안녕!')).toBe('greeting')
    expect(classifyUtterance('잘 잤어?')).toBe('greeting')
    expect(classifyUtterance('오랜만이야')).toBe('greeting')
    expect(classifyUtterance('굿모닝')).toBe('greeting')
  })

  it('인사말로 시작해도 본론이 붙으면 greeting이 아니다', () => {
    // 인사 뒤에 질문이 오면 로컬이 인사처럼 답해선 안 된다.
    expect(classifyUtterance('안녕, 어제 내가 산 등산화 어땠다고 했더라?')).toBe('general')
  })

  it('20자 미만 비질문은 reaction', () => {
    expect(classifyUtterance('오 그렇구나')).toBe('reaction')
    expect(classifyUtterance('응 알겠어')).toBe('reaction')
  })

  it('경계: 20자 정확히면 reaction이 아니다', () => {
    const twenty = '가'.repeat(20)
    expect(twenty.length).toBe(20)
    expect(classifyUtterance(twenty)).toBe('general')
    expect(classifyUtterance('가'.repeat(19))).toBe('reaction')
  })

  it('짧아도 질문이면 reaction이 아니다', () => {
    expect(classifyUtterance('이거 왜 이래')).toBe('general')
    expect(classifyUtterance('진짜?')).toBe('general')
  })

  it('참조 카드가 붙으면 무조건 personal — 로컬 경로는 카드를 싣지 않는다', () => {
    // greeting으로 보였을 발화라도 카드가 붙었으면 personal이다. 카드 없이
    // 로컬이 답하면 기억을 지어낸다.
    expect(classifyUtterance('안녕', { hasReferenceCards: true })).toBe('personal')
    expect(classifyUtterance('그때 그거 뭐였지', { hasReferenceCards: true })).toBe('personal')
  })

  it('빈 발화는 general (분류가 던지지 않는다)', () => {
    expect(classifyUtterance('')).toBe('general')
    expect(classifyUtterance(null)).toBe('general')
    expect(classifyUtterance(undefined)).toBe('general')
  })
})

describe('승격 추천 — 세 조건이 각각 단독으로 막는다', () => {
  const OK = { attempts: 40, avgSimilarity: 0.7, recentAvg: 0.7, priorAvg: 0.68 }

  it('전부 충족하면 추천', () => {
    expect(recommendPromotion(OK).recommended).toBe(true)
  })

  it('시도가 30회 미만이면 거절', () => {
    const v = recommendPromotion({ ...OK, attempts: RECOMMEND_MIN_ATTEMPTS - 1 })
    expect(v.recommended).toBe(false)
    expect(v.reason).toContain('시도')
  })

  it('평균 유사도가 0.55 미만이면 거절', () => {
    const v = recommendPromotion({ ...OK, avgSimilarity: RECOMMEND_MIN_SIMILARITY - 0.01 })
    expect(v.recommended).toBe(false)
    expect(v.reason).toContain('유사도')
  })

  it('최근 추세가 하락이면 거절', () => {
    const v = recommendPromotion({ ...OK, recentAvg: 0.6, priorAvg: 0.75 })
    expect(v.recommended).toBe(false)
    expect(v.reason).toContain('하락')
  })

  it('잡음 수준(5%p 이내) 하락은 하락이 아니다', () => {
    expect(recommendPromotion({ ...OK, recentAvg: 0.68, priorAvg: 0.7 }).recommended).toBe(true)
  })

  it('비교 구간에 표본이 없으면 하락으로 보지 않는다', () => {
    expect(recommendPromotion({ ...OK, recentAvg: 0.7, priorAvg: null }).recommended).toBe(true)
  })
})

describe('품질 필터 — 어색 한국어 네 갈래', () => {
  const ASK = '오늘 날씨 어때?'

  it('정상 응답은 통과', () => {
    expect(qualityVerdict('맑아요. 산책하기 좋겠어요.', ASK).ok).toBe(true)
  })

  it('한자 혼입은 미달', () => {
    expect(qualityVerdict('오늘은 晴天이에요', ASK)).toMatchObject({ ok: false })
    expect(qualityVerdict('오늘은 晴天이에요', ASK).reason).toContain('한자')
  })

  it('가나·키릴도 같은 사유로 막는다', () => {
    expect(qualityVerdict('오늘은 そうですね 맑아요', ASK).ok).toBe(false)
    expect(qualityVerdict('오늘은 хорошо 맑아요', ASK).ok).toBe(false)
  })

  it('라틴 문자는 막지 않는다 — PC/AI는 정상 한국어', () => {
    expect(qualityVerdict('PC 옆에 두고 쓰기 좋아요', ASK).ok).toBe(true)
  })

  it('마크다운 기호는 미달', () => {
    expect(qualityVerdict('**맑아요**', ASK).reason).toContain('마크다운')
    expect(qualityVerdict('- 맑아요\n- 따뜻해요', ASK).reason).toContain('마크다운')
    expect(qualityVerdict('```\n맑아요\n```', ASK).reason).toContain('마크다운')
  })

  it('3자 미만은 미달', () => {
    expect(qualityVerdict('응', ASK).ok).toBe(false)
  })

  it('질문 길이의 10배를 넘으면 미달', () => {
    const long = '오늘은 아주 맑고 바람도 선선해서 나가 있기 좋은 날씨예요. '.repeat(12)
    expect(long.length).toBeGreaterThan(ASK.length * 10)
    expect(qualityVerdict(long, ASK).reason).toContain('10배')
  })

  it('짧은 발화에는 바닥이 있다 — "안녕"에 40자 답이 장황은 아니다', () => {
    // 비율만 보면 "안녕"(2자)×10 = 20자. 인사 응답은 실측 30~60자라 그 규칙만
    // 남기면 가장 승격하기 좋은 유형이 영원히 막힌다.
    expect(qualityVerdict('안녕! 오늘도 좋은 하루 되세요. 어떤 기분이에요?', '안녕').ok).toBe(true)
    expect(qualityVerdict('안녕! '.repeat(40), '안녕').ok).toBe(false)
  })

  it('금칙 패턴은 미달', () => {
    expect(qualityVerdict('제 기록에 따르면 맑습니다', ASK).reason).toContain('금칙')
    expect(qualityVerdict('저는 AI라서 잘 모르겠어요', ASK).reason).toContain('금칙')
  })

  it('빈 응답은 미달', () => {
    expect(qualityVerdict('', ASK).ok).toBe(false)
    expect(qualityVerdict('   ', ASK).ok).toBe(false)
  })
})

describe('자동 강등 — 창이 다 찬 뒤에만, 30% 초과에서만', () => {
  const window = (fails) => Array.from({ length: DEMOTION_WINDOW }, (_, i) => (i < fails ? 1 : 0))

  it('창이 덜 찼으면 판정하지 않는다 (2회 중 1회 실패로 강등 금지)', () => {
    expect(demotionVerdict([1, 0]).demote).toBe(false)
  })

  it('정확히 30%면 강등하지 않는다 (초과여야 한다)', () => {
    expect(demotionVerdict(window(6)).demote).toBe(false) // 6/20 = 30%
  })

  it('30% 초과면 강등', () => {
    const v = demotionVerdict(window(7)) // 7/20 = 35%
    expect(v.demote).toBe(true)
    expect(v.reason).toContain('35%')
  })

  it('창을 넘긴 오래된 결과는 버린다', () => {
    // 앞의 실패 20개는 잘려 나가고 최근 20개(전부 통과)만 본다.
    expect(demotionVerdict([...window(20), ...window(0)]).demote).toBe(false)
  })
})

// ── E2E golden: 가짜 로컬 + 가짜 API로 승격 수명 전체 ───────────────────────

let dir
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'apia-promotion-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function makeDelta(target) {
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'adapter_config.json'), '{"peft_type":"LORA"}', 'utf-8')
  writeFileSync(join(target, 'adapter_model.safetensors'), 'weights', 'utf-8')
  return target
}

/** 승격 추천이 나올 만큼 greeting 그림자를 채운다. */
function fillShadow(store, type, count, sim) {
  for (let i = 0; i < count; i += 1) store.noteShadow({ similarity: sim, lengthRatio: 0.9, type })
}

describe('golden — 승격 → 로컬 서빙 → 품질 미달 → API 폴백 → 자동 강등', () => {
  it('전체 수명이 관제판 상태에 그대로 반영된다', async () => {
    const store = createNightSchoolStore({ dir })
    const candidate = makeDelta(join(dir, 'candidate'))
    expect(store.adopt('v1', candidate, { pass: true }, 30).ok).toBe(true)

    // ① 승격 OFF: 게이트는 null을 돌려주고 아무것도 세지 않는다 = 기존 경로.
    let localReply = '안녕하세요! 좋은 아침이에요.'
    let calls = 0
    const gate = createServingGate({
      store,
      generate: async () => { calls += 1; return { status: 'ok', reply: localReply } }
    })
    expect(await gate.serve('안녕')).toBe(null)
    expect(calls).toBe(0)
    expect(store.getState().serving.total).toBe(0)

    // ② 추천 전에는 승격을 켤 수 없다.
    expect(store.getState().byType.greeting.recommended).toBe(false)
    fillShadow(store, 'greeting', RECOMMEND_MIN_ATTEMPTS + 5, 0.72)
    expect(store.getState().byType.greeting.recommended).toBe(true)

    // ③ 사용자가 켠다 → 로컬이 답한다.
    store.setPromotion('greeting', true)
    const served = await gate.serve('안녕')
    expect(served).toMatchObject({ source: 'local', type: 'greeting', reply: localReply })
    expect(calls).toBe(1)
    expect(store.getState().serving).toMatchObject({ local: 1, api: 0 })

    // ④ 승격하지 않은 유형은 여전히 기존 경로 — 분류가 맞아도 세지 않는다.
    expect(await gate.serve('그 얘기 좀 더 해줄래', { hasReferenceCards: true })).toBe(null)
    expect(store.getState().serving.total).toBe(1)

    // ⑤ 품질 미달 주입 → 사용자는 못 보고 API로 샌다.
    localReply = '**안녕하세요** 晴天입니다'
    const fell = await gate.serve('안녕')
    expect(fell).toMatchObject({ source: 'api', type: 'greeting' })
    expect(fell.reason).toBeTruthy()
    expect(store.getState().serving).toMatchObject({ local: 1, api: 1 })

    // ⑥ 20회 중 30%를 넘길 때까지 계속 미달 → 자동 강등.
    //    (①~⑤에서 창에 이미 통과 1 + 미달 1이 들어 있다)
    for (let i = 0; i < 6; i += 1) await gate.serve('안녕')
    expect(store.isPromoted('greeting')).toBe(true) // 아직 창이 덜 찼다
    localReply = '안녕하세요! 좋은 아침이에요.'
    for (let i = 0; i < 12; i += 1) await gate.serve('안녕')

    const state = store.getState()
    expect(state.promotion.greeting).toBe(false)   // 강등됐다
    expect(state.demotions[0]).toMatchObject({ type: 'greeting' })
    expect(state.demotions[0].reason).toContain('품질 미달')

    // ⑦ 강등 후에는 다시 기존 경로. 관제판에 사유가 남아 있다.
    const after = store.getState().serving.total
    expect(await gate.serve('안녕')).toBe(null)
    expect(store.getState().serving.total).toBe(after)
    expect(state.serving.topReasons.some((r) => /마크다운|한자/.test(r.reason))).toBe(true)
  })

  it('채택 델타가 없으면 승격돼 있어도 API로 — 로컬 로드를 유발하지 않는다', async () => {
    const store = createNightSchoolStore({ dir })
    fillShadow(store, 'greeting', RECOMMEND_MIN_ATTEMPTS, 0.8)
    store.setPromotion('greeting', true)
    let calls = 0
    const gate = createServingGate({
      store,
      generate: async () => { calls += 1; return { status: 'ok', reply: '안녕하세요' } }
    })
    expect(await gate.serve('안녕')).toMatchObject({ source: 'api', reason: '채택 델타 없음' })
    expect(calls).toBe(0) // 생성 자체를 시도하지 않는다
  })

  it("status가 ok인데 본문이 비면 품질 실패로 센다 — 강등 창에 들어간다", async () => {
    const store = createNightSchoolStore({ dir })
    expect(store.adopt('v1', makeDelta(join(dir, 'c')), null, 10).ok).toBe(true)
    fillShadow(store, 'greeting', RECOMMEND_MIN_ATTEMPTS, 0.8)
    store.setPromotion('greeting', true)
    const gate = createServingGate({ store, generate: async () => ({ status: 'ok', reply: '' }) })

    for (let i = 0; i < DEMOTION_WINDOW; i += 1) {
      expect(await gate.serve('안녕')).toMatchObject({ source: 'api', reason: '빈 응답' })
    }
    // 빈 답만 뱉는 델타는 환경 탓이 아니라 모델 탓 — 창이 차면 강등된다.
    expect(store.isPromoted('greeting')).toBe(false)
    expect(store.getState().demotions[0]).toMatchObject({ type: 'greeting' })
  })

  it('모델 미상주(dormant)와 5초 초과(abort)는 강등 창에 들어가지 않는다', async () => {
    const store = createNightSchoolStore({ dir })
    expect(store.adopt('v1', makeDelta(join(dir, 'c')), null, 10).ok).toBe(true)
    fillShadow(store, 'greeting', RECOMMEND_MIN_ATTEMPTS, 0.8)
    store.setPromotion('greeting', true)

    let mode = 'dormant'
    const gate = createServingGate({
      store,
      generate: async () => {
        if (mode === 'dormant') return { status: 'dormant', reason: 'local model not resident' }
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
    })
    for (let i = 0; i < DEMOTION_WINDOW; i += 1) await gate.serve('안녕')
    mode = 'timeout'
    for (let i = 0; i < DEMOTION_WINDOW; i += 1) await gate.serve('안녕')

    // 환경 탓으로 40번 폴백했지만 모델을 벌하지 않는다 — 승격은 그대로다.
    expect(store.isPromoted('greeting')).toBe(true)
    expect(store.getState().demotions).toEqual([])
    const reasons = store.getState().serving.topReasons.map((r) => r.reason)
    expect(reasons.some((r) => r.includes('not resident'))).toBe(true)
    expect(reasons).toContain('생성 5초 초과')
  })
})
