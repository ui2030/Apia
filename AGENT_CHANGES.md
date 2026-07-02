# Agent Changes

Running log of edits made by the assistant. Newest first.

## 2026-07-02 (J단계 행동 지능 — 존재 인지·영속·디렉터 강화·행동 일관성)

User direction: *"행동이 자연스럽게 — 관절이 꺾여서 모션이 나온다거나, 행동이 기계처럼 부자연스럽다거나 그러면 안 되는 거 알지?"* — J단계 남은 갭 4종을 자연스러움 최우선으로 마감. Codex 사전/사후 검토 4라운드(MUST-FIX 8건 반영, 최종 APPROVE), `npm run verify` 341 tests ✓.

### 커밋 (전부 푸시됨)
- `21bbde3` 사용자 존재 인지 + 욕구 영속 — presenceManager(powerMonitor 유휴초 5s 폴링+잠금/절전, active/short-idle/away 상태기계), 복귀 인사(react 모션·관성 보간 경로만·10분 디바운스), 부재 틱 recordPace 제외, 잠금/절전 자율행동 정지(pauseLocked/pauseSuspended 분리, 재개 8s 유예), 욕구 localStorage 영속(`apia-needs:<charId>`, 오프라인 상승 욕구당 +0.5 상한), 학습 per-char 키(`apia-adaptation:<charId>`, 레거시 시드), flush→프로필 적용→load 순서(오프라인 보정이 새 캐릭터 성격 가중 사용).
- `880b6ed` GUI 검증 — tests/gui/presence-check.mjs(전이·인사·디바운스·잠금 9판정 ALL PASS), presence-visual.mjs(정면·측면 클로즈업), `__presenceDebug`(실 IPC와 동일 핸들러)·`__currentMotion` 훅.
- `25c063d` 디렉터 컨텍스트 강화 — needs 상위 3·방 활동 목록(SAFE_ID·최대 8)·진행/직전 활동, directive.activityHint(×1.25 가산만·임계 유지·쿨다운 중 가산 금지), DIRECTOR_SYSTEM에 presence="물리적 부재≠무관심" 명시.
- `4cf47c0` 행동 일관성 — behaviorPlanner(직전 슬롯 질량 절반 약화=약한 반복 회피, 걷기 도착 후 첫 틱 "둘러보기" linger 1회성 45s).

### 검증
- vitest 341 (신규 45: presence 15·needs 11·director 12·planner 7)
- presence-check GUI 9판정 ALL PASS, 스크린샷 해부학 검수(정면+측면) — 관절 꺾임 없음
- life-observe.mjs 90s 자율 생활 관찰: idle→walk→sit 슬롯 다양, 제스처 3종, 욕구 상승 속도 이론값 일치(thirst 90s≈0.034), pageerror 0

### Open items
- VRM 모델은 inertialization 미적용(MMD만) — VRM 클립 쓰게 되면 그때.
- linger는 짧은 인터럽트(45s 내 대화) 후에도 소비될 수 있음 — 자연스럽다고 판단, 어색하면 markInteraction에서 명시 취소.
- 측면 컷에서 꼬리 형상이 희게 크게 렌더되는 기존 폴리시 항목 여전(이번 작업과 무관).

## 2026-06-13 (음성 복제 기능 — 3단 테스트 + 디스플레이 2 시각 확인)

직전 세션에서 구현하다 끊긴 제로샷 음색 변환(seed-vc) 기능을 이어받아 테스트로 마감.
구현물(미커밋): `voice_clone_service.py`(신규), `voice_manager.py`/`voice.py`/`tts.py`/`stt.py`,
설정창 복제 UI(settings.html), preload IPC, 새 MMD 캐릭터 모델(PMX). 신규 코드 없이 검증만 수행.

검증 결과 (모두 통과):
- `npm run verify` — vite build + node --check + vitest 188개 ✓
- `scripts/voice-clone-smoke.py` (GPU) — f0 중앙값 원본 음성 220Hz → 변환 137Hz, 참조 음성 142Hz.
  변환음이 참조 쪽으로 이동(shiftedTowardRef), 길이 보존, 비무음, 6.6s 발화 6.1s 변환 ✓
- `scripts/voice-clone-e2e.py` (라이브 백엔드 HTTP) — upload→train 게이지 단조[20→80→100]→done,
  custom 음성 목록 노출, preview audio/wav, custom TTS 2연속 비폴백(2.4s/2.0s), 삭제 후 제거 ✓
- `tests/gui/voice-clone-ui-check.mjs` — 복제 UI 5요소·disabled·custom 토글·페이지에러 0 ✓

디스플레이 2 시각 확인:
- `apia-settings.json`에 `windowAnchor {x:-2560,y:720}` 추가 → 앱이 Display 2(2560×1392 @ x=-2560)에 생성.
- launchApia 캡처(앱 창만, 바탕화면 제외): MMD 캐릭터(PMX) 정상 렌더(SkinnedMesh 확인, T-pose 아님, 헤일로),
  리빙룸 씬 + 월드 라벨 표시. 설정창 음성복제 섹션 전부 렌더.
- 실 백엔드는 `python:workspace`(anaconda, seed_vc 보유)로 폴백 기동, `/health`·`/voices` 200,
  VoiceClone unavailable 로그 없음 = 복제 가용.

환경 메모: dev 백엔드 첫 후보 `py -3`(Python313)은 uvicorn 미설치라 실패 후 `python`(anaconda)로
정상 폴백. seed-vc는 anaconda에만 설치돼 있어 venv(backend/.venv)로는 복제 불가 — 패키징 exe는 자체 번들.

## 2026-05-29 (QA pass — adversarial review caught 3 backend bugs)

User direction: *"비판적 리뷰를 통해 버그 방지, 이제부터 테스터를 가장하여 테스트를 진행 후, 불편사항 개선"*. Inspected the runtime log from today's packaged smoke run, found `[TTS] pyttsx3 initialized` printing twice — that was the trail to three real eager-init regressions that survived the previous lazy-init work.

Verified after: `python -m compileall backend` ✓, `npm run verify` ✓.
Live test attempted via local uvicorn but blocked by user-env issue (anaconda's `pydantic` is incompatible with the bundled `fastapi` version — same family as the conda numpy issue that blocked `npm run build:backend`). Packaged ApiaBackend.exe has its own bundled deps so this is dev-only. Verification stayed at static-analysis + Codex review.

Codex did adversarial review across 2 rounds, caught both: a fast-path that primed voice but not stt, and an `asyncio.gather` without `return_exceptions=True` that would cancel sibling primes on one failure. Both fixed in round 2. Final APPROVE: yes.

### Bug 1: `backend/routers/tts.py` was still doing eager TTSService init
- Symptom (runtime log): `[TTS] pyttsx3 initialized` printed twice during backend startup.
- Cause: previous pass made `voice.py` lazy, but `tts.py:11` still had `tts_service = TTSService()` at module load. Each router constructed its own TTSService instance — duplicate pyttsx3 init + divergent voice state between the two routes (a voice change via /voices would not be visible to /tts).
- Fix: rewrote `tts.py` to `from routers.voice import get_tts` and `await get_tts()` in the route. One singleton, one lock, one pyttsx3 init.

### Bug 2: `backend/routers/stt.py` was doing synchronous WhisperService construction at module load
- Cause: `stt.py:8 whisper = WhisperService()` at module load. WhisperService's `__init__` calls `_load_model()` which does `whisper.load_model("small")` synchronously — a ~500MB model load that would block uvicorn startup if Whisper is installed (in packaged form, Whisper is excluded, so the import fails fast and prints a single-line warning — but the dev env penalty was 5–10s of blocked startup).
- Fix: applied the same lazy pattern as voice.py — module-level `_whisper`, `_whisper_lock`, async `get_whisper()` that wraps construction in `asyncio.to_thread`. Added `prime()` so warmup pulls the cost into the background.

### Bug 3: `voice.py` accessors were `_`-prefixed so other routers couldn't legitimately share them
- Cause: `_get_tts` / `_get_vm` named as private. The fix for bug 1 needed cross-router access; would have invited a copy of the lock pattern in tts.py.
- Fix: renamed to `get_tts` / `get_vm` (public). All internal call sites updated. State (`_tts`, `_vm`, `_tts_lock`, `_vm_lock`) stays underscore-private.

### Warmup now primes every deferred service, with per-service error isolation
- File: [backend/routers/warmup.py](backend/routers/warmup.py).
- Extracted `_prime_all_services()` — `asyncio.gather(voice.prime(), stt.prime(), return_exceptions=True)`. Per-service exceptions logged at WARN with `exc_info` (don't poison `_last_error`, which is reserved for the claude task's exception so the GET response stays accurate about *what* failed).
- Both `_run_warmup` AND the POST ready-fast-path now use `_prime_all_services()` — fixes a real Codex-flagged regression where the fast-path used to only call `voice.prime()`, so a session that already had claude initialized would skip whisper prime entirely and pay the cost on the first STT request.

### Files
- [backend/routers/voice.py](backend/routers/voice.py)
- [backend/routers/tts.py](backend/routers/tts.py)
- [backend/routers/stt.py](backend/routers/stt.py)
- [backend/routers/warmup.py](backend/routers/warmup.py)

### Field notes for the next pass (user env, not Apia code)
The QA pass surfaced two user-environment issues that block parts of the verification baseline. Recording here so future passes don't waste time diagnosing them:
1. **conda numpy without RECORD** — blocks `npm run build:backend` (pip can't uninstall the conda-installed numpy to install the requirements-packaging.txt version). Recovery: `pip install --force-reinstall --no-deps numpy==1.26.0`.
2. **anaconda fastapi/pydantic mismatch** — blocks running the backend from source via `uvicorn main:app` (fastapi expects `pydantic.fields.Undefined` which the anaconda pydantic version doesn't expose). Recovery options: pin pydantic to match fastapi, or use a clean venv with `requirements.txt`, or just rely on the packaged ApiaBackend.exe (which has its own bundled deps and works fine).

Neither blocks shipping. Both are local dev-environment hygiene issues.

Live test verified 2026-05-29: backend dev startup clean (zero eager init), warmup transitions correctly, TTS singleton shared across voice/tts routers (single pyttsx3 init), packaged build + smoke release pass.

## 2026-05-29 (Claude + Codex pass, VMD runtime pickup wiring)

User direction: ran `/goal` with "Apia 프로젝트 완성" condition. The biggest "Open item" carried over from the previous pass was MMD `.vmd` runtime pickup, which had been deferred for lack of a validated clip. Decision: wire the loader-correctness end of the pipeline anyway — drops are now a pure asset operation, no code change needed when a clip arrives.

Verified after: `npm run build` ✓, `python -m compileall backend` ✓, `npm run verify` ✓.

### VMD manifest re-added with same motion-name mirror as VRMA
- New: [src/assets/motions/vmd/manifest.json](src/assets/motions/vmd/manifest.json).
- Same key set as [src/assets/motions/manifest.json](src/assets/motions/manifest.json) (`idle_*`, `talk_*`, `react_*`) so a given motion name picks the right clip per active model type.
- The previous "stub manifest with no loader" version was correctly deleted earlier; this version comes back with a real loader behind it.

### `motionAssets.js` now resolves both VRMA and VMD
- File: [src/motionAssets.js](src/motionAssets.js).
- Added `resolveMmdMotionAsset(name)` mirroring `resolveMotionAsset(name)`. Both use the same shared `resolveFromManifest(manifest, pathToUrl, name)` helper, so the null-when-missing-file semantics are identical.
- Added a second `import.meta.glob('./assets/motions/vmd/**/*.vmd', { eager: true, query: '?url', import: 'default' })` so Vite gives `.vmd` files hashed URLs (works for production builds; missing clips just don't appear in the map and the resolver returns null).
- `listAvailableMotions()` unions both sides — a motion name shows up if either side has a real clip.

### `src/main.js` `playMotion` routes by model type
- Change: `playMotion(motion)` now checks `currentModel?.type === 'mmd'` and calls `resolveMmdMotionAsset` + `playMMDAnimation` on that path; falls back to the VRMA path for VRM (preserving the previous default). Procedural `applyMotion(motion)` still runs first for both — VRM's `updateVRMBody` provides the procedural layer, MMD relies on the clip + lipsync.

### `playMMDAnimation(url, { loop })` added
- File: [src/main.js](src/main.js).
- Uses `MMDLoader.loadAnimation(url, mesh, cb)` to parse the VMD into an `AnimationClip`, then `MMDAnimationHelper.add(mesh, { animation: clip, physics: false })` to register playback. `helper.remove(mesh)` is called first so successive playMMDAnimation calls cleanly swap clips instead of stacking actions.
- Non-loop: walks `helper.objects.get(mesh).mixer` (with a fallback for the older `helper.objects[uuid]` shape across three.js minor versions), calls `clipAction(clip)`, sets `LoopOnce` + `clampWhenFinished` so the animation halts on its last frame without snapping back. No `fadeOut` to a procedural layer because MMD doesn't have one — holding the last frame is the natural ending.
- Race safety: model captured at call entry via `const model = currentModel`. Both await points (`getMmdRuntime`, `loader.loadAnimation`'s callback) bail with `currentModel !== model`. All mutations use the captured `model` reference. Same defensive shape as `playVRMAnimation` after the round 5 race fix.

### Docs refresh
- [PROJECT_STATUS.md](PROJECT_STATUS.md): renamed Section 7 to "Motion clip pipeline" (was "scaffolding" — no longer just scaffolding), documented the routing + `playMMDAnimation` behavior, moved VMD pickup out of "Remaining Cleanup" into a "retired" note alongside the previously closed entries.
- [src/assets/motions/vmd/README.md](src/assets/motions/vmd/README.md): rewrote status block ("런타임 와이어링 완료"), added a "런타임 흐름" section pointing at the loader chain, kept the `fadeIn` field note (currently metadata-only on MMD side because `MMDAnimationHelper` doesn't expose direct fade API; preserved in manifest for future mixer-level fade work).

## Open items (still flagged for the next pass)
- **PyInstaller 3rd-party warnings**: non-blocking, sourced from libs we don't control. Triage only if packaged size or startup time starts mattering again.

## 2026-05-29 (Claude + Codex pass, 4-round review loop + completion)

User direction: 첫 번째 — *"아까 Apia 패스(2026-05-28) 작업물에 대해 Codex한테 코드 레벨로 APPROVE 받아줘"* — drove Codex review of the prior pass via the new bridge `workspace=` arg. 두 번째 — *"이제 서로 대화하고, apia 프로젝트 완성시켜"* — execute and iterate with Codex feedback until APPROVE. 세 번째 — *"이제 완벽플렌 만들고, 그거에 맞춰서 계속 진행해"* — formalize and execute the remaining cleanup plan.

Codex bridge `workspace` arg confirmed working — Codex opened the actual `C:/Users/ui2030/Documents/Apia/...` paths and returned real review content (not hallucinated).

Verified after: `npm run build` ✓, `python -m compileall backend` ✓, `npm run verify` ✓.

### Backend warmup / voice lazy-init — synchronization, exception observability, lock-scope fix
- File: [backend/routers/voice.py](backend/routers/voice.py).
- Change: lazy `_get_tts()` / `_get_vm()` now use `asyncio.Lock` + `asyncio.to_thread`. Added `prime()` for the warmup router to call so the first `/voices` request doesn't pay cold-start. Public route behavior unchanged.
- Why: Codex review flagged that the previous lazy pattern had no synchronization — under concurrent first requests, two workers could race and double-init pyttsx3.

- File: [backend/routers/warmup.py](backend/routers/warmup.py).
- Change:
  - Switched from `BackgroundTasks` + pre-checking `_warm_lock.locked()` to tracking `_warm_task: Optional[asyncio.Task]`. `_is_warming()` reads task state, which is not timing-sensitive the way the pre-check was.
  - `voice.prime()` runs **after** `_warm_lock` releases. Putting it inside the lock would have made claude provider init and voice init contend on the same mutex even though `voice.prime()` has its own internal locks.
  - `asyncio.create_task` now has a `_on_warm_done` callback that consumes `task.exception()`, logs it, and stores `_last_error`. Previously a failed warmup became an "unobserved task exception" GC warning. `_last_error` is exposed on `GET /warmup` and cleared when a new task starts (so retry-in-progress doesn't show a stale failure).
- Why: Codex round 2 surfaced the unobserved-exception risk and the in-lock voice prime as MUST-FIX after the round 1 sync fix.

### Renderer wires `POST /warmup` on startup
- Files: [electron/preload.js](electron/preload.js), [electron/main.js](electron/main.js), [src/main.js](src/main.js).
- Change:
  - New IPC channel `warmup`. Preload exposes `window.api.warmup()`. Main handles it via the existing `requestBackendJson('/warmup', { method: 'POST', timeout: 3000 })` pattern (matches `get-voices` shape). Any failure returns `null` so the caller stays noise-free.
  - `src/main.js` fires `window.api.warmup?.().catch(() => {})` once inside `getSettings().then(...)`, right after `scheduleAutoBehavior()`. Not added to `onSettingsApplied` — first hydrate is the intent; mode-switch already triggers fresh init through `_ensure_mode`.
- Why: backend `/warmup` existed since the previous pass but the renderer never called it, so the lazy-init mitigation was effectively dead code — first `/chat` still paid the full cost. With this wired, local-mode HF load happens in the background while the user is still reading the empty chat panel.

### VRMA non-loop actions cross-fade back to the procedural layer
- File: [src/main.js](src/main.js), `playVRMAnimation` + `clearModel`.
- Change: for non-loop actions, set `action.clampWhenFinished = true` and register a `'finished'` listener on the mixer that calls `action.fadeOut(0.35)` and removes itself. `updateVRMBody` (the procedural layer that runs every frame) takes over as the mixer's weight reaches zero, so the rest pose snap is gone.
- Listener lifecycle: tracked in a per-model `_pendingFadeOutHandlers` Set. Cleared at the start of every new `playVRMAnimation` call (before `stopAllAction`) and inside `clearModel` (before disposing the VRM). Prevents stale handlers from firing against a disposed mixer.
- Why: AGENT_CHANGES 2026-04-21 explicitly flagged this — "Cross-fade back to procedural layer when a VRMA action ends. currently `stopAllAction()` can snap the rest pose."

### VMD scaffold trimmed back
- Deleted: `src/assets/motions/vmd/manifest.json`. The stub manifest claimed coverage for clips that no loader was actually reading. Codex review correctly called it dead weight.
- Updated: [src/assets/motions/vmd/README.md](src/assets/motions/vmd/README.md) — removed the dead `[manifest.json](./manifest.json)` link and rewrote the status block to say "folder-only scaffold; the manifest will land with the runtime pickup PR."
- Why: a placeholder file that lies about itself is worse than nothing. The drop folders are still there for when the VMD wiring pass actually arrives.

### Doc refresh — PROJECT_STATUS.md
- Bumped `Last updated: 2026-05-29`.
- Section 6 (`Backend AI provider lifecycle`): documented the lock + exception-observability work and the renderer `/warmup` caller.
- Section 7 (`Motion clip scaffolding`): noted VMD manifest deletion + the new VRMA cross-fade behavior.
- "Remaining Cleanup" section: removed three retired entries (`src/main.js` legacy wrappers — none exist; `settings.html` mojibake — file is clean UTF-8, the "mojibake" was shell rendering; `/warmup` caller — wired this pass). PyInstaller noise + VMD pickup remain (both genuinely deferred).

> *Open items from this pass have been superseded by the VMD wiring pass above (PyInstaller noise carries forward; MMD pickup is now resolved).*

## 2026-05-28 (autonomous Claude + Codex pass)

User direction: *"둘이 토론을 통해 무엇을 해야할지에 대해 의논하고, 바로 실행해"* — Claude and Codex agreed on a short follow-up plan addressing the open items at the bottom of the previous pass, then executed without further confirmation.

Plan reviewed by Codex (peer): APPROVE with one MUST-FIX — the warmup endpoint must NOT block on the executor (use `BackgroundTasks` + dedupe lock). That MUST-FIX is reflected below.

Verified after: `npm run build` ✓, `python -m compileall backend` ✓, `npm run verify` ✓.

### Backend `POST /warmup` — first-chat latency mitigation
- New: [backend/routers/warmup.py](backend/routers/warmup.py).
- New mount: [backend/main.py](backend/main.py) `app.include_router(warmup.router, prefix="/warmup", tags=["warmup"])`.
- Behavior:
  - `POST /warmup`: if the target mode is already in `claude._initialized_modes`, returns `{status: "ready", mode}` immediately. Otherwise enqueues a `BackgroundTasks` job (`asyncio.to_thread` → `_ensure_mode`) under a module-level `asyncio.Lock` and returns `{status: "warming", mode}`. Concurrent POSTs are deduplicated by the lock so a slow local-mode HF load is never re-triggered.
  - `GET /warmup`: returns `{initialized_modes, mode, default_mode, warming}` for diagnostics.
- Why: after the lazy-init change in the previous pass, the first `/chat` paid the entire provider init cost. On local mode that can exceed the 30 s frontend timeout. With `/warmup` the renderer can fire-and-forget once on startup and the cost is paid in the background.
- Risk: low. Reuses the existing `claude` instance from `routers.chat` (no second instance), uses BackgroundTasks (the request returns instantly even on slow local init), and the dedupe lock prevents duplicate warmups.
- Caller wiring: not yet — backend exposes the endpoint, but `src/main.js` doesn't fire it. Documented as a remaining cleanup item in PROJECT_STATUS.md so the next pass picks it up.

### TTSService and VoiceManager are now lazy in the voice router
- File: [backend/routers/voice.py](backend/routers/voice.py).
- Change: removed module-level `tts = TTSService()` and `vm = VoiceManager()`. Replaced with `_get_tts()` / `_get_vm()` accessors that defer construction and the service `import` itself until first use.
- Why: mirrors the deferral pattern applied to `ClaudeService` in the previous pass. pyttsx3 init is cheap on most setups but flagged as the same shape of footgun in the prior "Observations still open" list.
- Risk: none observed. Routes call the accessor instead of the module-level name and the public API surface is unchanged.

### Renderer dummy-head blink target is cached
- Files: [src/characterController.js](src/characterController.js), [src/main.js](src/main.js).
- Change:
  - characterController.js exports `setDummyBlinkTarget(node)` / `clearDummyBlinkTarget()` and `_applyBlink` reads a cached `dummyBlinkTarget` reference. If the cache is empty (dev-only paths that don't go through `loadDummy`), it lazily populates from `getObjectByName('dummy-head')` once and never walks the scene graph again per frame.
  - main.js `loadDummy()` calls `setDummyBlinkTarget(dummyHead)` right after assigning the marker name. `clearModel()` calls `clearDummyBlinkTarget()` at the top so the cache never points to a disposed mesh.
- Why: addresses the prior observation that `mesh.getObjectByName('dummy-head')` was running every animation frame and walking the dummy subtree. Negligible on the dummy itself but bad shape if the gate is ever reused for a larger model.
- Risk: low. The lazy fallback inside `_applyBlink` means previously valid call paths still work even if a future loader forgets the setter (per Codex review — belt-and-suspenders, not over-design).

### VMD motion manifest scaffold (MMD side)
- New: [src/assets/motions/vmd/manifest.json](src/assets/motions/vmd/manifest.json), [src/assets/motions/vmd/README.md](src/assets/motions/vmd/README.md), and `src/assets/motions/vmd/{idle,talk,react,emote}/.gitkeep`.
- Why: VRMA manifest only covered the VRM side. The previous pass explicitly flagged the "no MMD side" gap. Manifest keys mirror the VRMA names one-to-one so a future `resolveMmdMotionAsset(name)` hook in `motionAssets.js` can pick the right table based on `currentModel.type`.
- Risk: none. No runtime wiring yet — purely drop-location scaffold + documentation. Vite's glob doesn't import `.vmd` until the wiring adds a glob.

### Doc refresh — PROJECT_STATUS.md
- File: [PROJECT_STATUS.md](PROJECT_STATUS.md).
- Change: bumped `Last updated`, clarified the "modelLoader.js removed" note to say the renderer now uses promise-based VRM/MMD runtime loaders with per-load tokens, added a "Backend AI provider lifecycle" section, added a "Motion clip scaffolding" section, and added two new entries to "Remaining Cleanup, Not Current Breakage" (frontend `/warmup` caller, VMD runtime pickup).
- Why: prior pass observation noted the doc lagged the actual loader path; this pass also added enough new surface (warmup endpoint, vmd manifest) that an out-of-date status doc would already mislead the next agent.

> *Open items from this pass have been resolved or superseded by the 2026-05-29 pass above — see the "Open items" section at the top of the file for the current list.*

## 2026-04-21 (third pass — motion system overhaul)

User direction: *"믹사모도 좋지 아주좋지 어쨌든 추천 따를게"* — implement the 3-layer motion plan that was proposed.

Verified after: `npm run build` ✓ (23 modules, all chunks produced).

### Layer 1: VRM rest pose (T-포즈 → A-포즈)
- File: [src/main.js](src/main.js) — `setupVRMRestPose(vrm)`, called once inside `loadVRMRuntimeModel` after the model is placed in the scene.
- What it sets: `leftUpperArm` +0.9 rad, `rightUpperArm` −0.9 rad (~52° drop), `leftLowerArm/rightLowerArm` ±0.2, `leftHand/rightHand` ±0.08, `leftUpperLeg/rightUpperLeg` ±0.06 (light stance). All via `getRawBoneNode` (VRM0 convention).
- Effect: immediately breaks T-pose. Arms hang naturally, slight shoulder-width leg splay.
- Note: VRM0 기준. 다른 모델에서 팔이 반대로 올라간다면 `setupVRMRestPose` 안의 rotation.z 부호를 반전시키면 됨.

### Layer 2: 전신 프로시저럴 애니메이션 (`updateVRMBody`)
- File: [src/main.js](src/main.js) — replaces the old 2-bone `idleVRM(t)`.
- What changed:
  - Old `idleVRM`: chest 1개 + head 2개 뼈만 구동. 팔/허리/목 없음.
  - New `updateVRMBody`: spine/chest/upperChest 호흡, neck+head 시선 분리 추적, leftUpperArm/rightUpperArm 숨결 연동 흔들림, 말할 때(`state === 'talk'`) 팔꿈치까지 살아 움직임, 앉을 때(`state === 'sit'`) 허벅지 −1.35/종아리 +1.70 rad 굴곡(착석 포즈).
  - 시선 추적: `neck`이 마우스를 lx×0.14/ly×0.07로 리드, `head`가 추가로 lx×0.10 더해서 목→머리 체인이 분리 반응. 이전엔 루트 메시 전체가 돌았음.
  - 강도: `getCurrentMotion().intensity`로 파라미터화 — motionManager의 personality 시스템과 연결됨.
- New imports in main.js: `getLookTarget`, `getCurrentMotion` from characterController.

### `getLookTarget()` export
- File: [src/characterController.js](src/characterController.js).
- Added `export function getLookTarget()` returning `{ x: lookTargetX, y: lookTargetY }`. 이전엔 마우스 좌표가 controller 내부에서만 쓰였음.

### VRM AnimationMixer 준비 (Layer 3 인프라)
- File: [src/main.js](src/main.js) — `loadVRMRuntimeModel` 성공 콜백.
- `currentModel.mixer = new AnimationMixer(vrm.scene)` 추가. `animate()` 루프에서 매 프레임 `currentModel.mixer?.update(delta)` 호출. `clearModel()` 시 `stopAllAction()` 정리.
- 아직 클립은 없지만 인프라가 준비됨 — Mixamo `.vrma` 클립이 들어오면 즉시 재생 가능.

### `playVRMAnimation(url, opts)` — Layer 3 clip loader
- File: [src/main.js](src/main.js) — `export async function playVRMAnimation(url, { loop, fadeIn })`.
- `@pixiv/three-vrm-animation`을 동적 import해서 `.vrma` 파일을 현재 VRM에 재생. `fadeIn` 파라미터로 기존 프로시저럴 모션과 크로스페이드 가능.
- 패키지 설치: `npm install @pixiv/three-vrm-animation` (3.5.2).
- **사용법 (Mixamo 다운로드 후)**:
  ```
  1. Mixamo에서 애니메이션 선택 → FBX Binary / 30fps / Without Skin 다운로드
  2. https://vrm-addon-for-blender.info/ 또는 pixiv vrma-converter로 .vrma 변환
  3. src/assets/motions/ 폴더에 놓기
  4. await playVRMAnimation('file:///path/to/idle.vrma', { loop: true })
     또는 Electron IPC로 경로 받아서 호출
  ```

## Open items (이번 패스에서 미처리)
- **MMD 모션**: vmd 클립 없어서 same issue. VMD 클립이 있으면 `MMDAnimationHelper.add(mesh, { animation: vmd })` — 기존 인프라로 재생 가능.
- **MotionManager → clip 파일 연결**: `motionManager.pickIdleMotion()` 반환값 `name` ('idle_breath_soft' 등)을 실제 `.vrma` 파일 경로로 resolve하는 `resolveMotionAsset(name)` 메서드 추가 필요. 클립이 준비되면 한 세션에 완성 가능.
- **앉기 다리 포즈 보정**: `sit` 상태 다리 굴곡 값(-1.35/1.70)은 표준 의자 높이 기준. 모델 크기나 의자 높이에 따라 조정 필요.

## 2026-04-21 (second pass — autonomous follow-up)

User direction: *"너가 생각했을 때 필요한건 자동으로 다 진행해주고 나중에 .md로 기능 업뎃한거 저장하고, 나에게 설명해"* — proceed with improvements I flagged in the earlier observations section, then log and explain.

Verified after: `npm run build` ✓ (22 modules transformed, all chunks produced), `python -m compileall backend` ✓.

### Claude model ID is no longer retired + env-overridable; Groq model also env-overridable
- Files: [backend/ai_config.py](backend/ai_config.py), [backend/services/claude_service.py](backend/services/claude_service.py), [electron/main.js](electron/main.js) (example env template).
- Change:
  - Added `CLAUDE_MODEL` and `GROQ_MODEL` to `ai_config.py`, sourced from `APIA_CLAUDE_MODEL` / `APIA_GROQ_MODEL` (fallbacks `CLAUDE_MODEL` / `GROQ_MODEL`).
  - Defaults: `claude-sonnet-4-6` (current Sonnet), `llama-3.3-70b-versatile` (unchanged from prior hardcode).
  - `claude_service.py` imports both and uses them in `_chat_claude` / `_chat_groq`; the old hardcoded `model="claude-sonnet-4-20250514"` is gone.
  - `electron/main.js` `BACKEND_ENV_EXAMPLE_CONTENT` now lists the two keys as commented-out examples so packaged users can discover them from `%APPDATA%/apia/backend-data/backend.env.example`.
- Why: the previous code pinned Claude to a retired Sonnet 4.0 date-suffixed ID (`claude-sonnet-4-20250514`). Future model swaps required a code change and a full backend rebuild. With env overrides, users can roll forward/back (e.g., to `claude-opus-4-7` or `claude-haiku-4-5-20251001`) without touching source.
- Risk: low. If a user's Anthropic account does not have access to `claude-sonnet-4-6`, requests will error cleanly via the existing exception path. They can then set `APIA_CLAUDE_MODEL` to any model ID they have access to.
- Pre-existing `.env.example` files in the user-data dir will **not** be regenerated (the code only writes when absent). Users who want the new keys in their local template can delete it and let the app re-create it on next launch.

### ClaudeService is now lazy — no provider init during module import
- File: [backend/services/claude_service.py](backend/services/claude_service.py).
- Change: removed `self._ensure_mode(self.default_mode)` from `__init__`. Provider initialization happens on first `/chat` call (existing path — `chat()` already calls `_ensure_mode(ai_mode)`).
- Why: `backend/routers/chat.py` instantiates `ClaudeService()` at module import time. With `APIA_AI_MODE=local`, the old init eagerly loaded a multi-GB HF model before FastAPI finished starting, which delayed the `/health` probe and pushed the packaged app toward `[BACKEND_READY_TIMEOUT]`. For Claude/Groq/hf_api modes, the init cost was cheap but still non-zero. Lazy init defers all of that to the first real request.
- Risk: the first chat turn now pays the provider init cost (previously paid at startup). For local HF this can exceed the 30 s frontend request timeout on a cold start. If that becomes a problem, we can add a background warm-up task or pre-select a lighter default; for now the trade-off favors faster startup.

### `_applyBlink` is now dummy-only by explicit marker
- Files: [src/main.js](src/main.js) (`loadDummy`), [src/characterController.js](src/characterController.js) (`_applyBlink`).
- Change:
  - `loadDummy()` now names the head sphere `'dummy-head'`.
  - `_applyBlink` uses `mesh.getObjectByName('dummy-head')` instead of a height-based heuristic (`y > 1.3`) and returns early when the marker is absent.
- Why: the height heuristic happened to only match the dummy model in practice, but it was fragile — any VRM/MMD with a top-level child positioned above y=1.3 would have been scaled unexpectedly. Meanwhile, VRM already blinks through `idleVRM` (`expressionManager.setValue('blink', ...)`) in `main.js`, and MMD blinks are typically morph-driven. Explicit naming makes the controller-level blink clearly scoped to the fallback model.
- Risk: none expected. If a VRM was accidentally relying on the old heuristic blink, that behavior was already unreliable and duplicated with `idleVRM`.

### `motionManager` interpretation offsets no longer silently no-op on array fields
- File: [src/motionManager.js](src/motionManager.js) (`normalizeCharacterProfile`).
- Change: the offset loop now skips non-numeric values and non-numeric target fields. Previously `behaviorTendency.reactionDelayMs + value` coerced array → string → NaN, and `clamp01` returned the fallback unchanged, making the offset a silent no-op (no warning, no error).
- Why: silent no-ops on user-visible config are a design trap — the user could edit `interpretation_presets.json` expecting `reactionDelayMs` offsets to take effect and never notice that only the numeric fields were affected. This keeps the same behavior for numeric fields and cleanly ignores unsupported types instead of pretending to apply them.
- Risk: none for the shipped defaults. Any preset that was relying on array offsets being ignored now just… continues to ignore them, the same way.

### `scheduleAutoBehavior()` is no longer double-scheduled at module load
- File: [src/main.js](src/main.js).
- Change: the unconditional bottom-of-file `scheduleAutoBehavior()` is now gated behind `if (!window.api)`. In Electron, the settings-hydration path inside `window.api.getSettings().then(...)` already calls it once settings load. The bottom call is kept as a fallback for pure-Vite dev environments where `window.api` is absent.
- Why: the old code always ran the bottom call, so the Electron path fired it once at module load and again inside the settings callback. `scheduleAutoBehavior` always clears its previous timer, so there was no leak — but the second call reset the random delay window, which is unnecessary work and made the auto-behavior cadence less predictable on startup.
- Risk: none. Dev-without-Electron path retains the fallback.

---

## 2026-04-21 (first pass)

### Removed dead "character near mouse" detector in chat.js
- File: [src/chat.js](src/chat.js)
- Change: deleted the `window.addEventListener('mousemove', ...)` block inside `startClickThroughManager` that was computing `nearChar` from hardcoded `(innerWidth - 140, innerHeight - 250)` and calling `window.__onCharNearChange`.
- Why: `window.__onCharNearChange` and `window.__lastNearChar` are never assigned anywhere in the repo (verified with grep). The hardcoded screen corner also does not match the actual character position after `frameCharacterCamera` centers the model. It was purely orphan work.
- Risk: none — no consumer existed. If near-character bubble behavior is wanted later, it should be computed from the projected model position, not a fixed corner.

### Fixed VRM model not being removed from scene on character swap (main.js)
- File: [src/main.js](src/main.js), `clearModel()`
- Change: `scene.remove(currentModel.obj)` → `scene.remove(currentModel.root)`; also switched `VRMUtils.deepDispose` argument from `currentModel.obj.scene` to `currentModel.root` for consistency.
- Why: for VRM, `scene.add(vrm.scene)` is what put the model into the tree, but `currentModel.obj` holds the `vrm` wrapper, not `vrm.scene`. So the old line `scene.remove(currentModel.obj)` removed *nothing* — the previous VRM model stayed in the scene graph after a character swap. For MMD and dummy, `obj === root`, so behavior is unchanged there. `currentModel.root` is already the Group that was added to the scene in every branch, so using it uniformly is correct.
- Risk: low. The only behavior difference is that VRM models now actually leave the scene on swap, which is the intended outcome. `deepDispose(vrm.scene)` and `deepDispose(currentModel.root)` are the same object for VRM.

## 2026-04-21 — Motion clip pipeline (manifest + Mixamo conversion scripts)

User asked the agent to fetch Mixamo motions automatically. Mixamo requires
Adobe login/captcha so automated download isn't possible; agreed plan was
**A+C**: (A) app-side manifest wiring so clips are auto-picked when present,
(C) Blender headless conversion scripts so user can drop FBX files and batch
convert.

### A1. New: VRMA folder layout + manifest
- New: [src/assets/motions/vrma/{idle,talk,react,emote}/](src/assets/motions/vrma/) with `.gitkeep`.
- New: [src/assets/motions/manifest.json](src/assets/motions/manifest.json) — maps every motion name in [motionManager.js MOTION_LIBRARY](src/motionManager.js#L9) to a relative clip path + loop/fadeIn hints.
- New: [src/assets/motions/vrma/README.md](src/assets/motions/vrma/README.md) — drop-location guide.
- Why: the motion name set was previously virtual (never resolved to files). Giving each a canonical path means the moment a `.vrma` is dropped into the matching location, it starts playing — no code change, no rebuild config.

### A2. New: [src/motionAssets.js](src/motionAssets.js)
- `resolveMotionAsset(name)` — returns `{ url, loop, fadeIn }` or `null` if either the manifest has no entry OR the file hasn't been dropped yet.
- Uses Vite's `import.meta.glob('./assets/motions/vrma/**/*.vrma', { eager: true, query: '?url' })` so clips get hashed filenames in production builds and are tree-shaken out when not present.
- Why a separate module: keeps main.js from growing another responsibility. Also makes the pipeline unit-testable.

### A3. main.js — `playMotion` wrapper replaces raw `applyMotion` call sites
- File: [src/main.js](src/main.js)
- Change: added `function playMotion(motion)` near the top of the module. It calls `applyMotion(motion)` (procedural layer, always runs) and then, if `resolveMotionAsset` returns a hit, kicks off `playVRMAnimation(url, { loop, fadeIn })` with a `.catch` so a broken clip never breaks the procedural layer.
- Call-site updates:
  - `window.__applyMotion = applyMotion` → `window.__applyMotion = playMotion` (so chat.js talk motions go through the wrapper)
  - `applyMotion(idleMotion)` in `scheduleAutoBehavior` → `playMotion(idleMotion)`
  - `applyMotion(reactMotion)` in `initChat`'s `applyEmotion` → `playMotion(reactMotion)`
- Why: chose a wrapper instead of building the clip logic into `applyMotion` because characterController.js must stay renderer-agnostic (MMD path doesn't know about VRMA).
- Risk: low. With zero clips present, `resolveMotionAsset` returns null and behavior matches previous state exactly. The procedural body layer runs regardless.

### C1. New: [scripts/mixamo-to-vrma.py](scripts/mixamo-to-vrma.py)
- Blender 4.x headless script. Does: FBX import → `mixamorig:*` bone rename → humanoid mapping on the VRM addon extension → attempts VRMA export via `bpy.ops.vrm.export_vrma` (tries several known operator names across addon versions).
- Fallback: if no VRMA export operator is registered, saves a `.blend` next to the target so the user can finish manually. Exits with code 2 in that case so the batch runner surfaces it.
- Why best-effort on the final export: the VRM Blender addon's operator names have shifted across versions; coding against a single name would silently break when the user upgrades. Trying known candidates and falling back is more robust than asserting.

### C2. New: [scripts/convert-mixamo.mjs](scripts/convert-mixamo.mjs)
- Node batch runner. Walks `mixamo-fbx/` (or a custom dir), mirrors its subfolder structure into `src/assets/motions/vrma/`, invokes Blender headless per FBX. `BLENDER_BIN` env var overrides the `blender` command.
- Naming convention: `mixamo-fbx/idle/breath_soft.fbx` → `src/assets/motions/vrma/idle/breath_soft.vrma`. Filenames (sans extension) must match a manifest.json clip entry to be consumed at runtime.

### C3. New: [scripts/README-mixamo.md](scripts/README-mixamo.md)
- Full workflow: Mixamo export settings (FBX Binary, Without Skin, 30fps), folder layout, batch command, troubleshooting for the VRMA operator fallback + wrong-rest-pose cases.
- Also explicit about what the script does NOT do (no auto-download from Mixamo, no cross-skeleton retargeting).

### Verification
- `npm run build` — 25 modules (was 23 after the Layer 3 pass; +1 for motionAssets.js, +1 because Vite sees the manifest.json via JSON import). Bundle growth: +5 kB on main chunk before gzip.
- No `.vrma` files are present yet, so `resolveMotionAsset` returns null for every motion name — app behaves identically to the previous pass. Clips become live the instant any file is dropped into `src/assets/motions/vrma/<category>/<name>.vrma` matching a manifest entry.

### Open items specific to this pass
- **Mixamo bone map coverage**: BONE_MAP in the python script covers the standard 22 humanoid bones. Fingers are not mapped (Mixamo has full finger rigs; VRM can too, but mapping them requires ~30 more entries). Start without them; add finger mapping if talking/gesturing motions look stiff.
- **Rest-pose mismatch risk**: the VRMA clips are baked against the Mixamo rig's T-pose. Apia applies an A-pose (setupVRMRestPose). When a VRMA action plays, the mixer overrides pose, so this works. But when an action ends (non-loop) or fades, the rest pose snaps back to A-pose, which can visibly pop. Consider cross-fading back to procedural layer rather than stopAllAction-ing.
- **No MMD side**: this pass is VRM-only. MMD motion clips (.vmd) still have no manifest. Worth mirroring once VRM side has at least one real clip validated.

## Observations still open for later

- **`ClaudeService` first-chat latency on local mode** — now that init is deferred, the first `/chat` request with `APIA_AI_MODE=local` will block while HF downloads/loads. If local is a common user path, consider an explicit `/warmup` endpoint or a background warm-up task.
- **`TTSService()` still instantiated at router import time** in [backend/routers/voice.py](backend/routers/voice.py#L11). pyttsx3 init is cheap in practice, but it follows the same pattern as the old `ClaudeService` — worth revisiting if startup ever gets tight again.
- **`mesh.getObjectByName('dummy-head')` is called every frame** inside `_applyBlink`. Three.js's implementation walks the subtree each call. For the tiny dummy group this is nothing, but if the blink gate stays this shape and we ever share it with a larger model, cache the reference once per model load.
- **PROJECT_STATUS.md still lists `src/modelLoader.js` as removed** but does not mention that the renderer now takes a promise-based path. When we next touch runtime startup docs, refresh that section.
