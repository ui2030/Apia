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

// 발주서 19 — 원장이 '조심'으로 본 화제 라벨만 채팅 body에 싣는다(원장은 읽기만).
describe('care_topics', () => {
  const { careTopicLabels, attachCareTopics, MAX_CARE_TOPICS } = require('../electron/services/chatPolicy.js')
  const row = (id, state, goldLabel = null) => ({ id, label: `L-${id}`, state, goldLabel })
  const BASE = { message: '안녕', history: [] }

  it('frozen·sensitive 포함, neutral/joke_ok 오버라이드·pending·thawed 제외', () => {
    const state = { topics: [
      row('a', 'frozen'),
      row('b', 'pending', 'sensitive'),  // 수동 민감은 상태와 무관하게 포함
      row('c', 'frozen', 'neutral'),
      row('d', 'frozen', 'joke_ok'),
      row('e', 'pending'),
      row('f', 'thawed'),
      row('g', 'neutral')
    ] }
    expect(careTopicLabels(state)).toEqual(['L-a', 'L-b'])
    expect(attachCareTopics(BASE, state)).toEqual({ ...BASE, care_topics: ['L-a', 'L-b'] })
  })

  it('없으면 키 자체를 안 붙인다(같은 객체 그대로)', () => {
    expect(attachCareTopics(BASE, { topics: [row('e', 'pending')] })).toBe(BASE)
    expect(attachCareTopics(BASE, { topics: [] })).toBe(BASE)
    expect(attachCareTopics(BASE, null)).toBe(BASE)
  })

  it('상한 8', () => {
    const topics = Array.from({ length: 12 }, (_, i) => row(`t${i}`, 'frozen'))
    expect(careTopicLabels({ topics }).length).toBe(MAX_CARE_TOPICS)
  })

  it('send-message·streamStart 둘 다 prepareExchange를 거치고, 거기서 배려를 붙인다', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../electron/main.js', import.meta.url), 'utf-8')
    const handler = (name) => src.slice(src.indexOf(`ipcMain.handle('${name}'`)).split('\nipcMain.handle(')[0]
    expect(handler('send-message')).toContain('prepareExchange(')
    expect(handler('chat:streamStart')).toContain('prepareExchange(')
    const prep = src.slice(src.indexOf('async function prepareExchange')).split('\n}\n')[0]
    expect(prep).toMatch(/attachCareTopics\([\s\S]*safeLedgerState\(\)\)/)
  })
})
