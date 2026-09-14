# Agent Working Set

Read-first map of the repo for agents picking up work. Lists every module that
is actually on a runtime path, what it owns, and how big it is — so you can tell
at a glance whether a file is a 40-line helper or a 2700-line aggregate.

> **All numbers measured 2026-09-15** (HEAD `7538bf1` + working-tree changes).
> Line counts and test counts drift fast. Re-measure before trusting them:
>
> ```powershell
> Get-ChildItem -Recurse electron,src -Filter *.js | Get-Content | Measure-Object -Line
> npm test                                            # vitest total
> backend\.venv\Scripts\python.exe -m pytest -q       # pytest total
> ```

---

## 1. Runtime safety and deployment (read before any change)

| File | Why |
|---|---|
| `REGRESSION_NOTES.md` | Regression history + prevention rules. Read before touching packaging, startup, settings, loaders. |
| `PROJECT_STATUS.md` | What has already shipped. Read before planning. |
| `ARCHITECTURE.md` | Layer boundaries and ownership. |
| `CLAUDE.md` | Repo-local agent instructions (verify gates, commit rules). |
| `RELEASE_SETUP.md` | Packaged deployment behavior + runtime config path. |
| `AGENT_CHANGES.md` | Running change log. |

## 2. Build and release pipeline

| File | Why |
|---|---|
| `package.json` | Scripts. `verify` = build → `verify-build.mjs` → `syntax-check.mjs` → vitest. |
| `vite.config.mjs` / `vitest.config.mjs` / `playwright.config.mjs` | Bundler + two test runners. |
| `electron-builder.yml` | Packaged layout, `asarUnpack`, `extraResources` (backend exe, `win-wallpaper.exe`). |
| `scripts/build-backend.mjs` | PyInstaller backend exe build + smoke. |
| `scripts/verify-build.mjs` | Asserts `dist/index.html`, `dist/settings.html`, `electron/main.js`, `electron/preload.js` exist. |
| `scripts/syntax-check.mjs` | `node --check` over **every** `electron/**/*.js` (glob, not a hardcoded list). Collects all failures. |
| `scripts/verify-release.mjs` / `verify-built-exe.mjs` / `smoke-release.mjs` | Artifact verification + packaged runtime smoke. |
| `scripts/run-release-builder.mjs`, `afterPack.cjs`, `rcedit.exe` | electron-builder driver + post-pack. |
| `scripts/win-wallpaper.cs` / `.exe` | Progman-child reparent helper (Win11 no-WorkerW path). |
| `scripts/gen-vmd.py`, `inspect-vmd.mjs`, `convert-mixamo.mjs`, `mixamo-to-vrma.py`, `motion-author-probe.py` | Motion authoring/ingest toolchain. |
| `scripts/voice-clone-e2e.py`, `voice-clone-smoke.py` | Voice-clone pipeline checks. |

## 3. Electron main process — 16 files, 6,079 lines

`electron/main.js` is **not** a thin orchestrator. At 1,954 lines it still owns
IPC registration, the behavior/spectate/presence tick loops, wallpaper
re-sync, hot-corner cursor polling, world load, and app event hooks. Extracted
services carry the rest.

| File | Lines | Owns |
|---|---:|---|
| `electron/main.js` | 1954 | App bootstrap, IPC surface, tick loops, wallpaper re-sync, hot corner, world load. Start here for startup/packaged issues. |
| `electron/services/backendLifecycle.js` | 688 | `BackendLifecycle` — live backend URL, child process, ensure-in-flight dedup, cooldown, health probe. All deps constructor-injected. |
| `electron/services/characterImportService.js` | 547 | Character import pipeline + generated metadata. |
| `electron/services/windowManager.js` | 481 | `WindowManager` — main + settings + startup-error window lifetime. `escapeHtml`, `renderStartupErrorHtml` exported pure. (The chat and hot-corner windows are still created inline in `main.js`.) |
| `electron/services/settingsAggregate.js` | 333 | `SettingsRepository` — `apia-settings.json` load/save/normalize, `ensureRuntimeFiles`. |
| `electron/services/registryService.js` | 316 | Character registry, envelope+repair reads, `activeCharacterId` rebinding. |
| `electron/services/backendEnvRepository.js` | 302 | `BackendEnvRepository` — dotenv-style `backend.env` read/write (API keys, provider config). Separate from settings on purpose. |
| `electron/services/wallpaperMode.js` | 296 | `createWallpaperMode(deps)` factory + default singleton. Native (`electron-as-wallpaper`) attach, Progman-child fallback, op serialization, health probe. |
| `electron/services/backendDiscovery.js` | 275 | Pure URL/port/launch-candidate helpers. `normalizeBackendHostname` strips IPv6 brackets. |
| `electron/schemas.js` | 270 | zod schemas + envelope variants + `parseCharacterEntries` / `parseWorldObjects` repair. |
| `electron/preload.js` | 168 | Renderer API surface (main window). |
| `electron/services/screenCapture.js` | 148 | Spectate capture — **window sources only**, never `'screen'`. Plus the save-gate. |
| `electron/ipc/registerCharacterIpc.js` | 131 | Character import / active-character IPC. Takes window refs as getters. |
| `electron/services/windowBoundsPolicy.js` | 118 | Pure "remember which monitor" policy — phantom-anchor rejection, work-area tie-break. |
| `electron/services/worldStore.js` | 39 | `apia-world.json` write boundary (validate before writeFileSync). |
| `electron/cornerPreload.js` | 13 | Hot-corner window preload. Minimal surface: open settings/chat + reveal subscription. |

## 4. Backend (FastAPI) — 8 routers, 12 services, 1 worker

Bootstrap: `backend/main.py` (172) wires the routers; `backend/ai_config.py`
(207) owns AI mode + env loading; `backend/schemas.py` (317) the request/response
contracts.

### Routers (`backend/routers/`, 958 lines)

| File | Lines | Prefix | Owns |
|---|---:|---|---|
| `chat.py` | 266 | `/chat` | Conversation + long-term memory + file search + web search/citations. |
| `store.py` | 217 | `/store` | Read-only surface over the shared SQLite store (memory + file chunks). |
| `warmup.py` | 166 | `/warmup` | Explicit provider warmup (providers init lazily). |
| `voice.py` | 165 | `/voices` | Voice list contract + voice-clone management. |
| `stt.py` | 47 | `/stt` | Whisper speech→text (lazy model load). |
| `spectate.py` | 36 | `/spectate` | Watch mode — one captured window → situation / focus point / interest. |
| `director.py` | 34 | `/director` | LLM behavior directive (compact context, separate from `/chat`). |
| `tts.py` | 26 | `/tts` | Text→speech; shares the `TTSService` instance with `voice.py`. |

### Services (`backend/services/`, 4,581 lines)

| File | Lines | Owns |
|---|---:|---|
| `claude_service.py` | 1380 | Provider selection (`claude` / `claude_code` / `groq` / `hf_api` / `local` / `ollama_vlm`), `auto` fallback, chat/stream/summarize/director/vision entry points. Blocking SDK calls run off the loop (`asyncio.to_thread`, or `_stream_sync_iter` for streams). |
| `file_index_service.py` | 737 | Indexed-folder allowlist, TXT/MD/PDF extraction, chunking, per-file atomic reindex, `retrieve_relevant`. Walk + file reads run in worker threads; warnings merge on the loop. |
| `memory_service.py` | 438 | Long-term chat memory (summaries + recall). |
| `cosyvoice_service.py` | 351 | Opt-in CosyVoice3 engine. Isolated from the default TTS chain; any failure falls back. |
| `tts_service.py` | 325 | Engine priority edge-tts → pyttsx3 → silent. |
| `web_search_service.py` | 287 | Search + citation assembly. |
| `store_service.py` | 268 | Singleton SQLite store, migrations, `execute_script` transactions. |
| `voice_clone_service.py` | 226 | Zero-shot timbre conversion (seed-vc wrapper). |
| `voice_manager.py` | 224 | Reference-voice upload/validation/storage. |
| `embedding_service.py` | 187 | Local-only sentence embeddings + `cosine_scores`. |
| `context_assembler.py` | 114 | Merges memory recalls + file recalls into `/chat` context blocks. |
| `whisper_service.py` | 43 | Whisper STT wrapper. |

### Other backend

- `backend/workers/cosyvoice_worker.py` (122) — runs in a **separate** venv; the backend never imports CosyVoice (torch/matcha conflict).
- `backend/store/migrations/001_initial.sql` (93), `002_file_chunks_unique.sql` (16).

## 5. Frontend renderer — 28 modules, 13,029 lines

`src/main.js` is 2,710 lines — the renderer's own aggregate (model load/clear,
world integration, per-frame loop, IPC bridge), not a shim.

| File | Lines | Owns |
|---|---:|---|
| `main.js` | 2710 | Renderer runtime, character load/clear, world integration, per-frame loop. |
| `sceneRuntime.js` | 1323 | Three.js boot recipe — renderer/scene/camera/lights/floor/clock + camera defaults. |
| `poseRig.js` | 1219 | Data-driven bone pose system. `buildBoneRegistry` → 59 roles incl. fingers/toes. Final authority over limbs. |
| `animationRuntime.js` | 868 | `playVRMAnimation` / `playMMDAnimation` + race-guard tokens. |
| `motionManager.js` | 842 | Personality-driven motion selection + behavior timing. |
| `characterController.js` | 780 | Idle / walk / sit / talk state, furniture collision footprints. |
| `chat.js` | 685 | Overlay chat surface, STT, TTS playback, talk-state transitions. |
| `world.js` | 561 | World objects, interaction, auto-behavior routing. |
| `modelRuntime.js` | 473 | Manifest fetch + lazy VRM/MMD runtime imports. |
| `chatRenderer.js` | 373 | Standalone chat **window** entry (`chat.html`) — the clickable surface in wallpaper mode. |
| `furnitureLayout.js` | 278 | Single source of truth for room furniture + `sitOffset` contract. |
| `expressionRuntime.js` | 276 | Emotion → PMX morph mapping + blink + autonomous micro-expressions. |
| `inertialization.js` | 250 | Clip-transition inertialization (GDC 2018 Bollo, simplified). |
| `lightingRig.js` | 237 | Time-of-day lighting rig. |
| `behaviorDirector.js` | 227 | LLM directive → mood/intent, consumed by the rule-based scheduler. |
| `lipsyncRuntime.js` | 222 | Offline WAV → viseme timeline → あ/い/う/え/お morphs. |
| `activityRunner.js` | 215 | Smart-object activity sequencer (walkTo → motion → bubble → sit chains). |
| `propManager.js` | 212 | Hand props (cup/glass/book) parented to wrist roles. |
| `postFx.js` | 208 | Outline → GTAO → bloom → vignette composer chain. |
| `needsManager.js` | 192 | Needs + personality utility AI (`NEED_KEYS`, `deriveNeedsTendency`). |
| `spectateDriver.js` | 151 | Watch-mode judgement — validates VLM JSON, decides whether to speak. Pure/injected. |
| `motionAssets.js` | 136 | VRMA + VMD + FBX manifests, name → clip descriptor, Mixamo retarget. |
| `adaptationStore.js` | 135 | Daily-rhythm learning → `timeOfDayEnergy`. |
| `chatShared.js` | 120 | Pure helpers shared by both chat surfaces (unit-testable, no `window.api`). |
| `presenceManager.js` | 102 | User-presence state machine from system idle seconds + lock/sleep events. |
| `stageRuntime.js` | 97 | Community stage (PMX/GLB room) import adapter. |
| `behaviorPlanner.js` | 69 | Autonomous behavior slot selection + post-walk dwell intent. |
| `touchInteraction.js` | 68 | Pure pointer-gesture classifier: tap / pet / grab. |

## 6. UI entry HTML — 4 files, 2,909 lines

| File | Lines | Notes |
|---|---:|---|
| `settings.html` | 2389 | Settings UI: import flow, AI mode, voice, backend.env, wallpaper toggle. Legacy mojibake still present — edit carefully. |
| `index.html` | 264 | Overlay DOM anchors, world layer, chat panel shell. |
| `chat.html` | 149 | Standalone chat window (wallpaper mode's input surface). |
| `corner.html` | 107 | Hot-corner reveal strip. |

## 7. Tests

| Suite | Count | How to run |
|---|---|---|
| vitest (node env) | **28 files / 536 tests** | `npm test` |
| pytest (backend) | **13 files / 188 tests** | `backend\.venv\Scripts\python.exe -m pytest -q` |
| Playwright e2e | 2 specs (`tests/gui/settings.spec.mjs`, `windowAnchor.spec.mjs`) | `npm run test:gui` — `globalSetup.mjs` rebuilds dist first |
| Standalone GUI harnesses | 39 in `tests/gui/` (38 use `launchApia`) | `node tests/gui/<name>.mjs` |
| Visual QA driver | `tests/gui/run-visual-qa.mjs` | `npm run qa:visual` (see `tests/gui/VISUAL_QA.md`) |

`tests/gui/helpers/launchApia.mjs` is the shared Electron launcher. It:
- asserts `dist/index.html` + `dist/settings.html` exist **and** that
  `dist/index.html` is newer than every `src/*.js` and root `*.html` — throwing
  **before** Electron starts, so no harness can validate a stale bundle;
- isolates `userData` into a tmp dir (`APIA_E2E_USER_DATA_DIR`);
- defaults `APIA_E2E_DISABLE_BACKEND`, `APIA_E2E_NO_SHELL_OPEN`,
  `APIA_E2E_NO_CURSOR_FEED`, `APIA_E2E_DISABLE_WALLPAPER` to `'1'` — all placed
  **before** `...extraEnv` so a harness can deliberately override any of them.

`tests/lighting-rig-unit.mjs` is a standalone (non-vitest) unit harness.

## 8. Read carefully, but not as runtime truth

- `SETUP.md` — useful architecture/setup notes, may lag the code.
- `README.md` / `README.txt` — entry pointers.
- `435t2.txt` — the user's own planning note. **Never edit or commit it.**

## 9. Safe default workflow

1. Read `REGRESSION_NOTES.md` and `PROJECT_STATUS.md`.
2. Read the exact runtime files for the area being changed (tables above).
3. Change code.
4. Run targeted verification (below), then the GUI harness that covers the area.
5. Kill leftover `electron` / `node` processes.
6. Update `REGRESSION_NOTES.md` if a new failure pattern was found.

## 10. Verification commands

```powershell
npm run build                                        # vite 6
npm run verify                                       # build + verify-build + syntax-check + vitest (536 tests)
backend\.venv\Scripts\python.exe -m pytest -q        # 188 tests — the venv, NOT anaconda
npm run test:gui                                     # playwright (2 specs, rebuilds dist)
node tests\gui\<name>-check.mjs                      # one standalone harness
npm run dist:dir                                     # electron-builder 26
npm run smoke:release                                # startup markers + /health, /voices, /warmup
```

`backend/pytest.ini` ties tests to `backend/tests/`. The backend runs from
`backend/.venv` (system-site-packages, inheriting anaconda's torch/transformers)
— if a system Python has fastapi pinned by another package, that venv is the
only supported runner:

```powershell
python -m venv backend/.venv
backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
backend\.venv\Scripts\python.exe -m pytest -q
```
