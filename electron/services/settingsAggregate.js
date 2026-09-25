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

const { SettingsSchema, aiModeSchema, ttsEngineSchema } = require('../schemas')
const { normalizeAnchor } = require('./windowBoundsPolicy')

// schemas.js의 aiMode enum이 단일 출처 — 여기서 다시 나열하면 둘이 갈라진다.
const VALID_AI_MODES = new Set(aiModeSchema.options)

// 관전은 화면 이미지를 보내므로 **비전 가능한 provider만** 의미가 있다. 텍스트
// 전용(local/hf_api)을 고르면 백엔드 vision_model_for가 None을 돌려줘 관전이
// 영영 조용해진다 — 설정 창 드롭다운엔 애초에 안 보이지만, 손으로 고친
// settings.json에서 들어올 수 있으므로 읽는 경계에서 막는다.
// ollama_vlm은 관전에서만 유효한 로컬 비전 모드라 VALID_AI_MODES(대화·디렉터용
// enum)엔 없다 — 그래서 이 집합만 aiModeSchema.options의 부분집합이 아니다.
const VISION_AI_MODES = new Set(['auto', 'claude', 'groq', 'claude_code', 'ollama_vlm'])

// TTS 엔진 — schemas.js가 단일 출처. 모르는 값은 'default'(기존 체인)로 눕힌다.
const VALID_TTS_ENGINES = new Set(ttsEngineSchema.options)

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
  // opt-in TTS 엔진. 'default'가 기존 체인(edge→pyttsx3→silent) — 기본값을
  // 바꾸면 모든 사용자의 목소리가 바뀌므로 절대 'cosyvoice'로 두지 않는다.
  ttsEngine: 'default',
  // CosyVoice 참조 음성의 원본 파일명(표시 전용). wav 자체는
  // backend-data/cosyvoice/prompt.wav 규약 경로에 있다.
  cosyvoicePromptName: null,
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
  spectatePaused: false,
  // A-2 교재 검색 참조 — 현재 발화와 겹치는 교재 카드를 채팅 프롬프트에 참고로
  // 붙인다. 기본 ON: 교재가 없으면 검색이 0장을 돌려줘서 아무 일도 안 일어나고,
  // 쌓인 사용자는 "지난주에 말한 그거"가 통하는 쪽이 정상이다.
  coursewareReferenceEnabled: true,
  // A-3 야간 학습기가 쓸 파이썬. **백엔드 venv가 아니다** — 학습 스택(unsloth/trl)은
  // 검증 실험을 돌린 night-loop-lab venv에만 있고, 백엔드 venv에 또 깔면 torch가
  // 6.9GB 중복된다. 경로가 없으면 학습 기능 전체가 조용히 비활성.
  trainingPythonPath: 'C:\\Users\\ui2030\\Documents\\night-loop-lab\\.venv\\Scripts\\python.exe'
})

const BACKEND_ENV_EXAMPLE_FILENAME = 'backend.env.example'
const BACKEND_ENV_EXAMPLE_CONTENT = `# Apia packaged backend configuration
APIA_AI_MODE=auto
# APIA_GROQ_KEY=
# APIA_ANTHROPIC_KEY=
# APIA_HF_TOKEN=
# APIA_MODEL_ID=Qwen/Qwen3-4B-Instruct-2507
# APIA_CLAUDE_MODEL=claude-sonnet-4-6
# APIA_GROQ_MODEL=llama-3.3-70b-versatile
# APIA_DEFAULT_MEMORY_TURNS=10
# APIA_AUTO_MODE_PRIORITY=groq,claude,hf_api,local

# === claude_code 모드 (설치된 Claude Code CLI를 구독 로그인 그대로 사용) ===
# API 키가 필요 없는 대신 구독 사용량을 씁니다. auto는 이 모드를 절대 자동 선택하지
# 않으므로, 쓰려면 설정 창에서 직접 고르세요.
# APIA_CLAUDE_CODE_BIN=              # 비우면 PATH에서 claude를 찾음
# APIA_CLAUDE_CODE_MODEL=            # 비우면 CLI 기본 모델

# === ollama_vlm 모드 (관전 전용 — 로컬 Ollama로 화면을 봅니다) ===
# 화면 이미지가 PC 밖으로 나가지 않고 키도 필요 없습니다. 준비물:
#   1) Ollama 설치 후 실행 (https://ollama.com)
#   2) ollama pull qwen3-vl:4b-instruct
# 설정 창의 "관전 코멘트 모델"에서 직접 고르세요(auto는 이 모드를 고르지 않습니다).
# 첫 호출은 모델을 메모리에 올리느라 10초 이상 걸릴 수 있고, 그 tick은 조용히
# 건너뜁니다 — 두 번째 호출부터 빨라집니다.
# APIA_OLLAMA_BASE_URL=http://localhost:11434
# APIA_OLLAMA_VLM_MODEL=qwen3-vl:4b-instruct

# === CosyVoice TTS 엔진 (선택 — 로컬에서 캐릭터 목소리를 복제해 말합니다) ===
# 설정 창의 "TTS 엔진"에서 CosyVoice를 골라야 동작하고, 아래 경로가 하나라도
# 없으면 조용히 기본 목소리(edge)로 말합니다. 준비물:
#   1) CosyVoice 저장소 + Fun-CosyVoice3-0.5B 모델을 내려받은 폴더
#   2) 그 폴더용 파이썬 가상환경(torch/torchaudio 포함) — 백엔드 환경과 별개입니다
# 첫 요청은 모델을 GPU에 올리느라 20초 이상 걸리고(그 뒤로는 문장당 1~3초),
# 켜져 있는 동안 VRAM을 약 4.2GB 씁니다. 아무것도 말하지 않은 채
# APIA_COSYVOICE_IDLE_UNLOAD_MIN분이 지나면 자동으로 반납합니다.
# APIA_COSYVOICE_PYTHON=C:\\Users\\<사용자>\\Documents\\cosyvoice3-exp\\venv\\Scripts\\python.exe
# APIA_COSYVOICE_REPO=C:\\Users\\<사용자>\\Documents\\cosyvoice3-exp\\CosyVoice
# APIA_COSYVOICE_MODEL_DIR=pretrained_models/Fun-CosyVoice3-0.5B
# 참조 음성(캐릭터 목소리). 비우면 설정 창에서 올린 파일
# (backend-data/cosyvoice/prompt.wav)을 쓰고, 그것도 없으면 한국어 기본 참조를
# 한 번 자동 생성해 캐시합니다.
# **반드시 한국어 음성을 쓰세요.** 중국어 참조를 주면 중국어 발음이 섞여
# 한국어가 오염됩니다(실측: "뭐" → "모").
# APIA_COSYVOICE_PROMPT_WAV=
# APIA_COSYVOICE_IDLE_UNLOAD_MIN=30

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

    // 개발자 로컬 엔진 플래그는 프로세스 환경(APIA_DEV_LOCAL_ENGINES)이 단일
    // 출처다. get-settings 응답에만 얹혀 나가므로 저장 payload로 되돌아오면
    // 안 되고, 스키마가 passthrough라 안 지우면 디스크에 눌러앉는다. 읽기·쓰기
    // 양쪽이 normalize를 지나므로 여기 한 곳에서 지운다.
    delete settings.devLocalEnginesEnabled

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
    // 기본 ON — 구버전 settings.json(키 없음)도 켜진 채로 하이드레이트된다.
    settings.coursewareReferenceEnabled = settings.coursewareReferenceEnabled !== false
    settings.trainingPythonPath = typeof settings.trainingPythonPath === 'string'
      ? settings.trainingPythonPath
      : SETTINGS_DEFAULTS.trainingPythonPath
    // Phase F: default true means new installs land in wallpaper mode. A
    // pre-Phase-F settings.json (no key set) hydrates as true too — same
    // intent. Coerce non-boolean to true so a hand-edited "yes"/null
    // doesn't accidentally turn the mode off.
    settings.useWallpaperMode = settings.useWallpaperMode !== false
    settings.models = Array.isArray(settings.models) ? settings.models : []
    settings.voiceId = typeof settings.voiceId === 'string' && settings.voiceId ? settings.voiceId : null
    if (!VALID_TTS_ENGINES.has(settings.ttsEngine)) {
      settings.ttsEngine = SETTINGS_DEFAULTS.ttsEngine
    }
    settings.cosyvoicePromptName =
      typeof settings.cosyvoicePromptName === 'string' && settings.cosyvoicePromptName
        ? settings.cosyvoicePromptName.slice(0, 120)
        : null
    // Anchor: normalize through the policy module — non-finite, missing, or
    // malformed payloads degrade to `null`, which tells WindowManager to
    // fall back to the primary display.
    settings.windowAnchor = normalizeAnchor(settings.windowAnchor)

    const parsed = SettingsSchema.safeParse(settings)
    if (!parsed.success) {
      return this.#salvage(settings, parsed.error.issues)
    }
    return parsed.data
  }

  /**
   * 스키마가 문서를 통째로 거부했을 때, 필드 단위로 살릴 수 있는 건 살린다.
   *
   * 예전엔 defaults를 통째로 돌려줬다. load()는 쓰지 않으니 그 자체론 조용하지만,
   * 사용자가 설정을 한 번이라도 만지면 patch()가 `{...load(), ...partial}`을
   * 저장하면서 그 손실을 디스크에 확정시킨다 — 필드 하나가 깨졌다고 API 키·앵커·
   * 목소리까지 날아간다. 필드별로 다시 검증해서 통과하는 값은 그대로 둔다.
   */
  #salvage(settings, issues) {
    const salvaged = { ...SETTINGS_DEFAULTS }
    const dropped = []

    for (const [key, fieldSchema] of Object.entries(SettingsSchema.shape)) {
      if (!(key in settings)) continue
      if (fieldSchema.safeParse(settings[key]).success) salvaged[key] = settings[key]
      else dropped.push(key)
    }

    // passthrough로 들어온 미지의 키는 스키마가 검사하지 않으므로 그대로 보존한다.
    // 단 legacy 미러(activeModel/activeCharacter)는 위에서 이미 delete됐고, 여기서도
    // 되살아나면 안 된다 — settings 객체에 없으니 자연히 빠진다.
    for (const key of Object.keys(settings)) {
      if (key in SettingsSchema.shape) continue
      salvaged[key] = settings[key]
    }

    this.#log.warn('[SETTINGS_SCHEMA_FAIL]', { dropped, issues })
    return salvaged
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
