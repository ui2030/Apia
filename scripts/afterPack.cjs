// electron-builder afterPack hook — stamp the app icon + version metadata onto
// the packaged Apia.exe.
//
// Why a hook instead of electron-builder's built-in win.icon: applying the icon
// to the exe requires rcedit, which electron-builder only runs when
// `signAndEditExecutable` is true. On this Windows box that flag forces a
// winCodeSign download whose macOS .dylib symlinks fail to extract ("cannot
// create symbolic link" — no symlink privilege), breaking the whole build. So we
// keep signAndEditExecutable:false (no winCodeSign) and run a standalone,
// repo-vendored rcedit ourselves. Without this the packaged exe + Start Menu /
// taskbar shortcuts ship the default Electron atom icon.
//
// Runs after the app is packed into appOutDir, before NSIS packages it — so the
// installer embeds the icon-stamped exe.

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

function resolveRcedit() {
  // Vendored copy is the self-contained, npm-ci-safe source. Fall back to the
  // electron-winstaller vendor binary if the vendored one is somehow absent.
  const candidates = [
    // Primary: repo-vendored, survives `npm ci`. The real dependency.
    path.join(__dirname, 'rcedit.exe'),
    // Best-effort fallback only — electron-winstaller is transitive and may be
    // pruned by `npm ci`, so it must never be the sole source.
    path.join(__dirname, '..', 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
  ]
  return candidates.find((p) => existsSync(p)) || null
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const productFilename = context.packager.appInfo.productFilename || 'Apia'
  // Single source of truth = package.json version (via appInfo). Hardcoding it
  // here would silently drift from the installer's ${version}. Fail fast if the
  // packager ever stops surfacing it rather than stamping a wrong number.
  const appVersion = context.packager.appInfo.version
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`)
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  const rcedit = resolveRcedit()

  if (!appVersion) throw new Error('[AFTERPACK_VERSION_MISSING] context.packager.appInfo.version unavailable')
  if (!existsSync(exePath)) throw new Error(`[AFTERPACK_EXE_MISSING] ${exePath}`)
  if (!existsSync(iconPath)) throw new Error(`[AFTERPACK_ICON_MISSING] ${iconPath}`)
  if (!rcedit) throw new Error('[AFTERPACK_RCEDIT_MISSING] no rcedit.exe found (scripts/rcedit.exe)')

  const args = [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'ProductName', 'Apia',
    '--set-version-string', 'FileDescription', 'Apia - Desktop AI Assistant',
    '--set-version-string', 'CompanyName', 'ui2030',
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 ui2030',
    '--set-file-version', appVersion,
    '--set-product-version', appVersion,
  ]

  execFileSync(rcedit, args, { stdio: 'inherit' })
  console.log(`[AFTERPACK_ICON_OK] stamped icon + v${appVersion} onto ${exePath}`)
}
