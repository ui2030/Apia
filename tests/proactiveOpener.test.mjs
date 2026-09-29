// 선톡(먼저 말 걸기) 순수 판단 + 상태 저장소 단위 테스트.
import { describe, it, expect } from 'vitest'
import {
  decideOpener,
  pickTopic,
  createOpenerStore
} from '../electron/services/proactiveOpener.js'

const HOUR = 3600000
const DAY = 86400000

// thawed(편함) + neutral + frozen(민감) + sensitive gold 를 섞은 원장 스냅샷.
function ledger() {
  return {
    topics: [
      { id: 'game', label: '게임', score: 0.15, state: 'thawed', goldLabel: null },
      { id: 'work', label: '업무', score: 0.5, state: 'neutral', goldLabel: null },
      { id: 'money', label: '돈', score: 0.8, state: 'frozen', goldLabel: null },
      { id: 'health', label: '건강', score: 0.2, state: 'thawed', goldLabel: 'sensitive' }
    ]
  }
}

describe('pickTopic', () => {
  it('prefers thawed over neutral, excludes frozen and sensitive', () => {
    const t = pickTopic(ledger(), null)
    expect(t.id).toBe('game') // 유일한 non-sensitive thawed
  })

  it('never returns a frozen or sensitive-labeled topic', () => {
    const only = { topics: [
      { id: 'money', label: '돈', score: 0.9, state: 'frozen', goldLabel: null },
      { id: 'health', label: '건강', score: 0.1, state: 'thawed', goldLabel: 'sensitive' }
    ] }
    expect(pickTopic(only, null)).toBeNull()
  })

  it('avoids repeating the last topic when an alternative exists', () => {
    const t = pickTopic(ledger(), 'game')
    expect(t.id).toBe('work')
  })

  it('returns null when there are no candidates (data insufficient)', () => {
    expect(pickTopic({ topics: [{ id: 'x', label: 'x', state: 'pending', goldLabel: null }] }, null)).toBeNull()
  })
})

describe('decideOpener', () => {
  const base = {
    now: Date.UTC(2026, 8, 26, 15, 0, 0),
    ledgerState: ledger(),
    lastOpenerAt: null,
    lastTopicId: null,
    midConversation: false,
    idleSec: 30,
    enabled: true,
    frequency: 'daily'
  }

  it('fires when present, not mid-conversation, no prior opener', () => {
    const d = decideOpener(base)
    expect(d.fire).toBe(true)
    expect(d.topic.id).toBe('game')
  })

  it('does not fire when disabled', () => {
    expect(decideOpener({ ...base, enabled: false }).fire).toBe(false)
    expect(decideOpener({ ...base, frequency: 'off' }).fire).toBe(false)
  })

  it('does not fire mid-conversation', () => {
    expect(decideOpener({ ...base, midConversation: true }).reason).toBe('mid-conversation')
  })

  it('does not fire when the user is away (idle >= 5min or unknown)', () => {
    expect(decideOpener({ ...base, idleSec: 600 }).reason).toBe('away')
    expect(decideOpener({ ...base, idleSec: undefined }).reason).toBe('away')
  })

  it('respects the 20h gap for daily frequency', () => {
    const recent = base.now - 10 * HOUR
    expect(decideOpener({ ...base, lastOpenerAt: recent }).reason).toBe('too-soon')
    const old = base.now - 21 * HOUR
    expect(decideOpener({ ...base, lastOpenerAt: old }).fire).toBe(true)
  })

  it('uses a wider gap for biDaily', () => {
    const at30h = base.now - 30 * HOUR
    expect(decideOpener({ ...base, frequency: 'biDaily', lastOpenerAt: at30h }).reason).toBe('too-soon')
    const at45h = base.now - 45 * HOUR
    expect(decideOpener({ ...base, frequency: 'biDaily', lastOpenerAt: at45h }).fire).toBe(true)
  })

  it('falls back to generic greeting when no topic is available', () => {
    const d = decideOpener({ ...base, ledgerState: { topics: [] } })
    expect(d.fire).toBe(true)
    expect(d.reason).toBe('generic')
    expect(d.topic).toBeNull()
  })
})

describe('createOpenerStore', () => {
  function memFs(initial = {}) {
    const files = { ...initial }
    return {
      files,
      readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p] },
      writeFileSync: (p, d) => { files[p] = d },
      renameSync: (a, b) => { files[b] = files[a]; delete files[a] },
      mkdirSync: () => {},
      unlinkSync: (p) => { delete files[p] }
    }
  }

  it('records sent/replied/ignored and remembers the last topic', () => {
    let t = 1000
    const fsImpl = memFs()
    const store = createOpenerStore({ statePath: '/x/opener.json', now: () => t, fsImpl })
    store.noteSent('game')
    t = 5000
    store.noteReplied()
    store.noteIgnored()
    const s = store.getState()
    expect(s.counts).toEqual({ sent: 1, replied: 1, ignored: 1 })
    expect(s.lastTopicId).toBe('game')
    expect(s.lastOpenerAt).toBe(1000)
  })

  it('persists across instances via the same fs', () => {
    const fsImpl = memFs()
    const a = createOpenerStore({ statePath: '/x/opener.json', now: () => 1, fsImpl })
    a.noteSent('work')
    const b = createOpenerStore({ statePath: '/x/opener.json', now: () => 2, fsImpl })
    expect(b.getState().lastTopicId).toBe('work')
    expect(b.getState().counts.sent).toBe(1)
  })
})
