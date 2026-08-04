/**
 * Tests for WindowManager.
 *
 * Per the plan: shallow only. The real BrowserWindow interactions need a
 * running Electron, so they stay covered by smoke:release. Here we exercise
 * the pure helpers (escapeHtml, renderStartupErrorHtml), constructor
 * validation, and the small DI surface around log + path injection.
 */
import { describe, it, expect, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  WindowManager,
  escapeHtml,
  renderStartupErrorHtml
} = require('../electron/services/windowManager')

function createDeps(overrides = {}) {
  return {
    BrowserWindow: vi.fn(),
    screen: {
      getPrimaryDisplay: () => ({
        workAreaSize: { width: 1280, height: 800 },
        workArea: { x: 0, y: 0, width: 1280, height: 800 }
      }),
      getAllDisplays: () => [
        { workArea: { x: 0, y: 0, width: 1280, height: 800 } }
      ]
    },
    isDev: false,
    appGetPath: vi.fn((key) => `/tmp/${key}`),
    appIsPackaged: true,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    preloadPath: '/tmp/preload.js',
    mainLogPath: '/tmp/main.log',
    loadSettings: () => ({ alwaysOnTop: true, windowAnchor: null }),
    patchSettings: vi.fn((s) => s),
    ...overrides
  }
}

describe('escapeHtml', () => {
  it('escapes the canonical XSS characters', () => {
    expect(escapeHtml('<script>alert("hi")</script>')).toBe(
      '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;'
    )
  })

  it('escapes ampersands and single quotes', () => {
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s')
  })

  it('handles non-string input by coercion', () => {
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(null)).toBe('null')
  })
})

describe('renderStartupErrorHtml', () => {
  it('embeds the title, log path, and detail', () => {
    const html = renderStartupErrorHtml({
      title: 'Boom',
      detail: 'stack trace here',
      mainLogPath: '/var/log/apia/main.log'
    })
    expect(html).toContain('Boom')
    expect(html).toContain('/var/log/apia/main.log')
    expect(html).toContain('stack trace here')
  })

  it('hides the detail block when detail is empty', () => {
    const html = renderStartupErrorHtml({
      title: 'Boom',
      mainLogPath: '/var/log/apia/main.log'
    })
    expect(html).not.toContain('Last error:')
  })

  it('escapes user-provided content in title and detail', () => {
    const html = renderStartupErrorHtml({
      title: '<img src=x onerror=alert(1)>',
      detail: '<script>',
      mainLogPath: '/log'
    })
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('WindowManager constructor', () => {
  it('accepts a complete deps bag', () => {
    expect(() => new WindowManager(createDeps())).not.toThrow()
  })

  it('rejects missing BrowserWindow', () => {
    expect(() => new WindowManager(createDeps({ BrowserWindow: undefined })))
      .toThrow(/BrowserWindow/)
  })

  it('rejects missing screen', () => {
    expect(() => new WindowManager(createDeps({ screen: undefined })))
      .toThrow(/screen/)
  })

  it('rejects missing log.info', () => {
    expect(() => new WindowManager(createDeps({ log: {} })))
      .toThrow(/log\.info/)
  })

  it('rejects missing preloadPath', () => {
    expect(() => new WindowManager(createDeps({ preloadPath: undefined })))
      .toThrow(/preloadPath/)
  })

  it('rejects missing mainLogPath', () => {
    expect(() => new WindowManager(createDeps({ mainLogPath: undefined })))
      .toThrow(/mainLogPath/)
  })

  it('rejects non-function loadSettings', () => {
    expect(() => new WindowManager(createDeps({ loadSettings: 'nope' })))
      .toThrow(/loadSettings/)
  })

  it('rejects non-function patchSettings', () => {
    expect(() => new WindowManager(createDeps({ patchSettings: undefined })))
      .toThrow(/patchSettings/)
  })

  it('starts with null main/settings refs', () => {
    const manager = new WindowManager(createDeps())
    expect(manager.getMain()).toBe(null)
    expect(manager.getSettings()).toBe(null)
  })
})

describe('WindowManager.applySettings', () => {
  it('is a no-op when no windows are alive', () => {
    const manager = new WindowManager(createDeps())
    expect(() => manager.applySettings({ alwaysOnTop: false })).not.toThrow()
  })
})

describe('WindowManager.flushPendingAnchor', () => {
  it('is a no-op when no main window has been created yet', () => {
    const manager = new WindowManager(createDeps())
    expect(() => manager.flushPendingAnchor()).not.toThrow()
  })
})

describe('WindowManager.moveMainToWorkArea', () => {
  // `landings`는 setBounds 호출마다 창이 "실제로" 앉는 자리. 배율이 다른
  // 모니터로 건너뛸 때 Chromium이 옮기기 전 모니터의 배율로 변환해 첫 호출이
  // 빗나가는 상황을 흉내낸다.
  async function managerWithMain(landings) {
    let bounds = { x: 0, y: 0, width: 1280, height: 800 }
    const setBounds = vi.fn(() => {
      bounds = landings.length ? landings.shift() : bounds
    })
    const win = {
      isDestroyed: () => false,
      on: vi.fn(),
      once: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      getBounds: () => ({ ...bounds }),
      setBounds,
      webContents: { on: vi.fn(), send: vi.fn(), openDevTools: vi.fn() },
      loadFile: vi.fn(async () => {}),
      loadURL: vi.fn(async () => {})
    }
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const manager = new WindowManager(createDeps({ BrowserWindow: function () { return win }, log }))
    await manager.createMainWindow()
    setBounds.mockClear()
    return { manager, setBounds, log }
  }

  const target = { x: -2195, y: -306, width: 2195, height: 1187 }

  it('sets the bounds once when the window lands inside the target work area', async () => {
    const { manager, setBounds, log } = await managerWithMain([{ ...target }])
    expect(manager.moveMainToWorkArea(target)).toBe(true)
    expect(setBounds).toHaveBeenCalledTimes(1)
    expect(log.warn).not.toHaveBeenCalledWith('[WINDOW_MOVE_RETRY]', expect.anything())
  })

  it('retries once when the first move lands outside the target work area', async () => {
    const { manager, setBounds, log } = await managerWithMain([
      { x: 3840, y: 535, width: 1920, height: 1080 }, // 화면 밖으로 튄 상태
      { ...target }
    ])
    expect(manager.moveMainToWorkArea(target)).toBe(true)
    expect(setBounds).toHaveBeenCalledTimes(2)
    expect(setBounds).toHaveBeenLastCalledWith(target)
    expect(log.warn).toHaveBeenCalledWith('[WINDOW_MOVE_RETRY]', expect.anything())
  })

  it('rejects a malformed work area without touching the window', async () => {
    const { manager, setBounds } = await managerWithMain([])
    expect(manager.moveMainToWorkArea({ x: 0, y: 0, width: NaN, height: 800 })).toBe(false)
    expect(setBounds).not.toHaveBeenCalled()
  })
})
