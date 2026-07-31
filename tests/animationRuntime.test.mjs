// VMD fade-handler drain (memory-leak fix): non-loop VMD 클립이 supersede/해제/
// 모델정리로 finished 없이 사라질 때 helper-소유 mixer에 건 리스너가 잔류하던
// 누수. clearVMDFadeHandlers가 저장한 그 mixer에서 정확히 떼는지 검증.
import { describe, it, expect } from 'vitest'
import { clearVMDFadeHandlers } from '../src/animationRuntime.js'

function fakeMixer() {
  const removed = []
  return {
    removed,
    removeEventListener(type, h) { removed.push([type, h]) },
  }
}

describe('clearVMDFadeHandlers', () => {
  it('removes each handler from its own mixer and empties the set', () => {
    const m1 = fakeMixer()
    const m2 = fakeMixer()
    const h1 = () => {}
    const h2 = () => {}
    const model = { _vmdFadeHandlers: new Set([
      { mixer: m1, handler: h1 },
      { mixer: m2, handler: h2 },
    ]) }

    clearVMDFadeHandlers(model)

    expect(m1.removed).toEqual([['finished', h1]])
    expect(m2.removed).toEqual([['finished', h2]])
    expect(model._vmdFadeHandlers.size).toBe(0)
  })

  it('is a no-op when no handler set exists', () => {
    expect(() => clearVMDFadeHandlers({})).not.toThrow()
    expect(() => clearVMDFadeHandlers(null)).not.toThrow()
  })
})
