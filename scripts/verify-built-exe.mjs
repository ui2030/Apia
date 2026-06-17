// Post-build regression guard: the packaged Apia.exe must carry the app version
// from package.json. This proves two things at once:
//   1. the afterPack hook (scripts/afterPack.cjs) actually ran and stamped the
//      exe — a vanilla Electron exe reports Electron's own version instead, and
//   2. the stamped version did not drift from package.json / the installer name.
// Runs after run-release-builder. Windows-only (the release target is NSIS);
// on other platforms it is a no-op.
import { readFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDir = process.cwd()
const exePath = resolve(rootDir, 'release', 'win-unpacked', 'Apia.exe')

async function readPackageVersion() {
  const raw = await readFile(resolve(rootDir, 'package.json'), 'utf8')
  const version = JSON.parse(raw).version
  if (!version) throw new Error('[VERIFY_EXE_NO_PACKAGE_VERSION] package.json has no version')
  // Require a 3-part semver so the prefix match below can't be loosened by a
  // 2-part version (e.g. "1.0" spuriously matching "1.0.0").
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`[VERIFY_EXE_BAD_PACKAGE_VERSION] expected X.Y.Z semver, got "${version}"`)
  }
  return version
}

async function readExeFileVersion() {
  // No PE-parsing dependency — ask Windows for the file version directly.
  const psCommand = `(Get-Item -LiteralPath '${exePath}').VersionInfo.FileVersion`
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { windowsHide: true }
  )
  return stdout.trim()
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[VERIFY_EXE_SKIP] not win32')
    return
  }

  try {
    await access(exePath)
  } catch {
    throw new Error(`[VERIFY_EXE_MISSING] ${exePath}`)
  }

  const expected = await readPackageVersion()
  const actual = await readExeFileVersion()

  // rcedit writes FileVersion as a 4-part string (e.g. 1.0.0.0); accept it as
  // long as it starts with the package version.
  if (actual !== expected && !actual.startsWith(`${expected}.`)) {
    throw new Error(
      `[VERIFY_EXE_VERSION_MISMATCH] Apia.exe FileVersion="${actual}" != package.json version="${expected}". ` +
      'The afterPack icon/version stamp likely did not run.'
    )
  }

  console.log(`[VERIFY_EXE_OK] Apia.exe FileVersion=${actual} matches package.json ${expected}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
