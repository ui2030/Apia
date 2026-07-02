# Agent Working Set

This file lists the files that should be read first before making more changes.
It is meant to reduce context loss and keep future work aligned with the current runtime path.

## Read First

### 1. Runtime safety and deployment

- [REGRESSION_NOTES.md](C:/Users/ui2030/Documents/Apia/REGRESSION_NOTES.md)
  - Regression history and prevention rules.
  - Read before changing packaging, runtime startup, settings, or loaders.

- [PROJECT_STATUS.md](C:/Users/ui2030/Documents/Apia/PROJECT_STATUS.md)
  - High-level status of what has already changed.
  - Read before planning new work.

- [RELEASE_SETUP.md](C:/Users/ui2030/Documents/Apia/RELEASE_SETUP.md)
  - Packaged deployment behavior and runtime config path.
  - Read before release or backend configuration changes.

### 2. Build and release pipeline

- [package.json](C:/Users/ui2030/Documents/Apia/package.json)
  - Commands and release entry points.

- [vite.config.mjs](C:/Users/ui2030/Documents/Apia/vite.config.mjs)
  - Frontend chunking and build budget.

- [electron-builder.yml](C:/Users/ui2030/Documents/Apia/electron-builder.yml)
  - Packaged app layout and backend resource wiring.

- [scripts/build-backend.mjs](C:/Users/ui2030/Documents/Apia/scripts/build-backend.mjs)
  - Backend exe build and smoke test.

- [scripts/verify-release.mjs](C:/Users/ui2030/Documents/Apia/scripts/verify-release.mjs)
  - Artifact verification.

- [scripts/smoke-release.mjs](C:/Users/ui2030/Documents/Apia/scripts/smoke-release.mjs)
  - Packaged runtime smoke test.

### 3. Electron runtime

- [electron/main.js](C:/Users/ui2030/Documents/Apia/electron/main.js)
  - Thin orchestrator now (~420 lines). Wires together backend / settings / windows aggregates + IPC handlers + app event hooks.
  - First file to inspect for startup/packaged issues, but most of the actual logic lives in the services below.

- [electron/services/backendLifecycle.js](C:/Users/ui2030/Documents/Apia/electron/services/backendLifecycle.js)
  - `BackendLifecycle` class — owns backend URL state, child process, ensure-in-flight dedup, cooldown, health probe. Deps injected at constructor (platform/env/spawn/spawnSync/http/https/discovery).

- [electron/services/backendDiscovery.js](C:/Users/ui2030/Documents/Apia/electron/services/backendDiscovery.js)
  - Pure URL/port/launch-candidate helpers. `normalizeBackendHostname` strips IPv6 brackets.

- [electron/services/settingsAggregate.js](C:/Users/ui2030/Documents/Apia/electron/services/settingsAggregate.js)
  - `SettingsRepository` — load/save/normalize for `apia-settings.json`, `ensureRuntimeFiles` for `backend.env.example`. `shouldForceAutoAiMode` injected as callback.

- [electron/services/windowManager.js](C:/Users/ui2030/Documents/Apia/electron/services/windowManager.js)
  - `WindowManager` — main + settings + startup-error BrowserWindow lifetime. `escapeHtml` + `renderStartupErrorHtml` exported as pure helpers.

- [electron/schemas.js](C:/Users/ui2030/Documents/Apia/electron/schemas.js)
  - zod schemas + envelope variants + `parseCharacterEntries` / `parseWorldObjects` repair helpers.

- [electron/preload.js](C:/Users/ui2030/Documents/Apia/electron/preload.js)
  - Renderer API surface exposed to the browser context.

- [electron/ipc/registerCharacterIpc.js](C:/Users/ui2030/Documents/Apia/electron/ipc/registerCharacterIpc.js)
  - Character import, active-character, and related IPC. Takes `mainWindowRef` / `settingsWindowRef` as getters.

- [electron/services/characterImportService.js](C:/Users/ui2030/Documents/Apia/electron/services/characterImportService.js)
  - Import pipeline and generated character metadata.

- [electron/services/registryService.js](C:/Users/ui2030/Documents/Apia/electron/services/registryService.js)
  - Character registry with envelope+repair reads, activeCharacterId rebinding.

### 4. Backend runtime

- [backend/ai_config.py](C:/Users/ui2030/Documents/Apia/backend/ai_config.py)
  - AI mode, env loading, runtime defaults.

- [backend/main.py](C:/Users/ui2030/Documents/Apia/backend/main.py)
  - Backend app bootstrap for exe and source runs.

- [backend/services/claude_service.py](C:/Users/ui2030/Documents/Apia/backend/services/claude_service.py)
  - Provider selection, `auto` mode, memory handling.

- [backend/services/tts_service.py](C:/Users/ui2030/Documents/Apia/backend/services/tts_service.py)
  - TTS runtime behavior.

- [backend/routers/voice.py](C:/Users/ui2030/Documents/Apia/backend/routers/voice.py)
  - Exposed voice list contract.

- [backend/routers/chat.py](C:/Users/ui2030/Documents/Apia/backend/routers/chat.py)
  - Chat request shape and backend route behavior.

### 5. Frontend runtime

- [src/main.js](C:/Users/ui2030/Documents/Apia/src/main.js)
  - Renderer runtime + character load/clear flow + world integration + per-frame loop. ~890 lines (down from 1190).

- [src/sceneRuntime.js](C:/Users/ui2030/Documents/Apia/src/sceneRuntime.js)
  - `createSceneRuntime({canvasEl})` — Three.js boot recipe (renderer/scene/camera/lights/floor/clock).

- [src/modelRuntime.js](C:/Users/ui2030/Documents/Apia/src/modelRuntime.js)
  - Lazy VRM/MMD runtime imports, manifest loaders. `getVRMUtils`/`getMmdHelper` getters for caller-side teardown.

- [src/animationRuntime.js](C:/Users/ui2030/Documents/Apia/src/animationRuntime.js)
  - `playVRMAnimation` / `playMMDAnimation` with module-owned race-guard tokens. Takes `ctx` for live `currentModel` access.

- [src/chat.js](C:/Users/ui2030/Documents/Apia/src/chat.js)
  - Chat flow, TTS playback, voice usage, talk-state transitions.

- [src/world.js](C:/Users/ui2030/Documents/Apia/src/world.js)
  - World objects, interaction, auto behavior routing.

- [src/characterController.js](C:/Users/ui2030/Documents/Apia/src/characterController.js)
  - Idle, walk, sit, talk state logic.

- [src/motionManager.js](C:/Users/ui2030/Documents/Apia/src/motionManager.js)
  - Personality-driven motion selection and behavior timing.

### 6. UI files

- [index.html](C:/Users/ui2030/Documents/Apia/index.html)
  - Overlay DOM anchors, world layer, chat panel shell.

- [settings.html](C:/Users/ui2030/Documents/Apia/settings.html)
  - Settings UI, import flow, AI mode selection, voice selection.
  - Handle carefully because legacy mojibake is still present.

## Read Carefully, But Not as Runtime Truth

- [SETUP.md](C:/Users/ui2030/Documents/Apia/SETUP.md)
  - Useful architectural/setup notes, but may lag runtime code.

- [435t2.txt](C:/Users/ui2030/Documents/Apia/435t2.txt)
  - Planning/reference structure note, not runtime source of truth.

- [README.md](C:/Users/ui2030/Documents/Apia/README.md)
  - Entry pointer only.

## Safe Default Workflow

Before changing code:

1. Read [REGRESSION_NOTES.md](C:/Users/ui2030/Documents/Apia/REGRESSION_NOTES.md)
2. Read [PROJECT_STATUS.md](C:/Users/ui2030/Documents/Apia/PROJECT_STATUS.md)
3. Read the exact runtime files for the area being changed
4. Run targeted verification
5. Update `REGRESSION_NOTES.md` if a new failure pattern was discovered

## Verification Commands

```powershell
npm run build                                       # vite 6
python -m compileall backend
npm run verify                                      # build + node --check + vitest run (122 tests)
backend/.venv/Scripts/python.exe -m pytest backend  # 17 contract+domain tests
npm run dist:dir                                    # electron-builder 26
npm run smoke:release                               # startup markers + /health, /voices, /warmup probes
```

`backend/pytest.ini` ties tests to `backend/tests/`. If your system Python has
fastapi pinned by another package (e.g. anaconda + pynecone), use a venv:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
backend/.venv/Scripts/python.exe -m pytest backend
```
