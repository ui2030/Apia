/**
 * Tests for the wallpaper-mode adapter.
 *
 * The module used to be untestable: module-level state, a hard
 * `require('electron-as-wallpaper')`, a direct `execFile`, and an env flag read
 * at load time. `createWallpaperMode(deps)` injects all four, so the attach
 * state machine can be exercised with no Windows shell involved.
 *
 * What's locked in here:
 *   - native attach wins; progman-child is the fallback when it throws
 *   - detach routes to the teardown matching the mode it attached with
 *   - APIA_E2E_DISABLE_WALLPAPER='1' disables BOTH strategies
 *   - enable/disable are serialized (a slow attach can't land after a detach)
 *   - the helper is spawned as `win-wallpaper.exe <action> <hwnd>`, with the
 *     HWND read as a 64-bit value (a Number would lose high bits)
 */
import { describe, it, expect, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createWallpaperMode } = require('../electron/services/wallpaperMode')

const HIGH_HWND = 0x0000_02F4_0001_0A3Cn

function fakeWindow(handle = HIGH_HWND) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(handle)
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getNativeWindowHandle: () => buf
  }
}

/** execFile stub that replies with the helper's JSON line on stdout. */
function fakeExecFile(reply, calls = []) {
  return (file, args, opts, cb) => {
    calls.push({ file, args, opts })
    const body = typeof reply === 'function' ? reply(args[0]) : reply
    setTimeout(() => cb(null, `${JSON.stringify(body)}\n`, ''), 0)
  }
}

function nativeStub() {
  return { attach: vi.fn(), detach: vi.fn(), reset: vi.fn() }
}

function make(overrides = {}) {
  return createWallpaperMode({
    platform: 'win32',
    env: {},
    resourcesPath: null,
    ...overrides
  })
}

describe('native strategy', () => {
  it('attaches via the native module and reports mode', async () => {
    const native = nativeStub()
    const wp = make({ loadNativeModule: () => native })

    expect(wp.isAvailable()).toBe(true)
    expect(await wp.enableWallpaper(fakeWindow())).toBe('native')
    expect(wp.isAttached()).toBe(true)
    expect(wp.getMode()).toBe('native')
    expect(native.attach).toHaveBeenCalledTimes(1)
  })

  it('is idempotent for the same window', async () => {
    const native = nativeStub()
    const wp = make({ loadNativeModule: () => native })
    const win = fakeWindow()

    expect(await wp.enableWallpaper(win)).toBe('native')
    expect(await wp.enableWallpaper(win)).toBe('native')
    expect(native.attach).toHaveBeenCalledTimes(1)
  })

  it('detaches with native.detach and clears state', async () => {
    const native = nativeStub()
    const wp = make({ loadNativeModule: () => native })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    await wp.disableWallpaper(win)
    expect(native.detach).toHaveBeenCalledWith(win)
    expect(wp.isAttached()).toBe(false)
    expect(wp.getMode()).toBe('none')
  })

  it('falls back to native.reset when detach throws', async () => {
    const native = nativeStub()
    native.detach.mockImplementation(() => { throw new Error('boom') })
    const wp = make({ loadNativeModule: () => native })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    await wp.disableWallpaper(win)
    expect(native.reset).toHaveBeenCalledTimes(1)
    expect(wp.getMode()).toBe('none')
  })

  it('caches the load error so a broken module is only required once', () => {
    const load = vi.fn(() => { throw new Error('no WorkerW build') })
    const wp = make({ loadNativeModule: load })

    expect(wp.isAvailable()).toBe(false)
    expect(wp.isAvailable()).toBe(false)
    expect(load).toHaveBeenCalledTimes(1)
    expect(wp.getLoadError()).toBe('no WorkerW build')
  })

  it('refuses outside win32', () => {
    const wp = make({ platform: 'darwin', loadNativeModule: () => nativeStub() })
    expect(wp.isAvailable()).toBe(false)
    expect(wp.getLoadError()).toMatch(/Windows-only/)
  })
})

describe('progman-child fallback', () => {
  it('runs the helper when the native attach throws', async () => {
    const native = nativeStub()
    native.attach.mockImplementation(() => { throw new Error('couldn\'t locate WorkerW') })
    const calls = []
    const wp = make({
      loadNativeModule: () => native,
      execFile: fakeExecFile({ ok: true, parentMatch: true, rect: '0,0,1920,1080' }, calls)
    })

    expect(await wp.enableWallpaper(fakeWindow())).toBe('progman-child')
    expect(wp.getMode()).toBe('progman-child')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toMatch(/win-wallpaper\.exe$/)
    expect(calls[0].args).toEqual(['attach', HIGH_HWND.toString()])
    expect(calls[0].opts.windowsHide).toBe(true)
  })

  it('reports false when the helper says parentMatch=false', async () => {
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: fakeExecFile({ ok: true, parentMatch: false })
    })

    expect(await wp.enableWallpaper(fakeWindow())).toBe(false)
    expect(wp.isAttached()).toBe(false)
  })

  it('detaches through the helper, not the native module', async () => {
    const calls = []
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: fakeExecFile({ ok: true, parentMatch: true }, calls)
    })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    await wp.disableWallpaper(win)
    expect(calls.map((c) => c.args[0])).toEqual(['attach', 'detach'])
    expect(wp.getMode()).toBe('none')
  })

  it('skips the helper detach when the window is already destroyed', async () => {
    const calls = []
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: fakeExecFile({ ok: true, parentMatch: true }, calls)
    })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    win.destroyed = true
    await wp.disableWallpaper(win)
    expect(calls.map((c) => c.args[0])).toEqual(['attach'])
    expect(wp.getMode()).toBe('none')
  })
})

describe('isStillAttached', () => {
  it('assumes healthy when not progman-child', async () => {
    const wp = make({ loadNativeModule: () => nativeStub() })
    expect(await wp.isStillAttached(fakeWindow())).toBe(true) // detached
    await wp.enableWallpaper(fakeWindow())
    expect(await wp.isStillAttached()).toBe(true) // native
  })

  it('probes the helper and reports a lost Progman parent', async () => {
    let parentMatch = true
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: fakeExecFile((action) => (
        action === 'check' ? { ok: true, parentMatch } : { ok: true, parentMatch: true }
      ))
    })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    expect(await wp.isStillAttached(win)).toBe(true)
    parentMatch = false // explorer.exe restarted, child orphaned
    expect(await wp.isStillAttached(win)).toBe(false)
  })

  it('is false when the progman-child window died', async () => {
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: fakeExecFile({ ok: true, parentMatch: true })
    })
    const win = fakeWindow()
    await wp.enableWallpaper(win)
    win.destroyed = true
    expect(await wp.isStillAttached(win)).toBe(false)
  })
})

describe('markDetached', () => {
  it('clears state so a re-enable actually re-attaches', async () => {
    const native = nativeStub()
    const wp = make({ loadNativeModule: () => native })
    const win = fakeWindow()

    await wp.enableWallpaper(win)
    wp.markDetached()
    expect(wp.isAttached()).toBe(false)
    await wp.enableWallpaper(win)
    expect(native.attach).toHaveBeenCalledTimes(2)
  })
})

describe('APIA_E2E_DISABLE_WALLPAPER', () => {
  it('disables both strategies', async () => {
    const calls = []
    const wp = make({
      env: { APIA_E2E_DISABLE_WALLPAPER: '1' },
      loadNativeModule: () => nativeStub(),
      execFile: fakeExecFile({ ok: true, parentMatch: true }, calls)
    })

    expect(wp.isAvailable()).toBe(false)
    expect(await wp.enableWallpaper(fakeWindow())).toBe(false)
    expect(calls).toHaveLength(0)
    expect(wp.isAttached()).toBe(false)
  })
})

describe('serialization', () => {
  it('applies ops in call order even when the attach helper is slow', async () => {
    const order = []
    const wp = make({
      loadNativeModule: () => { throw new Error('unavailable') },
      execFile: (file, args, opts, cb) => {
        order.push(`start:${args[0]}`)
        const delay = args[0] === 'attach' ? 20 : 0
        setTimeout(() => {
          order.push(`done:${args[0]}`)
          cb(null, JSON.stringify({ ok: true, parentMatch: true }), '')
        }, delay)
      }
    })
    const win = fakeWindow()

    const enabling = wp.enableWallpaper(win)
    const disabling = wp.disableWallpaper(win)
    await Promise.all([enabling, disabling])

    // detach must not start before attach finished — otherwise a toggle-off can
    // land first and leave the window stuck as a Progman child.
    expect(order).toEqual(['start:attach', 'done:attach', 'start:detach', 'done:detach'])
    expect(wp.getMode()).toBe('none')
  })

  it('keeps instances isolated from each other', async () => {
    const a = make({ loadNativeModule: () => nativeStub() })
    const b = make({ loadNativeModule: () => nativeStub() })

    await a.enableWallpaper(fakeWindow())
    expect(a.isAttached()).toBe(true)
    expect(b.isAttached()).toBe(false)
  })
})

describe('guards', () => {
  it('returns false for a missing or destroyed window', async () => {
    const wp = make({ loadNativeModule: () => nativeStub() })
    expect(await wp.enableWallpaper(null)).toBe(false)
    const dead = fakeWindow()
    dead.destroyed = true
    expect(await wp.enableWallpaper(dead)).toBe(false)
  })

  it('disable on a never-attached instance is a no-op', async () => {
    const calls = []
    const wp = make({
      loadNativeModule: () => nativeStub(),
      execFile: fakeExecFile({ ok: true }, calls)
    })
    await wp.disableWallpaper(fakeWindow())
    expect(calls).toHaveLength(0)
    expect(wp.getMode()).toBe('none')
  })
})
