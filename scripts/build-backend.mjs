import { access, mkdir, open, readFile, rm } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const rootDir = process.cwd()
const backendDir = resolve(rootDir, 'backend')
const entryPath = resolve(backendDir, 'main.py')
const packagingRequirements = resolve(backendDir, 'requirements-packaging.txt')
const backendDistDir = resolve(rootDir, 'backend-dist')
const backendBuildDir = resolve(rootDir, 'backend-build')
const pyinstallerWorkDir = resolve(backendBuildDir, 'pyinstaller-work')
const pyinstallerSpecDir = resolve(backendBuildDir, 'pyinstaller-spec')
// 패키징 전용 깨끗한 venv. PATH의 python에 바로 pip install 하면 ① 시스템 파이썬을
// 핀 버전으로 오염시키고 ② 3.13 같은 새 파이썬은 numpy==1.26.0 휠이 없어 실패하며
// ③ anaconda 상속 환경은 requirements-packaging.txt에 없는 패키지까지 번들에 섞인다.
// 베이스 인터프리터는 APIA_PACKAGING_PYTHON(예: anaconda3\python.exe, 3.11)로 지정.
const packagingVenvDir = resolve(backendBuildDir, 'pkg-venv')
const packagingVenvPython = resolve(
  packagingVenvDir,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
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
        // requirements-*.txt에 한국어 주석이 있다. 구버전 pip는 로캘(cp949)로 읽다 죽는다.
        PYTHONUTF8: '1',
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
    ...(process.env.APIA_PACKAGING_PYTHON ? [createRunner(process.env.APIA_PACKAGING_PYTHON)] : []),
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
  // 전용 venv라 매번 맞춘다 — "빠진 모듈이 있을 때만" 설치하면 핀을 고쳐도 이전
  // 버전이 그대로 남아 번들된다(이미 깔려 있으면 pip는 금방 끝난다).
  await runPython(['-m', 'pip', 'install', '-r', packagingRequirements])
  const missing = await getMissingModules(runPython)
  if (missing.length > 0) {
    throw new Error(`[BUILD_BACKEND_MODULES_MISSING] ${missing.join(', ')}`)
  }
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
  // 기본 설정(성격 등) — ai_config가 모듈 옆 defaults/에서 읽는다. 개인 설정은 userData/personal.
  args.push('--add-data', `${resolve(backendDir, 'defaults')}${delimiter}defaults`)
  // DB 스키마 — store_service가 <번들>/store/migrations/*.sql을 읽는다. 빠지면 새 PC의
  // 빈 apia.db에 테이블이 안 생겨 기억·파일·웹 통계가 전부 500(2026-10-08 실측).
  args.push('--add-data', `${resolve(backendDir, 'store', 'migrations')}${delimiter}store/migrations`)
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
  // 매번 빈 폴더에서 시작한다 — 이전 실행의 apia.db(테이블 있음)가 남아 있으면
  // store/migrations 번들 누락을 /store/memory/stats가 못 잡는다(astra 지적).
  await rm(smokeDataDir, { recursive: true, force: true })
  await mkdir(smokeDataDir, { recursive: true })

  const child = spawn(backendExePath, [], {
    cwd: backendDistDir,
    env: {
      ...process.env,
      // 빌드용으로 앞에 붙인 conda DLL 경로를 뺀 원래 PATH — 번들이 스스로 서는지 본다.
      PATH: process.env.APIA_SMOKE_PATH || process.env.PATH,
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
    // 스키마가 실제로 깔렸는지 — 테이블이 없으면 500이라 fetchJson이 던진다.
    await fetchJson(`http://127.0.0.1:${smokePort}/store/memory/stats`, 10000)
  } finally {
    await killChildTree(child)
    await waitForFileRelease(backendExePath)
  }
}

async function main() {
  // 기존 pkg-venv가 지금 지정한 베이스(APIA_PACKAGING_PYTHON)로 만든 것인지 확인한다.
  // 다른 파이썬(3.13·비-anaconda)으로 만든 묵은 venv를 재사용하면 위의 수정이 통째로
  // 무효가 된다 — 베이스가 다르면 지우고 새로 만든다(astra 지적).
  if (await ensurePathExists(packagingVenvPython)) {
    const cfg = await readFile(resolve(packagingVenvDir, 'pyvenv.cfg'), 'utf8').catch(() => '')
    const home = cfg.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim()
    const wanted = process.env.APIA_PACKAGING_PYTHON && resolve(process.env.APIA_PACKAGING_PYTHON, '..')
    if (wanted && home && resolve(home).toLowerCase() !== wanted.toLowerCase()) {
      console.log(`[BUILD_BACKEND_VENV_RECREATE] base changed: ${home} -> ${wanted}`)
      await rm(packagingVenvDir, { recursive: true, force: true })
    }
  }
  if (!(await ensurePathExists(packagingVenvPython))) {
    const runBase = await findPythonRunner()
    await runBase(['-m', 'venv', packagingVenvDir])
  }
  const runPython = createRunner(packagingVenvPython)
  // anaconda 베이스면 _ssl·_sqlite3가 쓰는 DLL(libssl·sqlite3·ffi)이 <base>\Libraryin에
  // 있는데, venv에선 PATH에 안 잡혀 PyInstaller가 못 모은다 → exe가 _ssl import에서 죽는다
  // (2026-10-08 실측). 베이스 경로는 pyvenv.cfg의 home.
  const venvHome = (await readFile(resolve(packagingVenvDir, 'pyvenv.cfg'), 'utf8'))
    .match(/^home\s*=\s*(.+)$/m)?.[1]?.trim()
  const condaBin = venvHome && resolve(venvHome, 'Library', 'bin')
  if (condaBin && (await ensurePathExists(condaBin))) {
    // 연기 테스트는 원래 PATH로 돌린다 — 빌드 PC의 DLL이 번들 누락을 가려 주면 안 된다.
    process.env.APIA_SMOKE_PATH = process.env.PATH
    process.env.PATH = `${condaBin}${delimiter}${process.env.PATH}`
  }
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
