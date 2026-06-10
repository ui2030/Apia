/**
 * Runtime contracts for files Electron reads from disk.
 *
 * The corresponding write paths already normalize, so the strict use case
 * is *read*: a registry/settings/world file might be hand-edited, left over
 * from an older version, or partially corrupted. We `safeParse` on read and
 * fall back to defaults rather than crashing the renderer.
 *
 * Vitest under tests/schemas.test.js exercises both the happy path and the
 * known-bad shapes — adding/removing a key here without updating that test
 * is intentionally hard.
 *
 * Kept as CommonJS so both the Electron main process (CJS) and vitest can
 * `require('./electron/schemas')` without an ESM bridge.
 */
const { z } = require('zod')

// ── Settings (apia-settings.json) ────────────────────────────────────────
//
// Mirrors SETTINGS_DEFAULTS in electron/main.js. `aiMode` enum is the source
// of truth — if a new provider is added there it must be added here too, and
// the contract test will fail until both move together.

const aiModeSchema = z.enum(['auto', 'local', 'hf_api', 'claude', 'groq'])

// windowAnchor: optional anchor point used to restore the main overlay onto
// the same display across runs. Only x/y are persisted — the overlay is
// non-resizable and always sized to the chosen display's workArea, so a
// raw bounds rectangle would be wrong (see services/windowBoundsPolicy.js).
const windowAnchorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).nullable()

const SettingsSchema = z.object({
  activeModel: z.string(),
  activeCharacter: z.string().nullable(),
  models: z.array(z.unknown()),
  alwaysOnTop: z.boolean(),
  charScale: z.number().min(1).max(500),
  autoBehavior: z.boolean(),
  aiMode: aiModeSchema,
  memoryTurns: z.number().int().min(1).max(50),
  ttsEnabled: z.boolean(),
  voiceId: z.string().nullable(),
  windowAnchor: windowAnchorSchema,
  // step 4 — every /chat defaults to use_web=true when enabled. Optional in
  // the schema for backward compat: a settings.json written by an older
  // version will hydrate to `false` via SETTINGS_DEFAULTS.
  useWebDefault: z.boolean().optional()
}).passthrough() // tolerate forward-compatible extra keys, but enforce known ones

// ── World (apia-world.json) ──────────────────────────────────────────────
//
// `sitOffset` is optional (point/decoration types don't have it). Numeric
// fields all use `.finite()` so a hand-edited apia-world.json holding
// `1e9999` (parses to Infinity) is caught at the boundary instead of
// silently propagating into Three.js geometry math. `normalizeWorldObject`
// in src/world.js still coerces upstream, but this schema is the
// authoritative contract for what's allowed on disk.

const worldTypeSchema = z.enum(['chair', 'point', 'decoration'])

const sitOffsetSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
}).nullable()

// Numeric fields now use .finite() so a hand-edited apia-world.json with
// `1e9999` (parses to Infinity) is caught at the boundary instead of
// silently propagating into Three.js geometry math.
const WorldObjectSchema = z.object({
  id: z.string(),
  type: worldTypeSchema,
  label: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  sitOffset: sitOffsetSchema.optional(),
  sitRotY: z.number().finite().optional(),
  anchorHeight: z.number().finite().optional(),
  screenOffsetY: z.number().finite().optional(),
  autoBehavior: z.boolean().optional(),
  clickable: z.boolean().optional(),
  hidden: z.boolean().optional(),
  bubbleText: z.string().optional(),
  badge: z.string().optional(),
  name: z.string().optional()
}).passthrough()

const WorldDocumentSchema = z.object({
  version: z.number().int().optional(),
  objects: z.array(WorldObjectSchema)
}).passthrough()

// Envelope variants used by the repair-aware read path: outer shape is
// validated strictly but the child elements are kept as unknown so each
// one can be salvaged independently. One bad world object should not drop
// the rest of the world. See parseWorldObjects below.
const WorldDocumentEnvelopeSchema = z.object({
  version: z.number().int().optional(),
  objects: z.array(z.unknown())
}).passthrough()

// ── Character registry (character_registry.json) ─────────────────────────
//
// The registry version is bumped on schema-breaking changes (currently 2).
// `analysis` and `documents` are derived during import — we accept loose
// shapes here because the renderer can render a degraded character entry
// (e.g. without a thumbnail) without erroring.

const CharacterDocumentSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string()
}).passthrough()

const CharacterEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  modelType: z.enum(['vrm', 'pmx', 'pmd']),
  basePath: z.string(),
  // The rest are present on imports but optional so older registry rows
  // (pre-analysis fields) still validate during readRegistry().
  customName: z.string().optional(),
  summary: z.string().optional(),
  originalDescription: z.string().optional(),
  importSource: z.string().optional(),
  modelManifestPath: z.string().optional(),
  profileGeneratedPath: z.string().optional(),
  profileUserPath: z.string().optional(),
  interpretationsPath: z.string().optional(),
  thumbnail: z.string().nullable().optional(),
  documents: z.array(CharacterDocumentSchema).optional(),
  status: z.string().optional(),
  analysis: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
}).passthrough()

// Registry version bumps on schema-breaking changes. v2 is the only version
// ever shipped — older snapshots don't exist in the wild — so we lock the
// envelope to a literal. When a future v3 lands, introduce a migration
// service (currently YAGNI per Codex review).
const CURRENT_REGISTRY_VERSION = 2

const CharacterRegistrySchema = z.object({
  version: z.literal(CURRENT_REGISTRY_VERSION),
  activeCharacterId: z.string().nullable(),
  characters: z.array(CharacterEntrySchema)
}).passthrough()

// Envelope: outer shape strict, child entries left unknown so each one can
// be salvaged independently via parseCharacterEntries.
const CharacterRegistryEnvelopeSchema = z.object({
  version: z.literal(CURRENT_REGISTRY_VERSION),
  activeCharacterId: z.string().nullable(),
  characters: z.array(z.unknown())
}).passthrough()

/**
 * Repair-aware parse for the character collection. Each element is
 * validated independently — one bad entry should not drop the user's
 * entire registry. Returns `{entries, repaired: {count, sampleReasons}}`.
 *
 * Caller is responsible for any aggregate-level consistency fixes (e.g.
 * `activeCharacterId` pointing at a dropped entry). This helper only
 * separates the wheat from the chaff at the element level.
 *
 * `sampleReasons` caps at the first 3 issues to keep log volume bounded —
 * an apocalyptic registry shouldn't flood diagnostics.
 */
function parseCharacterEntries(rawArray) {
  if (!Array.isArray(rawArray)) {
    return { entries: [], repaired: { count: 0, sampleReasons: [] } }
  }
  const entries = []
  const reasons = []
  for (const raw of rawArray) {
    const result = CharacterEntrySchema.safeParse(raw)
    if (result.success) {
      entries.push(result.data)
    } else {
      if (reasons.length < 3) {
        reasons.push(result.error.issues[0]?.message || 'unknown schema error')
      }
    }
  }
  return {
    entries,
    repaired: { count: rawArray.length - entries.length, sampleReasons: reasons }
  }
}

/**
 * Same repair pattern for world objects. One bad chair should not drop
 * the other furniture.
 */
function parseWorldObjects(rawArray) {
  if (!Array.isArray(rawArray)) {
    return { objects: [], repaired: { count: 0, sampleReasons: [] } }
  }
  const objects = []
  const reasons = []
  for (const raw of rawArray) {
    const result = WorldObjectSchema.safeParse(raw)
    if (result.success) {
      objects.push(result.data)
    } else {
      if (reasons.length < 3) {
        reasons.push(result.error.issues[0]?.message || 'unknown schema error')
      }
    }
  }
  return {
    objects,
    repaired: { count: rawArray.length - objects.length, sampleReasons: reasons }
  }
}

module.exports = {
  SettingsSchema,
  WorldObjectSchema,
  WorldDocumentSchema,
  WorldDocumentEnvelopeSchema,
  CharacterEntrySchema,
  CharacterRegistrySchema,
  CharacterRegistryEnvelopeSchema,
  CURRENT_REGISTRY_VERSION,
  aiModeSchema,
  worldTypeSchema,
  parseCharacterEntries,
  parseWorldObjects
}
