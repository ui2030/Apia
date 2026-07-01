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

// tmp → rename 원자적 JSON 쓰기. 저장 도중 크래시/전원차단이 나도 반쪽 JSON이
// 대상 경로에 노출되지 않아 레지스트리/프로필이 손상되지 않는다(반쪽이면
// readRegistry가 emptyRegistry로 폴백해 캐릭터 목록이 통째 유실됐음).
// backendEnvRepository.#atomicWrite와 동일 패턴. mkdir recursive는 idempotent.
function atomicWriteJson(targetPath, data) {
  const tmpPath = `${targetPath}.tmp`
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmpPath, targetPath)
}

// 저장은 상대경로 허용(이식성); 읽는(소비) 순간 charactersRoot 기준 절대경로로
// 해석한다. 이미 절대경로면 그대로 통과 — 기존 절대경로 엔트리가 안 깨진다
// (하위호환). readRegistry는 as-stored 유지(setActive/upsert 왕복 시 상대 보존),
// 소비용 getter(listCharacters/getCharacterById)에서만 해석한다.
const ENTRY_PATH_FIELDS = ['basePath', 'modelManifestPath', 'profileGeneratedPath', 'profileUserPath', 'interpretationsPath', 'thumbnail']
function resolveEntryPaths(entry) {
  if (!entry) return entry
  const root = getCharactersRoot()
  const out = { ...entry }
  for (const f of ENTRY_PATH_FIELDS) {
    const p = out[f]
    if (typeof p === 'string' && p && !path.isAbsolute(p)) out[f] = path.join(root, p)
  }
  return out
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
    atomicWriteJson(registryPath, initial)
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
  atomicWriteJson(registryPath, data)
  return data
}

function listCharacters() {
  const registry = readRegistry()
  return (registry.characters || []).map(resolveEntryPaths)
}

function getCharacterById(characterId) {
  const registry = readRegistry()
  const entry = registry.characters.find((character) => character.id === characterId)
  return entry ? resolveEntryPaths(entry) : null
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
  atomicWriteJson(character.profileUserPath, next)
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

  const basePath = resolveEntryPaths(character).basePath
  if (basePath && fs.existsSync(basePath)) {
    if (isSafeCharacterPath(basePath)) {
      try {
        fs.rmSync(basePath, { recursive: true, force: true })
      } catch (error) {
        console.warn('[Registry] delete failed:', basePath, error)
      }
    } else {
      console.warn('[Registry] skipped deleting unexpected path:', basePath)
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
  resolveEntryPaths,
  setActiveCharacter,
  setCharacterPersonalityOverrides,
  getCharacterPersonalityOverrides,
  upsertCharacter,
  deleteCharacter
}
