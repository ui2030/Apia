/**
 * Window coordinator for the Apia main process.
 *
 * Not strictly a DDD aggregate — it's an Electron-specific stateful service
 * that owns the lifetime of the main + settings BrowserWindows and the
 * startup-error fallback window. Naming it "Manager" matches the project's
 * existing vocabulary ("mainWindow", "settingsWindow") and is clearer than
 * forcing a Repository label onto something that has nothing to do with
 * persistence.
 *
 * Electron deps (BrowserWindow, screen) are injected so the module can be
 * imported in tests that exercise its pure helpers (escapeHtml +
 * renderStartupErrorHtml) without electron being present.
 */
const path = require('path')
const fs = require('fs')

const {
  pickTargetWorkArea,
  workAreaCentre
} = require('./windowBoundsPolicy')

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Pure renderer for the startup-error HTML. Exported so tests can validate
 * the markup directly and so the WindowManager itself stays slim.
 * `mainLogPath` is passed in so the caller (main.js) owns the runtime log
 * location — earlier this read a module-level MAIN_LOG_PATH constant.
 */
function renderStartupErrorHtml({ title, detail = '', mainLogPath }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apia Startup Error</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: #111827;
      color: #f9fafb;
    }
    .panel {
      max-width: 760px;
      margin: 0 auto;
      background: rgba(17, 24, 39, 0.94);
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 22px;
    }
    p {
      margin: 0 0 14px;
      line-height: 1.6;
      color: #d1d5db;
    }
    code, pre {
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 12px;
      background: rgba(2, 6, 23, 0.85);
      color: #bfdbfe;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="panel">
    <h1>${escapeHtml(title)}</h1>
    <p>Apia could not finish startup. Check the runtime log for more detail:</p>
    <pre>${escapeHtml(mainLogPath)}</pre>
    ${detail ? `<p>Last error:</p><pre>${escapeHtml(detail)}</pre>` : ''}
  </div>
</body>
</html>`
}

class WindowManager {
  #BrowserWindow
  #screen
  #isDev
  #appGetPath
  #appIsPackaged
  #log
  #preloadPath
  #mainLogPath
  #loadSettings
  #devURL

  #main = null
  #settings = null

  #saveSettings
  #anchorDebounceTimer = null

  constructor({
    BrowserWindow,
    screen,
    isDev,
    appGetPath,        // (key: string) => string
    appIsPackaged,     // boolean
    log,               // { info, warn, error }
    preloadPath,       // resolved absolute path to preload.js
    mainLogPath,       // for the startup-error HTML
    loadSettings,      // () => settings — used at main-window create time
    saveSettings,      // (partial) => settings — used to persist windowAnchor
    devURL = 'http://localhost:5173'
  }) {
    if (!BrowserWindow) throw new Error('WindowManager: BrowserWindow required')
    if (!screen) throw new Error('WindowManager: screen required')
    if (typeof appGetPath !== 'function') throw new Error('WindowManager: appGetPath required')
    if (!log?.info) throw new Error('WindowManager: log.info required')
    if (!preloadPath) throw new Error('WindowManager: preloadPath required')
    if (!mainLogPath) throw new Error('WindowManager: mainLogPath required')
    if (typeof loadSettings !== 'function') throw new Error('WindowManager: loadSettings required')
    if (typeof saveSettings !== 'function') throw new Error('WindowManager: saveSettings required')

    this.#BrowserWindow = BrowserWindow
    this.#screen = screen
    this.#isDev = isDev
    this.#appGetPath = appGetPath
    this.#appIsPackaged = appIsPackaged
    this.#log = log
    this.#preloadPath = preloadPath
    this.#mainLogPath = mainLogPath
    this.#loadSettings = loadSettings
    this.#saveSettings = saveSettings
    this.#devURL = devURL
  }

  getMain() {
    return this.#main
  }

  getSettings() {
    return this.#settings
  }

  /**
   * Persist the main-window anchor (centre of its current workArea) so the
   * next launch can restore onto the same display. Debounced 300ms because
   * dragging across a monitor fires `move` continuously. On `close` we
   * flush synchronously — Electron tears down the window object before
   * `before-quit` runs in the parent, so waiting until then would lose the
   * final position.
   */
  #attachAnchorPersistence(window) {
    const scheduleSave = () => {
      if (this.#anchorDebounceTimer !== null) {
        clearTimeout(this.#anchorDebounceTimer)
      }
      this.#anchorDebounceTimer = setTimeout(() => {
        this.#anchorDebounceTimer = null
        this.#flushAnchor()
      }, 300)
    }

    window.on('move', scheduleSave)
    window.on('moved', scheduleSave) // win32 only — final position after drag
    window.on('resize', scheduleSave)

    window.on('close', () => {
      if (this.#anchorDebounceTimer !== null) {
        clearTimeout(this.#anchorDebounceTimer)
        this.#anchorDebounceTimer = null
      }
      this.#flushAnchor()
    })
  }

  #flushAnchor() {
    const window = this.#main
    if (!window || window.isDestroyed()) return
    let bounds
    try {
      bounds = window.getBounds()
    } catch {
      return
    }
    // Anchor at the centre of the window so it's still inside the matching
    // display's workArea even after a small taskbar / DPI change.
    const anchor = workAreaCentre(bounds)
    if (!anchor) return
    try {
      const current = this.#loadSettings()
      this.#saveSettings({ ...current, windowAnchor: anchor })
    } catch (error) {
      this.#log.warn('[WINDOW_ANCHOR_SAVE_WARN]', error)
    }
  }

  /**
   * Public flush so the main process can drain a pending debounced save in
   * `before-quit`. Safe to call when no save is pending — no-op.
   */
  flushPendingAnchor() {
    if (this.#anchorDebounceTimer !== null) {
      clearTimeout(this.#anchorDebounceTimer)
      this.#anchorDebounceTimer = null
    }
    this.#flushAnchor()
  }

  /**
   * 환경설정의 모니터 선택 — 메인 창을 지정 workArea로 옮기고 앵커를 즉시
   * 영속한다. 보류 중인 move 디바운스를 걷어내고 flush하므로 사용자의 명시적
   * 선택이 앵커 저장의 권위가 된다(Codex MUST-FIX). 다음 실행은 기존
   * pickTargetWorkArea 경로가 이 앵커로 같은 모니터를 복원한다.
   */
  moveMainToWorkArea(workArea) {
    const main = this.#main
    if (!main || main.isDestroyed()) return false
    if (!workArea || ![workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite)) return false
    try {
      main.setBounds({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height
      })
    } catch {
      return false
    }
    this.flushPendingAnchor()
    return true
  }

  #attachDiagnostics(window, label) {
    window.on('closed', () => {
      this.#log.warn(`[WINDOW_CLOSED] ${label}`)
      if (window === this.#main) this.#main = null
      if (window === this.#settings) this.#settings = null
    })

    window.on('unresponsive', () => {
      this.#log.warn(`[WINDOW_UNRESPONSIVE] ${label}`)
    })

    window.webContents.on('did-start-loading', () => {
      this.#log.info(`[WINDOW_LOAD_START] ${label}`)
    })

    window.webContents.on('did-finish-load', () => {
      this.#log.info(`[WINDOW_LOAD_FINISH] ${label}`, window.webContents.getURL())
    })

    window.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.#log.error(`[WINDOW_LOAD_FAIL] ${label}`, { errorCode, errorDescription, validatedURL, isMainFrame })
    })

    window.webContents.on('render-process-gone', (event, details) => {
      this.#log.error(`[WINDOW_RENDER_GONE] ${label}`, details)
    })

    window.webContents.on('preload-error', (event, preloadPath, error) => {
      this.#log.error(`[WINDOW_PRELOAD_ERROR] ${label}`, { preloadPath, error })
    })
  }

  async createMainWindow() {
    const s = this.#loadSettings()
    const targetWorkArea = pickTargetWorkArea({
      anchor: s.windowAnchor,
      displays: this.#screen.getAllDisplays(),
      primaryDisplay: this.#screen.getPrimaryDisplay()
    })

    this.#main = new this.#BrowserWindow({
      width: targetWorkArea.width,
      height: targetWorkArea.height,
      x: targetWorkArea.x,
      y: targetWorkArea.y,
      transparent: true,
      frame: false,
      alwaysOnTop: s.alwaysOnTop !== false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      webPreferences: {
        preload: this.#preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        allowRunningInsecureContent: false
      }
    })
    this.#attachDiagnostics(this.#main, 'main')
    this.#attachAnchorPersistence(this.#main)

    // 처음부터 클릭 통과 상태로 두지 않음. 켜져 있으면 설정 버튼 / 채팅 버튼이
    // 전부 안 눌릴 수 있음.
    this.#main.setIgnoreMouseEvents(false)

    this.#log.info('[MAIN_WINDOW_CREATED]', {
      width: targetWorkArea.width,
      height: targetWorkArea.height,
      x: targetWorkArea.x,
      y: targetWorkArea.y,
      isDev: this.#isDev,
      isPackaged: this.#appIsPackaged
    })

    try {
      if (this.#isDev) {
        await this.#main.loadURL(this.#devURL)
        this.#main.webContents.openDevTools({ mode: 'detach' })
      } else {
        const appPath = this.#appGetPath('app')
        const indexPath = path.join(appPath, 'dist', 'index.html')
        this.#log.info('[MAIN_WINDOW_LOADFILE]', {
          appPath, indexPath, exists: fs.existsSync(indexPath)
        })
        await this.#main.loadFile(indexPath)
      }
    } catch (error) {
      await this.showStartupError('Main window failed to load.', error)
    }

    return this.#main
  }

  openSettings() {
    if (this.#settings && !this.#settings.isDestroyed()) {
      this.#settings.focus()
      return this.#settings
    }

    // 캐릭터가 있는 디스플레이의 작업영역 중앙에 띄운다. x/y를 안 주면 보조
    // 모니터(음수 좌표)로 새거나 다른 창 뒤에 숨어 사용자가 못 보는 일이 생긴다
    // — 벽지모드에선 핫코너 버튼이 유일한 진입점이라 가시성이 특히 중요하다.
    const SETTINGS_W = 440
    const SETTINGS_H = 700
    let settingsDisplay
    try {
      settingsDisplay = (this.#main && !this.#main.isDestroyed())
        ? this.#screen.getDisplayMatching(this.#main.getBounds())
        : this.#screen.getPrimaryDisplay()
    } catch {
      settingsDisplay = this.#screen.getPrimaryDisplay()
    }
    const sWa = settingsDisplay.workArea

    this.#settings = new this.#BrowserWindow({
      width: SETTINGS_W,
      height: SETTINGS_H,
      x: Math.round(Math.max(sWa.x, sWa.x + (sWa.width - SETTINGS_W) / 2)),
      y: Math.round(Math.max(sWa.y, sWa.y + (sWa.height - SETTINGS_H) / 2)),
      resizable: false,
      frame: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: this.#preloadPath,
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    this.#attachDiagnostics(this.#settings, 'settings')

    const settingsHtmlPath = this.#isDev
      ? path.join(__dirname, '..', '..', 'settings.html')
      : path.join(this.#appGetPath('app'), 'dist', 'settings.html')

    this.#log.info('[SETTINGS_WINDOW_LOADFILE]', {
      settingsPath: settingsHtmlPath, exists: fs.existsSync(settingsHtmlPath)
    })
    this.#settings.loadFile(settingsHtmlPath).catch((error) => {
      this.showStartupError('Settings window failed to load.', error).catch((nestedError) => {
        this.#log.error('[SETTINGS_WINDOW_ERROR_FALLBACK_FAILED]', nestedError)
      })
    })

    return this.#settings
  }

  async showStartupError(title, error) {
    const detail = error instanceof Error
      ? `${error.message}\n\n${error.stack || ''}`
      : String(error || '')

    this.#log.error('[STARTUP_UI_ERROR]', title, detail)

    const html = renderStartupErrorHtml({
      title, detail, mainLogPath: this.#mainLogPath
    })
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

    if (this.#main && !this.#main.isDestroyed()) {
      try {
        await this.#main.loadURL(dataUrl)
        return
      } catch (loadError) {
        // The main window can be alive-but-unusable when its initial load
        // failed (webContents gone) — `isDestroyed()` is false yet `loadURL`
        // throws "Object has been destroyed". Don't let the error reporter
        // itself crash; fall through to a fresh fallback window.
        this.#log.warn('[STARTUP_ERROR_MAIN_LOAD_FAILED]', loadError?.message || loadError)
      }
    }

    try {
      const fallback = new this.#BrowserWindow({
        width: 860,
        height: 620,
        show: true,
        backgroundColor: '#111827',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      await fallback.loadURL(dataUrl)
    } catch (fallbackError) {
      // Last resort — the error reporter must never throw (it runs inside other
      // catch blocks). The failure is already in the runtime log.
      this.#log.error('[STARTUP_ERROR_FALLBACK_FAILED]', fallbackError?.message || fallbackError)
    }
  }

  /**
   * Apply a settings change to the live windows. Owns the alwaysOnTop side
   * effect and the broadcast to both the main and settings webContents so
   * the IPC handler stays "ask windows to react to settings", not "manage
   * window state".
   */
  applySettings(settings) {
    if (this.#main && !this.#main.isDestroyed()) {
      this.#main.setAlwaysOnTop(settings.alwaysOnTop !== false)
      this.#main.webContents.send('settings-applied', settings)
    }
    if (this.#settings && !this.#settings.isDestroyed()) {
      this.#settings.webContents.send('settings-applied', settings)
    }
  }
}

module.exports = {
  WindowManager,
  escapeHtml,
  renderStartupErrorHtml
}
