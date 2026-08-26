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

const { SettingsSchema, aiModeSchema } = require('../schemas')
const { normalizeAnchor } = require('./windowBoundsPolicy')

// schemas.js의 aiMode enum이 단일 출처 — 여기서 다시 나열하면 둘이 갈라진다.
const VALID_AI_MODES = new Set(aiModeSchema.options)

// 관전은 화면 이미지를 보내므로 **비전 가능한 provider만** 의미가 있다. 텍스트
// 전용(local/hf_api)을 고르면 백엔드 vision_model_for가 None을 돌려줘 관전이
// 영영 조용해진다 — 설정 창 드롭다운엔 애초에 안 보이지만, 손으로 고친
// settings.json에서 들어올 수 있으므로 읽는 경계에서 막는다.
const VISION_AI_MODES = new Set(['auto', 'claude', 'groq', 'claude_code'])

// 역할별 모델 필드('' = 대화와 동일)와 각각이 허용하는 값의 집합.
const ROLE_AI_MODES = Object.freeze({
  aiModeDirector: VALID_AI_MODES,
  aiModeSpectate: VISION_AI_MODES
})

const SETTINGS_DEFAULTS = Object.freeze({
  models: [],
  alwaysOnTop: true,
  charScale: 100,
  autoBehavior: true,
  aiMode: 'auto',
  // 역할별 모델 라우팅. ''(기본) = 대화와 같은 모델을 쓴다. 디렉터/관전은 백그라운드로
  // 자주 도는 호출이라, 대화는 비싼 모델로 쓰면서 이 둘만 싼 모델로 내리고 싶은
  // 경우가 있다(반대도 마찬가지).
  aiModeDirector: '',
  aiModeSpectate: '',
  memoryTurns: 10,
  ttsEnabled: true,
  voiceId: null,
  windowAnchor: null,
  // Step 4: if true, every /chat request defaults to use_web=true so the
  // assistant tries a web search before answering. Per-message override
  // can still be added at the renderer layer later. Default false because
  // a user without a configured provider should not see "we searched but
  // got nothing" on every reply.
  useWebDefault: false,
  // Phase F: when true, the main overlay attaches itself as a Windows
  // wallpaper layer (behind desktop icons). Default true on the assumption
  // that anyone who installs Apia wants the "lives in your desktop"
  // experience; if `wallpaperMode.isAvailable()` returns false at boot
  // (non-Windows, native load failure), Electron silently falls back to
  // the old transparent-overlay path.
  useWallpaperMode: true,
  // M2 관전 모드 — 일시정지 상태만 디스크에 남긴다. 핫키로 멈춘 관전은 재시작
  // 후에도 멈춘 채로 있어야 한다(사용자가 명시적으로 재개하기 전엔 화면을 안 본다).
  // 캡처 대상 창 id는 **일부러 저장하지 않는다**: 창 id는 재시작 후 다른 창을
  // 가리킬 수 있어서, 복원했다가 엉뚱한 창을 찍는 것보다 매번 고르게 하는 편이
  // 프라이버시에 안전하다(Codex 사전검토).
  spectatePaused: false
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

# === claude_code 모드 (설치된 Claude Code CLI를 구독 로그인 그대로 사용) ===
# API 키가 필요 없는 대신 구독 사용량을 씁니다. auto는 이 모드를 절대 자동 선택하지
# 않으므로, 쓰려면 설정 창에서 직접 고르세요.
# APIA_CLAUDE_CODE_BIN=              # 비우면 PATH에서 claude를 찾음
# APIA_CLAUDE_CODE_MODEL=            # 비우면 CLI 기본 모델

# === step 2-4 (장기 기억 / 파일 검색 / 웹 검색) ===
# APIA_MEMORY_ENABLED=true
# APIA_FILES_ENABLED=true
# APIA_WEB_PROVIDER=none           # none | tavily | brave
# APIA_WEB_API_KEY=                # provider 키
# APIA_WEB_TIMEOUT_SECONDS=10
# APIA_FILES_CHUNK_CHARS=1000
# APIA_FILES_CHUNK_OVERLAP=200
# APIA_FILES_MAX_FILE_BYTES=5242880
# APIA_CONTEXT_MAX_CHARS=6000
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

    // 활성 캐릭터의 정본은 character_registry.json 하나뿐이다. 구버전
    // settings.json에 남아 있는 미러 키는 읽는 즉시 버린다 — 스키마가
    // passthrough라 안 버리면 저장할 때마다 되살아나 레지스트리와 갈라진다.
    delete settings.activeModel
    delete settings.activeCharacter

    if (!VALID_AI_MODES.has(settings.aiMode)) {
      settings.aiMode = SETTINGS_DEFAULTS.aiMode
    }

    if (this.#shouldForceAutoAiMode() && settings.aiMode === 'local') {
      settings.aiMode = 'auto'
    }

    // 역할별 모델은 ''(전역 추종)이 기본이자 안전한 폴백 — 모르는 값이 오면
    // 조용히 ''로 눕혀서 대화 모델을 따라가게 한다. shouldForceAutoAiMode의
    // local→auto 강제는 전역 aiMode 전용이라 여기엔 적용하지 않는다.
    for (const [key, allowed] of Object.entries(ROLE_AI_MODES)) {
      if (settings[key] !== '' && !allowed.has(settings[key])) {
        settings[key] = ''
      }
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
    settings.useWebDefault = settings.useWebDefault === true
    // Phase F: default true means new installs land in wallpaper mode. A
    // pre-Phase-F settings.json (no key set) hydrates as true too — same
    // intent. Coerce non-boolean to true so a hand-edited "yes"/null
    // doesn't accidentally turn the mode off.
    settings.useWallpaperMode = settings.useWallpaperMode !== false
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

  // 문서 통째 쓰기. 부트스트랩/기본값 복구용 — 사용자 조작 경로는 patch()를
  // 쓴다(스냅샷 되돌림 방지).
  save(data) {
    return this.#write(data)
  }

  /**
   * 부분 갱신. 디스크에서 다시 읽어 **호출자가 준 필드만** 얹는다.
   * 설정 창처럼 열릴 때 찍은 스냅샷을 통째로 되쓰는 writer가 있으면, 그
   * 사이 다른 경로에서 바뀐 값(관전 일시정지 등)이 조용히 되돌아간다.
   */
  patch(partial) {
    return this.#write({ ...this.load(), ...(partial || {}) })
  }

  // tmp → rename 원자적 쓰기. 저장 도중 크래시/전원차단이 나도 반쪽 JSON이
  // 대상 경로에 노출되지 않는다(registryService.atomicWriteJson과 같은 패턴).
  #write(data) {
    const normalized = this.normalize(data)
    const tmpPath = `${this.#settingsPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.#settingsPath)
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
  VISION_AI_MODES,
  BACKEND_ENV_EXAMPLE_FILENAME,
  BACKEND_ENV_EXAMPLE_CONTENT
}
