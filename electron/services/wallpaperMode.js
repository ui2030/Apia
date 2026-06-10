/**
 * Wallpaper-mode adapter for the main BrowserWindow.
 *
 * Wraps `electron-as-wallpaper` (Win32 Progman → WorkerW → SetParent) behind
 * a safe interface so the rest of Electron startup doesn't have to know the
 * package exists. Codex MUST-FIX:
 *   - lazy require so a non-Windows or native-load failure doesn't crash
 *     startup. The wrapper exposes `isAvailable()` for the caller to gate on.
 *   - attach / detach paired so settings toggles can flip the mode at
 *     runtime, not just at boot.
 *   - detach failure falls back to `reset()` and logs — never throw out of
 *     `disableWallpaper()` (the caller already failed once if we got here).
 *   - `disableWallpaper()` ALWAYS runs on app quit so a stale WorkerW
 *     child window doesn't survive into the next session.
 *
 * The native module is C++ node-gyp built (1.x series). The Rust/Neon 2.x
 * release line needs a `cargo` toolchain users don't have, so we pin 1.0.8
 * in package.json. Note for packagers: this module needs to be in
 * `asarUnpack` because Electron can't `require` native modules from inside
 * an .asar archive.
 */
const E2E_DISABLE = process.env.APIA_E2E_DISABLE_WALLPAPER === '1'

let cachedModule = null
let cachedLoadError = null
let attachedWindow = null

function loadNative() {
  if (cachedModule !== null) return cachedModule
  if (cachedLoadError) return null
  if (process.platform !== 'win32') {
    cachedLoadError = new Error(
      `wallpaper mode is Windows-only (platform=${process.platform})`
    )
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

/**
 * Attach the BrowserWindow as a wallpaper layer (behind desktop icons).
 * Returns true on success, false if the platform/native module can't
 * support it. Safe to call repeatedly — re-attach is idempotent on the
 * native side, but we still gate it on `attachedWindow` so the caller
 * doesn't pay the Win32 round-trip every settings save.
 */
function enableWallpaper(window, log) {
  const native = loadNative()
  if (!native) {
    log?.warn?.('[WALLPAPER_UNAVAILABLE]', getLoadError())
    return false
  }
  if (!window || window.isDestroyed?.()) {
    log?.warn?.('[WALLPAPER_NO_WINDOW]')
    return false
  }
  if (attachedWindow === window) {
    return true
  }
  try {
    native.attach(window, {
      transparent: true,
      // Forwarding mouse/keyboard from the WorkerW child back to the
      // BrowserWindow is possible but conflicts with desktop icons + Win+D
      // gestures. Step F1 keeps both off; F2 reconsiders once the chat
      // window is split out.
      forwardKeyboardInput: false,
      forwardMouseInput: false
    })
    attachedWindow = window
    log?.info?.('[WALLPAPER_ATTACH_OK]')
    return true
  } catch (error) {
    log?.warn?.('[WALLPAPER_ATTACH_FAIL]', error?.message || error)
    return false
  }
}

/**
 * Detach a previously attached window. ALWAYS safe to call — no-ops when
 * not attached, swallows errors with a `reset()` fallback so a partial
 * native failure can't leave the BrowserWindow stuck in a WorkerW child.
 */
function disableWallpaper(window, log) {
  const native = loadNative()
  if (!native) return
  if (!window) window = attachedWindow
  if (!window || window.isDestroyed?.()) {
    attachedWindow = null
    return
  }
  try {
    native.detach(window)
    log?.info?.('[WALLPAPER_DETACH_OK]')
  } catch (error) {
    log?.warn?.('[WALLPAPER_DETACH_FAIL]', error?.message || error)
    try {
      native.reset?.()
      log?.info?.('[WALLPAPER_RESET_FALLBACK_OK]')
    } catch (resetError) {
      log?.warn?.('[WALLPAPER_RESET_FAIL]', resetError?.message || resetError)
    }
  }
  if (attachedWindow === window) attachedWindow = null
}

function isAttached() {
  return attachedWindow !== null
}

module.exports = {
  isAvailable,
  getLoadError,
  enableWallpaper,
  disableWallpaper,
  isAttached
}
