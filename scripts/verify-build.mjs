import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const requiredFiles = [
  'dist/index.html',
  'dist/settings.html',
  'electron/main.js',
  'electron/preload.js'
]

async function assertExists(relativePath) {
  const target = resolve(process.cwd(), relativePath)
  try {
    await access(target)
  } catch {
    throw new Error(`[VERIFY_BUILD_MISSING] ${relativePath}`)
  }
}

async function main() {
  for (const file of requiredFiles) {
    await assertExists(file)
  }

  console.log('[VERIFY_BUILD_OK] required build artifacts are present')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
