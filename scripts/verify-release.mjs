import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const requiredPaths = [
  'dist/index.html',
  'dist/settings.html',
  'electron/main.js',
  'electron/preload.js',
  'backend/main.py',
  'backend-dist/ApiaBackend.exe',
  'electron-builder.yml',
  'node_modules/electron-builder'
]

async function assertExists(relativePath) {
  const target = resolve(process.cwd(), relativePath)
  try {
    await access(target)
  } catch {
    throw new Error(`[VERIFY_RELEASE_MISSING] ${relativePath}`)
  }
}

async function assertFileIncludes(relativePath, requiredText, errorCode) {
  const target = resolve(process.cwd(), relativePath)
  const content = await readFile(target, 'utf8')
  if (!content.includes(requiredText)) {
    throw new Error(`[${errorCode}] ${relativePath}`)
  }
}

async function main() {
  for (const file of requiredPaths) {
    await assertExists(file)
  }

  // The packaged-backend path resolution moved out of the thin-orchestrator
  // main.js into backendDiscovery.js (main.js now just passes
  // process.resourcesPath into getPackagedBackendExecutableCandidates). Assert
  // against the file that actually builds the resources/backend path.
  await assertFileIncludes('electron/services/backendDiscovery.js', "resourcesPath, 'backend'", 'VERIFY_RELEASE_BACKEND_LOOKUP_MISSING')
  await assertFileIncludes('electron-builder.yml', 'extraResources:', 'VERIFY_RELEASE_EXTRA_RESOURCES_MISSING')
  await assertFileIncludes('electron-builder.yml', 'from: backend-dist/ApiaBackend.exe', 'VERIFY_RELEASE_BACKEND_EXE_SOURCE_MISSING')
  await assertFileIncludes('electron-builder.yml', 'to: backend/ApiaBackend.exe', 'VERIFY_RELEASE_BACKEND_COPY_MISSING')

  console.log('[VERIFY_RELEASE_OK] release prerequisites are configured')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
