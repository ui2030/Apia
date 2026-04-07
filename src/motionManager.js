// src/motionManager.js

const PERSONALITY = {
  SHY: 'shy',
  ACTIVE: 'active',
  CALM: 'calm'
}

const MOTION_LIBRARY = {
  idle: {
    shy: [
      'idle_breath_soft',
      'idle_look_down_soft',
      'idle_small_fidget'
    ],
    active: [
      'idle_shift_weight',
      'idle_look_around',
      'idle_breath_lively'
    ],
    calm: [
      'idle_breath_soft',
      'idle_neutral',
      'idle_look_around_soft'
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

function randomPick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr[Math.floor(Math.random() * arr.length)]
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

export class MotionManager {
  constructor(options = {}) {
    this.personality = normalizePersonality(options.personality)
    this.lastMotion = null
    this.cooldowns = new Map()
    this.cooldownMs = options.cooldownMs ?? 1200
  }

  setPersonality(personality) {
    this.personality = normalizePersonality(personality)
  }

  getPersonality() {
    return this.personality
  }

  isCoolingDown(motionName) {
    const until = this.cooldowns.get(motionName) ?? 0
    return Date.now() < until
  }

  markUsed(motionName) {
    this.lastMotion = motionName
    this.cooldowns.set(motionName, Date.now() + this.cooldownMs)
  }

  pickIdleMotion() {
    const candidates = MOTION_LIBRARY.idle[this.personality] || MOTION_LIBRARY.idle.calm
    let motion = randomPick(candidates)

    if (motion && motion === this.lastMotion && candidates.length > 1) {
      const filtered = candidates.filter(m => m !== this.lastMotion)
      motion = randomPick(filtered)
    }

    if (motion) this.markUsed(motion)

    return {
      category: 'idle',
      name: motion || 'idle_neutral',
      intensity: this.personality === PERSONALITY.ACTIVE ? 1.0 : this.personality === PERSONALITY.SHY ? 0.75 : 0.85
    }
  }

  pickTalkMotion({ emotion = 'neutral', text = '' } = {}) {
    const talkStyle = classifyTalkStyle(text)
    const candidates = MOTION_LIBRARY.talk[this.personality] || MOTION_LIBRARY.talk.calm

    let motion = randomPick(candidates) || 'talk_soft'
    let intensity = 0.85

    const e = normalizeEmotion(emotion)

    if (e === 'happy') {
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

    if (talkStyle === 'long' && e === 'neutral') {
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
    let motion = 'react_neutral'
    let intensity = 0.8

    if (e === 'happy') {
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