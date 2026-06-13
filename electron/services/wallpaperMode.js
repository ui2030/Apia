/**
 * Wallpaper-mode adapter for the main BrowserWindow.
 *
 * Two attach strategies, tried in order:
 *   1. `electron-as-wallpaper` (Win32 Progman → WorkerW → SetParent). Works on
 *      Windows builds that keep a separate WorkerW behind the desktop icons.
 *   2. Progman-child fallback (scripts/win-wallpaper.exe, source win-wallpaper.cs). Windows 11 builds
 *      like 26200 have NO WorkerW — Progman hosts SHELLDLL_DefView (icons) and
 *      the wallpaper directly, spanning the whole virtual desktop. The native
 *      module then fails with "couldn't locate WorkerW". The helper does the
 *      reparent that build actually needs (WS_POPUP→WS_CHILD, SetParent to
 *      Progman, SetWindowPos HWND_BOTTOM onto the window's own monitor), which
 *      puts the overlay over the wallpaper but under the icons — on the right
 *      monitor (multi-display safe via MonitorFromWindow).
 *
 * The Progman-child helper MUST run ASYNC (execFile), never execFileSync: the
 * helper calls SetParent/SetWindowPos on the Electron window, which block on
 * that window's owning thread (the Electron main thread). A sync spawn blocks
 * the main thread waiting for the helper while the helper blocks waiting for
 * the main thread's message pump → deadlock (observed as a 15s ETIMEDOUT).
 * Async keeps the pump alive. The native path is in-process on the main thread,
 * so it's safe to call directly. enable/disable are serialized through a single
 * promise chain so a toggle-off can't interleave with an in-flight attach
 * (Codex MUST-FIX: stale-async race).
 *
 * `attachState.mode` is 'native' | 'progman-child' | 'none' so detach can route
 * to the matching teardown even when the native module isn't loadable.
 *
 * The native module is C++ node-gyp built (1.x). For packaged builds it must be
 * in `asarUnpack`, and scripts/win-wallpaper.exe ships via extraResources (it's
 * resolved from resourcesPath when packaged).
 */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const E2E_DISABLE = process.env.APIA_E2E_DISABLE_WALLPAPER === '1'

let cachedModule = null
let cachedLoadError = null
let attachState = { mode: 'none', window: null }

function loadNative() {
  if (cachedModule !== null) return cachedModule
  if (cachedLoadError) return null
  if (process.platform !== 'win32') {
    cachedLoadError = new Error(`wallpaper mode is Windows-only (platform=${process.platform})`)
    return null
  }
  if (E2E_DISABLE) {
    cachedLoadError = new Error('wallpaper disabled by APIA_E2E_DISABLE_WALLPAPER')
    return null
  }
  try {
    // eslint-disable-next-line global-require
    cachedModule = require('electron-as-wallpaper')
    return cachedModule
  } catch (error) {
    cachedLoadError = error
    cachedModule = null
    return null
  }
}

function isAvailable() {
  return loadNative() !== null
}

function getLoadError() {
  return cachedLoadError ? cachedLoadError.message || String(cachedLoadError) : null
}

// ── Progman-child fallback (Win11 no-WorkerW) ───────────────────────────────

function firstExisting(...candidates) {
  return candidates.filter(Boolean).find((p) => fs.existsSync(p)) || null
}

// The precompiled win-wallpaper.exe (~100ms cold, no PowerShell/Add-Type
// compile latency) is the single source of truth — win-wallpaper.cs is its
// source, committed + shipped via extraResources. (An earlier .ps1 fallback was
// dropped: it lacked the z-order fix, so if it ever ran it would reproduce the
// "hidden behind the wallpaper" bug.)
//
// resourcesPath comes FIRST: in a packaged build the __dirname path resolves
// INSIDE app.asar, and an .exe can't be spawned from inside an asar archive.
// extraResources ships it to resources/scripts. In dev, resourcesPath is
// Electron's own dist (no scripts/ there) so it falls through to the repo path.
function resolveHelper() {
  const res = process.resourcesPath
  const exe = firstExisting(
    res ? path.join(res, 'scripts', 'win-wallpaper.exe') : null,
    path.join(__dirname, '..', '..', 'scripts', 'win-wallpaper.exe')
  )
  return exe ? { path: exe } : null
}

function hwndOf(window) {
  try {
    // 64-bit Windows: native handle is an 8-byte pointer buffer. BigInt keeps
    // full precision (a plain Number would lose high bits — Codex MUST-FIX).
    return window.getNativeWindowHandle().readBigUInt64LE(0).toString()
  } catch {
    return null
  }
}

function runHelper(action, hwnd) {
  return new Promise((resolve) => {
    const helper = resolveHelper()
    if (!helper) return resolve({ ok: false, error: 'helper-missing' })
    execFile(helper.path, [action, hwnd], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      // The helper prints its JSON line even on a non-zero exit (carried on
      // error.stdout by execFile).
      const out = String(stdout || (error && error.stdout) || '').trim()
      if (out) {
        try { return resolve(JSON.parse(out.split(/\r?\n/).pop())) } catch {}
      }
      resolve({ ok: false, error: error ? (error.message || String(error)) : 'no-output' })
    })
  })
}

// Serialize attach/detach so an async helper spawn can't interleave with a
// later toggle — ops apply in call order, so the final attachState is correct.
let opChain = Promise.resolve()
function serialize(fn) {
  const next = opChain.then(fn, fn)
  opChain = next.catch(() => {})
  return next
}

async function tryProgmanChild(window, log) {
  if (process.platform !== 'win32' || E2E_DISABLE) return false
  if (window.isDestroyed?.()) return false
  const hwnd = hwndOf(window)
  if (!hwnd) {
    log?.warn?.('[WALLPAPER_HWND_FAIL]')
    return false
  }
  const result = await runHelper('attach', hwnd)
  if (result.ok && result.parentMatch) {
    log?.info?.('[WALLPAPER_PROGMAN_CHILD_OK]', result.rect)
    return true
  }
  log?.warn?.('[WALLPAPER_PROGMAN_CHILD_FAIL]', result.error || JSON.stringify(result))
  return false
}

// ── Public attach / detach ──────────────────────────────────────────────────

/**
 * Attach the window as a wallpaper layer. Returns a Promise of the mode that
 * succeeded ('native' | 'progman-child') or false. Idempotent: a second call
 * for an already-attached window is a no-op. Serialized with disable.
 */
function enableWallpaper(window, log) {
  return serialize(async () => {
    if (!window || window.isDestroyed?.()) {
      log?.warn?.('[WALLPAPER_NO_WINDOW]')
      return false
    }
    if (attachState.mode !== 'none' && attachState.window === window) {
      return attachState.mode
    }

    // Strategy 1: native module (in-process, main thread — safe to call sync).
    const native = loadNative()
    if (native) {
      try {
        native.attach(window, { transparent: true, forwardKeyboardInput: false, forwardMouseInput: false })
        attachState = { mode: 'native', window }
        log?.info?.('[WALLPAPER_ATTACH_OK]')
        return 'native'
      } catch (error) {
        log?.warn?.('[WALLPAPER_ATTACH_FAIL]', error?.message || error)
        // fall through to the Progman-child path
      }
    } else {
      log?.warn?.('[WALLPAPER_NATIVE_UNAVAILABLE]', getLoadError())
    }

    // Strategy 2: Progman-child (Win11 no-WorkerW). Async — see module header.
    if (await tryProgmanChild(window, log)) {
      attachState = { mode: 'progman-child', window }
      return 'progman-child'
    }

    return false
  })
}

/**
 * Detach a previously attached window via whichever teardown matches the mode
 * it was attached with. Returns a Promise. Always safe to call. Serialized.
 */
function disableWallpaper(window, log) {
  return serialize(async () => {
    const target = window || attachState.window
    const mode = attachState.mode
    if (mode === 'none' || !target) {
      attachState = { mode: 'none', window: null }
      return
    }

    if (mode === 'native') {
      const native = loadNative()
      if (native && !target.isDestroyed?.()) {
        try {
          native.detach(target)
          log?.info?.('[WALLPAPER_DETACH_OK]')
        } catch (error) {
          log?.warn?.('[WALLPAPER_DETACH_FAIL]', error?.message || error)
          try { native.reset?.(); log?.info?.('[WALLPAPER_RESET_FALLBACK_OK]') } catch (e) {
            log?.warn?.('[WALLPAPER_RESET_FAIL]', e?.message || e)
          }
        }
      }
    } else if (mode === 'progman-child') {
      // If the window is already destroyed (quit) the child HWND died with the
      // process — nothing to restore. Only detach a live window (toggle-off).
      if (!target.isDestroyed?.()) {
        const hwnd = hwndOf(target)
        if (hwnd) {
          const result = await runHelper('detach', hwnd)
          if (result.ok) log?.info?.('[WALLPAPER_PROGMAN_CHILD_DETACH_OK]')
          else log?.warn?.('[WALLPAPER_PROGMAN_CHILD_DETACH_FAIL]', result.error || '')
        }
      }
    }

    attachState = { mode: 'none', window: null }
  })
}

function isAttached() {
  return attachState.mode !== 'none'
}

function getMode() {
  return attachState.mode
}

/**
 * Health probe: is the Progman-child wallpaper still attached? Explorer
 * restarts recreate the shell and orphan the child window, silently losing the
 * wallpaper. Returns true when the attach still looks healthy, false when a
 * progman-child window has lost its Progman parent (caller should re-sync).
 * The native path can't be cheaply probed, so it's assumed healthy.
 */
async function isStillAttached(window) {
  if (attachState.mode !== 'progman-child') return true
  const target = window || attachState.window
  if (!target || target.isDestroyed?.()) return false
  const hwnd = hwndOf(target)
  if (!hwnd) return false
  const result = await runHelper('check', hwnd)
  return result.ok === true && result.parentMatch === true
}

/** Reset state to 'none' so a follow-up enableWallpaper actually re-attaches. */
function markDetached() {
  attachState = { mode: 'none', window: null }
}

module.exports = {
  isAvailable,
  getLoadError,
  enableWallpaper,
  disableWallpaper,
  isAttached,
  getMode,
  isStillAttached,
  markDetached
}
