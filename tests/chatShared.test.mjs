import { describe, it, expect } from 'vitest'
import { toUserMessage, isActiveFrame, createSpeechQueue, parseSfx } from '../src/chatShared.js'

describe('toUserMessage — 에러 한국어화', () => {
  it('타임아웃을 시간초과 안내로 매핑', () => {
    expect(toUserMessage('Request timed out after 30000ms')).toContain('시간이 초과')
  })

  it('네트워크/백엔드 다운을 연결 실패 안내로 매핑', () => {
    for (const raw of ['fetch failed', 'ECONNREFUSED 127.0.0.1:8000', 'backend unavailable']) {
      expect(toUserMessage(raw)).toContain('연결하지 못했')
    }
  })

  it('5xx를 백엔드 오류 안내로 매핑', () => {
    expect(toUserMessage('[502] Bad Gateway')).toContain('백엔드에서 오류')
  })

  it('빈/누락 입력은 일반 안내로 폴백', () => {
    expect(toUserMessage('')).toContain('알 수 없는 오류')
    expect(toUserMessage(null)).toContain('알 수 없는 오류')
    expect(toUserMessage(undefined)).toContain('알 수 없는 오류')
  })

  it('알 수 없는 에러는 앞부분을 잘라 노출', () => {
    const out = toUserMessage('Weird provider glitch #42')
    expect(out).toContain('오류가 발생했어요')
    expect(out).toContain('Weird provider glitch')
  })
})

describe('isActiveFrame — 요청 ID 가드', () => {
  it('현재 requestId와 일치할 때만 active', () => {
    expect(isActiveFrame({ requestId: 'a' }, 'a')).toBe(true)
    expect(isActiveFrame({ requestId: 'a' }, 'b')).toBe(false)
  })

  it('activeRequestId가 null이면 어떤 프레임도 거부(늦은 델타 방지)', () => {
    expect(isActiveFrame({ requestId: 'a' }, null)).toBe(false)
    expect(isActiveFrame({ requestId: null }, null)).toBe(false)
  })

  it('프레임이 없으면 false', () => {
    expect(isActiveFrame(null, 'a')).toBe(false)
    expect(isActiveFrame(undefined, 'a')).toBe(false)
  })

  it('늦게 도착한 이전 요청의 델타는 새 requestId와 불일치로 걸러짐', () => {
    const activeId = 'req-2'
    const staleDelta = { requestId: 'req-1', text: '이전 답변 조각' }
    expect(isActiveFrame(staleDelta, activeId)).toBe(false)
  })
})

describe('createSpeechQueue — 발화 직렬화', () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  it('겹쳐 호출해도 앞 발화가 끝난 뒤에 다음이 시작한다(중첩 재생 방지)', async () => {
    const speak = createSpeechQueue()
    const log = []
    const task = (name, ms) => async () => {
      log.push(`${name}:start`)
      await tick(ms)
      log.push(`${name}:end`)
    }
    // B를 A보다 먼저 끝날 만큼 짧게 줘도 순서가 뒤집히면 안 된다.
    const a = speak(task('A', 20))
    const b = speak(task('B', 1))
    await Promise.all([a, b])
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('셋 이상 쌓여도 등록 순서대로 하나씩 돈다(동시 진입 없음)', async () => {
    const speak = createSpeechQueue()
    let live = 0
    let maxLive = 0
    const ran = []
    const task = (name, ms) => async () => {
      live += 1
      maxLive = Math.max(maxLive, live)
      ran.push(name)
      await tick(ms)
      live -= 1
    }
    await Promise.all([speak(task('A', 15)), speak(task('B', 2)), speak(task('C', 8))])
    expect(ran).toEqual(['A', 'B', 'C'])
    expect(maxLive).toBe(1) // 겹쳐 돈 순간이 한 번도 없어야 한다
  })

  it('앞 발화가 실패해도 다음 발화가 막히지 않는다', async () => {
    const speak = createSpeechQueue()
    const ran = []
    const failing = speak(async () => { throw new Error('tts died') })
    await expect(failing).rejects.toThrow('tts died')
    await speak(async () => { ran.push('next') })
    expect(ran).toEqual(['next'])
  })

  it('큐가 비어 있으면 즉시 실행된다(단발 발화 경로)', async () => {
    const speak = createSpeechQueue()
    let done = false
    await speak(async () => { done = true })
    expect(done).toBe(true)
  })
})

describe('createSpeechQueue — ambient 우선순위·낡은 항목 드롭', () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  it('대기 중인 ambient는 더 새 ambient에 밀려 스스로 빠진다', async () => {
    const speak = createSpeechQueue()
    const ran = []
    const busy = speak(async () => { ran.push('user'); await tick(20) })
    const a1 = speak(async () => { ran.push('old') }, { priority: 'ambient' })
    const a2 = speak(async () => { ran.push('new') }, { priority: 'ambient' })
    await Promise.all([busy, a1, a2])
    expect(ran).toEqual(['user', 'new']) // 'old'는 이미 지나간 화면 얘기라 버려짐
  })

  it('user 발화는 여러 개여도 하나도 안 버려진다', async () => {
    const speak = createSpeechQueue()
    const ran = []
    await Promise.all([
      speak(async () => { ran.push('u1'); await tick(5) }),
      speak(async () => { ran.push('u2') }),
      speak(async () => { ran.push('u3') })
    ])
    expect(ran).toEqual(['u1', 'u2', 'u3'])
  })

  it('ambient 하나만 있으면 그대로 실행된다', async () => {
    const speak = createSpeechQueue()
    let ran = false
    await speak(async () => { ran = true }, { priority: 'ambient' })
    expect(ran).toBe(true)
  })

  it('ambient가 실행된 뒤 들어온 ambient는 정상 실행된다(슬롯 해제 확인)', async () => {
    const speak = createSpeechQueue()
    const ran = []
    await speak(async () => { ran.push('a') }, { priority: 'ambient' })
    await speak(async () => { ran.push('b') }, { priority: 'ambient' })
    expect(ran).toEqual(['a', 'b'])
  })
})

describe('parseSfx — 비언어 발성 태그', () => {
  it('태그를 떼고 종류를 돌려준다', () => {
    expect(parseSfx('[SFX:laugh] 우와 대박!')).toEqual({ text: '우와 대박!', sfx: 'laugh' })
  })

  it('태그가 없으면 sfx는 null', () => {
    expect(parseSfx('그냥 한마디')).toEqual({ text: '그냥 한마디', sfx: null })
  })

  it('모르는 종류는 태그만 지우고 소리는 내지 않는다', () => {
    expect(parseSfx('[SFX:explode] 뭐야')).toEqual({ text: '뭐야', sfx: null })
  })

  it('대소문자·공백을 견딘다', () => {
    expect(parseSfx('[SFX: SIGH ] 하아').sfx).toBe('sigh')
  })

  it('여러 개면 첫 번째 유효 태그만 쓰고 나머지도 제거한다', () => {
    const r = parseSfx('[SFX:wow] 어 [SFX:hmm] 저기')
    expect(r.sfx).toBe('wow')
    expect(r.text).not.toContain('[')
  })

  it('태그만 있으면 텍스트는 빈 문자열(소리만 낸다)', () => {
    expect(parseSfx('[SFX:sigh]')).toEqual({ text: '', sfx: 'sigh' })
  })

  it('빈 입력에도 안 터진다', () => {
    expect(parseSfx(null)).toEqual({ text: '', sfx: null })
  })
})

describe('createSpeechQueue — 사용자 발화 보호', () => {
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

  it('대기 중인 ambient는 뒤에 온 user 발화 앞에 끼어들지 못한다', async () => {
    const speak = createSpeechQueue()
    const ran = []
    // user1 재생 중 → 관전 코멘트가 큐에 붙음 → 사용자가 말을 걸어 user2가 붙음.
    // FIFO 그대로면 ambient가 user2보다 먼저 나가 "말 걸었는데 딴소리"가 된다.
    const u1 = speak(async () => { ran.push('user1'); await tick(20) })
    const amb = speak(async () => { ran.push('ambient') }, { priority: 'ambient' })
    const u2 = speak(async () => { ran.push('user2') })
    await Promise.all([u1, amb, u2])
    expect(ran).toEqual(['user1', 'user2'])
  })

  it('user 발화가 없으면 ambient는 정상 실행된다', async () => {
    const speak = createSpeechQueue()
    const ran = []
    const u1 = speak(async () => { ran.push('user1'); await tick(10) })
    const amb = speak(async () => { ran.push('ambient') }, { priority: 'ambient' })
    await Promise.all([u1, amb])
    expect(ran).toEqual(['user1', 'ambient'])
  })
})
