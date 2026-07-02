/**
 * Pure tests for src/motionManager.js — 2단계(디렉터 연동)의 핵심: 디렉터 mood가
 * 매핑된 제스처 flavor로 pickIdleMotion의 후보를 실제로 좁히는가.
 *
 * Math.random은 vi.spyOn으로 결정론화(첫 후보 고정) — lastMotion/cooldown 영향
 * 없는 신선한 인스턴스 1회 호출로 flaky 제거(Codex MUST-FIX).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MotionManager, MOTION_LIBRARY, GESTURE_FLAVORS } from '../src/motionManager.js'

afterEach(() => vi.restoreAllMocks())

function pick(personality, mood, rand = 0) {
  vi.spyOn(Math, 'random').mockReturnValue(rand)
  return new MotionManager({ personality }).pickIdleMotion({ mood }).name
}

describe('pickIdleMotion flavor steering', () => {
  it('known flavor with non-empty personality intersection → picks from that flavor', () => {
    // active 풀에는 energetic 교집합이 풍부(stretch_arms/wave/lean_in 등).
    const name = pick('active', 'energetic')
    expect(GESTURE_FLAVORS.energetic.has(name)).toBe(true)
    expect(MOTION_LIBRARY.idle.active).toContain(name)
  })

  it('calm + quiet → picks a quiet gesture', () => {
    const name = pick('calm', 'quiet')
    expect(GESTURE_FLAVORS.quiet.has(name)).toBe(true)
  })

  it('engaged still works (regression)', () => {
    const name = pick('active', 'engaged')
    expect(GESTURE_FLAVORS.engaged.has(name)).toBe(true)
  })

  it('known flavor with EMPTY intersection → falls back to full personality pool', () => {
    // shy 풀엔 energetic 교집합이 없다 → 전체 폴백(non-null, shy 어휘 내).
    const name = pick('shy', 'energetic')
    expect(name).toBeTruthy()
    expect(MOTION_LIBRARY.idle.shy).toContain(name)
  })

  it('unknown / null / prototype-key mood → full pool, no crash', () => {
    expect(MOTION_LIBRARY.idle.active).toContain(pick('active', 'bogus'))
    expect(MOTION_LIBRARY.idle.active).toContain(pick('active', undefined))
    // 프로토타입 키가 상속 속성을 잡아 flavor.has 크래시 나면 안 됨(Codex).
    for (const key of ['toString', '__proto__', 'hasOwnProperty', 'constructor']) {
      expect(MOTION_LIBRARY.idle.active).toContain(pick('active', key))
    }
  })
})

describe('pickIdleMotion — 클립 전용 연기 어휘 가용성 필터', () => {
  const CLIP_ONLY = ['idle_air_scent', 'idle_impatient', 'idle_skywatch', 'idle_stretch', 'idle_sway']

  it('isClipAvailable 미주입이면 클립 전용 이름은 절대 안 나온다(보수 기본)', () => {
    for (let i = 0; i < 60; i++) {
      const name = new MotionManager({ personality: 'calm' }).pickIdleMotion({}).name
      expect(CLIP_ONLY).not.toContain(name)
    }
  })

  it('isClipAvailable=false면 제외, true면 후보에 포함된다', () => {
    for (let i = 0; i < 60; i++) {
      const name = new MotionManager({ personality: 'calm' }).pickIdleMotion({ isClipAvailable: () => false }).name
      expect(CLIP_ONLY).not.toContain(name)
    }
    // 가용이면 언젠가 뽑힌다(calm 풀에 4종 편입 — 60회면 통계적으로 확실).
    let seen = false
    for (let i = 0; i < 60; i++) {
      const name = new MotionManager({ personality: 'calm' }).pickIdleMotion({ isClipAvailable: () => true }).name
      if (CLIP_ONLY.includes(name)) { seen = true; break }
    }
    expect(seen).toBe(true)
  })

  it('quiet flavor에서도 가용성 필터가 함께 작동한다', () => {
    for (let i = 0; i < 40; i++) {
      const name = new MotionManager({ personality: 'shy' }).pickIdleMotion({ mood: 'quiet', isClipAvailable: () => false }).name
      expect(CLIP_ONLY).not.toContain(name)
    }
  })
})

describe('profile-driven needs tendency + daily rhythm', () => {
  function bundleWith(generated = {}, user = {}) {
    return { generated, user, interpretations: {} }
  }

  it('default profile → neutral-ish tendency (calm bucket, axes 0.5)', () => {
    const m = new MotionManager({})
    const t = m.getNeedsTendency()
    expect(t.thirst).toBe(1)
    expect(t.boredom).toBeCloseTo(1.0, 5) // 0.85 + 0.5*0.3
    expect(t.comfort).toBeCloseTo(1.0, 5) // 1.15 - 0.5*0.3
    expect(m.getDailyRhythm()).toEqual({ chronotype: 'balanced', energyHourShift: 0 })
  })

  it('high-energy persona raises boredom tendency (derived, continuous)', () => {
    const m = new MotionManager({})
    m.setCharacterProfile(bundleWith({ canonicalPersona: { energy: 0.9, expressiveness: 0.7 } }))
    // energy 0.9 → active 버킷(1.4) × (0.85+0.27)=1.12 → 1.568
    expect(m.getNeedsTendency().boredom).toBeGreaterThan(1.4)
    expect(m.getNeedsTendency().boredom).toBeLessThanOrEqual(1.6) // 클램프
  })

  it('explicit needsTendency in the profile overrides derivation and clamps', () => {
    const m = new MotionManager({})
    m.setCharacterProfile(bundleWith({ needsTendency: { thirst: 1.5, boredom: 9, care: 0.1, junk: 3 } }))
    const t = m.getNeedsTendency()
    expect(t.thirst).toBe(1.5)
    expect(t.boredom).toBe(1.6) // 상한 클램프
    expect(t.care).toBe(0.5) // 하한 클램프
    expect(t).not.toHaveProperty('junk')
  })

  it('user profile needsTendency wins over generated', () => {
    const m = new MotionManager({})
    m.setCharacterProfile(bundleWith(
      { needsTendency: { thirst: 1.4 } },
      { needsTendency: { thirst: 0.8 } }
    ))
    expect(m.getNeedsTendency().thirst).toBe(0.8)
  })

  it('chronotype normalizes with whitelist and user precedence', () => {
    const m = new MotionManager({})
    m.setCharacterProfile(bundleWith({ dailyRhythm: { chronotype: 'evening' } }))
    expect(m.getDailyRhythm()).toEqual({ chronotype: 'evening', energyHourShift: -3 })
    m.setCharacterProfile(bundleWith(
      { dailyRhythm: { chronotype: 'evening' } },
      { dailyRhythm: { chronotype: 'MORNING' } }
    ))
    expect(m.getDailyRhythm().energyHourShift).toBe(2)
    m.setCharacterProfile(bundleWith({ dailyRhythm: { chronotype: 'vampire' } }))
    expect(m.getDailyRhythm().chronotype).toBe('balanced')
  })

  it('live persona slider (setPersonalityOverrides) re-derives the tendency', () => {
    const m = new MotionManager({})
    const before = m.getNeedsTendency().comfort
    m.setPersonalityOverrides({ confidence: 0.1 }) // 소심 → 안락 갈구↑
    const after = m.getNeedsTendency().comfort
    expect(after).toBeGreaterThan(before)
  })

  it('clearCharacterProfile resets tendency and rhythm to defaults', () => {
    const m = new MotionManager({})
    m.setCharacterProfile(bundleWith({ needsTendency: { thirst: 1.5 }, dailyRhythm: { chronotype: 'morning' } }))
    m.clearCharacterProfile()
    expect(m.getNeedsTendency().thirst).toBe(1)
    expect(m.getDailyRhythm().energyHourShift).toBe(0)
  })

  it('idle_wave is intentionally both energetic and engaged (AI clip reachable in both)', () => {
    expect(GESTURE_FLAVORS.energetic.has('idle_wave')).toBe(true)
    expect(GESTURE_FLAVORS.engaged.has('idle_wave')).toBe(true)
  })

  it('bias 미주입이면 기존 균등 무작위(무회귀)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const name = new MotionManager({ personality: 'active' }).pickIdleMotion({}).name
    expect(MOTION_LIBRARY.idle.active).toContain(name)
  })

  it('bias 함수로 가중 — 큰 가중 제스처가 선택됨(4단계)', () => {
    // 모든 후보 bias=1, 단 한 후보만 매우 큼 → 가중 무작위가 그걸 고름.
    const target = MOTION_LIBRARY.idle.active.find((m) => m === 'idle_stretch_arms')
    vi.spyOn(Math, 'random').mockReturnValue(0.999) // 누적 분포 끝쪽
    const mgr = new MotionManager({ personality: 'active' })
    const bias = (m) => (m === target ? 100 : 0.01)
    const name = mgr.pickIdleMotion({ bias }).name
    expect(name).toBe(target)
  })

  it('가중 floor — bias가 0/음수/NaN이어도 후보 배제 안 됨(탐험), 크래시 없음', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const mgr = new MotionManager({ personality: 'calm' })
    const name = mgr.pickIdleMotion({ bias: () => 0 }).name // 전부 0 → floor로 균등
    expect(MOTION_LIBRARY.idle.calm).toContain(name)
    expect(() => new MotionManager({ personality: 'calm' }).pickIdleMotion({ bias: () => NaN })).not.toThrow()
  })

  it('natural personality×flavor pairings each have ≥1 reachable clip', () => {
    // "mood가 실제로 닿는가"를 잠근다(Codex NICE-TO-HAVE). 부자연 쌍(shy×energetic,
    // active×quiet)은 의도적으로 비어 폴백되므로 제외.
    const natural = [
      ['active', 'energetic'], ['active', 'fidgety'], ['active', 'engaged'],
      ['calm', 'quiet'], ['calm', 'fidgety'], ['calm', 'engaged'],
      ['shy', 'quiet'], ['shy', 'fidgety'], ['shy', 'engaged']
    ]
    for (const [p, flavor] of natural) {
      const pool = MOTION_LIBRARY.idle[p].filter((m) => GESTURE_FLAVORS[flavor].has(m))
      expect(pool.length, `${p}×${flavor}`).toBeGreaterThan(0)
    }
  })

  it('calm × energetic/fidgety — 같은 제스처만 반복하지 않음(가드 ≥2 + dedup)', () => {
    // 회귀: 예전엔 calm×energetic/fidgety 교집합이 1개라 같은 idle 무한 반복.
    // idle_look_around_soft 추가로 교집합 2개 확보 + flavored<2면 전체풀 폴백.
    for (const mood of ['energetic', 'fidgety']) {
      const mgr = new MotionManager({ personality: 'calm' })
      const seen = new Set()
      for (let i = 0; i < 24; i++) seen.add(mgr.pickIdleMotion({ mood }).name)
      expect(seen.size, `calm×${mood}`).toBeGreaterThan(1)
    }
  })

  it('알 수 없는 프리셋 이름은 drop되고 라이브러리로 폴백(무반응 방지)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = new MotionManager({ personality: 'calm' })
    mgr.setCharacterProfile({
      generated: {
        motionPresetGroups: {
          idle: ['idle_breathe_soft', 'idle_breath_soft'], // 유령, 실명
          react: { happy: ['react_smile_small'] }          // 유령
        }
      }
    })
    const idle = mgr.getMotionCandidates('idle')
    expect(idle).not.toContain('idle_breathe_soft') // 유령 드롭
    expect(idle).toContain('idle_breath_soft')      // 실명 유지
    const happy = mgr.getMotionCandidates('react', 'happy')
    expect(happy).not.toContain('react_smile_small')
    expect(happy.length).toBeGreaterThan(0)         // 라이브러리 폴백
    expect(warn).toHaveBeenCalled()
  })

  it('라이브러리 정식 이름은 검증에서 드롭되지 않음(경고 없음)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const allIdle = [...MOTION_LIBRARY.idle.shy, ...MOTION_LIBRARY.idle.active, ...MOTION_LIBRARY.idle.calm]
    const allTalk = [...MOTION_LIBRARY.talk.shy, ...MOTION_LIBRARY.talk.active, ...MOTION_LIBRARY.talk.calm]
    const allReactHappy = [...MOTION_LIBRARY.react.active, ...MOTION_LIBRARY.react.calm]
    const mgr = new MotionManager({ personality: 'active' })
    mgr.setCharacterProfile({
      generated: { motionPresetGroups: { idle: allIdle, talk: allTalk, react: { happy: allReactHappy } } }
    })
    const groups = mgr.getCharacterProfile().motionPresetGroups
    for (const n of allIdle) expect(groups.idle, n).toContain(n)
    for (const n of allTalk) expect(groups.talk, n).toContain(n)
    for (const n of allReactHappy) expect(groups.react.happy, n).toContain(n)
    expect(warn).not.toHaveBeenCalled() // 정식 이름엔 경고 없음
  })
})
