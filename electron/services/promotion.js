/**
 * 계단식 승격(A-4) — 그림자로 검증된 발화 유형부터 로컬 학생이 **실제 사용자
 * 응답**을 맡는다. A플랜에서 로컬이 처음 입을 여는 지점이라, 이 파일의 모든
 * 판정은 한쪽으로만 기울어 있다.
 *
 *   승격은 수동(사용자가 관제판에서 토글) / 강등은 자동(품질 폴백률이 넘으면).
 *
 * 비대칭인 이유: 승격이 틀리면 사용자가 **어색한 답을 직접 읽는다**(되돌릴 수
 * 없는 인상), 강등이 틀리면 API를 한동안 더 쓸 뿐이다(돈). 그래서 올라가는
 * 길에는 사람이 서 있고, 내려오는 길은 코드가 혼자 연다.
 *
 * 이 모듈에는 디스크도 네트워크도 없다. 분류·품질·추천·강등은 전부 순수
 * 함수고, 서빙 게이트만 store와 generate를 주입받는다(테스트에서 가짜 로컬·
 * 가짜 API로 전체 시나리오를 돌리기 위한 유일한 seam).
 */

const TYPES = ['greeting', 'reaction', 'personal', 'general']

// ── 1. 발화 유형 분류 ───────────────────────────────────────────────────────
//
// LLM을 부르지 않는다 — 길이·패턴·참조 유무만 본다. 분류가 대화 경로 위에
// 있으므로 여기에 모델 왕복이 끼면 승격의 목적(지연 감소)이 뒤집힌다.

const REACTION_MAX_LEN = 20   // "짧은 호응"의 경계 (미만)
// 인사에 딸린 본론을 인사로 오분류하지 않기 위한 상한. 순수한 인사는 짧다
// ("안녕", "잘 잤어?", "좋은 아침이야") — 이보다 길면 인사말로 운을 뗀
// 본론이고, 그걸 로컬이 인사처럼 받아치면 사용자가 바로 알아챈다.
const GREETING_MAX_LEN = 15

const GREETING_RE = /(안녕|하이|헬로|굿모닝|좋은\s*아침|좋은\s*밤|잘\s*잤|잘\s*자|잘\s*지냈|오랜만|반가|다녀왔|나왔어|왔어|수고했|식사했|밥\s*먹었|뭐\s*하고?\s*있|뭐해|잘\s*있었|^hi$|^hello$)/i

// 질문 신호. '?'가 없어도 한국어는 어미로 묻는다 — 호응(reaction)과 질문을
// 가르는 건 이 목록이다.
const QUESTION_RE = /[?？]|(나요|까요|ㄹ까|을까|를까|인가|는가|냐|니\?|어때|어떻|무엇|뭐야|뭐지|뭔데|왜|언제|어디|누구|누가|얼마|몇)/

/**
 * 발화 하나의 유형. 순수 함수 — 시계도 상태도 보지 않는다.
 *
 * 순서가 계약이다. **personal이 제일 먼저** 걸린다: 참조 카드가 붙었다는 건
 * 이 발화가 사용자의 과거 기록을 물었다는 뜻인데, 로컬 서빙 경로는 참조 카드를
 * 프롬프트에 **싣지 않는다**(/training/shadow는 발화 하나만 받는다). 그 상태로
 * 로컬이 답하면 기억을 지어내게 된다 — 사용자가 personal을 명시적으로 승격한
 * 경우에만 그 위험을 지게 만든다.
 *
 * @param {string} message
 * @param {{hasReferenceCards?: boolean}} ctx
 * @returns {'greeting'|'reaction'|'personal'|'general'}
 */
function classifyUtterance(message, { hasReferenceCards = false } = {}) {
  const text = String(message == null ? '' : message).trim()
  if (hasReferenceCards) return 'personal'
  if (!text) return 'general'
  const len = text.length
  const isQuestion = QUESTION_RE.test(text)
  // 인사는 "짧고 + 인사 패턴"이 동시에 성립할 때만. "안녕, 어제 산 등산화 어땠어?"는
  // 인사가 아니라 본론이다.
  if (len <= GREETING_MAX_LEN && GREETING_RE.test(text)) return 'greeting'
  if (len < REACTION_MAX_LEN && !isQuestion) return 'reaction'
  return 'general'
}

// ── 2. 승격 추천 (표시용) ───────────────────────────────────────────────────

const RECOMMEND_MIN_ATTEMPTS = 30
const RECOMMEND_MIN_SIMILARITY = 0.55
const TREND_DROP_TOLERANCE = 0.05 // 이만큼까지의 하락은 잡음으로 본다

/**
 * 이 유형을 승격 후보로 **표시**해도 되는가. 자동 승격은 어디에도 없다 —
 * 이 함수의 true는 관제판 토글의 잠금을 푸는 것 하나만 한다.
 *
 * @param {{attempts:number, avgSimilarity:number|null, recentAvg:number|null, priorAvg:number|null}} stats
 */
function recommendPromotion(stats = {}) {
  const attempts = Number(stats.attempts) || 0
  const avg = Number.isFinite(stats.avgSimilarity) ? stats.avgSimilarity : null
  if (attempts < RECOMMEND_MIN_ATTEMPTS) {
    return { recommended: false, reason: `시도 ${attempts}회 (${RECOMMEND_MIN_ATTEMPTS}회 필요)` }
  }
  if (avg == null || avg < RECOMMEND_MIN_SIMILARITY) {
    return {
      recommended: false,
      reason: `평균 유사도 ${((avg || 0) * 100).toFixed(0)}% (${RECOMMEND_MIN_SIMILARITY * 100}% 필요)`
    }
  }
  // 추세는 최근 7일 vs 그 이전 7일. 이전 구간에 표본이 없으면 "하락 아님"이다 —
  // 이제 막 쌓이기 시작한 유형을 비교 대상 없이 떨어뜨리지 않는다.
  const recent = Number.isFinite(stats.recentAvg) ? stats.recentAvg : null
  const prior = Number.isFinite(stats.priorAvg) ? stats.priorAvg : null
  if (recent != null && prior != null && recent < prior - TREND_DROP_TOLERANCE) {
    return { recommended: false, reason: '최근 추세 하락' }
  }
  return { recommended: true, reason: '조건 충족' }
}

// ── 3. 품질 필터 (어색 한국어 게이트) ───────────────────────────────────────
//
// 사용자 실기 피드백에서 나온 네 가지 실패 모드를 그대로 막는다. 여기서 걸린
// 답은 **사용자에게 보이지 않고** API로 조용히 넘어간다 — 폴백이 투명한 게
// 이 기능의 전제다(사용자는 차이를 몰라야 한다).

// 한자·가나·키릴·아랍·데바나가리. 라틴 문자와 숫자는 막지 않는다 — "PC", "AI"
// 처럼 한국어 문장에 정상적으로 섞이는 것들이다.
const FOREIGN_SCRIPT_RE = /[぀-ヿ㐀-䶿一-鿿Ѐ-ӿ؀-ۿऀ-ॿ]/
// 마크다운 — 말로 하지 않는 기호. 로컬 학생이 교재 형식을 그대로 뱉을 때 나온다.
const MARKDOWN_RE = /(\*\*|__|```|^\s*#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s)/m
// 금칙 패턴 — 비서가 자기 구현을 드러내는 말투.
const BANNED_RE = /(제\s*기록에\s*따르면|기록에\s*따르면|제\s*데이터|학습된\s*바|제\s*교재|as\s+an\s+ai|저는\s*(인공지능|AI))/i

const QUALITY_MIN_LEN = 3
const QUALITY_LEN_MULTIPLE = 10 // 질문 길이의 이 배수를 넘으면 이상
// 10배 규칙의 바닥. 비율만으로 재면 "안녕"(2자)에 20자 넘는 답이 전부 이상이
// 되어 **가장 승격하기 좋은 유형인 인사가 영원히 못 나간다** — 실측에서 인사
// 응답은 30~60자였다. 장황함은 비율이 아니라 절대 길이로도 걸러야 한다.
const QUALITY_LEN_FLOOR = 120

/**
 * 로컬이 낸 답을 사용자에게 보여도 되는가. 한 가지라도 걸리면 API 폴백.
 *
 * @param {string} reply  로컬 학생의 답
 * @param {string} message 원래 발화 (길이 비교 기준)
 * @returns {{ok: boolean, reason: string|null}}
 */
function qualityVerdict(reply, message = '') {
  const text = String(reply == null ? '' : reply).trim()
  if (!text) return { ok: false, reason: '빈 응답' }
  if (text.length < QUALITY_MIN_LEN) return { ok: false, reason: '응답이 너무 짧음' }
  const askLen = String(message == null ? '' : message).trim().length
  if (askLen > 0 && text.length > Math.max(askLen * QUALITY_LEN_MULTIPLE, QUALITY_LEN_FLOOR)) {
    return { ok: false, reason: '응답이 질문의 10배 초과' }
  }
  if (FOREIGN_SCRIPT_RE.test(text)) return { ok: false, reason: '한자·비한글 혼입' }
  if (MARKDOWN_RE.test(text)) return { ok: false, reason: '마크다운 기호' }
  if (BANNED_RE.test(text)) return { ok: false, reason: '금칙 패턴' }
  return { ok: true, reason: null }
}

// ── 4. 자동 강등 ────────────────────────────────────────────────────────────

const DEMOTION_WINDOW = 20   // 최근 이만큼의 **로컬 생성 결과**만 본다
const DEMOTION_RATE = 0.3    // 이 비율을 초과하면 강등

/**
 * 최근 창이 다 찼고 품질 폴백률이 30%를 넘으면 강등.
 *
 * 창이 다 차기 전에는 판정하지 않는다 — 2회 중 1회 실패(50%)로 갓 승격한
 * 유형을 즉시 떨어뜨리면 토글이 장난감이 된다.
 *
 * @param {number[]} outcomes 1 = 품질 미달, 0 = 통과. 최신이 앞이든 뒤든 무관.
 */
function demotionVerdict(outcomes = []) {
  const list = Array.isArray(outcomes) ? outcomes.slice(-DEMOTION_WINDOW) : []
  if (list.length < DEMOTION_WINDOW) {
    return { demote: false, reason: null, rate: null, samples: list.length }
  }
  const fails = list.reduce((sum, v) => sum + (v ? 1 : 0), 0)
  const rate = fails / list.length
  if (rate > DEMOTION_RATE) {
    return {
      demote: true,
      rate,
      samples: list.length,
      reason: `최근 ${list.length}회 중 품질 미달 ${fails}회 (${(rate * 100).toFixed(0)}%)`
    }
  }
  return { demote: false, reason: null, rate, samples: list.length }
}

// ── 5. 서빙 게이트 ──────────────────────────────────────────────────────────

// 생성 상한. 넘으면 사용자 모르게 API로. 기본 5초는 발주서 값이고, env는
// 튜닝 손잡이다 — 실측(RTX 3060 / Qwen3-4B 4bit)에서 인사 한 줄 생성이
// 3~6초라 기본값이 빠듯하다. 더 큰 모델이나 느린 GPU에서는 올려야 로컬이
// 실제로 입을 연다. 코드에 테스트 전용 분기를 만들지 않으려고 상수를 밖으로 뺐다.
const LOCAL_SERVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.APIA_PROMOTION_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5000
})()

/**
 * 승격된 유형이면 로컬 학생에게 먼저 시키고, 폴백 네 조건 중 하나라도 걸리면
 * API로 넘긴다.
 *
 * 반환 규약이 세 갈래다 — 호출자(main.js)가 분기를 더 만들지 않도록:
 *   null                              승격 OFF. **기존 경로 그대로**, 아무것도 세지 않는다.
 *   { source:'local', reply, type }   로컬이 답했다. 이 문자열을 그대로 사용자에게.
 *   { source:'api', type, reason }    폴백. 호출자는 평소대로 /chat을 부른다.
 *
 * @param {object} deps
 * @param {object} deps.store           nightSchool store (승격 상태·서빙 집계 소유)
 * @param {(message:string, opts:{timeoutMs:number}) => Promise<{status?:string, reply?:string, reason?:string}>} deps.generate
 *        로컬 생성 1회. 모델을 **올리지 않는다** — 상주하지 않으면 dormant를 돌려준다.
 */
function createServingGate({ store, generate, timeoutMs = LOCAL_SERVE_TIMEOUT_MS } = {}) {
  if (!store || typeof generate !== 'function') {
    throw new Error('createServingGate: store and generate required')
  }

  async function serve(message, { hasReferenceCards = false, type: given } = {}) {
    // 승격이 하나도 없으면 분류조차 하지 않는다 — 승격 OFF에서 기존 경로에
    // 붙는 비용은 이 불리언 조회 하나다(§6.5 지연 증명).
    if (!store.hasPromotion()) return null
    const type = given || classifyUtterance(message, { hasReferenceCards })
    if (!store.isPromoted(type)) return null

    // 폴백 ①: 채택 델타 없음. 델타 없이는 "로컬 학생"이라는 게 존재하지 않는다.
    if (!store.adoptedDelta()) {
      store.noteServing({ type, source: 'api', reason: '채택 델타 없음' })
      return { source: 'api', type, reason: '채택 델타 없음' }
    }

    let res
    try {
      res = await generate(message, { timeoutMs })
    } catch (error) {
      // 폴백 ②: 생성 5초 초과(abort) 또는 백엔드 오류.
      const reason = /abort/i.test(error?.name || error?.message || '') ? '생성 5초 초과' : (error?.message || String(error))
      store.noteServing({ type, source: 'api', reason: String(reason).slice(0, 80) })
      return { source: 'api', type, reason }
    }

    // 폴백 ③: 로컬 모델 미상주 등 백엔드가 휴면을 돌려준 경우. 로드를 유발하지
    // 않는다는 원칙이 여기서 지켜진다 — 안 떠 있으면 그냥 API로 간다.
    if (res?.status !== 'ok') {
      const reason = res?.reason || res?.status || 'no reply'
      store.noteServing({ type, source: 'api', reason: String(reason).slice(0, 80) })
      return { source: 'api', type, reason }
    }

    // 폴백 ④: 품질 필터. 여기서만 강등 창에 기록한다 — 모델이 실제로 답을
    // 낸 경우만 모델 탓이다(미상주·타임아웃은 환경 탓이라 창에 넣지 않는다).
    // status가 ok인데 본문이 비었다면 그건 환경이 아니라 **모델이 낸 결과**다 —
    // 품질 실패로 세야 빈 답만 뱉는 델타가 제때 강등된다.
    const verdict = qualityVerdict(res.reply, message)
    if (!verdict.ok) {
      store.noteServing({ type, source: 'api', reason: verdict.reason, quality: true })
      return { source: 'api', type, reason: verdict.reason }
    }
    store.noteServing({ type, source: 'local' })
    return { source: 'local', type, reply: res.reply }
  }

  return { serve }
}

module.exports = {
  TYPES,
  REACTION_MAX_LEN,
  GREETING_MAX_LEN,
  RECOMMEND_MIN_ATTEMPTS,
  RECOMMEND_MIN_SIMILARITY,
  DEMOTION_WINDOW,
  DEMOTION_RATE,
  LOCAL_SERVE_TIMEOUT_MS,
  classifyUtterance,
  recommendPromotion,
  qualityVerdict,
  demotionVerdict,
  createServingGate
}
