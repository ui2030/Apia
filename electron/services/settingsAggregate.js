/**
 * Settings aggregate / repository for the Electron main process.
 *
 * Owns the persistence boundary for `apia-settings.json` and the bootstrap
 * of `backend-data/backend.env.example`. The aggregate's invariant is the
 * normalized settings shape — every read goes through `normalize()` so
 * callers receive a SettingsSchema-conformant object even when the disk
 * file is partially corrupt, missing, or hand-edited with out-of-range
 * values.
 *
 * Inputs are explicit dependencies (paths, logger, the
 * `shouldForceAutoAiMode` policy callback) so the class has no implicit
 * Electron coupling and can be unit-tested with a tmp dir.
 */
const fs = require('fs')
const path = require('path')

const { SettingsSchema } = require('../schemas')
const { normalizeAnchor } = require('./windowBoundsPolicy')

const VALID_AI_MODES = new Set(['auto', 'local', 'hf_api', 'claude', 'groq'])

const SETTINGS_DEFAULTS = Object.freeze({
  activeModel: 'dummy',
  activeCharacter: null,
  models: [],
  alwaysOnTop: true,
  charScale: 100,
  autoBehavior: true,
  aiMode: 'auto',
  memoryTurns: 10,
  ttsEnabled: true,
  voiceId: null,
  windowAnchor: null
})

const BACKEND_ENV_EXAMPLE_FILENAME = 'backend.env.example'
const BACKEND_ENV_EXAMPLE_CONTENT = `# Apia packaged backend configuration
APIA_AI_MODE=auto
# APIA_GROQ_KEY=
# APIA_ANTHROPIC_KEY=
# APIA_HF_TOKEN=
# APIA_MODEL_ID=Qwen/Qwen2.5-7B-Instruct
# APIA_CLAUDE_MODEL=claude-sonnet-4-6
# APIA_GROQ_MODEL=llama-3.3-70b-versatile
# APIA_DEFAULT_MEMORY_TURNS=10
# APIA_AUTO_MODE_PRIORITY=groq,claude,hf_api,local
`

class SettingsRepository {
  #settingsPath
  #dataDir
  #log
  #shouldForceAutoAiMode

  /**
   * `shouldForceAutoAiMode` is injected as a callback because the policy
   * signal (packaged backend exe present) lives in the discovery module,
   * and the settings aggregate should not depend on backend lifecycle.
   * Pass `() => false` from tests that don't care about packaged forcing.
   */
  constructor({ settingsPath, dataDir, log, shouldForceAutoAiMode }) {
    if (!settingsPath) throw new Error('SettingsRepository: settingsPath required')
    if (!dataDir) throw new Error('SettingsRepository: dataDir required')
    if (!log?.warn) throw new Error('SettingsRepository: log.warn required')
    if (typeof shouldForceAutoAiMode !== 'function') {
      throw new Error('SettingsRepository: shouldForceAutoAiMode must be a function')
    }
    this.#settingsPath = settingsPath
    this.#dataDir = dataDir
    this.#log = log
    this.#shouldForceAutoAiMode = shouldForceAutoAiMode
  }

  /**
   * Merge over defaults, coerce ranges, then schema-validate as the final
   * boundary. If the schema rejects (legacy normalize logic drifted), fall
   * back to defaults — never hand the renderer a malformed payload.
   */
  normalize(data = {}) {
    const settings = { ...SETTINGS_DEFAULTS, ...(data || {}) }

    if (!VALID_AI_MODES.has(settings.aiMode)) {
      settings.aiMode = SETTINGS_DEFAULTS.aiMode
    }

    if (this.#shouldForceAutoAiMode() && settings.aiMode === 'local') {
      settings.aiMode = 'auto'
    }

    settings.charScale = Number.isFinite(settings.charScale)
      ? Math.max(1, Math.min(500, settings.charScale))
      : SETTINGS_DEFAULTS.charScale
    settings.memoryTurns = Number.isFinite(settings.memoryTurns)
      ? Math.max(1, Math.min(50, settings.memoryTurns))
      : SETTINGS_DEFAULTS.memoryTurns
    settings.autoBehavior = settings.autoBehavior !== false
    settings.alwaysOnTop = settings.alwaysOnTop !== false
    settings.ttsEnabled = settings.ttsEnabled !== false
    settings.models = Array.isArray(settings.models) ? settings.models : []
    settings.voiceId = typeof settings.voiceId === 'string' && settings.voiceId ? settings.voiceId : null
    // Anchor: normalize through the policy module — non-finite, missing, or
    // malformed payloads degrade to `null`, which tells WindowManager to
    // fall back to the primary display.
    settings.windowAnchor = normalizeAnchor(settings.windowAnchor)

    const parsed = SettingsSchema.safeParse(settings)
    if (!parsed.success) {
      this.#log.warn('[SETTINGS_SCHEMA_FAIL]', parsed.error.issues)
      return { ...SETTINGS_DEFAULTS }
    }
    return parsed.data
  }

  load() {
    try {
      if (fs.existsSync(this.#settingsPath)) {
        return this.normalize(JSON.parse(fs.readFileSync(this.#settingsPath, 'utf-8')))
      }
    } catch (error) {
      this.#log.warn('[SETTINGS_LOAD_ERROR]', error)
    }
    return this.normalize()
  }

  // The backend-data directory is exposed so the renderer can ask Electron's
  // `shell.openPath` to reveal it (settings UI "Open backend.env folder"
  // button). The aggregate keeps the side effect at the boundary — it only
  // hands out the path; the IPC handler owns the shell call.
  getDataDir() {
    return this.#dataDir
  }

  save(data) {
    const normalized = this.normalize(data)
    fs.writeFileSync(this.#settingsPath, JSON.stringify(normalized, null, 2))
    return normalized
  }

  /**
   * Bootstrap user-facing config files in the backend data dir. Currently
   * only `backend.env.example` lives here — if more backend bootstrap files
   * appear, consider extracting to its own service per Codex review.
   */
  ensureRuntimeFiles() {
    try {
      fs.mkdirSync(this.#dataDir, { recursive: true })
      const examplePath = path.join(this.#dataDir, BACKEND_ENV_EXAMPLE_FILENAME)
      if (!fs.existsSync(examplePath)) {
        fs.writeFileSync(examplePath, BACKEND_ENV_EXAMPLE_CONTENT, 'utf-8')
      }
    } catch (error) {
      this.#log.warn('[BACKEND_RUNTIME_FILES_WARN]', error)
    }
  }
}

module.exports = {
  SettingsRepository,
  SETTINGS_DEFAULTS,
  VALID_AI_MODES,
  BACKEND_ENV_EXAMPLE_FILENAME,
  BACKEND_ENV_EXAMPLE_CONTENT
}
