// H단계 — 음소(비짐) 기반 립싱크.
//
// pyttsx3 TTS는 WAV 바이트만 주고 음소 메타데이터가 없다. 그래서 재생
// 직전에 WAV를 오프라인 분석해 20ms 프레임별 (개구도, 모음 추정) 비짐
// 타임라인을 뽑고, 재생 시점과 동기화해 あ/い/う/え/お 모프에 분배한다.
// 사인파 입뻐끔(구 lipsyncMMD)은 "타임라인이 아예 없을 때"(디코드 실패
// 등)의 폴백으로만 남는다.
//
// 분석 휴리스틱 (아니메식 근사 — 정밀 음소 인식이 아니라 "입이 소리에
// 맞춰 그럴듯하게 움직이는" 것이 목표):
//   - RMS → 개구도. 발화별 p95 정규화 + 노이즈 게이트 (TTS 보이스/볼륨
//     편차 흡수, Codex 권고). 전부 게이트 밑이면(무음 WAV) 닫힌 입
//     타임라인이 된다 — 사인파 폴백이 아니라 (Codex MUST-FIX).
//   - ZCR(영교차율) → 모음 버킷. 높음=전설모음(い/え), 낮음=원순(う/お),
//     중간=あ. Edge-TTS(I단계)로 바뀌면 word boundary 메타데이터로 업그레이드
//     여지 있음.
//
// 동기화: 재생 창(메인 or 채팅 창)이 audio.play() 성공 **후**
// offsetSec(=audio.currentTime)과 함께 타임라인을 넘긴다. 수신 시점을
// t0으로 삼되 offset만큼 되감아 IPC 지연을 흡수한다 (Codex MUST-FIX).

const FRAME_SEC = 0.02
const MAX_FRAMES = 6000      // 120s 상한 — IPC로 들어오는 타임라인 캡
const MAX_DURATION = 120
const VOWELS = ['a', 'i', 'u', 'e', 'o', 'n']

const MMD_VOWEL_MORPHS = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' }
const VRM_VOWEL_EXPRS = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' }

const MOUTH_RATE = 25 // 1/s — 입은 표정보다 훨씬 빨라야 음절을 따라간다

let _timeline = null   // { duration, step, frames: [{open, vowel}] }
let _t0Ms = 0
const _weights = new Map() // morph/expr key → smoothed weight

/** WAV ArrayBuffer → 비짐 타임라인. 실패 시 null (호출부가 폴백 결정). */
export async function analyzeWav(arrayBuffer) {
  try {
    // OfflineAudioContext — autoplay 정책/리소스 누수와 무관한 분석 전용.
    // decodeAudioData가 버퍼를 detach하므로 호출부는 복제본을 줘야 한다.
    const ctx = new OfflineAudioContext(1, 16000, 16000)
    const audio = await ctx.decodeAudioData(arrayBuffer)
    const data = audio.getChannelData(0)
    const sr = audio.sampleRate
    const hop = Math.max(1, Math.round(sr * FRAME_SEC))
    const n = Math.min(Math.floor(data.length / hop), MAX_FRAMES)
    if (n < 1) return null

    const rms = new Float32Array(n)
    const zcr = new Float32Array(n)
    for (let f = 0; f < n; f++) {
      const s = f * hop
      let sum = 0
      let crossings = 0
      for (let i = s; i < s + hop; i++) {
        const v = data[i]
        sum += v * v
        if (i > s && (v >= 0) !== (data[i - 1] >= 0)) crossings++
      }
      rms[f] = Math.sqrt(sum / hop)
      zcr[f] = crossings / hop
    }

    // p95 정규화 + 노이즈 게이트
    const sorted = [...rms].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
    const gate = Math.max(p95 * 0.12, 1e-4)
    const span = Math.max(p95 - gate, 1e-6)

    const frames = []
    for (let f = 0; f < n; f++) {
      // 3프레임 이동평균 — 개구도 떨림 제거
      const r0 = rms[Math.max(0, f - 1)]
      const r2 = rms[Math.min(n - 1, f + 1)]
      const r = (r0 + rms[f] + r2) / 3
      const open = Math.max(0, Math.min(1, (r - gate) / span))
      let vowel = 'n'
      if (open >= 0.06) {
        const z = zcr[f]
        if (z > 0.16) vowel = 'i'
        else if (z > 0.11) vowel = 'e'
        else if (z < 0.045) vowel = 'o'
        else if (z < 0.07) vowel = 'u'
        else vowel = 'a'
      }
      frames.push({ open, vowel })
    }
    return { duration: n * FRAME_SEC, step: FRAME_SEC, frames }
  } catch {
    return null
  }
}

/**
 * IPC로 들어온(혹은 로컬) 타임라인 검증·상한. 통과 못 하면 null —
 * allowlist는 action 이름만 보므로 payload는 여기서 걸러야 한다 (Codex
 * MUST-FIX).
 */
export function sanitizeTimeline(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { duration, step, frames } = raw
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) return null
  if (!Number.isFinite(step) || step < 0.005 || step > 0.1) return null
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES) return null
  const clean = []
  for (const fr of frames) {
    const open = Number(fr?.open)
    if (!Number.isFinite(open) || open < 0 || open > 1) return null
    const vowel = VOWELS.includes(fr?.vowel) ? fr.vowel : 'n'
    clean.push({ open, vowel })
  }
  return { duration, step, frames: clean }
}

/** 재생 시작 (offsetSec = 이미 흘러간 오디오 시간 — IPC 지연 보정). */
export function playTimeline(timeline, offsetSec = 0) {
  const clean = sanitizeTimeline(timeline)
  if (!clean) return false
  _timeline = clean
  const off = Number.isFinite(offsetSec) ? Math.max(0, Math.min(offsetSec, clean.duration)) : 0
  _t0Ms = performance.now() - off * 1000
  return true
}

export function stopTimeline() {
  _timeline = null
}

export function isTimelineActive() {
  return _timeline !== null
}

function currentFrame() {
  if (!_timeline) return null
  const elapsed = (performance.now() - _t0Ms) / 1000
  if (elapsed < 0) return { open: 0, vowel: 'n' }
  if (elapsed >= _timeline.duration) {
    _timeline = null // 자연 종료 — stop 신호가 늦어도 입은 닫힌다
    return null
  }
  const idx = Math.min(_timeline.frames.length - 1, Math.floor(elapsed / _timeline.step))
  return _timeline.frames[idx]
}

function approach(key, target, dt) {
  const cur = _weights.get(key) ?? 0
  const next = cur + (target - cur) * (1 - Math.exp(-MOUTH_RATE * Math.max(0, Math.min(dt, 0.1))))
  _weights.set(key, next)
  return next
}

// 비짐 → 모음별 목표 가중. 정지/타임라인 없음이면 전 모음 0으로 수렴
// (Codex MUST-FIX: 활성 모음만이 아니라 전부 닫는다).
function vowelTargets(frame, fallbackActive, fallbackPhase) {
  const t = { a: 0, i: 0, u: 0, e: 0, o: 0 }
  if (frame) {
    if (frame.vowel !== 'n') t[frame.vowel] = frame.open
  } else if (fallbackActive) {
    t.a = Math.abs(Math.sin(fallbackPhase)) * 0.8 // 구 사인파 폴백
  }
  return t
}

/** 매 프레임 (MMD): lipsyncMMD 자리에서 호출. */
export function updateMouthMMD(model, dt, fallbackActive, fallbackPhase) {
  const mesh = model?.obj
  const dict = model?.morphs
  if (!mesh?.morphTargetInfluences || !dict) return
  const targets = vowelTargets(currentFrame(), fallbackActive, fallbackPhase)
  for (const [v, morphName] of Object.entries(MMD_VOWEL_MORPHS)) {
    const idx = dict[morphName]
    if (idx === undefined) continue
    mesh.morphTargetInfluences[idx] = approach(`m:${v}`, targets[v], dt)
  }
}

/** 매 프레임 (VRM): lipsyncVRM 자리에서 호출. */
export function updateMouthVRM(model, dt, fallbackActive, fallbackPhase) {
  const em = model?.obj?.expressionManager
  if (!em) return
  const targets = vowelTargets(currentFrame(), fallbackActive, fallbackPhase)
  for (const [v, expr] of Object.entries(VRM_VOWEL_EXPRS)) {
    em.setValue(expr, approach(`v:${v}`, targets[v], dt))
  }
}
