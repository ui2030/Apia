const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const extractZip = require('extract-zip')
const { dialog } = require('electron')

const registryService = require('./registryService')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.gif', '.webp', '.spa', '.sph'])
const DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.docx', '.hwp', '.hwpx'])
const MODEL_EXTS = new Set(['.pmx', '.pmd', '.vrm'])

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'character'
}

function toFileUrl(absPath) {
  const normalized = absPath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return `file://${normalized}`
  return `file:///${normalized}`
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function scanFiles(rootDir) {
  const out = []

  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        out.push(abs)
      }
    }
  }

  await walk(rootDir)
  return out
}

function chooseEntryModel(files) {
  const models = files
    .filter((file) => MODEL_EXTS.has(path.extname(file).toLowerCase()))
    .map((file) => ({
      abs: file,
      ext: path.extname(file).toLowerCase().slice(1),
      depth: file.split(path.sep).length,
      size: fs.statSync(file).size,
      name: path.basename(file).toLowerCase()
    }))

  if (!models.length) return null

  const vrm = models.filter((model) => model.ext === 'vrm')
  const mmd = models.filter((model) => model.ext === 'pmx' || model.ext === 'pmd')
  const preferredPool = mmd.length ? mmd : vrm

  preferredPool.sort((a, b) => {
    const scoreA = /model|main|body|character/.test(a.name) ? -1 : 0
    const scoreB = /model|main|body|character/.test(b.name) ? -1 : 0

    if (scoreA !== scoreB) return scoreA - scoreB
    if (a.depth !== b.depth) return a.depth - b.depth
    return b.size - a.size
  })

  return preferredPool[0]
}

function buildBasenameMap(files) {
  const map = {}

  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue

    const base = path.basename(file).toLowerCase()
    if (!map[base]) map[base] = []
    map[base].push(file)
  }

  return map
}

async function copyDir(src, dest) {
  ensureDir(dest)
  const entries = await fsp.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      ensureDir(path.dirname(destPath))
      await fsp.copyFile(srcPath, destPath)
    }
  }
}

async function copySelectedFiles(filePaths, sourceRoot, targetRoot) {
  for (const absPath of filePaths) {
    const rel = path.relative(sourceRoot, absPath)
    const dest = path.join(targetRoot, rel)
    ensureDir(path.dirname(dest))
    await fsp.copyFile(absPath, dest)
  }
}

async function prepareImportSource(sourcePath, workingRoot) {
  const stat = await fsp.stat(sourcePath)

  if (stat.isDirectory()) {
    return {
      extractedRoot: sourcePath,
      entryModelAbs: null,
      importSource: 'directory',
      originalSourcePath: null
    }
  }

  const ext = path.extname(sourcePath).toLowerCase()

  if (ext === '.zip') {
    await extractZip(sourcePath, { dir: workingRoot })
    return {
      extractedRoot: workingRoot,
      entryModelAbs: null,
      importSource: 'zip',
      originalSourcePath: sourcePath
    }
  }

  if (ext === '.vrm') {
    const copiedFile = path.join(workingRoot, path.basename(sourcePath))
    await fsp.copyFile(sourcePath, copiedFile)
    return {
      extractedRoot: workingRoot,
      entryModelAbs: copiedFile,
      importSource: 'file',
      originalSourcePath: sourcePath
    }
  }

  if (ext === '.pmx' || ext === '.pmd') {
    await copyDir(path.dirname(sourcePath), workingRoot)
    return {
      extractedRoot: workingRoot,
      entryModelAbs: path.join(workingRoot, path.basename(sourcePath)),
      importSource: 'file',
      originalSourcePath: sourcePath
    }
  }

  throw new Error(`Unsupported import source: ${sourcePath}`)
}

function uniqueCharacterId(baseId) {
  const registry = registryService.readRegistry()
  const existingIds = new Set((registry.characters || []).map((character) => character.id))

  if (!existingIds.has(baseId)) return baseId

  let index = 1
  while (existingIds.has(`${baseId}_${index}`)) index += 1
  return `${baseId}_${index}`
}

async function writeJsonIfMissing(filePath, data) {
  if (!(await pathExists(filePath))) {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
}

async function createCharacterFiles({
  characterDir,
  displayName,
  summary,
  description,
  modelType,
  entryModelAbs,
  extractedRoot,
  scannedFiles
}) {
  const modelDir = path.join(characterDir, 'model')
  const extractedDir = path.join(modelDir, 'extracted')
  const originalDir = path.join(modelDir, 'original_package')
  const docsDir = path.join(characterDir, 'docs')
  const motionsDir = path.join(characterDir, 'motions')

  ensureDir(modelDir)
  ensureDir(extractedDir)
  ensureDir(originalDir)
  ensureDir(docsDir)
  ensureDir(motionsDir)

  await copyDir(extractedRoot, extractedDir)

  const docs = scannedFiles.filter((file) => DOC_EXTS.has(path.extname(file).toLowerCase()))
  await copySelectedFiles(docs, extractedRoot, docsDir)

  const copiedScannedFiles = await scanFiles(extractedDir)
  const entryRelativePath = path.relative(extractedRoot, entryModelAbs)
  const copiedEntry = path.join(extractedDir, entryRelativePath)

  if (!(await pathExists(copiedEntry))) {
    throw new Error('Imported model entry file could not be resolved after copy.')
  }

  const imageFiles = copiedScannedFiles.filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase()))
  const basenameMap = buildBasenameMap(copiedScannedFiles)

  const manifest = {
    version: 1,
    modelType,
    entryFile: path.basename(copiedEntry),
    // 이식성: 매니페스트 위치(characterDir/model) 기준 상대경로. loadManifestByPath가
    // 이걸로 entryFileUrl을 재해석해 다른 PC/설치본에서도 로드된다. 절대 필드는
    // 하위호환용 유지(entryRelPath 없는 구 매니페스트는 절대 URL로 폴백).
    entryRelPath: path.relative(path.join(characterDir, 'model'), copiedEntry).replace(/\\/g, '/'),
    entryAbsolutePath: copiedEntry,
    entryFileUrl: toFileUrl(copiedEntry),
    rootDir: extractedDir,
    rootDirUrl: toFileUrl(extractedDir),
    loaderHints: {
      textureResolver: 'basename-fallback',
      note: 'When relative texture references are broken, resolve by basename as a fallback.'
    },
    files: copiedScannedFiles.map((file) => path.relative(extractedDir, file).replace(/\\/g, '/')),
    assets: {
      images: imageFiles.map((file) => ({
        name: path.basename(file),
        relativePath: path.relative(extractedDir, file).replace(/\\/g, '/'),
        absolutePath: file,
        fileUrl: toFileUrl(file)
      })),
      docs: docs.map((file) => ({
        name: path.basename(file),
        relativePath: path.relative(extractedRoot, file).replace(/\\/g, '/'),
        copiedTo: path.join('docs', path.relative(extractedRoot, file)).replace(/\\/g, '/')
      }))
    },
    textureBasenameMap: Object.fromEntries(
      Object.entries(basenameMap).map(([key, files]) => [
        key,
        files.map((file) => toFileUrl(file))
      ])
    ),
    warnings: [],
    ready: true
  }

  // 엔진 기본 프롬프트는 특정 작품·인물에 종속되지 않는 일반 서술(모델 불문 원칙).
  // 사용자가 import 시 description/summary를 주면 그걸 우선한다 — 캐릭터 고유
  // 정체성은 이 엔진 기본값이 아니라 사용자가 채우는 몫. (모델 이름을 프롬프트에
  // 박지 않는다 — 이전 `${displayName} base` 는 IP 파생명이 새는 경로였음.)
  const defaultPersonaPrompt = '데스크톱에서 사용자와 함께 지내는 3D 캐릭터 동반자. '
    + '차분하고 균형 잡힌 성격으로 자연스럽고 부드럽게 대화하며, 특정 작품·인물에 '
    + '종속되지 않는다. 세부 성향은 프로필의 성격 수치로 결정된다.'

  const profileGenerated = {
    version: 1,
    identity: {
      name: displayName,
      slug: path.basename(characterDir)
    },
    canonicalPersona: {
      confidence: 0.55,
      energy: 0.5,
      warmth: 0.5,
      emotionalStability: 0.65,
      talkSpeed: 0.5,
      expressiveness: 0.45,
      curiosity: 0.5,
      dominance: 0.45,
      socialStyle: 'balanced'
    },
    speechStyle: {
      tone: 'natural',
      formality: 'mid',
      verbosity: 'medium',
      defaultEndingStyle: 'soft'
    },
    behaviorTendency: {
      baseIdle: 'composed',
      gazeStrength: 0.45,
      fidgetiness: 0.3,
      movementRange: 0.2,
      reactionDelayMs: [250, 700]
    },
    motionPresetGroups: {
      idle: ['idle_breath_soft'],
      talk: ['talk_soft'],
      react: {
        happy: ['react_happy'],
        surprised: ['react_small_surprised']
      },
      locomotion: {
        walk: []
      }
    },
    systemPromptCore: description || summary || defaultPersonaPrompt
  }

  const profileUser = {
    customName: displayName,
    summary: summary || '',
    originalDescription: description || '',
    preferredInterpretation: 'default'
  }

  const interpretationPresets = {
    default: { label: 'Default' },
    shy: {
      label: 'Shy',
      offset: {
        confidence: -0.2,
        expressiveness: -0.12,
        gazeStrength: -0.18,
        fidgetiness: 0.14
      }
    },
    lively: {
      label: 'Lively',
      offset: {
        energy: 0.22,
        expressiveness: 0.18,
        movementRange: 0.12
      }
    }
  }

  await fsp.writeFile(
    path.join(modelDir, 'model_manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  )

  await writeJsonIfMissing(path.join(characterDir, 'profile.generated.json'), profileGenerated)
  await writeJsonIfMissing(path.join(characterDir, 'profile.user.json'), profileUser)
  await writeJsonIfMissing(path.join(characterDir, 'interpretation_presets.json'), interpretationPresets)
  await writeJsonIfMissing(
    path.join(motionsDir, 'index.json'),
    { version: 1, idle: [], talk: [], react: [], locomotion: [] }
  )

  return {
    manifest,
    copiedDocs: docs.map((file) => ({
      name: path.basename(file),
      path: path.join(docsDir, path.relative(extractedRoot, file))
    }))
  }
}

async function importFromZip({ zipPath, displayName, customName = '', summary = '', description = '' }) {
  if (!zipPath) {
    throw new Error('zipPath is required.')
  }

  if (!(await pathExists(zipPath))) {
    throw new Error(`Import source was not found: ${zipPath}`)
  }

  registryService.ensureRegistry()

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'apia-character-import-'))
  const workingRoot = path.join(tempRoot, 'import-source')
  ensureDir(workingRoot)

  try {
    const prepared = await prepareImportSource(zipPath, workingRoot)
    const scannedFiles = await scanFiles(prepared.extractedRoot)
    const entryModel = prepared.entryModelAbs
      ? {
          abs: prepared.entryModelAbs,
          ext: path.extname(prepared.entryModelAbs).toLowerCase().slice(1)
        }
      : chooseEntryModel(scannedFiles)

    if (!entryModel) {
      throw new Error('No PMX/PMD/VRM model file was found in the selected source.')
    }

    const inferredName =
      displayName ||
      path.basename(entryModel.abs, path.extname(entryModel.abs)) ||
      path.basename(zipPath, path.extname(zipPath))

    const characterId = uniqueCharacterId(slugify(customName || inferredName))
    const charactersRoot = registryService.getCharactersRoot()
    const characterDir = path.join(charactersRoot, characterId)

    if (await pathExists(characterDir)) {
      throw new Error(`Character directory already exists: ${characterDir}`)
    }

    ensureDir(characterDir)

    const modelDir = path.join(characterDir, 'model')
    const originalDir = path.join(modelDir, 'original_package')
    ensureDir(originalDir)

    if (prepared.originalSourcePath) {
      await fsp.copyFile(
        prepared.originalSourcePath,
        path.join(originalDir, path.basename(prepared.originalSourcePath))
      )
    } else {
      await fsp.writeFile(
        path.join(originalDir, 'source_directory.txt'),
        zipPath,
        'utf-8'
      )
    }

    const { manifest, copiedDocs } = await createCharacterFiles({
      characterDir,
      displayName: inferredName,
      summary,
      description,
      modelType: entryModel.ext,
      entryModelAbs: entryModel.abs,
      extractedRoot: prepared.extractedRoot,
      scannedFiles
    })

    // 이식성: 레지스트리엔 charactersRoot 기준 상대경로로 저장(다른 PC/설치본에서도
    // 로드). getCharacterById가 읽을 때 절대로 해석. root 밖이면 relative가 ..나
    // 절대를 줄 수 있어 그 경우 characterDir(절대) 그대로 저장.
    const rr = path.relative(registryService.getCharactersRoot(), characterDir)
    const relBase = (!rr || rr.startsWith('..') || path.isAbsolute(rr)) ? characterDir : rr
    const entry = registryService.upsertCharacter({
      id: characterId,
      displayName: inferredName,
      customName: customName || inferredName,
      summary,
      originalDescription: description,
      modelType: entryModel.ext,
      importSource: prepared.importSource,
      basePath: relBase,
      modelManifestPath: path.join(relBase, 'model', 'model_manifest.json'),
      profileGeneratedPath: path.join(relBase, 'profile.generated.json'),
      profileUserPath: path.join(relBase, 'profile.user.json'),
      interpretationsPath: path.join(relBase, 'interpretation_presets.json'),
      thumbnail: null,
      documents: copiedDocs.map((doc) => ({
        name: doc.name,
        path: doc.path,
        type: path.extname(doc.path).slice(1).toLowerCase()
      })),
      status: 'ready',
      analysis: {
        modelFound: true,
        texturesResolved: entryModel.ext === 'vrm' ? true : manifest.assets.images.length > 0,
        missingTextures: [],
        imageCount: manifest.assets.images.length,
        docCount: copiedDocs.length,
        resolver: manifest.loaderHints.textureResolver
      }
    })

    return {
      ok: true,
      character: entry,
      manifest,
      message: `${inferredName} imported successfully.`
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
}

async function pickImportSource(browserWindow) {
  const result = await dialog.showOpenDialog(browserWindow, {
    title: 'Import character source',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Character Sources', extensions: ['zip', 'vrm', 'pmx', 'pmd'] }
    ]
  })

  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true }
  }

  const sourcePath = result.filePaths[0]
  const stat = await fsp.stat(sourcePath)

  return {
    ok: true,
    path: sourcePath,
    name: path.basename(sourcePath),
    kind: stat.isDirectory() ? 'directory' : 'file'
  }
}

async function pickZipAndImport(browserWindow) {
  const picked = await pickImportSource(browserWindow)
  if (!picked?.ok || !picked.path) {
    return picked || { ok: false, canceled: true }
  }

  const sourcePath = picked.path
  const guessed = path.basename(sourcePath, path.extname(sourcePath))

  return importFromZip({
    zipPath: sourcePath,
    displayName: guessed,
    customName: guessed,
    summary: '',
    description: ''
  })
}

module.exports = {
  importFromZip,
  pickImportSource,
  pickZipAndImport,
  toFileUrl
}
