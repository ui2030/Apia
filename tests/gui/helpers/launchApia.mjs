/**
 * Launch Apia (Electron) in an isolated tmp userData dir for one test.
 *
 * Why this helper exists:
 *   - Tests must never touch the user's real %APPDATA%\Apia profile. The
 *     `APIA_E2E_USER_DATA_DIR` env hook in `electron/main.js` calls
 *     `app.setPath('userData', tmpDir)` before anything reads it, which
 *     is the load-bearing guarantee. Per Codex review.
 *   - Backend autostart is disabled with `APIA_E2E_DISABLE_BACKEND=1`. The
 *     GUI is contracted to degrade gracefully when the backend is
 *     unreachable; the tests lock that contract in.
 *   - `shell.openPath` is stubbed with `APIA_E2E_NO_SHELL_OPEN=1` so a
 *     test that exercises the "Open backend.env folder" button doesn't
 *     leave a real Explorer window dangling on the test runner.
 *
 * The helper returns `{ app, mainWindow, userData, cleanup }`. `cleanup`
 * is idempotent — call it from a finally / `test.afterEach`.
 */
import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..', '..')

/**
 * @param {object} options
 * @param {string=} options.existingUserData
 *   Pass a tmp dir you've pre-seeded (e.g. with a phantom windowAnchor).
 *   When provided, the helper does NOT delete the dir at cleanup so the
 *   caller can inspect the post-close state.
 * @param {object=} options.extraEnv
 *   Extra env vars merged into the launch (e.g. APIA_BACKEND_URL).
 */
export async function launchApia({ existingUserData, extraEnv = {} } = {}) {
  const userData = existingUserData || await mkdtemp(join(tmpdir(), 'apia-e2e-'))
  const ownsUserData = !existingUserData

  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      APIA_E2E_USER_DATA_DIR: userData,
      APIA_E2E_DISABLE_BACKEND: '1',
      APIA_E2E_NO_SHELL_OPEN: '1',
      ...extraEnv
    }
  })

  // firstWindow() resolves to whichever BrowserWindow opens first — that's
  // the main overlay (createMainWindow is the first window-creating call
  // after app.whenReady).
  const mainWindow = await app.firstWindow()

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    try {
      await app.close()
    } catch {
      // Electron sometimes errors during shutdown when the renderer has
      // already torn down; that's harmless for cleanup purposes.
    }
    if (ownsUserData) {
      await rm(userData, { recursive: true, force: true })
    }
  }

  return { app, mainWindow, userData, cleanup }
}

/**
 * Open the settings window from the main window. Uses `Promise.all` to
 * race-avoid: the `window` event can fire between `click()` and
 * `waitForEvent('window')` if they're awaited sequentially. Per Codex
 * review.
 */
export async function openSettingsWindow(app, mainWindow) {
  const [settingsWindow] = await Promise.all([
    app.waitForEvent('window'),
    mainWindow.click('#settings-btn')
  ])
  await settingsWindow.waitForLoadState('domcontentloaded')
  return settingsWindow
}
