/**
 * GUI e2e for the settings window — backend.env folder button, API key
 * input/save/clear roundtrip, Korean text rendering.
 *
 * These tests drive the real renderer through Playwright's _electron API.
 * They are the surface I couldn't reach during the original verify pass
 * (no GUI driver was installed). With the driver in, this is the layer
 * that catches IPC↔preload↔renderer wiring regressions.
 */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { launchApia, openSettingsWindow } from './helpers/launchApia.mjs'

test('userData is isolated to a tmp dir (load-bearing guarantee)', async () => {
  const { app, userData, cleanup } = await launchApia()
  try {
    // Assert the Electron-side app actually wrote to the tmp dir — proves
    // APIA_E2E_USER_DATA_DIR + app.setPath landed before any path read.
    // Codex review: surface this loud so a broken seam fails the whole
    // suite at the first test rather than silently corrupting real data.
    const liveUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    // Windows path comparison: case-insensitive, normalized separators.
    expect(liveUserData.toLowerCase().replaceAll('\\', '/'))
      .toBe(userData.toLowerCase().replaceAll('\\', '/'))
  } finally {
    await cleanup()
  }
})

test('settings window opens and renders Korean labels without mojibake', async () => {
  const { app, mainWindow, cleanup } = await launchApia()
  try {
    const settings = await openSettingsWindow(app, mainWindow)

    // Section titles in the file are exact Korean. Any mojibake (cp949→utf8
    // misdecode, BOM corruption) would shift the codepoints and the
    // text-content match would fail. Using getByText keeps the assertion
    // tied to user-visible content, not DOM structure.
    await expect(settings.locator('.section-title', { hasText: 'AI 설정' })).toBeVisible()
    await expect(settings.locator('.section-title', { hasText: '캐릭터 모델' })).toBeVisible()
    await expect(settings.locator('text=backend.env 편집')).toBeVisible()
    await expect(settings.locator('#open-backend-env-file')).toBeVisible()
    await expect(settings.locator('#open-backend-env')).toBeVisible()
    await expect(settings.locator('text=Groq API 키')).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('backend.env folder button reports ok with the dataDir path (shell.openPath stubbed)', async () => {
  const { app, mainWindow, userData, cleanup } = await launchApia()
  try {
    const settings = await openSettingsWindow(app, mainWindow)
    // The IPC returns { ok, path, stubbed:true } in test mode. Evaluating in
    // the renderer is fine — preload bridges window.api.
    const result = await settings.evaluate(async () => window.api.openBackendDataDir())
    expect(result.ok).toBe(true)
    expect(result.stubbed).toBe(true)
    // path must be inside the isolated tmp userData, not the user's real one.
    // Codex review: assert the normalized path begins with the tmp userData
    // (basename contains is too loose — a real path under %APPDATA% that
    // happens to share the last component would slip through).
    const normalize = (p) => p.toLowerCase().replaceAll('\\', '/').replace(/\/+$/, '')
    expect(normalize(result.path)).toMatch(new RegExp(`^${normalize(userData).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/`))
  } finally {
    await cleanup()
  }
})

test('API key write→read→clear roundtrip lands in backend.env', async () => {
  const { app, mainWindow, userData, cleanup } = await launchApia()
  try {
    // ── write ─────────────────────────────────────────────────────────
    let settings = await openSettingsWindow(app, mainWindow)

    // The Groq row's <input data-input> is the API-key field.
    const groqRow = settings.locator('.api-key-row[data-key="APIA_GROQ_KEY"]')
    await expect(groqRow.locator('[data-status]')).toHaveText('저장된 키 없음')
    await groqRow.locator('[data-input]').fill('gsk_e2e_test_value')

    // Save & close — `save()` then `window.close()`.
    await settings.click('button.btn-purple') // "저장 및 적용"

    // backend.env should now exist in the tmp userData.
    const envPath = join(userData, 'backend-data', 'backend.env')
    // Wait for the file to be flushed — the IPC handler awaits the
    // repo write before resolving. 2s is plenty.
    await expect.poll(() => existsSync(envPath), { timeout: 5_000 }).toBe(true)
    const written = await readFile(envPath, 'utf-8')
    expect(written).toContain('APIA_GROQ_KEY=gsk_e2e_test_value')

    // ── re-open and check presence flag ──────────────────────────────
    settings = await openSettingsWindow(app, mainWindow)
    const groqRow2 = settings.locator('.api-key-row[data-key="APIA_GROQ_KEY"]')
    await expect(groqRow2.locator('[data-status]')).toHaveText('저장된 키 있음')
    // The input must be empty — we never reflect the secret value back into
    // the DOM. Renderer should be structurally incapable of seeing it.
    await expect(groqRow2.locator('[data-input]')).toHaveValue('')

    // ── clear ─────────────────────────────────────────────────────────
    await groqRow2.locator('[data-clear]').click()
    await settings.click('button.btn-purple')

    await expect.poll(async () => {
      const text = await readFile(envPath, 'utf-8').catch(() => '')
      return text.includes('APIA_GROQ_KEY=')
    }, { timeout: 5_000 }).toBe(false)
  } finally {
    await cleanup()
  }
})

test('backend.env file button reports missing when file does not exist', async () => {
  // Fresh tmp userData → backend.env has never been created. The handler
  // must return ok:true + missing:true and (under the no-shell-open seam)
  // not attempt to spawn a real editor.
  const { app, mainWindow, userData, cleanup } = await launchApia()
  try {
    const settings = await openSettingsWindow(app, mainWindow)
    const result = await settings.evaluate(async () => window.api.openBackendEnvFile())
    expect(result.ok).toBe(true)
    expect(result.missing).toBe(true)
    expect(result.stubbed).toBe(true)
    // The reported path must point at the would-be backend.env inside the
    // isolated tmp dir — proves we didn't leak the user's real %APPDATA%.
    const normalize = (p) => p.toLowerCase().replaceAll('\\', '/')
    expect(normalize(result.path)).toContain(normalize(join(userData, 'backend-data', 'backend.env')))
  } finally {
    await cleanup()
  }
})

test('backend.env file button reports ok (not missing) after a key was saved', async () => {
  const { app, mainWindow, userData, cleanup } = await launchApia()
  try {
    // Seed backend.env via the save IPC so the file actually exists.
    let settings = await openSettingsWindow(app, mainWindow)
    await settings.locator('.api-key-row[data-key="APIA_GROQ_KEY"] [data-input]')
      .fill('gsk_e2e_for_open_file')
    await settings.click('button.btn-purple')

    const envPath = join(userData, 'backend-data', 'backend.env')
    await expect.poll(() => existsSync(envPath), { timeout: 5_000 }).toBe(true)

    // Re-open settings and click the file-open IPC.
    settings = await openSettingsWindow(app, mainWindow)
    const result = await settings.evaluate(async () => window.api.openBackendEnvFile())
    expect(result.ok).toBe(true)
    expect(result.missing).toBeFalsy()
    expect(result.stubbed).toBe(true)
  } finally {
    await cleanup()
  }
})

test('restartBackend is skipped under the e2e seam', async () => {
  // APIA_E2E_DISABLE_BACKEND=1 (set by launchApia) means the lifecycle was
  // never spawned, so restart must return skipped:'e2e' without trying to
  // kill anything. This pins the seam at the IPC boundary.
  const { app, mainWindow, cleanup } = await launchApia()
  try {
    const settings = await openSettingsWindow(app, mainWindow)
    const result = await settings.evaluate(async () => window.api.restartBackend())
    expect(result.ok).toBe(false)
    expect(result.skipped).toBe('e2e')
  } finally {
    await cleanup()
  }
})
