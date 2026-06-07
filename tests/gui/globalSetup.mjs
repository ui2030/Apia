/**
 * Build the Vite dist once before any e2e test runs, then assert the
 * specific files our specs depend on. A stale or empty `dist/` would
 * otherwise surface as "Electron loaded but the window is blank" — much
 * harder to diagnose than a synchronous setup failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..')

export default async function globalSetup() {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`[APIA_E2E_GLOBAL_SETUP] vite build failed (exit ${result.status})`)
  }

  for (const relPath of ['dist/index.html', 'dist/settings.html']) {
    const abs = join(projectRoot, relPath)
    if (!existsSync(abs)) {
      throw new Error(`[APIA_E2E_GLOBAL_SETUP] missing build artifact: ${abs}`)
    }
  }
}
