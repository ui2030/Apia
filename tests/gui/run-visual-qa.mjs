// E단계: 시각QA 상시 러너 — 빌드부터 시각 검증까지 한 명령으로.
//
//   node tests/gui/run-visual-qa.mjs   (= npm run qa:visual)
//
// 순서(항상 이 순서, 병렬 금지 — 한 GPU에 Electron 다중 인스턴스는 플레이크):
//   1. build            vite build — E2E는 dist 번들을 로드하므로 빌드를
//                       건너뛰면 옛 코드를 검증하는 함정에 빠진다. 그래서 상시.
//   2. vitest           단위 테스트 전체
//   3. transition-check 클립↔걷기 핸드오프 4단언
//   4. tail-check       꼬리 들림 3단언
//   5. vmd-check        9개 모션 × 3각도 스크린샷 + [error] 로그 단언
//
// 한 스텝이 실패해도 끝까지 진행하고, 마지막에 요약표를 출력한다.
// 하나라도 실패하면 exit 1. 스크린샷 폴더 목록은 실패 시에도 출력된다.
//
// 구현 메모(Codex 사전 검토 MUST-FIX 반영):
//   - Windows에서 npm.cmd/npx.cmd를 셸 없이 spawn하면 Node 18.20+에서
//     EINVAL(CVE-2024-27980 대응)이고, shell:true는 따옴표 함정이 있다.
//     그래서 npm을 아예 거치지 않고 process.execPath(node)로 vite/vitest의
//     JS 실행 파일을 직접 호출한다 — 인용 문제도, .cmd 문제도 없음.
//   - 모든 스텝 cwd = 프로젝트 루트 고정.
//   - 스텝별 타임아웃: Electron이 행에 걸리면 프로세스 트리째 강제 종료
//     (Windows는 child.kill()이 손자 프로세스를 못 죽이므로 taskkill /t).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', '..')
const node = process.execPath

const steps = [
  {
    name: 'build',
    label: 'vite build (dist 갱신)',
    args: [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    timeoutMs: 180_000
  },
  {
    name: 'vitest',
    label: '단위 테스트',
    args: [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run'],
    timeoutMs: 300_000
  },
  {
    name: 'transition-check',
    label: '클립↔걷기 핸드오프 (4단언)',
    args: [path.join(__dirname, 'transition-check.mjs')],
    timeoutMs: 240_000
  },
  {
    name: 'tail-check',
    label: '꼬리 들림 (3단언)',
    args: [path.join(__dirname, 'tail-check.mjs')],
    timeoutMs: 180_000
  },
  {
    name: 'smoothness-check',
    label: '시선 반응 + 전환 부드러움 (2단언)',
    args: [path.join(__dirname, 'smoothness-check.mjs')],
    timeoutMs: 180_000
  },
  {
    name: 'expression-check',
    label: '감정→표정 모프 + 깜빡임 (4단언)',
    args: [path.join(__dirname, 'expression-check.mjs')],
    timeoutMs: 180_000
  },
  {
    name: 'lipsync-check',
    label: '비짐 타임라인 → 입모양 (5단언)',
    args: [path.join(__dirname, 'lipsync-check.mjs')],
    timeoutMs: 180_000
  },
  {
    name: 'vmd-check',
    label: '9모션×3각도 스크린샷 + 에러 로그 단언',
    args: [path.join(__dirname, 'vmd-check.mjs')],
    timeoutMs: 600_000
  }
]

function killTree(child) {
  if (process.platform === 'win32') {
    // /t: 자식(Electron, GPU 프로세스)까지, /f: 강제
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(node, step.args, { cwd: root, stdio: 'inherit' })
    let timedOut = false
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      resolve(result)
    }
    let graceTimer
    const timer = setTimeout(() => {
      timedOut = true
      console.error(`\n[qa] ${step.name}: ${step.timeoutMs / 1000}s 타임아웃 — 프로세스 트리 종료`)
      killTree(child)
      // taskkill 자체가 실패하면 exit 이벤트가 영영 안 와 러너가 행에
      // 걸린다 — 10s 유예 후 강제 진행 (Codex 사후 검증 권고)
      graceTimer = setTimeout(() => {
        console.error(`[qa] ${step.name}: 종료 확인 실패 — 강제 진행`)
        settle({ ...step, ok: false, code: null, timedOut, ms: Date.now() - started })
      }, 10_000)
    }, step.timeoutMs)
    child.on('error', (err) => {
      console.error(`[qa] ${step.name}: spawn 실패 — ${err.message}`)
      settle({ ...step, ok: false, code: null, timedOut, ms: Date.now() - started })
    })
    child.on('exit', (code) => {
      settle({ ...step, ok: !timedOut && code === 0, code, timedOut, ms: Date.now() - started })
    })
  })
}

const results = []
for (const step of steps) {
  console.log(`\n${'='.repeat(60)}\n[qa] ${step.name} — ${step.label}\n${'='.repeat(60)}`)
  // eslint-disable-next-line no-await-in-loop -- 순차 실행이 사양(GPU 경합 방지)
  results.push(await runStep(step))
}

// ───── 스크린샷 폴더 목록 (실패 시에도 눈으로 확인할 수 있도록 항상 출력) ─────
const shotRoot = path.join(root, 'test-results')
console.log(`\n${'='.repeat(60)}\n[qa] 스크린샷 폴더 — 눈으로 볼 것들 (기준은 tests/gui/VISUAL_QA.md)\n${'='.repeat(60)}`)
if (existsSync(shotRoot)) {
  for (const dir of readdirSync(shotRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const full = path.join(shotRoot, dir.name)
    const pngs = readdirSync(full).filter((f) => f.endsWith('.png'))
    console.log(`  ${path.join('test-results', dir.name)}  (${pngs.length} png)`)
  }
} else {
  console.log('  (test-results 폴더 없음)')
}

// ───── 요약표 ─────
const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${'='.repeat(60)}\n[qa] 요약\n${'='.repeat(60)}`)
console.log(`  ${pad('스텝', 18)}${pad('결과', 12)}소요`)
for (const r of results) {
  const verdict = r.ok ? 'PASS' : r.timedOut ? 'TIMEOUT' : `FAIL(${r.code})`
  console.log(`  ${pad(r.name, 18)}${pad(verdict, 12)}${(r.ms / 1000).toFixed(1)}s`)
}
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\nVISUAL QA FAILED — ${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
console.log('\nVISUAL QA PASSED')
process.exit(0)
