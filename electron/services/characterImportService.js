const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const extractZip = require('extract-zip')
const { dialog } = require('electron')
const registryService = require('./registryService')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.gif', '.webp', '.spa', '.sph'])
const DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.docx', '.hwp', '.hwpx'])
const MODEL_EXTS = new Set(['.pmx', '.vrm'])

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '_')
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
    .filter(file => MODEL_EXTS.has(path.extname(file).toLowerCase()))
    .map(file => ({
      abs: file,
      ext: path.extname(file).toLowerCase().slice(1),
      depth: file.split(path.sep).length,
      size: fs.statSync(file).size,
      name: path.basename(file).toLowerCase()
    }))

  if (!models.length) return null

  const vrm = models.filter(m => m.ext === 'vrm')
  const pmx = models.filter(m => m.ext === 'pmx')

  const preferredPool = pmx.length ? pmx : vrm

  preferredPool.sort((a, b) => {
    const nameScoreA = /model|main|body|character/.test(a.name) ? -1 : 0
    const nameScoreB = /model|main|body|character/.test(b.name) ? -1 : 0
    if (nameScoreA !== nameScoreB) return nameScoreA - nameScoreB
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

function uniqueCharacterId(baseId) {
  const registry = registryService.readRegistry()
  const existingIds = new Set((registry.characters || []).map(c => c.id))

  if (!existingIds.has(baseId)) return baseId

  let i = 1
  while (existingIds.has(`${baseId}_${i}`)) i += 1
  return `${baseId}_${i}`
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

  const docs = scannedFiles.filter(file => DOC_EXTS.has(path.extname(file).toLowerCase()))
  await copySelectedFiles(docs, extractedRoot, docsDir)

  const copiedScannedFiles = await scanFiles(extractedDir)
  const copiedEntry = copiedScannedFiles.find(file => path.basename(file) === path.basename(entryModelAbs))

  if (!copiedEntry) {
    throw new Error('추출 후 PMX/VRM 엔트리 파일을 다시 찾을 수 없습니다.')
  }

  const imageFiles = copiedScannedFiles.filter(file => IMAGE_EXTS.has(path.extname(file).toLowerCase()))
  const basenameMap = buildBasenameMap(copiedScannedFiles)

  const manifest = {
    version: 1,
    modelType,
    entryFile: path.basename(copiedEntry),
    entryAbsolutePath: copiedEntry,
    entryFileUrl: toFileUrl(copiedEntry),
    rootDir: extractedDir,
    rootDirUrl: toFileUrl(extractedDir),
    loaderHints: {
      textureResolver: 'basename-fallback',
      note: 'PMX 내부 상대 경로가 어긋난 경우 basename 기준으로 텍스처를 보정하도록 렌더러 로더에서 사용'
    },
    files: copiedScannedFiles.map(file => path.relative(extractedDir, file).replace(/\\/g, '/')),
    assets: {
      images: imageFiles.map(file => ({
        name: path.basename(file),
        relativePath: path.relative(extractedDir, file).replace(/\\/g, '/'),
        absolutePath: file,
        fileUrl: toFileUrl(file)
      })),
      docs: docs.map(file => ({
        name: path.basename(file),
        relativePath: path.relative(extractedRoot, file).replace(/\\/g, '/'),
        copiedTo: path.join('docs', path.relative(extractedRoot, file)).replace(/\\/g, '/')
      }))
    },

    // 🔥 프론트에서 바로 candidates[0]으로 쓸 수 있게 문자열 URL 배열로 저장
    textureBasenameMap: Object.fromEntries(
      Object.entries(basenameMap).map(([key, files]) => [
        key,
        files.map(file => toFileUrl(file))
      ])
    ),

    warnings: [],
    ready: true
  }

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
      idle: ['idle_breathe_soft'],
      talk: ['talk_default'],
      react: {
        happy: ['react_smile_small'],
        surprised: ['react_small_startle']
      },
      locomotion: {
        walk: ['walk_default']
      }
    },
    systemPromptCore: description || summary || `${displayName} 캐릭터 기본 프로필`
  }

  const profileUser = {
    customName: displayName,
    summary: summary || '',
    originalDescription: description || '',
    preferredInterpretation: 'default'
  }

  const interpretationPresets = {
    default: { label: '기본' },
    shy: {
      label: '소심한 해석',
      offset: {
        confidence: -0.2,
        expressiveness: -0.12,
        gazeStrength: -0.18,
        fidgetiness: 0.14
      }
    },
    lively: {
      label: '활발한 해석',
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
  await writeJsonIfMissing(path.join(motionsDir, 'index.json'), { version: 1, idle: [], talk: [], react: [], locomotion: [] })

  return {
    manifest,
    copiedDocs: docs.map(file => ({
      name: path.basename(file),
      path: path.join(docsDir, path.relative(extractedRoot, file))
    }))
  }
}

async function importFromZip({ zipPath, displayName, customName = '', summary = '', description = '' }) {
  if (!zipPath) {
    throw new Error('zipPath가 비어 있습니다.')
  }

  if (!(await pathExists(zipPath))) {
    throw new Error(`ZIP 파일을 찾을 수 없습니다: ${zipPath}`)
  }

  registryService.ensureRegistry()

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'apia-character-import-'))
  const extractRoot = path.join(tempRoot, 'unzipped')
  ensureDir(extractRoot)

  try {
    await extractZip(zipPath, { dir: extractRoot })

    const scannedFiles = await scanFiles(extractRoot)
    const entryModel = chooseEntryModel(scannedFiles)

    if (!entryModel) {
      throw new Error('ZIP 안에서 PMX 또는 VRM 파일을 찾지 못했습니다.')
    }

    const inferredName = displayName || path.basename(entryModel.abs, path.extname(entryModel.abs))
    const characterId = uniqueCharacterId(slugify(customName || inferredName))
    const charactersRoot = registryService.getCharactersRoot()
    const characterDir = path.join(charactersRoot, characterId)

    if (await pathExists(characterDir)) {
      throw new Error(`이미 같은 캐릭터 폴더가 존재합니다: ${characterDir}`)
    }

    ensureDir(characterDir)

    const modelDir = path.join(characterDir, 'model')
    const originalDir = path.join(modelDir, 'original_package')
    ensureDir(originalDir)
    await fsp.copyFile(zipPath, path.join(originalDir, path.basename(zipPath)))

    const { manifest, copiedDocs } = await createCharacterFiles({
      characterDir,
      displayName: inferredName,
      summary,
      description,
      modelType: entryModel.ext,
      entryModelAbs: entryModel.abs,
      extractedRoot: extractRoot,
      scannedFiles
    })

    const entry = registryService.upsertCharacter({
      id: characterId,
      displayName: inferredName,
      customName: customName || inferredName,
      summary,
      originalDescription: description,
      modelType: entryModel.ext,
      importSource: 'zip',
      basePath: characterDir,
      modelManifestPath: path.join(characterDir, 'model', 'model_manifest.json'),
      profileGeneratedPath: path.join(characterDir, 'profile.generated.json'),
      profileUserPath: path.join(characterDir, 'profile.user.json'),
      interpretationsPath: path.join(characterDir, 'interpretation_presets.json'),
      thumbnail: null,
      documents: copiedDocs.map(doc => ({
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
      message: `${inferredName} 캐릭터를 등록했습니다.`
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
}

async function pickZipAndImport(browserWindow) {
  const result = await dialog.showOpenDialog(browserWindow, {
    title: '캐릭터 ZIP 선택',
    properties: ['openFile'],
    filters: [{ name: 'ZIP Files', extensions: ['zip'] }]
  })

  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true }
  }

  const zipPath = result.filePaths[0]
  const guessed = path.basename(zipPath, '.zip')

  return await importFromZip({
    zipPath,
    displayName: guessed,
    customName: guessed,
    summary: '',
    description: ''
  })
}

module.exports = {
  importFromZip,
  pickZipAndImport,
  toFileUrl
}