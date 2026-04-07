const fs = require('fs')
const path = require('path')
const { app } = require('electron')

function getCharactersRoot() {
  // 개발 중에는 프로젝트 폴더 안, 배포 후에는 userData 아래를 사용
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'characters')
    : path.join(process.cwd(), 'src', 'assets', 'characters')
}

function getRegistryPath() {
  return path.join(getCharactersRoot(), 'character_registry.json')
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function ensureRegistry() {
  const root = getCharactersRoot()
  const registryPath = getRegistryPath()

  ensureDir(root)

  if (!fs.existsSync(registryPath)) {
    const initial = {
      version: 2,
      activeCharacterId: null,
      characters: []
    }
    fs.writeFileSync(registryPath, JSON.stringify(initial, null, 2), 'utf-8')
  }

  return registryPath
}

function readRegistry() {
  const registryPath = ensureRegistry()
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
}

function writeRegistry(data) {
  const registryPath = ensureRegistry()
  fs.writeFileSync(registryPath, JSON.stringify(data, null, 2), 'utf-8')
  return data
}

function listCharacters() {
  const registry = readRegistry()
  return registry.characters || []
}

function getCharacterById(characterId) {
  const registry = readRegistry()
  return registry.characters.find(c => c.id === characterId) || null
}

function setActiveCharacter(characterId) {
  const registry = readRegistry()
  const exists = registry.characters.some(c => c.id === characterId)

  if (!exists) {
    throw new Error(`Character not found: ${characterId}`)
  }

  registry.activeCharacterId = characterId
  writeRegistry(registry)
  return { ok: true, activeCharacterId: characterId }
}

function upsertCharacter(entry) {
  const registry = readRegistry()
  const now = new Date().toISOString()
  const idx = registry.characters.findIndex(c => c.id === entry.id)

  if (idx >= 0) {
    registry.characters[idx] = {
      ...registry.characters[idx],
      ...entry,
      updatedAt: now
    }
  } else {
    registry.characters.push({
      createdAt: now,
      updatedAt: now,
      ...entry
    })

    if (!registry.activeCharacterId) {
      registry.activeCharacterId = entry.id
    }
  }

  writeRegistry(registry)
  return getCharacterById(entry.id)
}

module.exports = {
  getCharactersRoot,
  getRegistryPath,
  ensureRegistry,
  readRegistry,
  writeRegistry,
  listCharacters,
  getCharacterById,
  setActiveCharacter,
  upsertCharacter
}
