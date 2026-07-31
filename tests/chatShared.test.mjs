import { describe, it, expect } from 'vitest'
import { toUserMessage, isActiveFrame } from '../src/chatShared.js'

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
