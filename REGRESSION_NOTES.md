# Regression Notes

## 2026-04-18

### TTS voice list must only expose supported voices
- Symptom: custom-trained voices appeared in the settings selector, but `/tts` only understood system voices.
- Cause: `/voices` mixed discovery data with actual synthesis capability.
- Prevention: keep `voices` limited to synth-supported options. Expose unsupported items separately if the UI needs them later.

### UI timers must be cleaned up on every exit path
- Symptom: the import loading step animation could keep running after an import failure.
- Cause: `setInterval` was cleared only on the success path.
- Prevention: declare timer handles outside `try` blocks and always clear them in `finally`.

### Backend capability changes must update UI allowlists too
- Symptom: backend import supported `PMD`, but the settings UI still rejected it.
- Cause: extension support changed in the service layer without matching updates to the file input and frontend validation.
- Prevention: when adding a supported source type, update all three together:
  1. backend import logic
  2. file input `accept`
  3. frontend validation/error copy

### Legacy mojibake files should avoid new localized literals
- Symptom: a newly inserted default voice label rendered as broken text in `settings.html`.
- Cause: the file already contained encoding-corrupted text, so adding more localized literals made the result fragile.
- Prevention: prefer ASCII for new labels in legacy mojibake files until the file encoding is normalized end-to-end.

### Renderer and world manager contracts must stay aligned
- Symptom: world labels were wired to a missing DOM target and the animation loop called the old `updateWorldLabels` shape.
- Cause: the world UI implementation changed, but `index.html`, `main.js`, and `world.js` were not updated together.
- Prevention: when changing overlay/world rendering, verify all three together:
  1. DOM anchor ids/classes
  2. render-loop call signatures
  3. interaction callbacks such as `onWalkTo`

### Temporary TTS object URLs must be revoked
- Symptom: repeated TTS playback could keep accumulating Blob-backed audio URLs in memory.
- Cause: `URL.createObjectURL(...)` was used for generated audio, but no cleanup ran on end/error/play failure.
- Prevention: every temporary media URL needs one cleanup path that runs on:
  1. playback ended
  2. playback error
  3. `audio.play()` rejection

### Character posture state should not depend on one-shot move config
- Symptom: sit offsets and seat-facing rotation disappeared right after arriving at a chair.
- Cause: the movement config was cleared after arrival even though the active sit state still needed that data every frame.
- Prevention: separate transient navigation data from persistent posture data such as active sit pose.

### Timed posture exits should survive temporary state overrides
- Symptom: a sit timer could expire while the character was temporarily in `talk`, causing the character to stay seated forever afterward.
- Cause: timeout cleanup depended on the current state still being `sit` at the exact callback moment.
- Prevention: use deadline-based checks for posture expiry so temporary states can restore correctly without losing the exit condition.

### UI support claims must match the real picker path
- Symptom: the settings window said model folders were supported, but the click path only opened a file picker.
- Cause: backend support existed, yet the renderer never exposed a directory-capable picker.
- Prevention: whenever the UI advertises a source type, verify the actual selection path can produce that source type end-to-end.

### Generated character data must be consumed by the runtime
- Symptom: `profile.generated.json` and related persona files were created during import, but the runtime still used a hardcoded calm personality for every character.
- Cause: data generation was added on the import path without wiring the renderer behavior/motion layer to load and apply that data.
- Prevention: when adding generated metadata files, verify there is a matching runtime read path and one user-visible behavior change driven by that data.

### Desktop deployment cannot assume an external backend is already running
- Symptom: the Electron app depended on `127.0.0.1:8000`, but there was no built-in bootstrap path for starting the FastAPI server.
- Cause: development instructions existed, yet runtime startup responsibility was left entirely to the user environment.
- Prevention: desktop releases need one explicit backend strategy:
  1. spawn a local backend process
  2. bundle a backend executable
  3. point to a configured remote backend
  If none is wired, treat it as a deployment blocker.

### Async model loaders must resolve only after the model is really ready
- Symptom: `await loadModel(...)` could return before the loader callback finished, and a slower older request could overwrite a newer character selection.
- Cause: callback-based GLTF/MMD loaders were wrapped in an `async` function name only, without an actual completion promise or stale-load guard.
- Prevention: any async asset loader must:
  1. return a promise that resolves on load success/failure
  2. ignore stale late results with a request token or version id
  3. dispose or drop superseded assets before they touch live scene state

### Windows packaging must avoid privilege-sensitive signing helpers unless intentionally needed
- Symptom: `electron-builder --dir` produced `win-unpacked`, then failed while extracting `winCodeSign` because symbolic-link creation was blocked on the local machine.
- Cause: the default Windows packaging path still pulled in signing/edit helpers even for an unsigned local smoke build.
- Prevention: for local unsigned packaging on Windows:
  1. set `win.signAndEditExecutable: false`
  2. keep a `verify:release` step that checks packaged backend/resource wiring before distribution
  3. only re-enable signing in an environment that explicitly supports certificate/signing prerequisites

### Packaged backend builds must explicitly exclude optional heavyweight AI stacks
- Symptom: the first PyInstaller backend build ballooned past 2 GB and stalled because optional `torch` and `transformers` paths were silently bundled.
- Cause: imports inside delayed code paths still count for static analysis unless they are explicitly excluded.
- Prevention: when packaging the backend executable:
  1. exclude heavyweight optional modules such as `torch`, `transformers`, `accelerate`, and `whisper`
  2. smoke-test the produced executable after build instead of trusting the PyInstaller exit code alone
  3. treat backend size spikes as a regression signal, not just a slow build

### Remote backend configuration must not trigger local auto-spawn
- Symptom: a configured remote `APIA_BACKEND_URL` could still fall through to local spawn logic, producing a misleading mixed mode.
- Cause: spawn eligibility was derived from health check failure alone, not from whether the backend URL actually pointed to a local host.
- Prevention: only auto-start a local backend when the configured backend URL resolves to a loopback host such as `127.0.0.1` or `localhost`.

### Release verification should fail fast when the packaging toolchain is out of sync
- Symptom: `dist:dir` got all the way through frontend build and backend exe build before failing because `electron-builder` had not been installed after `package.json` changed.
- Cause: the release preflight checked artifacts, but not whether the required local packaging toolchain was actually present.
- Prevention: `verify:release` should validate both:
  1. generated artifacts such as the backend executable
  2. local packaging dependencies such as `electron-builder`

### Packaged runtime configuration must have a non-source path
- Symptom: packaged builds could start successfully but still leave operators unsure where to place API keys, which turns into "AI is broken" reports even though the app is running.
- Cause: runtime configuration was only documented as environment variables or source edits, while packaged users need a file-based path that survives upgrades and does not require editing the app bundle.
- Prevention:
  1. load `backend.env` from the user runtime directory before reading AI settings
  2. create a `backend.env.example` file in that directory so the path is discoverable
  3. strip UTF-8 BOM when parsing `backend.env`, because Windows editors often add it and the first key will silently fail otherwise
  4. document the actual Electron `userData` path as observed at runtime, including lowercase app-name folders on Windows
  5. keep the deployment guide aligned with the actual runtime search order and normalization rules

### Packaged Electron smoke tests can lie when `ELECTRON_RUN_AS_NODE=1` is inherited
- Symptom: `Apia.exe` appeared to exit immediately with code `0`, printed a Node version string, and never produced any main-process logs.
- Cause: the local shell inherited `ELECTRON_RUN_AS_NODE=1`, which makes Electron binaries behave like plain Node before the app's main process ever starts.
- Prevention:
  1. clear `ELECTRON_RUN_AS_NODE` before any packaged-app smoke test
  2. confirm suspicion by checking whether `Apia.exe --version` prints a Node version instead of app startup logs
  3. treat "no logs at all" as a possible environment override, not automatically as an app crash

### Packaged local backend startup must survive default-port collisions
- Symptom: the packaged app could load its UI but the bundled backend died immediately if another process was already listening on `127.0.0.1:8000`.
- Cause: the runtime assumed the default local port was always free and only discovered the conflict after spawning the backend executable.
- Prevention:
  1. when using the default local backend URL, probe the configured port before spawning
  2. if the port is occupied and no healthy backend is responding there, move to the next available local port
  3. log the selected runtime backend URL so packaged diagnostics show the real port in use

### Backend smoke-test cleanup must release the executable before the next build
- Symptom: running `npm run build:backend` twice in a row could fail with `PermissionError` while overwriting `backend-dist/ApiaBackend.exe`.
- Cause: the smoke-test process tree was killed on Windows, but the build script did not wait for the child exit and file-handle release before starting the next PyInstaller pass.
- Prevention:
  1. wait for the smoke-test child process to exit after `taskkill`
  2. poll for the packaged executable to become writable before rebuilding
  3. treat repeated build runs as part of the packaging regression suite, not an edge case

### Packaged backend diagnostics are incomplete unless child stdout/stderr also lands in the runtime log
- Symptom: packaged backend failures could still be invisible in `main.log` even after adding main-process startup diagnostics.
- Cause: the child backend process wrote to the terminal console only, which packaged Windows users typically never see.
- Prevention:
  1. route backend child `stdout` and `stderr` through the same runtime log sink as Electron main-process events
  2. prefer file-backed diagnostics over console-only output for packaged apps
  3. keep the packaged smoke test checking for runtime log output, not just process exit codes

### Release smoke tests should neutralize inherited Electron-as-Node mode automatically
- Symptom: a shell with `ELECTRON_RUN_AS_NODE=1` can make packaged Electron smoke tests report false startup failures even when the app is healthy.
- Cause: the smoke test inherited the caller environment instead of enforcing an Electron runtime environment for the child process.
- Prevention:
  1. clear `ELECTRON_RUN_AS_NODE` inside the smoke-test child environment
  2. validate success through startup log markers and runtime file creation
  3. keep the smoke test separate from pure artifact verification so release checks cover both packaging and launch behavior

### Manual packaged-app cleanup must kill the whole process tree
- Symptom: a forced manual shutdown of `Apia.exe` left `resources/backend/ApiaBackend.exe` running and locked, which then broke the next `electron-builder --dir` pass with `Access is denied`.
- Cause: killing only the Electron parent process does not guarantee that packaged child processes stop on Windows.
- Prevention:
  1. for smoke tests, stop the packaged app with `taskkill /T /F` or equivalent tree cleanup
  2. if packaging suddenly fails with a locked backend executable, check for stray `ApiaBackend.exe` processes before blaming the build config
  3. treat cleanup procedure bugs as part of the release regression surface, not as harmless local noise

### Runtime backend base URLs must be stored without a trailing slash
- Symptom: packaged startup logs showed the backend process booting successfully, but health checks kept hitting `//health`, returned `404`, and the app killed the backend as if startup had failed.
- Cause: `URL.toString()` normalized local backend URLs to `http://127.0.0.1:8001/`, and later string concatenation produced double-slash endpoint paths.
- Prevention:
  1. normalize stored backend base URLs by trimming trailing slashes before appending route paths
  2. make release smoke tests require a real `[BACKEND_READY]` marker, not just window-load success
  3. when backend startup times out, inspect the exact requested paths in runtime logs before assuming the backend executable is broken

### Windows packaged backend shutdown must kill the whole process tree
- Symptom: even after the app decided to stop the packaged backend, `release/win-unpacked/resources/backend/ApiaBackend.exe` could remain alive and keep the next packaging pass locked.
- Cause: `child.kill()` is not reliable for PyInstaller onefile-style Windows processes because the launched executable can outlive the direct Node child handle.
- Prevention:
  1. stop packaged Windows backends with `taskkill /T /F` against the tracked PID
  2. treat unexpected release-folder file locks as a possible shutdown bug, not automatically as a build-tool problem
  3. use the same tree-kill strategy in app shutdown, release smoke cleanup, and backend build smoke cleanup where applicable

### Chunk warnings should follow a documented budget after real splitting work
- Symptom: the heaviest frontend chunk dropped from roughly `781 kB` to roughly `544 kB` after separating `three/examples`, but Vite still warned because the default threshold stayed at `500 kB`.
- Cause: the default warning limit is generic, while this app intentionally carries a larger local 3D runtime payload even after meaningful split points have been applied.
- Prevention:
  1. split obvious payload boundaries first instead of muting the warning immediately
  2. once the post-split size is understood, set `chunkSizeWarningLimit` to a measured budget instead of the untouched default
  3. keep the before/after size numbers with the regression notes so future growth is judged against the tuned budget

### Vite config format should avoid the deprecated CJS fallback path
- Symptom: every `vite build` emitted `The CJS build of Vite's Node API is deprecated`.
- Cause: the project kept an ESM-style `vite.config.js` inside a CommonJS package, so Vite had to bridge through its older CJS config-loading path.
- Prevention:
  1. keep the Vite config in `vite.config.mjs` when the package itself remains CommonJS
  2. update setup docs whenever the config filename changes
  3. treat repeated build warnings as real debt and either remove them or document why they must stay

### Remove unused loader modules once the runtime path is verified
- Symptom: old loader helpers stayed in the repo after the runtime switched to the promise-based model loader path, creating extra stale code to debug around.
- Cause: the new loader path was added successfully, but the unused helper module was never cleaned up.
- Prevention:
  1. remove unused loader files after validating the replacement path in build and packaged smoke tests
  2. search for orphaned helper modules after large refactors instead of assuming bundlers will make them harmless
  3. keep the repo aligned with the actual runtime path so error triage has fewer false leads

### Distinguish shell mojibake from real file corruption before mass rewriting HTML
- Symptom: `settings.html` looked broadly broken in PowerShell output even though most user-facing Korean strings were still valid in the UTF-8 source.
- Cause: terminal rendering noise and a genuinely corrupted line were mixed together, making the file look worse than it was.
- Prevention:
  1. inspect suspicious UI files with a UTF-8 reader or targeted `rg` search before attempting a large re-encoding pass
  2. prefer surgical fixes when the stored source is mostly healthy, especially in long legacy HTML files
  3. after bulk code removal in the same pass, run an immediate syntax check to catch dangling braces or wrappers left behind

### Package Electron releases from an isolated staging directory when a parent folder has its own Node project
- Symptom: `electron-builder` reported unresolved dependencies from `C:\Users\ui2030\node_modules` even though the current project dependencies were installed correctly.
- Cause: a separate parent-level `package.json` and `node_modules` polluted `electron-builder`'s dependency walk, so packaging logs reflected the wrong project tree.
- Prevention:
  1. run `electron-builder` from a clean staging directory outside the polluted parent tree and point the output back to the workspace release folder
  2. copy the exact packaging inputs (`dist`, `electron`, `backend-dist`, `package.json`, `package-lock.json`, `electron-builder.yml`, `node_modules`) into that staging directory before packaging
  3. if release logs mention a parent `node_modules` path, treat it as a packaging-environment bug before changing app dependencies

### Keep PyInstaller packaging scoped to runtime modules only
- Symptom: backend packaging emitted avoidable warnings for `tzdata`, `numpy.array_api`, and large swaths of development-only Python ecosystems.
- Cause: the packaging environment leaked extra user-site modules into analysis and the build collected more submodules than the runtime actually needs.
- Prevention:
  1. set `PYTHONNOUSERSITE=1` for packaging commands so user-level Python packages do not silently widen the analysis graph
  2. install small real runtime extras such as `tzdata` when hooks expect them
  3. keep PyInstaller collection focused on dynamic runtime packages and verify the packaged backend against at least `/health` and `/voices`

### Lazy-init of a backend service must cover every router that touches it
- Symptom: runtime log showed `[TTS] pyttsx3 initialized` printed twice during backend startup even after `voice.py` was made lazy in the previous pass.
- Cause: `tts.py` and `voice.py` each had module-level `TTSService()` construction. Making one lazy left the other eager; result was two separate instances, two pyttsx3 inits, and voice state split between routes (a `/voices` voice change wasn't visible to `/tts`).
- Prevention:
  1. When deferring a service constructor, grep every router that imports the service and confirm none still constructs it at module load
  2. Expose one shared lazy accessor (e.g. `voice.get_tts()`) and have downstream routers import that, rather than copy the lock-and-singleton pattern per router
  3. When wiring a warmup endpoint, prime every deferred service — the fast-path that returns "ready early" must prime the same set as the background warmup path, or it pays the cost on the first end-user request anyway

### Async warmup that primes multiple services must isolate per-service errors
- Symptom: `asyncio.gather(voice.prime(), stt.prime())` fail-fast behavior would cancel the sibling prime when one service raised, turning one optional degraded service into a whole-warmup failure.
- Cause: default `asyncio.gather` cancels in-flight siblings on the first exception.
- Prevention:
  1. Use `asyncio.gather(..., return_exceptions=True)` whenever the primes are independent and optional
  2. Iterate the returned results and log each per-service failure (`exc_info=...`) instead of swallowing
  3. Don't store optional-service prime failures into the same status field as the primary task's failure — keep the GET status accurate about which thing actually broke

### Backend readiness probes should use a simple Node HTTP request, not a generic fetch helper
- Symptom: packaged startup sometimes logged `/health 200 OK` but still concluded with `[BACKEND_READY_TIMEOUT]`.
- Cause: the generic fetch-based helper was a poor fit for slow first-response packaged backends, so readiness checks could misclassify a backend that was actually healthy.
- Prevention:
  1. probe packaged backend readiness with a dedicated Node `http/https` request path that only answers “did the backend return 2xx?”
  2. keep startup readiness timeouts separate from normal request timeouts
  3. when a readiness timeout happens alongside backend `200 OK` logs, investigate the probe implementation before blaming the backend executable

### Deferred: Electron 28 → 35+ security upgrade
- Symptom: `npm audit` reports 1 high-severity advisory against `electron@^28.3.3` after the 2026-06 dependency cleanup. Dev/build tools (vite/vitest/electron-builder) were updated; `electron` itself was deliberately left at 28.
- Cause: Electron 28 → 35+ is a multi-major runtime upgrade. webPreferences defaults around contextIsolation strictness and sandbox shifted across versions, and the transparent overlay + custom IPC surface has no automated end-to-end coverage. Doing the upgrade in the same session as the audit pass would risk a renderer regression with no test to catch it.
- Prevention:
  1. treat the Electron upgrade as its own pass; it needs renderer smoke at minimum (load the packaged window, fire each IPC channel, verify VRM + MMD load) before merging
  2. do not describe the audit as "fully clean" while Electron remains pinned — the current state is "dev/build remediated, Electron deferred"
  3. when scheduling the upgrade, expect to revisit `electron-builder.yml` for any new electron-version-specific signing/build options, and to re-validate `preload.js`'s `contextBridge.exposeInMainWorld` surface against the destination Electron's `contextIsolation` defaults

### MMDPhysics needs ammo.js loaded *before* the model
- Symptom: PMX hair/skirt/tail bones froze in place even after the procedural shoulder/elbow pass landed. Console showed `[Apia MMD] physics enable failed Error: THREE.MMDPhysics: Import ammo.js`. Bone matching was fine (`missing: []`), so the visual freeze was a false signal pointing at our retarget code instead of the simulator.
- Cause: `helper.add(mesh, { physics: true })` constructs `MMDPhysics`, which reads `window.Ammo`. ammo.js wasn't being initialized at all, so every PMX load fell into the catch and silently shipped without physics. `rigidBodyCount === 0` log existed but the *thrown* path skipped it.
- Prevention:
  1. when wiring a feature whose constructor reads a global, initialize that global on a path the loader actually awaits — not lazily inside the catch's diagnostic.
  2. wasm-backed three.js libs need three handoffs we kept getting wrong: (a) Vite has to *see* the `.wasm` (use `import './path.wasm?url'`), (b) emscripten's internal fetch will fail under Electron file:// — pass `wasmBinary` ourselves, (c) the emscripten factory ends with `this.Ammo = b` and ESM strict-mode `this` is undefined — call via `factory.call(globalThis, opts)`.
  3. for any "X freezes" report on PMX, check the physics enable log first before suspecting bone mapping / retargeting; bones moving but physics off is a much more common shape than the inverse.

### Verification checklist
- Run `npm run verify`
- Run `python -m compileall backend`
- Re-check any UI option that was added or renamed against the actual runtime path
