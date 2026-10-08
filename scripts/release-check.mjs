/**
 * npm run release:check — 배포 전 점검을 한 번에. 실패하면 그 단계 한 줄을 찍고 멈춘다.
 *
 *   verify → verify:release → 제3자 고지 최신 → 커밋 안 된 변경 없음(435t2.txt 제외)
 *   → HEAD에 v<version> 태그 → dist:win → smoke:release → release/ 정리 + 요약
 *
 * --allow-dirty : 커밋 안 된 변경을 실패 대신 경고로(커밋 전 리허설용). 정식 릴리스엔 쓰지 말 것.
 * 백엔드 빌드 파이썬은 APIA_PACKAGING_PYTHON(예: anaconda3\python.exe)으로 지정.
 */
import { spawn, execSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const installerName = `Apia-Setup-${version}.exe`
const allowDirty = process.argv.includes('--allow-dirty')
const IGNORED_DIRTY = new Set(['435t2.txt']) // 사용자 메모 — 커밋 대상 아님
const warnings = []
const timings = []

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const tee = (out) => (chunk) => {
      out.write(chunk)
      for (const line of String(chunk).split(/\r?\n/)) {
        if (/\bwarn(ing)?\b|_WARN\]/i.test(line) && !/deprecat/i.test(line)) warnings.push(line.trim())
      }
    }
    child.stdout.on('data', tee(process.stdout))
    child.stderr.on('data', tee(process.stderr))
    child.on('exit', (code) => resolve(code))
  })
}

async function step(name, fn) {
  console.log(`\n[RELEASE_CHECK] ▶ ${name}`)
  const t0 = Date.now()
  let error = null
  try {
    const r = await fn()
    if (typeof r === 'number' && r !== 0) error = `exit ${r}`
    else if (typeof r === 'string') error = r
  } catch (e) {
    error = e.message
  }
  timings.push([name, Date.now() - t0])
  if (error) {
    console.error(`\n[RELEASE_CHECK_FAIL] ${name}: ${error}`)
    process.exit(1)
  }
}

function dirtyFiles() {
  return execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((f) => !IGNORED_DIRTY.has(f))
}

const sec = (ms) => `${(ms / 1000).toFixed(1)}s`
const started = Date.now()

await step('npm run verify', () => run('npm run verify'))
await step('verify:release 전제', () => run('npm run verify:release'))
await step('제3자 고지 최신', () => run('node scripts/gen-third-party-notices.mjs --check'))
await step('커밋 안 된 변경 없음', () => {
  const dirty = dirtyFiles()
  if (!dirty.length) return
  const msg = `${dirty.length}개 — ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ' …' : ''}`
  if (!allowDirty) return msg
  warnings.push(`[RELEASE_CHECK_WARN] --allow-dirty: 커밋 안 된 변경 ${msg}`)
})
await step(`HEAD에 v${version} 태그`, () => {
  const tags = execSync('git tag --points-at HEAD', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  if (!tags.some((t) => t === `v${version}` || t.startsWith(`v${version}-`))) {
    return `없음(HEAD 태그: ${tags.join(', ') || '없음'}) — git tag v${version} 후 재실행`
  }
})
await step('설치본 빌드 (dist:win)', () => run('npm run dist:win'))
await step('설치본 연기 테스트 (smoke:release)', () => run('npm run smoke:release'))
await step(`release/ 정리 (${installerName}만 남김)`, () => {
  const releaseDir = join(root, 'release')
  statSync(join(releaseDir, installerName)) // 없으면 throw → 실패
  for (const f of readdirSync(releaseDir)) {
    if (f !== installerName) rmSync(join(releaseDir, f), { recursive: true, force: true })
  }
})

const installer = join(root, 'release', installerName)
console.log('\n[RELEASE_CHECK_OK] 전 단계 통과')
console.log(`  설치본: ${installer}`)
console.log(`  크기:   ${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`)
console.log(`  총 시간: ${sec(Date.now() - started)}`)
for (const [name, ms] of timings) console.log(`    - ${name}: ${sec(ms)}`)
const uniq = [...new Set(warnings)]
console.log(`  경고 ${uniq.length}건${uniq.length ? ':' : ''}`)
for (const w of uniq.slice(0, 30)) console.log(`    ! ${w}`)
