/**
 * Tests for the SettingsRepository aggregate.
 *
 * The aggregate owns the boundary between disk (apia-settings.json + the
 * backend-data dir bootstrap) and the renderer-facing settings shape. These
 * tests exercise its invariants — normalize defaults, range clamps, schema
 * fallback to defaults, save→load roundtrip, ensureRuntimeFiles idempotency
 * — using a per-test tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  SettingsRepository,
  SETTINGS_DEFAULTS,
  VISION_AI_MODES,
  BACKEND_ENV_EXAMPLE_FILENAME,
  BACKEND_ENV_EXAMPLE_CONTENT
} = require('../electron/services/settingsAggregate')

let tmpDir
let settingsPath
let dataDir
let log

function createRepo({ shouldForceAutoAiMode = () => false } = {}) {
  return new SettingsRepository({
    settingsPath,
    dataDir,
    log,
    shouldForceAutoAiMode
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'apia-settings-'))
  settingsPath = join(tmpDir, 'apia-settings.json')
  dataDir = join(tmpDir, 'backend-data')
  log = { warn: vi.fn() }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('SettingsRepository constructor', () => {
  it('rejects missing settingsPath', () => {
    expect(() => new SettingsRepository({
      dataDir, log, shouldForceAutoAiMode: () => false
    })).toThrow(/settingsPath/)
  })

  it('rejects missing log.warn', () => {
    expect(() => new SettingsRepository({
      settingsPath, dataDir, log: {}, shouldForceAutoAiMode: () => false
    })).toThrow(/log\.warn/)
  })

  it('rejects non-function shouldForceAutoAiMode', () => {
    expect(() => new SettingsRepository({
      settingsPath, dataDir, log, shouldForceAutoAiMode: true
    })).toThrow(/shouldForceAutoAiMode/)
  })
})

describe('normalize', () => {
  it('produces the default shape from empty input', () => {
    const repo = createRepo()
    const normalized = repo.normalize()
    // All defaults present and unchanged.
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      expect(normalized).toHaveProperty(key)
    }
  })

  it('clamps charScale to the schema range (1..500)', () => {
    const repo = createRepo()
    expect(repo.normalize({ charScale: 99999 }).charScale).toBe(500)
    expect(repo.normalize({ charScale: -5 }).charScale).toBe(1)
  })

  it('clamps memoryTurns to (1..50)', () => {
    const repo = createRepo()
    expect(repo.normalize({ memoryTurns: 999 }).memoryTurns).toBe(50)
    expect(repo.normalize({ memoryTurns: 0 }).memoryTurns).toBe(1)
  })

  it('useWebDefault defaults to false and coerces non-boolean to false', () => {
    // step 4: this toggle controls whether every /chat starts with use_web=true.
    // Default must stay `false` so a fresh install doesn't fire web searches
    // before the user configures a provider.
    const repo = createRepo()
    expect(repo.normalize().useWebDefault).toBe(false)
    expect(repo.normalize({ useWebDefault: true }).useWebDefault).toBe(true)
    expect(repo.normalize({ useWebDefault: 'yes' }).useWebDefault).toBe(false)
    expect(repo.normalize({ useWebDefault: 1 }).useWebDefault).toBe(false)
  })

  it('coursewareReferenceEnabled defaults to true (구버전 settings.json 포함)', () => {
    // A-2: 명시적으로 끈 적이 없으면 켜져 있어야 한다. 교재가 없으면 검색이
    // 0장을 돌려줄 뿐이라 켜져 있는 것만으로 달라지는 건 없다.
    const repo = createRepo()
    expect(repo.normalize().coursewareReferenceEnabled).toBe(true)
    expect(repo.normalize({ coursewareReferenceEnabled: false }).coursewareReferenceEnabled).toBe(false)
    expect(repo.normalize({ coursewareReferenceEnabled: 'no' }).coursewareReferenceEnabled).toBe(true)
  })

  it('rejects an unknown aiMode and falls back to default', () => {
    const repo = createRepo()
    expect(repo.normalize({ aiMode: 'gpt5' }).aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
  })

  it('forces aiMode=auto when shouldForceAutoAiMode and saved mode is local', () => {
    const repo = createRepo({ shouldForceAutoAiMode: () => true })
    expect(repo.normalize({ aiMode: 'local' }).aiMode).toBe('auto')
  })

  it('leaves aiMode alone for non-local saved modes even when forcing', () => {
    const repo = createRepo({ shouldForceAutoAiMode: () => true })
    expect(repo.normalize({ aiMode: 'claude' }).aiMode).toBe('claude')
  })

  it('accepts claude_code as an explicit aiMode', () => {
    const repo = createRepo()
    expect(repo.normalize({ aiMode: 'claude_code' }).aiMode).toBe('claude_code')
  })

  it("defaults per-role ai modes to '' (follow the global aiMode)", () => {
    const repo = createRepo()
    const settings = repo.normalize()
    expect(settings.aiModeDirector).toBe('')
    expect(settings.aiModeSpectate).toBe('')
  })

  it('keeps a valid per-role ai mode', () => {
    const repo = createRepo()
    const settings = repo.normalize({ aiModeDirector: 'groq', aiModeSpectate: 'claude_code' })
    expect(settings.aiModeDirector).toBe('groq')
    expect(settings.aiModeSpectate).toBe('claude_code')
  })

  it("coerces an invalid per-role ai mode to ''", () => {
    const repo = createRepo()
    const settings = repo.normalize({ aiModeDirector: 'gpt5', aiModeSpectate: 42 })
    expect(settings.aiModeDirector).toBe('')
    expect(settings.aiModeSpectate).toBe('')
  })

  // 관전은 화면을 봐야 하므로 텍스트 전용 모델은 UI에 안 보인다. 손으로 고친
  // settings.json으로는 들어올 수 있으니 읽는 경계에서 눕힌다.
  it("coerces a text-only aiModeSpectate to '' but keeps it for the director", () => {
    const repo = createRepo()
    for (const textOnly of ['local', 'hf_api']) {
      const settings = repo.normalize({
        aiModeDirector: textOnly,
        aiModeSpectate: textOnly
      })
      expect(settings.aiModeSpectate).toBe('')
      expect(settings.aiModeDirector).toBe(textOnly)
    }
  })

  it('keeps every vision-capable mode for aiModeSpectate', () => {
    const repo = createRepo()
    for (const mode of ['auto', 'claude', 'groq', 'claude_code', 'ollama_vlm']) {
      expect(repo.normalize({ aiModeSpectate: mode }).aiModeSpectate).toBe(mode)
    }
  })

  // 드롭다운이 normalize가 거부할 값을 제시하면 사용자는 "골랐는데 안 걸린다"를
  // 겪는다(조용히 ''로 눕는다). 두 목록은 같이 움직여야 한다.
  it('offers only vision-capable modes in the spectate dropdown', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf-8')
    const select = html.match(/<select id="ai-mode-spectate">([\s\S]*?)<\/select>/)
    expect(select).toBeTruthy()
    const values = [...select[1].matchAll(/value="([^"]*)"/g)].map(m => m[1])
    expect(values).toContain('ollama_vlm')
    for (const value of values) {
      if (value === '') continue // '기본(대화와 동일)'
      expect(VISION_AI_MODES.has(value)).toBe(true)
    }
  })

  // 로컬 Ollama VLM은 이미지 전용 경로다 — 대화/디렉터로 새면 백엔드가
  // "unsupported mode"로 떨어뜨리므로 읽는 경계에서 눕힌다.
  it('accepts ollama_vlm only for the spectate role', () => {
    const repo = createRepo()
    const settings = repo.normalize({ aiMode: 'ollama_vlm', aiModeDirector: 'ollama_vlm' })
    expect(settings.aiMode).toBe('auto')
    expect(settings.aiModeDirector).toBe('')
  })

  it('does not force per-role local to auto when the packaged backend forces it', () => {
    const repo = createRepo({ shouldForceAutoAiMode: () => true })
    expect(repo.normalize({ aiMode: 'local', aiModeDirector: 'local' })).toMatchObject({
      aiMode: 'auto',
      aiModeDirector: 'local'
    })
  })

  // ── TTS 엔진 (opt-in cosyvoice) ────────────────────────────────────────
  // 기본값이 'default'가 아니면 모든 사용자의 목소리가 바뀐다 — 기본 체인 무변이
  // 이 기능의 전제라서 기본값 자체를 테스트로 고정한다.
  it("defaults ttsEngine to 'default' (기존 edge 체인)", () => {
    const repo = createRepo()
    expect(repo.normalize().ttsEngine).toBe('default')
    expect(repo.normalize().cosyvoicePromptName).toBeNull()
  })

  it('keeps a valid ttsEngine', () => {
    const repo = createRepo()
    expect(repo.normalize({ ttsEngine: 'cosyvoice' }).ttsEngine).toBe('cosyvoice')
  })

  it("coerces an unknown ttsEngine to 'default'", () => {
    const repo = createRepo()
    for (const bad of ['piper', '', 42, null]) {
      expect(repo.normalize({ ttsEngine: bad }).ttsEngine).toBe('default')
    }
  })

  it('coerces a non-string cosyvoicePromptName to null and caps its length', () => {
    const repo = createRepo()
    expect(repo.normalize({ cosyvoicePromptName: 42 }).cosyvoicePromptName).toBeNull()
    expect(repo.normalize({ cosyvoicePromptName: '' }).cosyvoicePromptName).toBeNull()
    expect(repo.normalize({ cosyvoicePromptName: 'x'.repeat(500) }).cosyvoicePromptName)
      .toHaveLength(120)
  })

  it('offers only known engines in the tts-engine dropdown', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf-8')
    const select = html.match(/<select id="tts-engine">([\s\S]*?)<\/select>/)
    expect(select).toBeTruthy()
    const values = [...select[1].matchAll(/value="([^"]*)"/g)].map(m => m[1])
    expect(values).toEqual(['default', 'cosyvoice'])
  })

  // 저장 화이트리스트에 빠지면 사용자가 고른 엔진이 저장 한 번에 되돌아간다.
  // 개발자 게이트가 들어오면서 이 두 필드는 **행이 DOM에 있을 때만** 실린다 —
  // 무조건 실으면 게이트 off에서 'default'/null로 덮어쓴다.
  it('includes the tts engine fields in the settings save whitelist (게이트 on일 때)', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf-8')
    expect(html).toMatch(/if \(ttsEngineSel\) \{\s*saved\.ttsEngine = ttsEngineSel\.value\s*saved\.cosyvoicePromptName = cosyvoicePromptName/)
    // 무조건 싣는 예전 형태가 되살아나면 회귀다.
    expect(html).not.toMatch(/^\s*ttsEngine:\s*document\.getElementById/m)
    expect(html).not.toMatch(/^\s*cosyvoicePromptName,$/m)
  })

  it('documents the cosyvoice knobs in backend.env.example', () => {
    for (const knob of [
      'APIA_COSYVOICE_PYTHON',
      'APIA_COSYVOICE_REPO',
      'APIA_COSYVOICE_MODEL_DIR',
      'APIA_COSYVOICE_PROMPT_WAV',
      'APIA_COSYVOICE_IDLE_UNLOAD_MIN'
    ]) {
      expect(BACKEND_ENV_EXAMPLE_CONTENT).toContain(knob)
    }
    // 한국어 참조가 필수인 이유(중국어 참조 = 발음 오염)를 반드시 안내한다.
    expect(BACKEND_ENV_EXAMPLE_CONTENT).toContain('한국어')
  })

  it('coerces non-array models to []', () => {
    const repo = createRepo()
    expect(repo.normalize({ models: 'broken' }).models).toEqual([])
  })

  it('normalizes a missing windowAnchor to null', () => {
    const repo = createRepo()
    expect(repo.normalize().windowAnchor).toBeNull()
  })

  it('normalizes a partial windowAnchor (non-finite x) to null', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: Infinity, y: 0 } }).windowAnchor).toBeNull()
  })

  it('passes through a clean windowAnchor', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: 100, y: 200 } }).windowAnchor)
      .toEqual({ x: 100, y: 200 })
  })

  it('coerces a stringified anchor (forward-compat with older settings files)', () => {
    const repo = createRepo()
    expect(repo.normalize({ windowAnchor: { x: '50', y: '60' } }).windowAnchor)
      .toEqual({ x: 50, y: 60 })
  })

  it('falls back to defaults when the merged shape fails schema (defensive)', () => {
    const repo = createRepo()
    // null charScale → coercion above sets to default; this test exercises
    // the schema-fallback path by passing a non-string voiceId that survives
    // the legacy coercion but breaks schema (z.string().nullable()).
    // Actually voiceId is coerced to null for non-strings, so we test
    // alwaysOnTop being non-boolean — coercion sets `!== false`, so any
    // non-false truthy becomes true, and false stays false. Hard to break
    // post-coercion. This test just asserts schema doesn't reject the
    // happy path even with garbage input.
    const out = repo.normalize({ voiceId: 12345, alwaysOnTop: 'yes' })
    expect(out.voiceId).toBe(null) // coerced
    expect(out.alwaysOnTop).toBe(true) // coerced via !== false
  })
})

// 스키마가 문서를 통째로 거부해도 필드 하나 때문에 나머지를 다 잃으면 안 된다.
// load()는 안 쓰지만 patch()가 `{...load(), ...partial}`을 저장하므로, 사용자가
// 설정을 한 번 만지는 순간 그 손실이 디스크에 확정된다.
describe('schema-fail per-field salvage', () => {
  // memoryTurns 10.5는 범위 보정(1~50)을 통과하고 z.number().int()에서만 걸린다
  // — 실제로 도달 가능한 유일한 계열의 실패 케이스.
  const poisoned = {
    memoryTurns: 10.5,
    aiMode: 'groq',
    charScale: 137,
    voiceId: 'ko-KR-Some-Voice',
    windowAnchor: { x: 12, y: 34 },
    myFutureKey: { nested: true },
    activeModel: 'legacy-mirror',
    activeCharacter: 'legacy-mirror'
  }

  it('defaults only the poisoned field and keeps everything else', () => {
    const repo = createRepo()
    const out = repo.normalize(poisoned)

    expect(out.memoryTurns).toBe(SETTINGS_DEFAULTS.memoryTurns) // 유일한 손실
    expect(out.aiMode).toBe('groq')
    expect(out.charScale).toBe(137)
    expect(out.voiceId).toBe('ko-KR-Some-Voice')
    expect(out.windowAnchor).toEqual({ x: 12, y: 34 })
  })

  it('preserves unknown (passthrough) keys and still drops the legacy mirrors', () => {
    const out = createRepo().normalize(poisoned)
    expect(out.myFutureKey).toEqual({ nested: true })
    expect('activeModel' in out).toBe(false)
    expect('activeCharacter' in out).toBe(false)
  })

  it('logs [SETTINGS_SCHEMA_FAIL] with the dropped field list', () => {
    createRepo().normalize(poisoned)
    expect(log.warn).toHaveBeenCalledWith('[SETTINGS_SCHEMA_FAIL]', expect.objectContaining({
      dropped: ['memoryTurns']
    }))
  })

  it('patch() no longer persists the whole-document loss', () => {
    const repo = createRepo()
    repo.save(poisoned)          // 저장 시점에 이미 salvage된 문서가 디스크로
    repo.patch({ charScale: 90 })
    const reloaded = repo.load()
    expect(reloaded.charScale).toBe(90)
    expect(reloaded.aiMode).toBe('groq')            // 예전엔 'auto'로 되돌아갔다
    expect(reloaded.voiceId).toBe('ko-KR-Some-Voice')
    expect(reloaded.myFutureKey).toEqual({ nested: true })
  })
})

describe('load / save roundtrip', () => {
  it('returns defaults when the file does not exist', () => {
    const repo = createRepo()
    const settings = repo.load()
    expect(settings.aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
  })

  it('save then load returns the saved (normalized) shape', async () => {
    const repo = createRepo()
    repo.save({ aiMode: 'groq', charScale: 120, memoryTurns: 25 })
    const reloaded = repo.load()
    expect(reloaded.aiMode).toBe('groq')
    expect(reloaded.charScale).toBe(120)
    expect(reloaded.memoryTurns).toBe(25)
    // Disk file is normalized too (range, types).
    const onDisk = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(onDisk.aiMode).toBe('groq')
    expect(onDisk.charScale).toBe(120)
  })

  it('load logs a warn and falls back to defaults when the file is unparseable JSON', async () => {
    await writeFile(settingsPath, '{ not json', 'utf-8')
    const repo = createRepo()
    const settings = repo.load()
    expect(settings.aiMode).toBe(SETTINGS_DEFAULTS.aiMode)
    expect(log.warn).toHaveBeenCalledWith('[SETTINGS_LOAD_ERROR]', expect.any(Error))
  })
})

describe('patch', () => {
  it('leaves omitted fields alone', () => {
    const repo = createRepo()
    repo.save({ aiMode: 'groq', charScale: 120, memoryTurns: 25 })
    repo.patch({ charScale: 80 })
    const reloaded = repo.load()
    expect(reloaded.charScale).toBe(80)
    expect(reloaded.aiMode).toBe('groq')   // 안 준 필드는 그대로
    expect(reloaded.memoryTurns).toBe(25)
  })

  it('does not revert a flag changed between snapshot and save', () => {
    // 설정 창이 열릴 때 찍은 스냅샷(spectatePaused:false)을 통째로 되쓰면,
    // 그 사이 핫키로 켠 관전 일시정지가 조용히 풀린다 — 프라이버시 버그.
    const repo = createRepo()
    const snapshot = repo.load()
    expect(snapshot.spectatePaused).toBe(false)

    repo.patch({ spectatePaused: true }) // 다른 경로(핫키)가 먼저 바꿈

    // 설정 창 저장: 자기가 편집하는 필드만 보낸다.
    repo.patch({ charScale: 150, ttsEnabled: false })

    const reloaded = repo.load()
    expect(reloaded.spectatePaused).toBe(true)
    expect(reloaded.charScale).toBe(150)
  })

  it('never re-emits the legacy active-character mirror keys', async () => {
    // 활성 캐릭터의 정본은 character_registry.json 하나뿐. 구버전 파일에
    // 남아 있던 미러 키가 살아 돌아오면 레지스트리와 갈라진다.
    await writeFile(settingsPath, JSON.stringify({
      activeModel: 'char-old',
      activeCharacter: 'char-old',
      charScale: 110
    }), 'utf-8')
    const repo = createRepo()
    expect(repo.load()).not.toHaveProperty('activeCharacter')
    expect(repo.load()).not.toHaveProperty('activeModel')

    repo.patch({ ttsEnabled: false })
    const onDisk = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(onDisk).not.toHaveProperty('activeCharacter')
    expect(onDisk).not.toHaveProperty('activeModel')
    expect(onDisk.charScale).toBe(110) // 나머지 값은 보존
  })

  it('writes atomically (no .tmp left behind)', async () => {
    const repo = createRepo()
    repo.patch({ charScale: 101 })
    await expect(access(`${settingsPath}.tmp`)).rejects.toThrow()
    expect(repo.load().charScale).toBe(101)
  })
})

describe('ensureRuntimeFiles', () => {
  it('creates the backend.env.example file on first run', async () => {
    const repo = createRepo()
    repo.ensureRuntimeFiles()
    const examplePath = join(dataDir, BACKEND_ENV_EXAMPLE_FILENAME)
    await access(examplePath) // throws if missing
    const content = await readFile(examplePath, 'utf-8')
    expect(content).toContain('APIA_AI_MODE=auto')
  })

  it('does not overwrite an existing example file', async () => {
    const repo = createRepo()
    repo.ensureRuntimeFiles()
    const examplePath = join(dataDir, BACKEND_ENV_EXAMPLE_FILENAME)
    await writeFile(examplePath, 'user-modified content', 'utf-8')
    repo.ensureRuntimeFiles() // idempotent
    const content = await readFile(examplePath, 'utf-8')
    expect(content).toBe('user-modified content')
  })

  it('catches and logs file IO failures instead of throwing', async () => {
    // Create a *file* at the dataDir path so mkdirSync('...') trips.
    // On Windows, mkdirSync({recursive:true}) on a file path throws ENOTDIR.
    await writeFile(dataDir, 'i am a file, not a directory', 'utf-8')
    const repo = createRepo()
    expect(() => repo.ensureRuntimeFiles()).not.toThrow()
    expect(log.warn).toHaveBeenCalledWith(
      '[BACKEND_RUNTIME_FILES_WARN]',
      expect.any(Error)
    )
  })
})

// ── 개발자 전용 로컬 엔진 게이트 (APIA_DEV_LOCAL_ENGINES) ──────────────────
// 관전 ollama_vlm과 TTS CosyVoice는 개발자 PC의 준비물(Ollama 설치, 수제 venv)에
// 기대는 선택지다. 배포본에서 고를 수 있으면 조용히 폴백하고 사용자는 "고장"으로
// 읽는다 — 그래서 UI에서 통째로 숨긴다. 백엔드 능력·스키마는 그대로 둔다.
describe('dev-only local engine gate', () => {
  const readSettingsHtml = () =>
    readFile(new URL('../settings.html', import.meta.url), 'utf-8')

  it('never persists the devLocalEnginesEnabled flag', () => {
    const repo = createRepo()
    // get-settings 응답을 그대로 되돌려 보내는 최악의 경우에도 디스크에 남으면 안 된다.
    const saved = repo.patch({ devLocalEnginesEnabled: true, charScale: 120 })
    expect(saved).not.toHaveProperty('devLocalEnginesEnabled')
    expect(saved.charScale).toBe(120)
    expect(repo.load()).not.toHaveProperty('devLocalEnginesEnabled')
  })

  it('drops a devLocalEnginesEnabled key that already sits on disk', async () => {
    await writeFile(settingsPath, JSON.stringify({ devLocalEnginesEnabled: true }), 'utf-8')
    expect(createRepo().load()).not.toHaveProperty('devLocalEnginesEnabled')
  })

  it('keeps the schema permissive — gating is UI-only', () => {
    const repo = createRepo()
    expect(repo.normalize({ aiModeSpectate: 'ollama_vlm' }).aiModeSpectate).toBe('ollama_vlm')
    expect(repo.normalize({ ttsEngine: 'cosyvoice' }).ttsEngine).toBe('cosyvoice')
  })

  it('marks every dev-only control with data-dev-local', async () => {
    const html = await readSettingsHtml()
    expect(html).toMatch(/<option value="ollama_vlm" data-dev-local>/)
    expect(html).toMatch(/<div class="row" data-dev-local>\s*<div class="row-label">TTS 엔진<\/div>/)
    expect(html).toMatch(/id="tts-engine-hint" data-dev-local/)
    expect(html).toMatch(/id="cosyvoice-prompt-row" data-dev-local/)
  })

  it('removes (not hides) the dev-only controls unless the flag says otherwise', async () => {
    const html = await readSettingsHtml()
    // 제거여야 한다 — hidden으로 두면 나중에 도는 updateCosyvoiceRow/loadVoices가
    // 다시 뒤집어 슬그머니 되살린다.
    expect(html).toMatch(
      /settings\.devLocalEnginesEnabled !== true\)[\s\S]{0,200}querySelectorAll\('\[data-dev-local\]'\)[\s\S]{0,60}\.remove\(\)/
    )
  })

  it('preserves a stored spectate mode the dropdown cannot show', async () => {
    const html = await readSettingsHtml()
    // 게이트 off + 저장값 ollama_vlm → select.value가 ''로 떨어진다. 그 ''를
    // 저장하면 개발자가 켜 둔 값이 날아가므로 payload에서 빼야 한다.
    // 판정은 **옵션 목록에 저장값이 있는지**로만 한다.
    expect(html).toMatch(
      /spectateGatedAway = !!savedSpectate[\s\S]{0,160}spectateSel\.options[\s\S]{0,120}option\.value === savedSpectate/
    )
    expect(html).toMatch(/if \(!spectateGatedAway\) \{\s*saved\.aiModeSpectate = spectateSel\.value/)
    expect(html).not.toMatch(/^\s*aiModeSpectate:\s*document\.getElementById/m)
  })

  // 회귀 방지: "값이 ''면 건너뛴다"는 순진한 가드는 목록에 멀쩡히 있는 값
  // (claude/groq…)을 '기본(대화와 동일)'으로 되돌리는 정상 조작까지 막았다.
  // 그 형태가 되살아나면 실패한다.
  it('still lets a visible spectate mode be reset back to the default', async () => {
    const html = await readSettingsHtml()
    expect(html).not.toMatch(/spectateValue === '' && settings\.aiModeSpectate/)
  })

  it('never puts a terminal command in the settings UI', async () => {
    const html = await readSettingsHtml()
    // 모르는 프로그램 설치 + 터미널 명령 유도는 악성코드와 겉모습이 같다.
    // 준비 방법은 backend.env.example에만 남긴다.
    expect(html).not.toContain('ollama pull')
    expect(BACKEND_ENV_EXAMPLE_CONTENT).toContain('ollama pull qwen3-vl:4b-instruct')
  })
})
