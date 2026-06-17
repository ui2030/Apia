// G단계 — 감정 → PMX 표정 모프 연동 + 깜빡임.
//
// 표정 모프가 풍부한 PMX(예: 170 모프)는 まばたき·笑い·怒り 등 표정 모프를 갖고
// 있지만 지금까지 아무도 안 썼다 (VRM만 expressionManager 펄스, PMX는
// 깜빡임조차 dummy 전용 경로라 미적용). 이 모듈이 그 구멍을 메운다.
//
// 소유권 규칙 (Codex 사전 검토 반영):
// - 관리 대상 = 프리셋에 등장하는 모프 합집합 + まばたき. **그 외 모프는
//   절대 안 건드린다** — ★貫通対策(뚫림 방지, 로드 시 1.0 고정)과 ON_xxx
//   의상 토글이 보존되는 근거.
// - 입 모프(あ 계열)는 관리 대상에서 **제외** — lipsyncMMD가 소유한다.
//   감정 프리셋에 입을 벌리는 표정을 넣고 싶으면 lipsync와 blend 규칙부터
//   정해야 한다 (Codex MUST-FIX로 빠진 이유).
// - 호출 순서: helper/lipsync까지 끝난 뒤 마지막에 update가 돈다 —
//   "managed morphs win after helper/lipsync". VMD에 모프 트랙이 생겨도
//   관리 대상만 덮는다.
//
// 스무딩: 모프별 지수 접근. 진입은 빠르게(표정은 0.2s쯤에 떠야 반응으로
// 느껴짐), 복귀는 느리게(여운). 감정은 HOLD_MS 유지 후 자동 중립 복귀.

const EMOTION_PRESETS = {
  neutral: {},
  happy: { '笑い': 0.55, 'にこり': 0.5, 'にっこり': 0.65 },
  sad: { '困る': 0.75, 'なごみ': 0.45, '口角下げ': 0.4 },
  angry: { '怒り': 0.8, 'じと目': 0.35, '口角下げ': 0.3 },
  // 주의: びっくり에 丸目/瞳小를 합치면 눈 정점 모프끼리 간섭해 흰자 뜬
  // 반감김이 된다 (A/B 스크린샷 비교로 확정) — 단독 びっくり가 정답.
  surprised: { 'びっくり': 0.85, '眉上移動': 0.4 }
}

const BLINK_MORPH = 'まばたき'
const EYE_SMILE_MORPH = '笑い' // 눈웃음이 이미 눈을 감기므로 깜빡임과 합치면 이중 감김

const MANAGED_MORPHS = (() => {
  const set = new Set([BLINK_MORPH])
  for (const preset of Object.values(EMOTION_PRESETS)) {
    for (const name of Object.keys(preset)) set.add(name)
  }
  return [...set]
})()

const RATE_IN = 10  // 1/s — 목표가 현재보다 클 때 (표정 떠오름)
const RATE_OUT = 4  // 1/s — 목표가 작을 때 (여운을 남기며 풀림)
const HOLD_MS = 6000

let _emotion = 'neutral'
let _holdUntil = 0
const _targets = new Map()  // morph name → target weight
const _weights = new Map()  // morph name → smoothed current weight
let _loggedMissing = false

// ── 자율 미세표정 (J단계) ───────────────────────────────────────────
// 무표정으로 굳지 않게, 가끔 눈썹을 까딱하고(brow flick) 입가에 아주 옅은
// 미소가 드나든다(micro-smile). 성격(expressiveness)이 빈도/세기를 정한다.
//
// 소유권 안전: *이미 감정 프리셋에 등장하는* 모프만 건드린다 — 따라서
// MANAGED_MORPHS에 포함돼 reset/추적되고, 貫通対策·ON_xxx 의상 토글은
// 절대 안 건드린다(파일 상단 계약 그대로). 입 모음(あ系)은 손대지 않는다.
// 감정이 떠 있는 동안엔 자율 레이어를 약하게 눌러(프리셋 우선) 싸우지 않게.
// 후보는 *반드시 MANAGED_MORPHS(프리셋에 등장)* 안에서만 고른다 — 모호한
// 이름('上' 등)이 의상/비표정 모프에 잘못 걸리지 않도록(codex 지적). 아래
// 목록은 모두 EMOTION_PRESETS에 등장하는 안전 모프이고, 해석 시 한 번 더
// MANAGED_MORPHS 멤버십을 확인한다. 笑い는 눈을 감기므로 미소 후보에서 제외.
const AUTO_BROW_CANDIDATES = ['眉上移動']        // 눈썹 올림(surprised 프리셋)
const AUTO_SMILE_CANDIDATES = ['にこり', 'にっこり'] // 눈 안 감기는 입가 미소(happy 프리셋)
let _autoT = 0
let _autoBrowNextAt = 1.5
let _autoBrowOnset = -1
let _autoResolved = false
let _autoBrowName = null
let _autoSmileName = null

/** 감정 설정. 알 수 없는 값은 neutral 취급. neutral은 즉시 복귀 시작. */
export function setExpressionEmotion(emotion) {
  const key = EMOTION_PRESETS[emotion] ? emotion : 'neutral'
  _emotion = key
  _holdUntil = key === 'neutral'
    ? 0
    : (typeof performance !== 'undefined' ? performance.now() : Date.now()) + HOLD_MS
  const preset = EMOTION_PRESETS[key]
  for (const name of MANAGED_MORPHS) {
    if (name === BLINK_MORPH) continue
    _targets.set(name, preset[name] ?? 0)
  }
}

export function getExpressionEmotion() {
  return _emotion
}

/** 모델 교체/해제 시 호출 — 이전 모델의 감정 target이 새 모델에 안 샌다. */
export function resetExpression() {
  _emotion = 'neutral'
  _holdUntil = 0
  _targets.clear()
  _weights.clear()
  _loggedMissing = false
  _autoT = 0
  _autoBrowNextAt = 1.5
  _autoBrowOnset = -1
  _autoResolved = false
  _autoBrowName = null
  _autoSmileName = null
}

/**
 * 매 프레임 (MMD 경로, lipsyncMMD 뒤) 호출. blinkValue는
 * characterController의 깜빡임 0..1.
 */
export function updateExpression(model, dt, blinkValue = 0, personality = null) {
  if (model?.type !== 'mmd') return
  const mesh = model.obj
  const dict = model.morphs
  const influences = mesh?.morphTargetInfluences
  if (!dict || !influences) return

  if (!_loggedMissing) {
    _loggedMissing = true
    const missing = MANAGED_MORPHS.filter((n) => dict[n] === undefined)
    if (missing.length) console.info('[expression] 모델에 없는 표정 모프(스킵):', missing)
  }

  // hold 만료 → 중립 복귀
  if (_holdUntil && (typeof performance !== 'undefined' ? performance.now() : Date.now()) > _holdUntil) {
    setExpressionEmotion('neutral')
  }

  const clampedDt = Math.max(0, Math.min(dt, 0.1))
  for (const [name, target] of _targets) {
    const idx = dict[name]
    if (idx === undefined) continue
    const cur = _weights.get(name) ?? 0
    const rate = target > cur ? RATE_IN : RATE_OUT
    const next = cur + (target - cur) * (1 - Math.exp(-rate * clampedDt))
    _weights.set(name, next)
    influences[idx] = next
  }

  // ── 자율 미세표정 패스 ───────────────────────────────────────────
  // 감정 스무딩 위에 *가산*한다. 건드리는 모프는 위 루프가 이미 쓴
  // 모프와 같을 수 있으므로(눈썹/미소가 프리셋에도 등장), 합쳐서 clamp.
  if (!_autoResolved) {
    _autoResolved = true
    const managed = new Set(MANAGED_MORPHS) // 안전망: 관리 대상 밖이면 거부
    const pick = (cands) => cands.find((n) => managed.has(n) && dict[n] !== undefined) ?? null
    _autoBrowName = pick(AUTO_BROW_CANDIDATES)
    _autoSmileName = pick(AUTO_SMILE_CANDIDATES)
  }
  const expr = Math.max(0, Math.min(1, personality?.expressiveness ?? 0.5))
  // 감정이 떠 있으면(neutral 아님) 자율은 약하게 — 프리셋이 주인.
  const autoGain = _holdUntil ? 0.35 : 1
  _autoT += clampedDt

  // brow flick — Poisson 간격(평균은 expressiveness가 높을수록 짧음), 0.7s
  // 동안 부드럽게 떴다 내린다. 가끔만 일어나 "표정 깜빡임"으로 읽힌다.
  if (_autoBrowName && autoGain > 0) {
    const idx = dict[_autoBrowName]
    if (_autoT >= _autoBrowNextAt) {
      _autoBrowOnset = _autoT
      const mean = 8 - expr * 4 // 평균 4~8s 간격
      _autoBrowNextAt = _autoT + 2.0 + (-Math.log(Math.max(0.001, Math.random())) * mean)
    }
    const p = _autoBrowOnset >= 0 ? (_autoT - _autoBrowOnset) / 0.7 : 1
    if (p >= 0 && p < 1) {
      const env = Math.sin(Math.PI * p) // 떴다 내리는 산 모양(항상 위로)
      const offset = env * (0.10 + expr * 0.18) * autoGain
      const base = _weights.get(_autoBrowName) ?? 0
      influences[idx] = Math.max(0, Math.min(1, base + offset))
    }
  }

  // micro-smile — 아주 옅은 미소가 느리게 드나든다(항상 ≥0). 슬픔/분노 땐 생략.
  if (_autoSmileName && _emotion !== 'sad' && _emotion !== 'angry' && autoGain > 0) {
    const idx = dict[_autoSmileName]
    const drift = (0.5 + 0.5 * Math.sin(_autoT * 0.13)) // 0..1, 매우 느림
    const offset = drift * (0.04 + expr * 0.08) * autoGain
    const base = _weights.get(_autoSmileName) ?? 0
    influences[idx] = Math.max(0, Math.min(1, base + offset))
  }

  // 깜빡임 — 눈웃음(笑い) 가중만큼 줄여 이중 감김 방지
  const blinkIdx = dict[BLINK_MORPH]
  if (blinkIdx !== undefined) {
    const smile = _weights.get(EYE_SMILE_MORPH) ?? 0
    influences[blinkIdx] = Math.max(0, Math.min(1, blinkValue)) * (1 - smile)
  }
}
