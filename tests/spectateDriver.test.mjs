// M2 관전 모드 판단부 — 침묵 게이트가 이 기능의 성패다. 계속 떠드는 동반자는
// 꺼버리게 되므로, "말 안 하는 쪽"이 제대로 도는지를 집중적으로 잠근다.
import { describe, it, expect } from 'vitest'
import {
  parseSpectate,
  isDuplicateComment,
  createCommentGate,
  isSpectateSkip,
  spectateRawOf
} from '../src/spectateDriver.js'

const ok = {
  summary: '캐릭터가 교전 중',
  focus: { x: 0.4, y: -0.2 },
  interest: 0.8,
  comment: '우와 방금 그거 아슬아슬했다',
  emotion: 'surprised'
}

describe('parseSpectate — 검증/clamp', () => {
  it('산문에 둘러싸인 JSON도 뽑아낸다', () => {
    const r = parseSpectate('여기요: ' + JSON.stringify(ok) + ' 끝')
    expect(r.comment).toBe(ok.comment)
    expect(r.emotion).toBe('surprised')
  })

  it('focus를 -1..1로 clamp한다', () => {
    const r = parseSpectate(JSON.stringify({ ...ok, focus: { x: 9, y: -9 } }))
    expect(r.focus).toEqual({ x: 1, y: -1 })
  })

  it('focus가 없거나 숫자가 아니면 null (시선을 안 건드림)', () => {
    expect(parseSpectate(JSON.stringify({ ...ok, focus: null })).focus).toBeNull()
    expect(parseSpectate(JSON.stringify({ ...ok, focus: { x: 'a', y: 0 } })).focus).toBeNull()
  })

  it('모르는 emotion은 neutral로 떨어진다', () => {
    expect(parseSpectate(JSON.stringify({ ...ok, emotion: 'smug' })).emotion).toBe('neutral')
  })

  it('interest가 없으면 0 — 기본이 침묵이다', () => {
    const r = parseSpectate(JSON.stringify({ summary: 'x', comment: 'y' }))
    expect(r.interest).toBe(0)
  })

  it('JSON이 아니거나 알맹이가 없으면 null', () => {
    expect(parseSpectate('그냥 말')).toBeNull()
    expect(parseSpectate('{"interest":0.9}')).toBeNull() // summary도 comment도 없음
    expect(parseSpectate(null)).toBeNull()
  })

  it('긴 코멘트는 잘린다(말풍선·TTS 보호)', () => {
    const r = parseSpectate(JSON.stringify({ ...ok, comment: '가'.repeat(200) }))
    expect(r.comment.length).toBe(60)
  })
})

describe('isDuplicateComment', () => {
  it('구두점·공백만 다르면 같은 말로 본다', () => {
    expect(isDuplicateComment('우와 대박!!', '우와 대박')).toBe(true)
  })
  it('어미만 붙인 재탕도 잡는다', () => {
    expect(isDuplicateComment('방금 그거 아슬아슬했다 진짜', '방금 그거 아슬아슬했다')).toBe(true)
  })
  it('다른 말은 통과', () => {
    expect(isDuplicateComment('이번엔 이겼네', '방금 그거 아슬아슬했다')).toBe(false)
  })
  it('너무 짧은 겹침은 중복이 아니다', () => {
    expect(isDuplicateComment('음', '음 그렇구나 저기 봐')).toBe(false)
  })
})

describe('createCommentGate — 침묵 게이트', () => {
  const gateAt = (t) => {
    let clock = t
    const gate = createCommentGate({ minInterest: 0.55, minGapMs: 45000, now: () => clock })
    return { gate, advance: (ms) => { clock += ms } }
  }

  it('흥미도가 낮으면 말하지 않는다', () => {
    const { gate } = gateAt(0)
    const v = gate.consider(parseSpectate(JSON.stringify({ ...ok, interest: 0.3 })))
    expect(v).toEqual({ speak: false, reason: 'low-interest' })
  })

  it('코멘트가 비어 있으면 말하지 않는다', () => {
    const { gate } = gateAt(0)
    const v = gate.consider(parseSpectate(JSON.stringify({ ...ok, comment: '' })))
    expect(v.speak).toBe(false)
  })

  it('말하지 않아도 summary는 갱신된다(다음 프롬프트가 변화를 알아야 함)', () => {
    const { gate } = gateAt(0)
    gate.consider(parseSpectate(JSON.stringify({ ...ok, interest: 0.1, summary: '조용한 로비' })))
    expect(gate.lastSummary()).toBe('조용한 로비')
    expect(gate.recent()).toEqual([]) // 말 안 했으니 기억엔 안 남는다
  })

  it('통과하면 말하고 링버퍼에 쌓인다', () => {
    const { gate, advance } = gateAt(0)
    const first = gate.consider(parseSpectate(JSON.stringify(ok)))
    expect(first.speak).toBe(true)
    expect(first.focus).toEqual({ x: 0.4, y: -0.2 })
    advance(60000)
    gate.consider(parseSpectate(JSON.stringify({ ...ok, comment: '이번엔 완전 압도했네' })))
    expect(gate.recent()).toEqual([ok.comment, '이번엔 완전 압도했네'])
  })

  it('최소 간격 안에 또 말하려 하면 막는다', () => {
    const { gate, advance } = gateAt(0)
    expect(gate.consider(parseSpectate(JSON.stringify(ok))).speak).toBe(true)
    advance(10000)
    const v = gate.consider(parseSpectate(JSON.stringify({ ...ok, comment: '완전 다른 말인데' })))
    expect(v).toEqual({ speak: false, reason: 'too-soon' })
  })

  it('직전에 한 말과 중복이면 막는다', () => {
    const { gate, advance } = gateAt(0)
    gate.consider(parseSpectate(JSON.stringify(ok)))
    advance(60000)
    const v = gate.consider(parseSpectate(JSON.stringify(ok)))
    expect(v).toEqual({ speak: false, reason: 'duplicate' })
  })

  it('링버퍼는 recentSize를 넘지 않는다', () => {
    let clock = 0
    const gate = createCommentGate({ minInterest: 0.1, recentSize: 3, minGapMs: 0, now: () => clock })
    for (const c of ['하나', '둘둘둘둘', '셋셋셋셋', '넷넷넷넷', '다섯다섯']) {
      clock += 60000
      gate.consider(parseSpectate(JSON.stringify({ ...ok, comment: c })))
    }
    expect(gate.recent()).toEqual(['셋셋셋셋', '넷넷넷넷', '다섯다섯'])
  })

  it('context()가 프롬프트용 컴팩트 컨텍스트를 낸다', () => {
    const { gate } = gateAt(0)
    gate.consider(parseSpectate(JSON.stringify(ok)))
    expect(gate.context()).toEqual({ recent: [ok.comment], lastSummary: ok.summary })
  })
})

describe('isSpectateSkip — 정상 무발화 vs 실패', () => {
  it('말 안 한 정상 tick은 전부 skip으로 센다(백오프 금지)', () => {
    for (const status of ['paused', 'no-source', 'no-change', 'dead-frame', 'no-vision']) {
      expect(isSpectateSkip({ status })).toBe(true)
    }
  })
  it('ok와 error는 skip이 아니다', () => {
    expect(isSpectateSkip({ status: 'ok', raw: '{}' })).toBe(false)
    expect(isSpectateSkip({ status: 'error' })).toBe(false) // 실패는 백오프를 타야 한다
    expect(isSpectateSkip(null)).toBe(false)
  })
  it('spectateRawOf는 ok일 때만 raw를 준다', () => {
    expect(spectateRawOf({ status: 'ok', raw: '{"a":1}' })).toBe('{"a":1}')
    expect(spectateRawOf({ status: 'no-change' })).toBeNull()
  })
})
