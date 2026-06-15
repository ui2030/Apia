// src/motionManager.js

const PERSONALITY = {
  SHY: 'shy',
  ACTIVE: 'active',
  CALM: 'calm'
}

const MOTION_LIBRARY = {
  idle: {
    // 절차적 idle(breath/gaze/fidget/weightshift) + 캐릭터다운 포즈 클립 혼합.
    // 포즈 클립(hands_clasped/ponder/…)은 .vmd가 있으면 재생, VRM·미존재면
    // 절차적 폴백. look_around/look_down은 절차적 시선 임펄스(main.js).
    shy: [
      'idle_breath_soft',
      'idle_look_down_soft',
      'idle_small_fidget',
      'idle_hands_clasped',
      'idle_ponder',
      'idle_head_tilt_soft',
      'idle_sway_relax'
    ],
    active: [
      'idle_shift_weight',
      'idle_look_around',
      'idle_breath_lively',
      'idle_hand_on_hip',
      'idle_hands_back',
      'idle_head_tilt',
      'idle_lean_in',
      'idle_stretch_arms'
    ],
    calm: [
      'idle_breath_soft',
      'idle_neutral',
      'idle_look_around_soft',
      'idle_arms_crossed',
      'idle_relaxed',
      'idle_head_tilt_soft',
      'idle_lean_in',
      'idle_sway_relax'
    ]
  },

  talk: {
    shy: [
      'talk_soft',
      'talk_think',
      'talk_small_nod'
    ],
    active: [
      'talk_happy',
      'talk_explain',
      'talk_big_nod'
    ],
    calm: [
      'talk_soft',
      'talk_explain_soft',
      'talk_neutral'
    ]
  },

  react: {
    shy: [
      'react_shy',
      'react_small_surprised',
      'react_small_nod'
    ],
    active: [
      'react_surprised',
      'react_happy',
      'react_big_nod'
    ],
    calm: [
      'react_nod',
      'react_small_surprised',
      'react_neutral'
    ]
  }
}

// J단계 — "듣는 듯한/관여된" idle 제스처(방금 대화 직후 선호). 갸웃·손 모음·
// 생각·둘러보기는 사용자를 향한 주의로 읽힌다. hands_back/arms_crossed 같은
// 닫힌/독립 포즈는 제외.
const ENGAGED_IDLE = new Set([
  'idle_head_tilt',
  'idle_head_tilt_soft',
  'idle_hands_clasped',
  'idle_ponder',
  'idle_look_around',
  'idle_look_around_soft',
  'idle_lean_in'
])

function randomPick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function clamp01(value, fallback = 0.5) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback
}

function uniqueMerge(...groups) {
  const merged = []
  const seen = new Set()

  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      if (!item || seen.has(item)) continue
      seen.add(item)
      merged.push(item)
    }
  }

  return merged
}

function normalizePersonality(personality) {
  if (personality === PERSONALITY.SHY) return PERSONALITY.SHY
  if (personality === PERSONALITY.ACTIVE) return PERSONALITY.ACTIVE
  return PERSONALITY.CALM
}

function normalizeEmotion(emotion) {
  return emotion || 'neutral'
}

function classifyTalkStyle(text = '') {
  const len = text.trim().length

  if (len >= 60) return 'long'
  if (len >= 20) return 'medium'
  return 'short'
}

function createDefaultProfile() {
  return {
    personality: PERSONALITY.CALM,
    canonicalPersona: {
      confidence: 0.5,
      energy: 0.5,
      warmth: 0.5,
      emotionalStability: 0.65,
      talkSpeed: 0.5,
      expressiveness: 0.45,
      curiosity: 0.5,
      dominance: 0.45,
      socialStyle: 'balanced'
    },
    behaviorTendency: {
      baseIdle: 'composed',
      gazeStrength: 0.45,
      fidgetiness: 0.3,
      movementRange: 0.2,
      reactionDelayMs: [250, 700]
    },
    motionPresetGroups: {
      idle: [],
      talk: [],
      react: {},
      locomotion: {}
    },
    source: null
  }
}

function inferPersonality(canonicalPersona = {}, behaviorTendency = {}) {
  const energy = clamp01(canonicalPersona.energy, 0.5)
  const expressiveness = clamp01(canonicalPersona.expressiveness, 0.45)
  const confidence = clamp01(canonicalPersona.confidence, 0.5)
  const movementRange = clamp01(behaviorTendency.movementRange, 0.2)
  const fidgetiness = clamp01(behaviorTendency.fidgetiness, 0.3)
  const socialStyle = String(canonicalPersona.socialStyle || '').toLowerCase()

  if (
    confidence < 0.43 ||
    socialStyle.includes('shy') ||
    (energy < 0.42 && expressiveness < 0.45)
  ) {
    return PERSONALITY.SHY
  }

  if (
    energy > 0.62 ||
    expressiveness > 0.62 ||
    movementRange > 0.52 ||
    fidgetiness > 0.58
  ) {
    return PERSONALITY.ACTIVE
  }

  return PERSONALITY.CALM
}

function normalizeReactionDelay(input) {
  if (!Array.isArray(input) || input.length < 2) return [250, 700]

  const min = Number.isFinite(input[0]) ? Math.max(0, input[0]) : 250
  const max = Number.isFinite(input[1]) ? Math.max(min, input[1]) : 700
  return [min, max]
}

function normalizeMotionPresetGroups(input = {}) {
  return {
    idle: Array.isArray(input.idle) ? input.idle.filter(Boolean) : [],
    talk: Array.isArray(input.talk) ? input.talk.filter(Boolean) : [],
    react: input.react && typeof input.react === 'object' ? input.react : {},
    locomotion: input.locomotion && typeof input.locomotion === 'object' ? input.locomotion : {}
  }
}

function resolveInterpretationOffset(bundle = {}) {
  const preferredKey = bundle?.user?.preferredInterpretation
  if (!preferredKey) return {}

  const preset = bundle?.interpretations?.[preferredKey]
  if (!preset || typeof preset !== 'object') return {}
  return preset.offset && typeof preset.offset === 'object' ? preset.offset : {}
}

function normalizeCharacterProfile(bundle = null) {
  const defaults = createDefaultProfile()
  if (!bundle || typeof bundle !== 'object') return defaults

  const generated = bundle.generated && typeof bundle.generated === 'object' ? bundle.generated : {}
  const offset = resolveInterpretationOffset(bundle)
  const generatedPersona =
    generated.canonicalPersona && typeof generated.canonicalPersona === 'object'
      ? generated.canonicalPersona
      : {}
  const generatedBehavior =
    generated.behaviorTendency && typeof generated.behaviorTendency === 'object'
      ? generated.behaviorTendency
      : {}

  const canonicalPersona = {
    ...defaults.canonicalPersona,
    ...generatedPersona
  }

  const behaviorTendency = {
    ...defaults.behaviorTendency,
    ...generatedBehavior
  }

  for (const [key, value] of Object.entries(offset)) {
    // 배열(예: reactionDelayMs)에 숫자 offset을 더하면 문자열 강제변환으로 NaN이 되면서
    // clamp01 fallback 경로로 빠져 silent no-op이 된다. 수치 필드에만 offset을 적용.
    if (!Number.isFinite(value)) continue

    if (key in canonicalPersona && typeof canonicalPersona[key] === 'number') {
      canonicalPersona[key] = clamp01(canonicalPersona[key] + value, canonicalPersona[key])
    } else if (key in behaviorTendency && typeof behaviorTendency[key] === 'number') {
      behaviorTendency[key] = clamp01(behaviorTendency[key] + value, behaviorTendency[key])
    }
  }

  canonicalPersona.confidence = clamp01(canonicalPersona.confidence, defaults.canonicalPersona.confidence)
  canonicalPersona.energy = clamp01(canonicalPersona.energy, defaults.canonicalPersona.energy)
  canonicalPersona.warmth = clamp01(canonicalPersona.warmth, defaults.canonicalPersona.warmth)
  canonicalPersona.emotionalStability = clamp01(
    canonicalPersona.emotionalStability,
    defaults.canonicalPersona.emotionalStability
  )
  canonicalPersona.talkSpeed = clamp01(canonicalPersona.talkSpeed, defaults.canonicalPersona.talkSpeed)
  canonicalPersona.expressiveness = clamp01(
    canonicalPersona.expressiveness,
    defaults.canonicalPersona.expressiveness
  )
  canonicalPersona.curiosity = clamp01(canonicalPersona.curiosity, defaults.canonicalPersona.curiosity)
  canonicalPersona.dominance = clamp01(canonicalPersona.dominance, defaults.canonicalPersona.dominance)

  behaviorTendency.gazeStrength = clamp01(behaviorTendency.gazeStrength, defaults.behaviorTendency.gazeStrength)
  behaviorTendency.fidgetiness = clamp01(behaviorTendency.fidgetiness, defaults.behaviorTendency.fidgetiness)
  behaviorTendency.movementRange = clamp01(behaviorTendency.movementRange, defaults.behaviorTendency.movementRange)
  behaviorTendency.reactionDelayMs = normalizeReactionDelay(behaviorTendency.reactionDelayMs)

  return {
    personality: inferPersonality(canonicalPersona, behaviorTendency),
    canonicalPersona,
    behaviorTendency,
    motionPresetGroups: normalizeMotionPresetGroups(generated.motionPresetGroups),
    source: bundle
  }
}

// Cached personality vector object reused across frames. Codex MUST-FIX
// (step 1 round 1): updateVRMBody is called every frame; allocating a new
// object each call would churn GC. We update fields in place on profile
// changes only.
function createEmptyVector() {
  return {
    confidence: 0.5,
    energy: 0.5,
    warmth: 0.5,
    expressiveness: 0.45,
    talkSpeed: 0.5,
    curiosity: 0.5,
    dominance: 0.45,
    gazeStrength: 0.45,
    fidgetiness: 0.3,
    movementRange: 0.2,
    reactionDelayMs: [250, 700],
  }
}

function refreshVector(target, profile) {
  const canonical = profile.canonicalPersona || {}
  const behavior = profile.behaviorTendency || {}
  target.confidence = clamp01(canonical.confidence, target.confidence)
  target.energy = clamp01(canonical.energy, target.energy)
  target.warmth = clamp01(canonical.warmth, target.warmth)
  target.expressiveness = clamp01(canonical.expressiveness, target.expressiveness)
  target.talkSpeed = clamp01(canonical.talkSpeed, target.talkSpeed)
  target.curiosity = clamp01(canonical.curiosity, target.curiosity)
  target.dominance = clamp01(canonical.dominance, target.dominance)
  target.gazeStrength = clamp01(behavior.gazeStrength, target.gazeStrength)
  target.fidgetiness = clamp01(behavior.fidgetiness, target.fidgetiness)
  target.movementRange = clamp01(behavior.movementRange, target.movementRange)
  target.reactionDelayMs = normalizeReactionDelay(behavior.reactionDelayMs)
}

export class MotionManager {
  constructor(options = {}) {
    this.personality = normalizePersonality(options.personality)
    this.profile = createDefaultProfile()
    this.lastMotion = null
    this.cooldowns = new Map()
    this.cooldownMs = options.cooldownMs ?? 1200
    // Stable vector — same object ref across frames so callers can cache.
    this._vector = createEmptyVector()
    refreshVector(this._vector, this.profile)
  }

  setPersonality(personality) {
    this.personality = normalizePersonality(personality)
  }

  getPersonality() {
    return this.personality
  }

  setCharacterProfile(bundle = null) {
    this.profile = normalizeCharacterProfile(bundle)
    // Codex MUST-FIX (step 1 round 1): profile.user can carry vector
    // overrides set by the user via the settings UI. Apply them on top of
    // the generated/interpretation merge so live slider changes survive a
    // reload.
    const overrides = bundle?.user?.personalityOverrides
    if (overrides && typeof overrides === 'object') {
      this._mergePersonaOverrides(overrides)
      // Codex MUST-FIX (round 2): re-infer personality AFTER overrides
      // land. Otherwise the motion preset (shy/active/calm) reflects only
      // the generated profile while the procedural vector reflects the
      // user's slider edits — preset/animation desync.
      this.profile.personality = inferPersonality(
        this.profile.canonicalPersona,
        this.profile.behaviorTendency
      )
    }
    this.setPersonality(this.profile.personality)
    refreshVector(this._vector, this.profile)
    this.lastMotion = null
    this.cooldowns.clear()
  }

  clearCharacterProfile() {
    this.profile = createDefaultProfile()
    this.setPersonality(this.profile.personality)
    refreshVector(this._vector, this.profile)
    this.lastMotion = null
    this.cooldowns.clear()
  }

  /**
   * Patch the active profile's canonicalPersona/behaviorTendency with the
   * fields in `overrides`. Used by the settings UI's live sliders + by
   * setCharacterProfile when profile.user.personalityOverrides is present.
   * Unknown keys are ignored; numeric fields are clamped to [0,1].
   */
  setPersonalityOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== 'object') return
    this._mergePersonaOverrides(overrides)
    this.setPersonality(inferPersonality(
      this.profile.canonicalPersona,
      this.profile.behaviorTendency
    ))
    refreshVector(this._vector, this.profile)
  }

  _mergePersonaOverrides(overrides) {
    const persona = this.profile.canonicalPersona
    const behavior = this.profile.behaviorTendency
    for (const [key, value] of Object.entries(overrides)) {
      if (!Number.isFinite(value)) continue
      if (key in persona && typeof persona[key] === 'number') {
        persona[key] = clamp01(value, persona[key])
      } else if (key in behavior && typeof behavior[key] === 'number') {
        behavior[key] = clamp01(value, behavior[key])
      }
    }
  }

  /**
   * Returns the live personality vector. Stable object — same ref across
   * calls so callers can cache or read fields without GC churn. Mutated in
   * place on profile/override changes.
   */
  getPersonalityVector() {
    return this._vector
  }

  getCharacterProfile() {
    return this.profile
  }

  getBehaviorConfig() {
    const behavior = this.profile.behaviorTendency || {}
    const canonical = this.profile.canonicalPersona || {}
    const mobilityScore = clamp01(
      (clamp01(behavior.movementRange, 0.2) * 0.55) +
      (clamp01(canonical.energy, 0.5) * 0.25) +
      (clamp01(behavior.fidgetiness, 0.3) * 0.20),
      0.35
    )

    const minDelay = Math.round(clamp(15000 - mobilityScore * 6500, 5500, 18000))
    const maxDelay = Math.round(clamp(23000 - mobilityScore * 9000, minDelay + 2500, 26000))
    const chairBias = clamp(
      0.7 - clamp01(behavior.movementRange, 0.2) * 0.4 +
      (String(behavior.baseIdle || '').toLowerCase() === 'composed' ? 0.08 : 0),
      0.18,
      0.82
    )

    // J단계(행동 지능) — 자율 행동 믹스를 성격이 좌우하게. 이동성이 높으면 더
    // 돌아다니고(walk↑), 낮으면 제자리 제스처(idle↑). fidget이 높으면 이동성이
    // 낮아도 제자리에서 안절부절 제스처가 늘어난다. 합(idleBias+walkShare)은
    // 최대 0.94라 가구 슬롯이 항상 ≥6% 남는다. 소비측에서 다시 clamp(방어).
    const fidget = clamp01(behavior.fidgetiness, 0.3)
    const inPlaceIdleBias = clamp(0.30 - mobilityScore * 0.18 + fidget * 0.12, 0.16, 0.44)
    const walkShare = clamp(0.26 + mobilityScore * 0.30, 0.22, 0.50)

    return {
      autoBehaviorMinMs: minDelay,
      autoBehaviorMaxMs: maxDelay,
      chairBias,
      inPlaceIdleBias,
      walkShare
    }
  }

  getMotionCandidates(category, emotion = 'neutral') {
    const presets = this.profile.motionPresetGroups || {}
    const library = MOTION_LIBRARY[category]?.[this.personality] || MOTION_LIBRARY[category]?.calm || []

    if (category === 'react') {
      const emotionPresets =
        presets.react && typeof presets.react === 'object' && Array.isArray(presets.react[emotion])
          ? presets.react[emotion]
          : []

      return uniqueMerge(emotionPresets, library)
    }

    return uniqueMerge(presets[category], library)
  }

  isCoolingDown(motionName) {
    const until = this.cooldowns.get(motionName) ?? 0
    return Date.now() < until
  }

  markUsed(motionName) {
    this.lastMotion = motionName
    this.cooldowns.set(motionName, Date.now() + this.cooldownMs)
  }

  pickIdleMotion({ mood } = {}) {
    const candidates = this.getMotionCandidates('idle')
    // J단계 — 방금 대화했으면(mood:'engaged') "듣는 듯한" 제스처를 선호:
    // 갸웃·손 모음·생각·둘러보기. 후보에 없으면(성격별로) 전체로 폴백.
    let pool = candidates
    if (mood === 'engaged') {
      const engaged = candidates.filter((m) => ENGAGED_IDLE.has(m))
      if (engaged.length > 0) pool = engaged
    }
    let motion = randomPick(pool)

    if (motion && motion === this.lastMotion && pool.length > 1) {
      const filtered = pool.filter((m) => m !== this.lastMotion)
      motion = randomPick(filtered)
    }

    if (motion) this.markUsed(motion)

    const expressiveness = clamp01(this.profile.canonicalPersona?.expressiveness, 0.45)
    const energy = clamp01(this.profile.canonicalPersona?.energy, 0.5)
    const intensity = clamp(
      0.68 + expressiveness * 0.2 + energy * 0.12,
      0.65,
      1.08
    )

    return {
      category: 'idle',
      name: motion || 'idle_neutral',
      intensity
    }
  }

  pickTalkMotion({ emotion = 'neutral', text = '' } = {}) {
    const talkStyle = classifyTalkStyle(text)
    const candidates = this.getMotionCandidates('talk', emotion)

    let motion = randomPick(candidates) || 'talk_soft'
    const expressiveness = clamp01(this.profile.canonicalPersona?.expressiveness, 0.45)
    const talkSpeed = clamp01(this.profile.canonicalPersona?.talkSpeed, 0.5)
    let intensity = clamp(0.72 + expressiveness * 0.22 + talkSpeed * 0.14, 0.7, 1.12)

    const e = normalizeEmotion(emotion)

    const talkPresets = this.getMotionCandidates('talk', e)

    if (talkPresets.length > 0) {
      motion = randomPick(talkPresets) || motion
    } else if (e === 'happy') {
      motion = this.personality === PERSONALITY.ACTIVE ? 'talk_happy' : 'talk_soft'
      intensity = 1.0
    } else if (e === 'sad') {
      motion = 'talk_think'
      intensity = 0.7
    } else if (e === 'angry') {
      motion = 'talk_explain'
      intensity = 1.05
    } else if (e === 'surprised') {
      motion = 'talk_big_nod'
      intensity = 1.0
    }

    if (talkStyle === 'long' && e === 'neutral' && talkPresets.length === 0) {
      motion = this.personality === PERSONALITY.ACTIVE ? 'talk_explain' : 'talk_neutral'
      intensity += 0.05
    }

    if (motion) this.markUsed(motion)

    return {
      category: 'talk',
      name: motion,
      intensity
    }
  }

  pickReactMotion({ emotion = 'neutral' } = {}) {
    const e = normalizeEmotion(emotion)
    const candidates = this.getMotionCandidates('react', e)
    let motion = randomPick(candidates) || 'react_neutral'
    const expressiveness = clamp01(this.profile.canonicalPersona?.expressiveness, 0.45)
    let intensity = clamp(0.68 + expressiveness * 0.2, 0.65, 1.05)

    if (candidates.length > 0) {
      intensity = clamp(intensity + (e === 'surprised' ? 0.12 : 0), 0.65, 1.08)
    } else if (e === 'happy') {
      motion = this.personality === PERSONALITY.ACTIVE ? 'react_happy' : 'react_small_nod'
      intensity = 1.0
    } else if (e === 'sad') {
      motion = this.personality === PERSONALITY.SHY ? 'react_shy' : 'react_neutral'
      intensity = 0.7
    } else if (e === 'angry') {
      motion = 'react_big_nod'
      intensity = 1.0
    } else if (e === 'surprised') {
      motion = this.personality === PERSONALITY.ACTIVE ? 'react_surprised' : 'react_small_surprised'
      intensity = 1.0
    }

    if (motion) this.markUsed(motion)

    return {
      category: 'react',
      name: motion,
      intensity
    }
  }
}

export {
  PERSONALITY,
  MOTION_LIBRARY
}
