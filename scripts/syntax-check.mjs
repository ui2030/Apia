/**
 * `node --check` every file under electron/ — recursively, not a hardcoded list.
 *
 * The old `verify` script named 5 files by hand, so 10 of the 16 electron
 * modules (worldStore, windowManager, screenCapture, …) could ship with a
 * syntax error and verify would still pass. A glob can't drift.
 *
 * src/ is deliberately excluded: vite parses every module it bundles, so
 * `npm run build` already fails loudly on a syntax error there.
 *
 * Every failure is collected and printed — stopping at the first one hides
 * how many files are broken.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(projectRoot, 'electron')

const files = readdirSync(electronDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => join(entry.parentPath || entry.path, entry.name))
  .sort()

if (files.length === 0) {
  console.error('[SYNTAX_CHECK] no .js files found under electron/ — glob broken?')
  process.exit(1)
}

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({
      file: relative(projectRoot, file),
      output: (result.stderr || result.stdout || '').trim()
    })
  }
}

if (failures.length > 0) {
  for (const { file, output } of failures) {
    console.error(`[SYNTAX_CHECK_FAIL] ${file}\n${output}\n`)
  }
  console.error(`[SYNTAX_CHECK] ${failures.length}/${files.length} file(s) failed`)
  process.exit(1)
}

console.log(`[SYNTAX_CHECK_OK] ${files.length} electron file(s)`)
