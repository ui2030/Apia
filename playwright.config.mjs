/**
 * Playwright e2e config for Apia's Electron GUI tests.
 *
 * Lives separately from vitest (`vitest.config.mjs` / `npm test`) so the two
 * test runners stay independent — `npm test` for the fast unit feedback
 * loop, `npm run test:gui` for the slower windowed-Electron flow. CI runs
 * both.
 *
 * Tests target the *packaged dist* (Vite build output) rather than the dev
 * server because:
 *   - it's deterministic (no HMR / vite startup race)
 *   - it's closer to what users get
 *   - the dev path is already exercised by hand during interactive work,
 *     so the e2e suite covers the production-like configuration instead.
 *
 * Tests get an isolated tmp `userData` via `APIA_E2E_USER_DATA_DIR` so a
 * test run can never trash the user's real Apia profile. Backend autostart
 * is disabled (`APIA_E2E_DISABLE_BACKEND=1`) — the GUI must degrade
 * gracefully when the backend is unreachable, which is the contract we
 * want to lock in anyway.
 */
import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: join(__dirname, 'tests', 'gui'),
  // GUI tests serialize because they share the global Electron binary; a
  // parallel run of two _electron.launch() calls is racy on Windows.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  // Build once before any test runs so the spec files can assume
  // `dist/index.html` and `dist/settings.html` exist. The globalSetup file
  // also fails loudly if those assets are missing, which is much faster
  // than letting an individual test launch Electron with a stale or
  // empty dist and failing on a black window.
  globalSetup: join(__dirname, 'tests', 'gui', 'globalSetup.mjs'),
  use: {
    // Each test owns its launch; no shared `use` config beyond defaults.
    trace: 'retain-on-failure'
  }
})
