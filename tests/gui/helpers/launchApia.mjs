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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..', '..')

/**
 * Fail fast when dist/ is missing or older than the sources it was built from.
 *
 * The two Playwright specs get a fresh build from `tests/gui/globalSetup.mjs`,
 * but the 40+ standalone harnesses (`node tests/gui/foo-check.mjs`) run outside
 * Playwright and had no such guard — so a harness could "pass" against a bundle
 * built before the change under test. Same artifact list as globalSetup so the
 * two paths can't disagree.
 *
 * Deliberately throws BEFORE electron.launch: an Electron process started on a
 * stale bundle is worse than no run at all (Codex).
 */
function assertDistFresh() {
  for (const relPath of ['dist/index.html', 'dist/settings.html']) {
    if (!existsSync(join(projectRoot, relPath))) {
      throw new Error(
        `[APIA_DIST_MISSING] ${relPath} — run \`npm run build\` before this harness`
      )
    }
  }

  const distMtime = statSync(join(projectRoot, 'dist', 'index.html')).mtimeMs
  // src/*.js top level only (src/assets is model/motion binaries — thousands of
  // files, none of which vite inlines into index.html) + the root HTML entries.
  const sources = [
    ...readdirSync(join(projectRoot, 'src'))
      .filter((n) => n.endsWith('.js'))
      .map((n) => join(projectRoot, 'src', n)),
    ...readdirSync(projectRoot)
      .filter((n) => n.endsWith('.html'))
      .map((n) => join(projectRoot, n))
  ]

  let newest = 0
  let newestFile = ''
  for (const file of sources) {
    const m = statSync(file).mtimeMs
    if (m > newest) { newest = m; newestFile = file }
  }

  if (newest > distMtime) {
    throw new Error(
      `[APIA_DIST_STALE] dist/index.html is older than ${newestFile} — ` +
      'run `npm run build` before this harness'
    )
  }
}

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
  assertDistFresh()

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
      // F단계 — 전역 커서 시선 피드 차단. 테스트 중 실제 마우스가 움직이면
      // 시선(눈/목/머리)이 끌려가 스크린샷·자세 단언이 비결정적이 된다.
      // 시선 검증은 smoothness-check가 __setLookTarget 훅으로 한다.
      APIA_E2E_NO_CURSOR_FEED: '1',
      // 벽지 모드는 데스크톱 창 계층을 실제로 조작하므로 테스트 기본은 OFF.
      // extraEnv보다 앞에 둬서 벽지를 실제로 검증하려는 하네스는 덮어쓸 수 있다.
      APIA_E2E_DISABLE_WALLPAPER: '1',
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
