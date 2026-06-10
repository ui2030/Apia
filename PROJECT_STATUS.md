# Project Status

Last updated: 2026-06-10

## Goal

Apia is a desktop AI character assistant:

- transparent Electron overlay on the desktop
- 3D character rendering with VRM and MMD support
- text chat, TTS, voice selection, emotion and motion reactions
- packaged backend for desktop release
- character behavior, world interaction, and future autonomous agent behavior

## What Has Been Updated

### 1. Desktop packaging and backend startup

- The packaged Electron app now includes a bundled backend executable.
- `npm run dist:dir` produces `release/win-unpacked/`.
- Packaged backend config is read from `%APPDATA%/apia/backend-data/backend.env`.
- `%APPDATA%/apia/backend-data/backend.env.example` is created automatically.
- Local packaged startup no longer assumes port `8000` is free.
- When the default port is occupied, the app probes another local port and logs the final backend URL.
- Remote backend URLs no longer trigger accidental local auto-spawn.

Key files:

- [electron/main.js](C:/Users/ui2030/Documents/Apia/electron/main.js)
- [backend/ai_config.py](C:/Users/ui2030/Documents/Apia/backend/ai_config.py)
- [backend/main.py](C:/Users/ui2030/Documents/Apia/backend/main.py)
- [scripts/build-backend.mjs](C:/Users/ui2030/Documents/Apia/scripts/build-backend.mjs)
- [scripts/verify-release.mjs](C:/Users/ui2030/Documents/Apia/scripts/verify-release.mjs)
- [scripts/smoke-release.mjs](C:/Users/ui2030/Documents/Apia/scripts/smoke-release.mjs)
- [electron-builder.yml](C:/Users/ui2030/Documents/Apia/electron-builder.yml)

### 2. Diagnostics and release verification

- Electron main-process startup now writes a runtime log.
- Packaged backend stdout and stderr are also copied into the same runtime log.
- Startup failure now has a fallback error window instead of silent failure.
- Release smoke testing now checks packaged launch behavior, not only build artifacts.
- Smoke testing clears `ELECTRON_RUN_AS_NODE` so packaged Electron does not produce false failures.
- Windows backend shutdown now kills the full process tree to avoid locked executables during the next build.

Key files:

- [electron/main.js](C:/Users/ui2030/Documents/Apia/electron/main.js)
- [scripts/smoke-release.mjs](C:/Users/ui2030/Documents/Apia/scripts/smoke-release.mjs)
- [REGRESSION_NOTES.md](C:/Users/ui2030/Documents/Apia/REGRESSION_NOTES.md)

### 3. Settings, AI mode, and runtime config

- Packaged releases default to `auto` AI mode instead of assuming local models.
- `backend.env` loading now supports BOM-stripped files from the runtime data directory.
- `claude_service` now logs the loaded env file path and handles `auto` selection more safely.
- Settings now align better with packaged behavior.

Key files:

- [backend/ai_config.py](C:/Users/ui2030/Documents/Apia/backend/ai_config.py)
- [backend/services/claude_service.py](C:/Users/ui2030/Documents/Apia/backend/services/claude_service.py)
- [settings.html](C:/Users/ui2030/Documents/Apia/settings.html)

### 4. Character import and runtime behavior

- Model folder picking was added so UI claims match real import behavior.
- PMD support and import validation were aligned.
- Voice list exposure was narrowed to supported synthesis voices.
- Character profile data is now actually consumed by runtime motion/behavior selection.
- World interaction now supports `chair`, `point`, and `decoration`.
- Auto behavior can trigger walking and sitting behavior.
- Talk state and sit state restoration bugs were fixed.
- TTS object URL cleanup was added to avoid media leaks.

Key files:

- [electron/services/characterImportService.js](C:/Users/ui2030/Documents/Apia/electron/services/characterImportService.js)
- [electron/ipc/registerCharacterIpc.js](C:/Users/ui2030/Documents/Apia/electron/ipc/registerCharacterIpc.js)
- [backend/routers/voice.py](C:/Users/ui2030/Documents/Apia/backend/routers/voice.py)
- [backend/services/tts_service.py](C:/Users/ui2030/Documents/Apia/backend/services/tts_service.py)
- [src/main.js](C:/Users/ui2030/Documents/Apia/src/main.js)
- [src/chat.js](C:/Users/ui2030/Documents/Apia/src/chat.js)
- [src/world.js](C:/Users/ui2030/Documents/Apia/src/world.js)
- [src/characterController.js](C:/Users/ui2030/Documents/Apia/src/characterController.js)
- [src/motionManager.js](C:/Users/ui2030/Documents/Apia/src/motionManager.js)

### 5. Frontend bundle quality

- `three/examples` was split away from the main runtime chunk.
- Largest frontend chunk dropped from about `781 kB` to about `544 kB`.
- Vite config was moved to `vite.config.mjs`, which removed the old CJS deprecation warning.
- Unused helper module `src/modelLoader.js` was removed; the renderer now uses promise-based VRM/MMD runtime loaders (`loadVRMRuntimeModel`, `loadMMDRuntimeModel`) that resolve only after the model is in the scene and ignore stale results via a per-load token.

Key files:

- [vite.config.mjs](C:/Users/ui2030/Documents/Apia/vite.config.mjs)
- [src/main.js](C:/Users/ui2030/Documents/Apia/src/main.js)

### 6. Backend AI provider lifecycle

- `ClaudeService` provider init is deferred to the first `/chat` call.
- A new `POST /warmup` endpoint kicks the deferred init in a background task so the first chat doesn't pay the full latency. `GET /warmup` reports `initialized_modes`, current `mode`, `warming` flag, and `last_error` (so a failed claude warmup is observable, not silently swallowed).
- The warmup task is tracked as a real `asyncio.Task` with a `done` callback that consumes the exception and clears stale failures on retry. The voice/stt primes run *after* the warmup lock releases — claude provider init and the auxiliary primes never contend on the same mutex.
- `TTSService`, `VoiceManager`, and `WhisperService` are all lazy with `asyncio.Lock` + `asyncio.to_thread`. The TTSService singleton is shared between `voice.py` and `tts.py` via `voice.get_tts()` — earlier versions had each router construct its own instance, which double-initialized pyttsx3 and split voice state between routes.
- Warmup primes voice + stt in parallel via `asyncio.gather(..., return_exceptions=True)`, so one optional service failing doesn't cancel the sibling or block the response. Both the background warmup path and the "already ready" fast-path go through the same prime helper.
- The renderer calls `POST /warmup` once after settings hydrate (`src/main.js`), via a new `window.api.warmup()` IPC channel.

Key files:

- [backend/routers/warmup.py](C:/Users/ui2030/Documents/Apia/backend/routers/warmup.py)
- [backend/routers/voice.py](C:/Users/ui2030/Documents/Apia/backend/routers/voice.py)
- [backend/routers/tts.py](C:/Users/ui2030/Documents/Apia/backend/routers/tts.py) (uses `voice.get_tts()`)
- [backend/routers/stt.py](C:/Users/ui2030/Documents/Apia/backend/routers/stt.py) (lazy WhisperService + `prime()`)
- [backend/services/claude_service.py](C:/Users/ui2030/Documents/Apia/backend/services/claude_service.py)
- [electron/main.js](C:/Users/ui2030/Documents/Apia/electron/main.js) (`warmup` IPC handler)
- [electron/preload.js](C:/Users/ui2030/Documents/Apia/electron/preload.js) (`window.api.warmup`)
- [src/main.js](C:/Users/ui2030/Documents/Apia/src/main.js) (renderer fires warmup after `scheduleAutoBehavior`)

### 7. Motion clip pipeline

- VRMA manifest + folders for `.vrma` clips (idle/talk/react/emote).
- VMD manifest + folders for `.vmd` clips, mirroring the VRMA motion-name keys one-to-one.
- `src/motionAssets.js` resolves either side: `resolveMotionAsset(name)` for VRM, `resolveMmdMotionAsset(name)` for MMD. Both return `null` if the manifest entry exists but no file is dropped, so the runtime degrades gracefully.
- `src/main.js` `playMotion(motion)` branches on `currentModel.type` and routes to either `playVRMAnimation` or `playMMDAnimation`. Same motion name produces the right clip per model type — drop a `.vmd` and the MMD path picks it up automatically; drop a `.vrma` and the VRM path does.
- `playMMDAnimation` uses `MMDLoader.loadAnimation` + `MMDAnimationHelper.add(mesh, { animation, physics: false })`. Non-loop actions set `LoopOnce` + `clampWhenFinished` on the helper's internal mixer; race-guarded the same way as `playVRMAnimation` (model captured at call entry, bail in callback if it changed).
- `_applyBlink` in the renderer now caches the dummy head reference instead of walking the scene graph each frame.
- `playVRMAnimation` for non-loop actions no longer snaps back to the A-pose: `clampWhenFinished = true` holds the last frame, a `'finished'` listener does a 0.35s `fadeOut`, and the procedural `updateVRMBody` layer takes over smoothly. Listeners are tracked per model and cleaned up on next action / on `clearModel`.

Key files:

- [src/assets/motions/manifest.json](C:/Users/ui2030/Documents/Apia/src/assets/motions/manifest.json)
- [src/assets/motions/vmd/manifest.json](C:/Users/ui2030/Documents/Apia/src/assets/motions/vmd/manifest.json)
- [src/motionAssets.js](C:/Users/ui2030/Documents/Apia/src/motionAssets.js)
- [src/characterController.js](C:/Users/ui2030/Documents/Apia/src/characterController.js)
- [src/main.js](C:/Users/ui2030/Documents/Apia/src/main.js) (`playMotion` routing, `playVRMAnimation` cross-fade, `playMMDAnimation`)

## Current Verification Baseline

These commands passed after the latest updates:

```powershell
npm run build              # vite 6
python -m compileall backend
npm run verify             # vite build + node --check + vitest run (178 tests)
npm run dist:dir           # electron-builder 26
npm run smoke:release      # startup markers + HTTP behavior probes
backend/.venv/Scripts/python.exe -m pytest backend  # 99 tests
```

Test totals (current):
- Frontend (vitest): 178 across 9 files — schemas, repairs, registryService, backendEnvRepository, windowBoundsPolicy, settingsAggregate, windowManager, backendDiscovery, backendLifecycle
- Backend (pytest): 99 across 8 files — test_contracts, test_warmup_domain, test_store_service, test_embedding_service, test_memory_service, test_file_index_service, test_context_assembler, test_web_search_service

## Current Known State

- Packaged app launch is working.
- Packaged backend launch is working.
- Runtime logs are written and currently show no `[ERROR]` entries in the latest smoke run.
- Frontend chunk warnings are now budgeted intentionally after measured optimization.

### 8. Schema-backed I/O + per-element repair

- `electron/schemas.js` (zod) and `backend/schemas.py` (pydantic) own the on-disk + HTTP contracts. Settings, world document, character registry on the JS side; chat/voices/warmup/tts/stt on the Python side.
- Read paths use *envelope schemas* (`CharacterRegistryEnvelopeSchema`, `WorldDocumentEnvelopeSchema`) so one bad child entry can be salvaged without dropping the whole file. `parseCharacterEntries` / `parseWorldObjects` exported from `electron/schemas.js`; registryService rebinds `activeCharacterId` when the original target was dropped.
- Numeric world-object fields use `.finite()`. Registry version is `z.literal(CURRENT_REGISTRY_VERSION)` so legacy v1 fails strict parsing (no v1 in the wild today; migration service is YAGNI).

### 9. Backend lifecycle + discovery as an aggregate

- `electron/services/backendLifecycle.js` — `BackendLifecycle` class owns URL state, child process handle, dedup-in-flight promise, cooldown clock, `isHealthy`/`ensureRunning`/`stop`. Constructor takes platform/env/spawn/spawnSync/http/https/discovery as injectable deps; covered by 31 unit tests.
- `electron/services/backendDiscovery.js` — pure helpers (URL parsing, port probing, launch-candidate selection). `normalizeBackendHostname` strips IPv6 brackets so `[::1]` is recognized as loopback in `isLocalBackendUrl`, `getBackendSpawnConfig`, and the `pickAvailableBackendUrl` probe host. 32 unit tests.
- `ensureRunning` dedup gate fired BEFORE `await pickAvailableUrl` so concurrent calls don't double-spawn when discovery is slow.

### 10. Settings + Window aggregates

- `electron/services/settingsAggregate.js` — `SettingsRepository` owns load/save/normalize against `apia-settings.json` + `backend-data/backend.env.example` bootstrap. `shouldForceAutoAiMode` injected as a callback (settings policy reads a backend-packaging signal without depending on the backend module). 17 unit tests.
- `electron/services/windowManager.js` — `WindowManager` owns the main + settings BrowserWindow lifetime, startup-error window fallback, and the settings-applied broadcast. `escapeHtml` + `renderStartupErrorHtml` exported as pure helpers for direct testing (15 tests; real BrowserWindow interactions stay covered by `smoke:release`).
- `registerCharacterIpc` now takes `mainWindowRef` / `settingsWindowRef` as getters so the windows can be recreated without leaving the IPC pinned to a null ref.

### 11. Renderer split (modelRuntime + animationRuntime + sceneRuntime)

- `src/modelRuntime.js` — lazy VRM/MMD runtime imports, manifest loaders. Caller-side `window.__textureMap` lifetime; manifest returns the full parsed object.
- `src/animationRuntime.js` — `playVRMAnimation` / `playMMDAnimation` with module-owned race-guard tokens. Stable `animationCtx` in main.js wires `getCurrentModel`.
- `src/sceneRuntime.js` — Three.js boot recipe (renderer/scene/camera/lights/floor/clock) factored out as `createSceneRuntime`. main.js calls it once at module load.
- `window.__textureMap` global removed — texture map threads explicitly through `loadMMDRuntimeModel`. Each MMD load builds a fresh `LoadingManager` to avoid `THREE.DefaultLoadingManager` aliasing.

### 12. Provider warmup as a domain aggregate

- `ClaudeService.resolve_auto_target()` returns the priority-ordered first prereq-satisfied mode (or null), used by the settings panel "Auto target" row.
- `_record_init_error(mode, error)` captures swallowed init failures inside `_init_*`; `get_last_init_error()` surfaces them through `WarmupStatusResponse.last_error` with `[init:<mode>]` provenance prefix. Router-level task error still wins when present and gets `[warmup]` prefix.
- Aggregate invariant `auto_target ∈ available_modes` asserted at the router boundary + locked by contract test.
- Settings panel auto-refreshes 2s after seeing `warming: true` so the user sees warming → ready without manual click.

### 13. Provider status UI + IPC contract

- `settings.html` Provider status panel: Active / Auto target (when default_mode='auto') / Available / Status (Ready / Warming / Idle / No provider / Backend unreachable) / Error / hint about credentials.
- `electron/preload.js` exposes `getWarmupStatus`; main.js IPC handler returns null on failure for clean unreachable rendering.

### 14. smoke-release behavior probes

- `scripts/smoke-release.mjs` now parses the backend URL from `[BACKEND_READY]` and runs `/health`, `/voices`, `/warmup` GET shape probes after startup-marker scrape. Catches PyInstaller bundle drift that source-Python tests can't see.

### 15. Shared data foundation (step 1 of long-term memory / file / web search)

- Migration runner: `backend/store/migrations/*.sql` applied lexicographically, each tracked in `schema_version`. `StoreService._apply_one_migration` wraps each migration body + version INSERT inside `BEGIN/COMMIT` so a half-failing migration rolls the DDL back (sqlite3 `executescript`'s implicit COMMIT otherwise leaves orphan tables).
- `001_initial.sql` creates `chat_turns` / `conversation_summaries` / `indexed_folders` / `file_chunks` / `citations`. Embeddings are raw `BLOB` (little-endian float32) — no sqlite-vec dependency to keep PyInstaller bundling sane. The retrieval helper does cosine in numpy/Python; we can swap retrieval without touching schema if scale changes.
- `StoreService`: single process-wide SQLite connection in WAL + `foreign_keys=ON`, `Row` factory, write serialization via `asyncio.Lock`, async wrappers (`fetchall/fetchone/execute/executemany`) all go through `asyncio.to_thread` so the event loop doesn't block on disk.
- `EmbeddingService`: lazy `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, ~480 MB, Korean-friendly). `status()` exposes `{loaded, loading, error, dim}` for the settings UI. `embed/embed_one` produce L2-normalized float32 BLOBs; `blob_to_vec` rejects misaligned bytes; `cosine_similarity` rejects dim mismatches (silent zip-truncation was the original Codex MUST-FIX).
- `/store/embedding/{status,warmup}` (200-with-error contract — a 5xx here would break the renderer's retry banner).
- FastAPI `lifespan` opens `DATA_DIR/apia.db`, applies migrations, hangs `app.state.store` + `app.state.embedding`; closes the store on shutdown.

Key files:

- [backend/store/migrations/001_initial.sql](backend/store/migrations/001_initial.sql)
- [backend/services/store_service.py](backend/services/store_service.py)
- [backend/services/embedding_service.py](backend/services/embedding_service.py)
- [backend/routers/store.py](backend/routers/store.py)
- [backend/schemas.py](backend/schemas.py) (HealthResponse, ChatRequest/Response, VoicesResponse, Warmup variants, TTSRequest, STTResponse, EmbeddingStatusResponse, MemoryStatsResponse, MemorySummarizeResponse)
- [backend/main.py](backend/main.py) (`lifespan` + DATA_DIR resolution)

### 16. Long-term memory (step 2)

- `MemoryService` (`backend/services/memory_service.py`) owns: `record_turn`, `record_chat_exchange` (user→assistant→summarize serialized in one coroutine — split create_tasks would race and break `conversation_summaries` contiguity), `retrieve_relevant` (summaries-first → raw turns fallback, recent N excluded, cosine ranking via `asyncio.to_thread`), `summarize_if_needed` (`asyncio.Lock`-gated, no-op when `summarize_fn=None`), `stats()`, `build_context_text()`.
- BLOB integrity is enforced at every boundary: INSERT-time `len(blob) == embedding.dim * 4` check (mismatched embed → NULL + `last_error`); retrieve-time per-row dim check (mismatch → skip + WARN, don't crash the rank loop); query-side dim check (saves N row warnings on a single corrupt query).
- `ClaudeService` gained `summarize(text, ai_mode=None)` — separate from `chat()` because chat's emotion-tag injection, fallback strings, and roleplay system prompt are all wrong for note-taking. `summarize` raises `RuntimeError` on `fallback` so MemoryService can capture it cleanly. Each provider has its own `_summarize_*` impl (Claude uses `system=` slot; Groq/HF/local use a system message at the head of `messages`).
- `chat()` also gained `memory_context: Optional[str]`. `_build_system_prompt` appends a "참고할 기억" section to `SYSTEM_PROMPT` — memory never lands in the `messages` array (Codex MUST-FIX: Anthropic API's `system=` slot is exclusive — a `role='system'` in `messages` breaks the request).
- `/chat` retrieve→context→reply→`asyncio.create_task(record_chat_exchange)`. The task is held in a module-level `_BACKGROUND_TASKS` set (Codex MUST-FIX round 2: bare `create_task` ref can be GC'd by the loop's weak-tracking) and discarded in the done callback.
- Provider gating at startup: `main.py` lifespan checks `resolve_auto_target()` + `list_available_modes()` and passes `summarize_fn=None` when neither is satisfied. The `last_error` distinguishes "no provider available" from a summarize call that actually ran and failed.
- `APIA_MEMORY_ENABLED=false` makes every public method a no-op (no DB writes, no embed calls) and `stats()` reports `enabled: false` so the settings UI can render "memory off" without guessing.
- `/store/memory/stats` + `/store/memory/summarize` — both 200 always. `summarize_id: null` means "nothing happened" (disabled / no provider / below threshold / call failed); `stats.last_error` carries the reason with `<stage>: <type>: <message>` prefix.
- Settings (`backend/ai_config.py`): `APIA_MEMORY_ENABLED` (default true), `_RETRIEVE_TOP_K` (5), `_MIN_SCORE` (0.55), `_SUMMARY_EVERY` (20), `_EXCLUDE_RECENT` (default = `DEFAULT_MEMORY_TURNS * 2` so retrieve doesn't echo turns the history already carries).
- Backend test totals: 37 → 50. Added `tests/test_memory_service.py` (10 cases — round-trip, dim mismatch, ranking, min_score, summary-priority, recent-exclusion, summarize threshold+idempotent, provider-disabled, ordering invariant, no-op when disabled) + 2 contract tests for `/store/memory/{stats,summarize}`.

Key files:

- [backend/services/memory_service.py](backend/services/memory_service.py)
- [backend/services/claude_service.py](backend/services/claude_service.py) (`_build_system_prompt`, `summarize`, `_summarize_*`)
- [backend/routers/chat.py](backend/routers/chat.py) (retrieve + background record task with strong-ref set)
- [backend/routers/store.py](backend/routers/store.py) (`/store/memory/stats`, `/store/memory/summarize`)
- [backend/main.py](backend/main.py) (lifespan provider-gating for `summarize_fn`)
- [backend/ai_config.py](backend/ai_config.py) (MEMORY_* env vars)
- [backend/tests/test_memory_service.py](backend/tests/test_memory_service.py)

### 17. File search (step 3)

- New migration `002_file_chunks_unique.sql` adds UNIQUE on `(source_path, source_kind, chunk_index)` so per-file reindex is a clean DELETE-by-path-then-INSERT.
- `StoreService.execute_script(statements)` — multi-statement transactions inside `_write_lock`, explicit `BEGIN/COMMIT/ROLLBACK`. Used by file reindex to make "purge old chunks + insert new" atomic.
- `FileIndexService` (`backend/services/file_index_service.py`) owns the allowlist (`indexed_folders`), text extraction (TXT/MD/PDF via lazy `pypdf`), char-based chunking, content_hash-keyed change detection, per-file atomic reindex, and `ingest_text` for drag-and-drop.
- Security invariants (all Codex MUST-FIX rounds 1-2): allowlist check uses `Path.resolve().is_relative_to()` not string prefix (defeats `..`, symlinks, `C:\a` matching `C:\a2`). `add_folder` rejects parent/child overlap with an existing entry. `remove_folder` cascade computes doomed chunk ids through `is_path_under()` per row instead of `LIKE prefix || '%'` (which prefix-bleeds). `retrieve_relevant` re-applies the allowlist at scan time so a stray row outside any registered folder cannot resurface in chat context.
- `ingest_text` always uses `source_path = "dropped:<label>:<uuid12>"` so two ingests with the same human label cannot collide on the new UNIQUE index. Label is for display, the suffix is the row's identity.
- `services/context_assembler.py`: `ContextItem(section, body, score)` + `assemble_context_blocks(items, max_total_chars)`. Trimming drops *items* in lowest-score-first order until the final-prompt char count (bodies + per-section overhead) fits the cap — never cuts mid-body or breaks section labels.
- `ClaudeService.chat(context_blocks: dict | None = None, memory_context: str | None = None)` — context_blocks dict generalized for "기억"/"파일"/"웹" sections in `_CONTEXT_SECTION_ORDER`. `memory_context` (step 2 signature) survives as a backwards-compatible alias via `_coerce_context_blocks`.
- `/store/files/*` router: `GET folders`, `POST folders` (200 with `status='rejected' + reason` for overlap/bad-dir), `DELETE folders`, `POST reindex` (400 when path isn't in allowlist — that's a UI bug not a soft skip), `POST ingest_text`, `GET stats`.
- Walk-time skips: `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`, `.next`, `.cache`, `.idea`, `.vscode`, plus any hidden dir / file.
- Backend test totals: 50 → 99 (this step adds the file-index suite, the context-assembler suite, the web suite, and several router contract probes). Frontend `npm run verify` passes 178/178.

Key files:

- [backend/store/migrations/002_file_chunks_unique.sql](backend/store/migrations/002_file_chunks_unique.sql)
- [backend/services/store_service.py](backend/services/store_service.py) (`execute_script`)
- [backend/services/file_index_service.py](backend/services/file_index_service.py)
- [backend/services/context_assembler.py](backend/services/context_assembler.py)
- [backend/services/claude_service.py](backend/services/claude_service.py) (`_build_system_prompt` dict + `_coerce_context_blocks`)
- [backend/routers/store.py](backend/routers/store.py) (`/store/files/*`)
- [backend/routers/chat.py](backend/routers/chat.py) (memory+files+web 병렬 retrieve, context cap)
- [backend/ai_config.py](backend/ai_config.py) (FILES_* + CONTEXT_MAX_CHARS)
- [backend/tests/test_file_index_service.py](backend/tests/test_file_index_service.py)
- [backend/tests/test_context_assembler.py](backend/tests/test_context_assembler.py)

### 18. Web search + citations (step 4)

- `WebSearchService` (`backend/services/web_search_service.py`) — provider dispatch (`none` / `tavily` / `brave` / direct callable `search_fn` for tests). External HTTP via `urllib` + `asyncio.to_thread` (no new `requests`/`httpx` runtime dep). Timeout is `APIA_WEB_TIMEOUT_SECONDS`.
- Marker parser: `[1]..[9999]` only, dedupes by first appearance, order preserved. Reject `[10000]+` to avoid date/array-index false positives.
- `record_citations(turn_id, markers, results)` writes one row per *valid* marker into `citations` (FK to `chat_turns.id`). Out-of-range markers (LLM hallucinates `[99]` when only 5 results exist) get silently skipped — same dedupe shape as the parser.
- `/chat` flow:
  - When `use_web=true` and the provider is configured, web search runs in parallel with memory/file retrieve.
  - Web results are formatted as `- [N] title \n snippet \n (url)` inside the "웹" section so the assistant sees the marker numbers it should cite.
  - When the reply contains markers + memory is enabled: user/assistant turns are recorded *synchronously* (citations need the assistant turn_id as FK), citations rows are written, and only `summarize_if_needed` runs in the background.
  - When the reply contains markers but memory is **disabled** (Codex MUST-FIX round 4): citations are returned in `ChatResponse.citations` as non-persistent in-memory entries so the renderer can still show source pop-overs.
  - When the reply has no markers: the existing step-2 background `record_chat_exchange` path is unchanged.
- `ChatResponse.citations: List[ChatCitation]` — always present (default `[]`); same `marker_number / source_kind / source_path / title / snippet / page` shape regardless of whether the source ends up being web (step 4), file (future), or memory (future).
- `/store/web/*` router: `GET stats`, `POST search` (single-shot from UI), `GET citations/{turn_id}`. Disabled state returns 200 + `enabled=false + last_error` (same convention as `/store/memory`, `/store/files`).
- Provider lock removed (Codex NICE-TO-HAVE round 4): the call site is stateless — there's no init resource to protect — so serializing concurrent searches just added latency.
- Test totals after step 4: backend 50 → 99 (file/context/web + contract probes + use_web happy-path round-trip).

Key files:

- [backend/services/web_search_service.py](backend/services/web_search_service.py)
- [backend/routers/chat.py](backend/routers/chat.py) (use_web parallel retrieve + sync citation persistence)
- [backend/routers/store.py](backend/routers/store.py) (`/store/web/*`)
- [backend/schemas.py](backend/schemas.py) (`ChatCitation`, `WebSearch*`, `TurnCitations*`, `ChatRequest.use_web`, `ChatResponse.citations`)
- [backend/ai_config.py](backend/ai_config.py) (`WEB_PROVIDER`, `WEB_API_KEY`, `WEB_MAX_RESULTS`, `WEB_TIMEOUT_SECONDS`)
- [backend/tests/test_web_search_service.py](backend/tests/test_web_search_service.py)

### 19. Dependency security pass

- vite 5 → 6, vitest 2 → 4, electron-builder 24 → 26 (audit fix of 17 → 1).
- electron 28 deferred — see REGRESSION_NOTES "Deferred: Electron 28 → 35+ security upgrade".
- `engines.node: ">=20"` added so future installs fail clearly on unsupported Node.

## Remaining Cleanup, Not Current Breakage

- PyInstaller still prints non-blocking packaging warnings from third-party libraries, but packaged release verification is passing. Deferred — sourced from libs we don't control; triage only if packaged size/startup matters again.
- Electron 28 → 35+ runtime upgrade is the only outstanding security advisory; deferred to its own pass with renderer smoke (see REGRESSION_NOTES).

> Three prior entries were retired after verification or completion:
> - `src/main.js` "legacy loader wrappers" — there are no delegating wrappers (only `loadVRMRuntimeModel` / `loadMMDRuntimeModel`).
> - `settings.html` "legacy mojibake" — file is clean UTF-8 (524 valid hangul, zero replacement characters). See REGRESSION_NOTES.md "Distinguish shell mojibake from real file corruption" for the established prevention rule.
> - "MMD `.vmd` runtime pickup" — wired in the 2026-05-29 pass: `resolveMmdMotionAsset` + `playMMDAnimation` + `playMotion` routing on `currentModel.type`. Drop a `.vmd` matching a manifest entry and it plays without code changes.

## Source of Truth

When there is a mismatch between older notes and runtime code, trust these in order:

1. runtime code under `electron/`, `backend/`, `src/`
2. release scripts under `scripts/`
3. [REGRESSION_NOTES.md](C:/Users/ui2030/Documents/Apia/REGRESSION_NOTES.md)
4. [RELEASE_SETUP.md](C:/Users/ui2030/Documents/Apia/RELEASE_SETUP.md)
5. planning/reference docs such as `435t2.txt` and older setup notes
