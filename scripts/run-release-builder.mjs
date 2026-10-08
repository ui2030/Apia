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
  'electron-builder.yml',
  // extraResources로 resources/docs/에 동봉하는 문서(electron-builder.yml).
  'THIRD_PARTY_NOTICES.md',
  'PRIVACY.md',
  'docs/user'
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
    // electron-as-wallpaper의 네이티브 .node는 Visual Studio 없이는 못 굽는다(이 PC 포함).
    // node_modules에도 바이너리가 없어서 rebuild는 실패만 하고, 앱은 원래
    // Progman-child 폴백(win-wallpaper.exe)으로 붙는다 — smoke:release가 허용하는 경로.
    // VS 빌드 도구를 갖춘 PC에서 네이티브 경로를 살리려면 이 줄을 빼면 된다.
    '--config.npmRebuild=false',
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
