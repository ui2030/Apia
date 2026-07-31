/**
 * Tests for the sofa-as-seat work (방 구조 개선):
 *   1. world.js interactWith dispatches a sit payload for ANY object with a
 *      sitOffset, not just type:'chair' (root-cause fix — sofa is type:'point').
 *   2. characterController walkTo/_walk skip the walkBounds clamp for explicit
 *      sit targets so the character can reach a wall-side seat (sofa x-2.2 sits
 *      outside DEFAULT_BOUNDS minX-1.7) and lands ON the seat, not clamped short.
 */
import { describe, it, expect } from 'vitest'
import { WorldManager } from '../src/world.js'
import { walkTo, updateCharacter, getState, setState } from '../src/characterController.js'

// interactWith touches this.getObjectById/onWalkTo/showBubble/log but NOT the
// DOM (no jsdom in this config), so we invoke it on a minimal fake `this`.
function fakeManager(object, onWalkTo) {
  return {
    getObjectById: (id) => (id === object.id ? object : null),
    onWalkTo,
    showBubble: () => {},
    onStartActivity: null,
    log: () => {},
  }
}

describe('world.interactWith sit dispatch (type-agnostic)', () => {
  it('passes sitOffset payload for a non-chair seat (type:point)', () => {
    let payload = null
    const seat = {
      id: 'sofa', type: 'point', clickable: true,
      x: -2.2, z: 4.6,
      sitOffset: { x: 0.15, y: 0.04, z: 0 }, sitRotY: 0, seatHeight: 0.38,
      // no activity → falls through to the walk/sit payload path
    }
    const ok = WorldManager.prototype.interactWith.call(
      fakeManager(seat, (p) => { payload = p }),
      'sofa', { source: 'click' },
    )
    expect(ok).toBe(true)
    expect(payload).not.toBeNull()
    expect(payload.sitOffset).toEqual({ x: 0.15, y: 0.04, z: 0 })
    expect(payload.seatHeight).toBe(0.38)
  })

  it('still omits sitOffset for a plain point with no sitOffset', () => {
    let payload = null
    const spot = { id: 'plant', type: 'point', clickable: true, x: 0, z: 5 }
    WorldManager.prototype.interactWith.call(
      fakeManager(spot, (p) => { payload = p }),
      'plant', { source: 'click' },
    )
    expect(payload).not.toBeNull()
    expect(payload.sitOffset).toBeUndefined()
  })
})

describe('characterController bounds exception for sit targets', () => {
  it('reaches an out-of-bounds seat without clamping (sofa x-2.2 → seat x-2.05)', () => {
    setState('idle')
    // Seat = furniture center (-2.2,4.6) + sitOffset.x 0.15 → x -2.05. If the
    // walkBounds (minX-1.7) clamp still applied, the target would clamp to -1.7
    // and the seat would land at -1.55. Start adjacent so arrival is immediate.
    const mesh = {
      position: { x: -2.0, y: 0, z: 4.6, set(x, y, z) { this.x = x; this.y = y; this.z = z } },
      rotation: { x: 0, y: 0, z: 0 },
      getObjectByName: () => null,
    }
    walkTo({ x: -2.2, z: 4.6, sitOffset: { x: 0.15, y: 0.04, z: 0 }, sitRotY: 0, seatHeight: 0.38, holdSit: true })
    let t = 0
    for (let i = 0; i < 300 && getState() !== 'sit'; i += 1) {
      t += 0.05
      updateCharacter(mesh, t, 0.05)
    }
    expect(getState()).toBe('sit')
    // Landed on the seat (~-2.05), i.e. well past the -1.7 bound — proving the
    // clamp was skipped. Tolerance covers the sit-bob on position.
    expect(mesh.position.x).toBeLessThan(-1.9)
    expect(mesh.position.x).toBeCloseTo(-2.05, 1)
  })
})
