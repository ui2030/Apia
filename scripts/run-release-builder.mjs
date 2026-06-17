import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const rootDir = process.cwd()
const stageDir = process.platform === 'win32'
  ? resolve('C:\\Users\\Public\\ApiaReleaseStage')
  : resolve('/tmp/apia-release-stage')

const requiredEntries = [
  'dist',
  'electron',
  'backend-dist',
  // App icon — electron-builder.yml references build/icon.ico for win.icon and
  // the NSIS installer/uninstaller icons. The builder resolves those paths
  // against THIS staging dir, so build/ must be staged too (like backend-dist),
  // or NSIS hard-fails with "cannot find specified resource build/icon.ico".
  'build',
  // win-wallpaper.exe is shipped via electron-builder.yml extraResources, but
  // that `from:` path resolves against THIS staging dir — so the file has to be
  // staged here too, like backend-dist. Without it the wallpaper helper is
  // absent from the packaged app and the Win11 behind-icons mode silently
  // falls back to overlay.
  'scripts/win-wallpaper.exe',
  // afterPack hook + the standalone rcedit it shells to, used to stamp the app
  // icon onto Apia.exe (electron-builder.yml afterPack). Both resolve relative
  // to this staging dir, so both must be staged.
  'scripts/afterPack.cjs',
  'scripts/rcedit.exe',
  'node_modules',
  'package.json',
  'package-lock.json',
  'electron-builder.yml'
]

function assertSafeStageDir(targetPath) {
  const normalized = resolve(targetPath)

  if (process.platform === 'win32') {
    const allowedRoot = resolve('C:\\Users\\Public')
    if (normalized !== allowedRoot && !normalized.startsWith(`${allowedRoot}${sep}`)) {
      throw new Error(`[RELEASE_STAGE_UNSAFE_PATH] ${normalized}`)
    }
    return
  }

  const allowedRoot = resolve('/tmp')
  if (normalized !== allowedRoot && !normalized.startsWith(`${allowedRoot}${sep}`)) {
    throw new Error(`[RELEASE_STAGE_UNSAFE_PATH] ${normalized}`)
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: {
        ...process.env,
        ...(options.env || {})
      },
      stdio: options.stdio || 'inherit',
      windowsHide: true,
      shell: false
    })

    child.on('error', (error) => rejectPromise(error))
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(`[RELEASE_STAGE_COMMAND_FAILED] ${command} ${args.join(' ')}`))
    })
  })
}

async function copyReleaseInputs() {
  for (const entry of requiredEntries) {
    await cp(resolve(rootDir, entry), resolve(stageDir, entry), {
      recursive: true,
      force: true
    })
  }
}

function getBuilderEntrypoint() {
  return resolve(stageDir, 'node_modules', 'electron-builder', 'cli.js')
}

async function main() {
  assertSafeStageDir(stageDir)

  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  await copyReleaseInputs()

  const builderArgs = [
    getBuilderEntrypoint(),
    ...process.argv.slice(2),
    `--config.directories.output=${resolve(rootDir, 'release')}`
  ]

  try {
    await runCommand(process.execPath, builderArgs, { cwd: stageDir })
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
