import { access, mkdir, open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const rootDir = process.cwd()
const backendDir = resolve(rootDir, 'backend')
const entryPath = resolve(backendDir, 'main.py')
const packagingRequirements = resolve(backendDir, 'requirements-packaging.txt')
const backendDistDir = resolve(rootDir, 'backend-dist')
const backendBuildDir = resolve(rootDir, 'backend-build')
const pyinstallerWorkDir = resolve(backendBuildDir, 'pyinstaller-work')
const pyinstallerSpecDir = resolve(backendBuildDir, 'pyinstaller-spec')
const backendExePath = resolve(
  backendDistDir,
  process.platform === 'win32' ? 'ApiaBackend.exe' : 'ApiaBackend'
)

const requiredModules = [
  'PyInstaller',
  'fastapi',
  'uvicorn',
  'edge_tts',
  'pyttsx3',
  'soundfile',
  'numpy',
  'tzdata',
  'httpx',
  'huggingface_hub',
  'anthropic',
  'groq'
]

const hiddenImports = [
  'routers.chat',
  'routers.tts',
  'routers.stt',
  'routers.voice',
  'services.claude_service',
  'services.tts_service',
  // edge_tts는 tts_service의 메서드 내부에서 lazy import — PyInstaller가
  // 바이트코드 분석으로 대개 잡지만, 명시가 드리프트에 안전하다.
  'edge_tts',
  'services.voice_manager',
  'services.whisper_service',
  'anthropic',
  'groq',
  'huggingface_hub'
]

const collectedPackages = [
  'pyttsx3',
  'multipart'
]

const excludedModules = [
  'torch',
  'torchvision',
  'torchaudio',
  'transformers',
  'accelerate',
  'bitsandbytes',
  'sentencepiece',
  'whisper',
  'openai_whisper',
  'triton',
  'IPython',
  'ipykernel',
  'jupyter_client',
  'jupyter_core',
  'matplotlib',
  'matplotlib_inline',
  'debugpy',
  'watchfiles',
  'pytest',
  '_pytest',
  'trio',
  'curio',
  'mypy',
  'numpydoc',
  'paramiko',
  'gevent',
  'uvloop',
  'numpy.array_api',
  'numpy.testing'
]

function createRunner(command, baseArgs = []) {
  return async function run(extraArgs, options = {}) {
    const args = [...baseArgs, ...extraArgs]
    return runCommand(command, args, options)
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        ...(options.env || {})
      },
      windowsHide: true,
      shell: false
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (options.stdio !== 'pipe') {
        process.stdout.write(text)
      }
    })

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (options.stdio !== 'pipe') {
        process.stderr.write(text)
      }
    })

    child.on('error', (error) => {
      rejectPromise(error)
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      const error = new Error(
        `[BUILD_BACKEND_COMMAND_FAILED] ${command} ${args.join(' ')}`
      )
      error.stdout = stdout
      error.stderr = stderr
      error.code = code
      rejectPromise(error)
    })
  })
}

async function findPythonRunner() {
  const candidates = [
    createRunner('python'),
    createRunner('py', ['-3'])
  ]

  for (const run of candidates) {
    try {
      await run(['--version'], { stdio: 'pipe' })
      return run
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('[BUILD_BACKEND_NO_PYTHON] Python 3 was not found in PATH')
}

async function ensurePathExists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function assertExists(targetPath, errorCode) {
  if (!(await ensurePathExists(targetPath))) {
    throw new Error(`[${errorCode}] ${targetPath}`)
  }
}

async function waitForProcessExit(child, timeoutMs = 10000) {
  if (!child?.pid) {
    return
  }

  if (child.exitCode !== null || child.killed) {
    return
  }

  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      resolvePromise()
    }, timeoutMs)

    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

async function waitForFileRelease(targetPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const handle = await open(targetPath, 'r+')
      await handle.close()
      return
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
        return
      }
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }

  throw new Error(`[BUILD_BACKEND_FILE_LOCKED] ${targetPath}`)
}

async function getMissingModules(runPython) {
  const checkScript = [
    'import importlib.util',
    `required = ${JSON.stringify(requiredModules)}`,
    'missing = [name for name in required if importlib.util.find_spec(name) is None]',
    'print("\\n".join(missing))'
  ].join('; ')

  const result = await runPython(['-c', checkScript], { stdio: 'pipe' })
  return result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function ensurePackagingModules(runPython) {
  const missing = await getMissingModules(runPython)
  if (missing.length === 0) {
    return
  }

  console.log(`[BUILD_BACKEND_INSTALL] missing modules: ${missing.join(', ')}`)
  await runPython(['-m', 'pip', 'install', '-r', packagingRequirements])
}

async function buildBackendExe(runPython) {
  if (await ensurePathExists(backendExePath)) {
    await waitForFileRelease(backendExePath)
  }

  await rm(backendDistDir, { recursive: true, force: true })
  await rm(pyinstallerWorkDir, { recursive: true, force: true })
  await rm(pyinstallerSpecDir, { recursive: true, force: true })
  await mkdir(backendBuildDir, { recursive: true })

  const args = [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onefile',
    '--name',
    'ApiaBackend',
    '--distpath',
    backendDistDir,
    '--workpath',
    pyinstallerWorkDir,
    '--specpath',
    pyinstallerSpecDir,
    '--paths',
    backendDir
  ]

  for (const hiddenImport of hiddenImports) {
    args.push('--hidden-import', hiddenImport)
  }

  for (const pkg of collectedPackages) {
    args.push('--collect-submodules', pkg)
  }

  for (const excludedModule of excludedModules) {
    args.push('--exclude-module', excludedModule)
  }

  args.push('--collect-data', 'pyttsx3')
  args.push(entryPath)

  await runPython(args)

  if (!(await ensurePathExists(backendExePath))) {
    throw new Error(`[BUILD_BACKEND_EXE_MISSING] ${backendExePath}`)
  }
}

async function waitForHealthyBackend(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/health`

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return true
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }

  return false
}

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`[SMOKE_HTTP_${response.status}] ${await response.text()}`)
    }

    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function killChildTree(child) {
  if (!child?.pid) {
    return
  }

  if (process.platform === 'win32') {
    try {
      await runCommand('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'pipe' })
    } catch {
      // Best effort cleanup.
    }
    await waitForProcessExit(child)
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // Best effort cleanup.
  }

  await waitForProcessExit(child)
}

async function smokeTestBackendExe() {
  const smokePort = String(18765)
  const smokeDataDir = resolve(backendBuildDir, 'smoke-data')
  await mkdir(smokeDataDir, { recursive: true })

  const child = spawn(backendExePath, [], {
    cwd: backendDistDir,
    env: {
      ...process.env,
      APIA_BACKEND_HOST: '127.0.0.1',
      APIA_BACKEND_PORT: smokePort,
      DATA_DIR: smokeDataDir,
      PYTHONUTF8: '1'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  let exited = false

  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })

  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  child.on('exit', () => {
    exited = true
  })

  try {
    const healthy = await waitForHealthyBackend(smokePort)
    if (!healthy || exited) {
      const logTail = `${stdout}\n${stderr}`.trim()
      throw new Error(
        `[BUILD_BACKEND_SMOKE_FAILED] ${logTail || 'backend executable did not become healthy'}`
      )
    }

    const voicesPayload = await fetchJson(`http://127.0.0.1:${smokePort}/voices`, 10000)
    if (!Array.isArray(voicesPayload?.voices)) {
      throw new Error('[BUILD_BACKEND_SMOKE_VOICES_FAILED] /voices did not return a voices array')
    }
  } finally {
    await killChildTree(child)
    await waitForFileRelease(backendExePath)
  }
}

async function main() {
  const runPython = await findPythonRunner()
  await assertExists(entryPath, 'BUILD_BACKEND_ENTRY_MISSING')
  await assertExists(packagingRequirements, 'BUILD_BACKEND_REQUIREMENTS_MISSING')
  await ensurePackagingModules(runPython)
  await buildBackendExe(runPython)
  await smokeTestBackendExe()

  console.log(`[BUILD_BACKEND_OK] ${backendExePath}`)
}

main().catch(async (error) => {
  const message = error?.message || String(error)
  if (error?.stdout) {
    process.stderr.write(error.stdout)
  }
  if (error?.stderr) {
    process.stderr.write(error.stderr)
  }
  if (error?.stack && !message.includes(error.stack)) {
    process.stderr.write(`${error.stack}\n`)
  }
  console.error(message)
  process.exit(1)
})
