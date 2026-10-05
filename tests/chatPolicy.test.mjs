// 발주서 16 — 대기 상한이 실제 응답자를 따라가고, 교사→로컬 폴백 안내는 하루 1회.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chatTimeoutFor, createFallbackNotice, FALLBACK_NOTICES } = require('../electron/services/chatPolicy.js')

describe('chatTimeoutFor', () => {
  it('auto는 로컬 폴백이 있어 느린 쪽(180s)', () => {
    expect(chatTimeoutFor('auto')).toBe(180000)
    expect(chatTimeoutFor('local')).toBe(180000)
    expect(chatTimeoutFor('claude_code')).toBe(180000)
    expect(chatTimeoutFor('groq')).toBe(30000)
  })
})

describe('createFallbackNotice', () => {
  it('하루 1회만, 다음날 다시', () => {
    let now = new Date(2026, 9, 6, 10)
    const notice = createFallbackNotice(() => now)
    const fb = { fallback: 'local', fallback_reason: 'budget' }
    expect(notice({})).toBeNull()                    // 폴백 없는 답은 안내 없음
    expect(notice(fb)).toBe(FALLBACK_NOTICES.budget)
    expect(notice(fb)).toBeNull()
    expect(notice({ fallback: 'local', fallback_reason: 'error' })).toBeNull()
    now = new Date(2026, 9, 7, 9)
    expect(notice({ fallback: 'local', fallback_reason: 'error' })).toBe(FALLBACK_NOTICES.error)
  })

  it('예산이 아닌 이유로 폴백하면 예산 탓을 하지 않는다', () => {
    const notice = createFallbackNotice()
    expect(notice({ fallback: 'local' })).toBe(FALLBACK_NOTICES.error)
  })
})

describe('partial 안내', () => {
  it('교사 답이 중간에 끊기면 하루 1회 규칙과 무관하게 매번 알린다', () => {
    const notice = createFallbackNotice(() => new Date(2026, 9, 6, 10))
    expect(notice({ fallback: 'partial', fallback_reason: 'error' })).toBe(FALLBACK_NOTICES.partial)
    expect(notice({ fallback: 'partial', fallback_reason: 'error' })).toBe(FALLBACK_NOTICES.partial)
    expect(notice({ fallback: 'local', fallback_reason: 'error' })).toBe(FALLBACK_NOTICES.error)
  })
})
