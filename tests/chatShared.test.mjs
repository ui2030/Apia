import { describe, it, expect } from 'vitest'
import { toUserMessage, isActiveFrame, createSpeechQueue } from '../src/chatShared.js'

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
