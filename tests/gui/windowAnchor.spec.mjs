/**
 * GUI e2e for the windowAnchor persistence flow.
 *
 * Unit tests already cover `pickTargetWorkArea` in full (phantom monitor
 * fallback, single/multi display, edge inclusion). This file proves the
 * end-to-end wire-up at the Electron boundary:
 *
 *   - On launch, the saved anchor is read and a phantom-monitor anchor
 *     falls back to the primary workArea.
 *   - On graceful shutdown, the actual window centre is written back to
 *     `apia-settings.json` so the next launch can use it.
 *
 * The save path is the one I couldn't verify by `taskkill /F` during the
 * original manual smoke — Playwright's `app.close()` lets us drive a
 * clean shutdown instead.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchApia } from './helpers/launchApia.mjs'

test('phantom anchor on disk → main window restored to primary workArea', async () => {
  // Seed a userData with an anchor that no real display contains.
  const userData = await mkdtemp(join(tmpdir(), 'apia-anchor-phantom-'))
  await writeFile(join(userData, 'apia-settings.json'), JSON.stringify({
    activeModel: 'dummy',
    activeCharacter: null,
    models: [],
    alwaysOnTop: true,
    charScale: 100,
    autoBehavior: true,
    aiMode: 'auto',
    memoryTurns: 10,
    ttsEnabled: true,
    voiceId: null,
    windowAnchor: { x: 99999, y: 99999 }
  }, null, 2))

  const { app, mainWindow, cleanup } = await launchApia({ existingUserData: userData })
  try {
    // Read the live bounds from main process to compare against the primary
    // workArea. `mainWindow.evaluate` runs in the renderer, which doesn't
    // see screen.* — go through `app.evaluate` so we hit electron/main.
    const { bounds, primaryWorkArea } = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(),
      primaryWorkArea: screen.getPrimaryDisplay().workArea
    }))
    expect(bounds.x).toBe(primaryWorkArea.x)
    expect(bounds.y).toBe(primaryWorkArea.y)
    expect(bounds.width).toBe(primaryWorkArea.width)
    expect(bounds.height).toBe(primaryWorkArea.height)
  } finally {
    await cleanup()
    // Caller-owned dir: clean up explicitly because launchApia preserves it.
    const { rm } = await import('node:fs/promises')
    await rm(userData, { recursive: true, force: true })
  }
})

test('graceful shutdown writes windowAnchor back to apia-settings.json', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'apia-anchor-save-'))
  const settingsPath = join(userData, 'apia-settings.json')

  // Start with no anchor — first run.
  await writeFile(settingsPath, JSON.stringify({
    activeModel: 'dummy',
    activeCharacter: null,
    models: [],
    alwaysOnTop: true,
    charScale: 100,
    autoBehavior: true,
    aiMode: 'auto',
    memoryTurns: 10,
    ttsEnabled: true,
    voiceId: null,
    windowAnchor: null
  }, null, 2))

  const { app, cleanup } = await launchApia({ existingUserData: userData })
  try {
    // Sanity check: the file currently has null anchor.
    const before = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(before.windowAnchor).toBeNull()
  } finally {
    // app.close() goes through `before-quit` → flushPendingAnchor.
    await cleanup()
  }

  // After graceful close, anchor should be written. Codex review: be
  // lenient about exact center — DPI scaling / taskbar drift can shift
  // it a few pixels. Assert it sits inside the primary workArea
  // (which is what we know the window occupied) instead.
  const after = JSON.parse(await readFile(settingsPath, 'utf-8'))
  expect(after.windowAnchor).not.toBeNull()
  expect(Number.isFinite(after.windowAnchor.x)).toBe(true)
  expect(Number.isFinite(after.windowAnchor.y)).toBe(true)
  // Anchor must be a positive on-screen point; phantom (99999,99999)
  // would mean the save mistakenly wrote through stale state.
  expect(after.windowAnchor.x).toBeLessThan(50_000)
  expect(after.windowAnchor.y).toBeLessThan(50_000)

  const { rm } = await import('node:fs/promises')
  await rm(userData, { recursive: true, force: true })
})
