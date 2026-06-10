const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const {
  CharacterRegistryEnvelopeSchema,
  CURRENT_REGISTRY_VERSION,
  parseCharacterEntries
} = require('../schemas')

function getCharactersRoot() {
  // Test seam: when a test sets globalThis.__APIA_TEST_USERDATA__ to a tmp
  // dir, treat it as the userData root. Production never sets this — the
  // check is one boolean read per registry op, effectively free.
  if (globalThis.__APIA_TEST_USERDATA__) {
    return path.join(globalThis.__APIA_TEST_USERDATA__, 'characters')
  }
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

function emptyRegistry() {
  return { version: CURRENT_REGISTRY_VERSION, activeCharacterId: null, characters: [] }
}

/**
 * Read the registry with per-entry repair semantics. The outer envelope
 * (`version` literal, `activeCharacterId` shape, `characters` array) is
 * validated strictly. Each entry inside `characters` is then parsed
 * independently, so one corrupted character cannot drop the rest.
 *
 * Aggregate consistency: if `activeCharacterId` points at an entry that
 * got dropped, repair it to the first surviving entry (or null). Never
 * leave a dangling pointer.
 *
 * Never writes back. upsert/delete paths reshape on their own.
 */
function readRegistry() {
  const registryPath = ensureRegistry()
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
  } catch (error) {
    console.warn('[Registry] read/parse failed, falling back to empty:', error)
    return emptyRegistry()
  }

  const envelope = CharacterRegistryEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    console.warn('[Registry] envelope schema failed:', envelope.error.issues)
    return emptyRegistry()
  }

  const { entries, repaired } = parseCharacterEntries(envelope.data.characters)
  if (repaired.count > 0) {
    console.warn('[Registry] dropped invalid entries:', repaired)
  }

  let activeCharacterId = envelope.data.activeCharacterId
  if (activeCharacterId !== null) {
    const stillExists = entries.some((entry) => entry.id === activeCharacterId)
    if (!stillExists) {
      // Active pointer became dangling — either because the entry was
      // dropped just now, or because the file had a stale pointer before
      // we even read it. Repair to first valid entry, or null.
      const repaired = entries.length > 0 ? entries[0].id : null
      console.warn('[Registry] activeCharacterId rebound', {
        from: activeCharacterId,
        to: repaired
      })
      activeCharacterId = repaired
    }
  }

  return {
    version: envelope.data.version,
    activeCharacterId,
    characters: entries
  }
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
  return registry.characters.find((character) => character.id === characterId) || null
}

function setActiveCharacter(characterId) {
  const registry = readRegistry()
  const exists = registry.characters.some((character) => character.id === characterId)

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
  const index = registry.characters.findIndex((character) => character.id === entry.id)

  if (index >= 0) {
    registry.characters[index] = {
      ...registry.characters[index],
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

function isSafeCharacterPath(targetPath) {
  if (!targetPath) return false

  const root = path.resolve(getCharactersRoot())
  const target = path.resolve(targetPath)
  const rel = path.relative(root, target)

  if (!rel) return false
  if (rel.startsWith('..')) return false
  if (path.isAbsolute(rel)) return false

  return true
}

/**
 * Step 1 — write the personality overrides the user picked in the settings
 * UI into the character's `profile.user.json`. The slider values land under
 * `personalityOverrides`, layered on top of whatever `preferredInterpretation`
 * etc. was already there. motionManager re-applies these on next character
 * load + immediately via the `character-personality-updated` broadcast.
 */
function setCharacterPersonalityOverrides(characterId, overrides) {
  const character = getCharacterById(characterId)
  if (!character) throw new Error(`Character not found: ${characterId}`)
  if (!character.profileUserPath) {
    throw new Error(`Character has no profileUserPath: ${characterId}`)
  }
  if (!overrides || typeof overrides !== 'object') {
    throw new Error('overrides must be an object')
  }
  let existing = {}
  try {
    if (fs.existsSync(character.profileUserPath)) {
      existing = JSON.parse(fs.readFileSync(character.profileUserPath, 'utf-8')) || {}
    }
  } catch (error) {
    console.warn('[Registry] profile.user parse failed, starting fresh:', error)
    existing = {}
  }
  const cleaned = {}
  for (const [k, v] of Object.entries(overrides)) {
    if (Number.isFinite(v)) {
      cleaned[k] = Math.max(0, Math.min(1, v))
    }
  }
  const next = {
    ...existing,
    personalityOverrides: { ...(existing.personalityOverrides || {}), ...cleaned }
  }
  fs.mkdirSync(path.dirname(character.profileUserPath), { recursive: true })
  fs.writeFileSync(character.profileUserPath, JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true, characterId, overrides: next.personalityOverrides }
}

function getCharacterPersonalityOverrides(characterId) {
  const character = getCharacterById(characterId)
  if (!character?.profileUserPath) return {}
  try {
    if (fs.existsSync(character.profileUserPath)) {
      const data = JSON.parse(fs.readFileSync(character.profileUserPath, 'utf-8'))
      return data?.personalityOverrides || {}
    }
  } catch {}
  return {}
}

function deleteCharacter(characterId) {
  const registry = readRegistry()
  const character = registry.characters.find((item) => item.id === characterId)

  if (!character) {
    throw new Error(`Character not found: ${characterId}`)
  }

  registry.characters = registry.characters.filter((item) => item.id !== characterId)

  if (registry.activeCharacterId === characterId) {
    registry.activeCharacterId = registry.characters.length > 0
      ? registry.characters[0].id
      : null
  }

  writeRegistry(registry)

  if (character.basePath && fs.existsSync(character.basePath)) {
    if (isSafeCharacterPath(character.basePath)) {
      try {
        fs.rmSync(character.basePath, { recursive: true, force: true })
      } catch (error) {
        console.warn('[Registry] delete failed:', character.basePath, error)
      }
    } else {
      console.warn('[Registry] skipped deleting unexpected path:', character.basePath)
    }
  }

  return { ok: true, deletedId: characterId }
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
  setCharacterPersonalityOverrides,
  getCharacterPersonalityOverrides,
  upsertCharacter,
  deleteCharacter
}
