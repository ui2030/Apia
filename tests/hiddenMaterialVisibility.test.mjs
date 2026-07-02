/**
 * Tests for modelRuntime.syncHiddenMaterialVisibility — MMD 숨김 토글 파츠
 * (transparent+opacity 0 재질)가 흰 셸로 새는 것을 visible=false로 차단하는
 * per-frame 동기화. 우리가 숨긴 재질만 복원한다(외부가 숨긴 것 불가침).
 */
import { describe, it, expect } from 'vitest'
import { syncHiddenMaterialVisibility } from '../src/modelRuntime.js'

function mat(over = {}) {
  return { transparent: false, opacity: 1, visible: true, userData: {}, ...over }
}

describe('syncHiddenMaterialVisibility', () => {
  it('hides transparent materials at opacity 0 and counts them', () => {
    const hiddenPart = mat({ transparent: true, opacity: 0 })
    const normal = mat()
    const n = syncHiddenMaterialVisibility([hiddenPart, normal])
    expect(n).toBe(1)
    expect(hiddenPart.visible).toBe(false)
    expect(hiddenPart.userData.__hiddenByOpacity).toBe(true)
    expect(normal.visible).toBe(true)
  })

  it('does NOT hide opaque materials even at opacity 0 (transparent flag required)', () => {
    const odd = mat({ transparent: false, opacity: 0 })
    syncHiddenMaterialVisibility([odd])
    expect(odd.visible).toBe(true)
  })

  it('restores a material we hid once a morph raises its opacity', () => {
    const blush = mat({ transparent: true, opacity: 0 })
    syncHiddenMaterialVisibility([blush])
    expect(blush.visible).toBe(false)
    blush.opacity = 0.6 // 재질 모프가 켬(예: 홍조)
    syncHiddenMaterialVisibility([blush])
    expect(blush.visible).toBe(true)
    expect(blush.userData.__hiddenByOpacity).toBeUndefined()
  })

  it('never force-shows a material hidden by someone else', () => {
    const external = mat({ transparent: true, opacity: 0.8, visible: false })
    syncHiddenMaterialVisibility([external])
    expect(external.visible).toBe(false) // 외부 숨김 불가침
  })

  it('a material both externally hidden and opacity-0 is not adopted (no flag steal)', () => {
    const external = mat({ transparent: true, opacity: 0, visible: false })
    syncHiddenMaterialVisibility([external])
    expect(external.userData.__hiddenByOpacity).toBeUndefined()
    external.opacity = 1
    syncHiddenMaterialVisibility([external])
    expect(external.visible).toBe(false) // 여전히 외부 숨김 존중
  })

  it('near-zero within eps hides; above eps stays visible', () => {
    const tiny = mat({ transparent: true, opacity: 0.0005 })
    const soft = mat({ transparent: true, opacity: 0.05 })
    syncHiddenMaterialVisibility([tiny, soft])
    expect(tiny.visible).toBe(false)
    expect(soft.visible).toBe(true) // 부드러운 페이드는 건드리지 않음
  })

  it('accepts null, a single material, and undefined opacity without throwing', () => {
    expect(syncHiddenMaterialVisibility(null)).toBe(0)
    expect(syncHiddenMaterialVisibility(undefined)).toBe(0)
    const single = mat({ transparent: true, opacity: 0 })
    expect(syncHiddenMaterialVisibility(single)).toBe(1)
    const noOpacity = mat({ transparent: true, opacity: undefined })
    expect(() => syncHiddenMaterialVisibility([noOpacity, null])).not.toThrow()
    expect(noOpacity.visible).toBe(true) // opacity 미정의 → 1로 간주
  })

  it('is idempotent across frames (steady hidden count, no flapping)', () => {
    const part = mat({ transparent: true, opacity: 0 })
    const a = syncHiddenMaterialVisibility([part])
    const b = syncHiddenMaterialVisibility([part])
    const c = syncHiddenMaterialVisibility([part])
    expect([a, b, c]).toEqual([1, 1, 1])
    expect(part.visible).toBe(false)
  })
})
