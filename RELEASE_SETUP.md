# Release Setup

This guide covers the packaged Windows build created by `npm run dist:dir` or `npm run dist:win`.

## 릴리스 절차 5줄

1. 버전 올리기: `package.json`의 `version` 수정 → 의존성이 바뀌었으면 `npm run notices`로 `THIRD_PARTY_NOTICES.md` 재생성 → 커밋.
2. 태그: `git tag v<version>` (예: `v1.0.0`, 프리릴리스는 `v1.0.0-alpha.2`) — release:check가 HEAD의 이 태그를 확인한다.
3. 점검: `$env:APIA_PACKAGING_PYTHON="<파이썬 3.11 실행 파일 경로, 예: C:\Python311\python.exe>"; npm run release:check` — verify → 고지 최신 → 깨끗한 작업트리 → 태그 → `dist:win` → `smoke:release` 순. 실패 시 실패 단계 한 줄이 찍히고(태그는 `git tag -d`로 지우고 고친 뒤 다시), 성공하면 `release/`에 `Apia-Setup-<version>.exe` 하나만 남는다.
4. 배포: `git push --follow-tags` → GitHub Releases에 새 릴리스 만들고 `Apia-Setup-<version>.exe`와 `THIRD_PARTY_NOTICES.md`를 첨부.
5. 메모: 릴리스 노트에 바뀐 점 + 아래 경고 문구를 붙인다.
   > 이 설치 파일은 코드 서명이 되어 있지 않습니다. 처음 실행하면 Windows SmartScreen이 "Windows의 PC 보호" 경고를 띄울 수 있습니다 — **추가 정보 → 실행**을 누르면 설치됩니다.

## Runtime Layout

- App bundle: `release/win-unpacked/`
- Packaged backend executable: `release/win-unpacked/resources/backend/ApiaBackend.exe`
- User runtime data directory: `%APPDATA%/apia/backend-data`
- Example backend config file: `%APPDATA%/apia/backend-data/backend.env.example`
- Optional live backend config file: `%APPDATA%/apia/backend-data/backend.env`

The Electron app creates `%APPDATA%/apia/backend-data` on startup and writes `backend.env.example` if it does not exist yet.
The folder name is lowercase because Electron derives `userData` from the packaged app name.

## Recommended AI Mode

Use `APIA_AI_MODE=auto` for packaged releases.

Why:

- the packaged backend intentionally excludes heavyweight local model stacks such as `torch` and `transformers`
- `auto` can safely pick `groq`, `claude`, or `hf_api` when their credentials are available
- stale `local` settings are normalized back to `auto` in the packaged desktop app

## backend.env Example

Create `%APPDATA%/apia/backend-data/backend.env` with values like:

```env
APIA_AI_MODE=auto
APIA_GROQ_KEY=your_groq_key
# APIA_ANTHROPIC_KEY=your_anthropic_key
# APIA_HF_TOKEN=your_huggingface_token
APIA_MODEL_ID=Qwen/Qwen3-4B-Instruct-2507
APIA_DEFAULT_MEMORY_TURNS=10
APIA_AUTO_MODE_PRIORITY=groq,claude,hf_api,local
```

Notes:

- environment variables already set on the machine still win over `backend.env`
- `backend.env` is read at backend startup
- quoted values like `"value"` or `'value'` are supported

## Verification Checklist

Run these before sharing a build:

```powershell
npm run verify
python -m compileall backend
npm run build:backend
node scripts/verify-release.mjs
npm run dist:dir
```

## Known Deployment Limits

- The packaged backend does not include the full local LLM runtime.
- `local` mode therefore requires a separate full build that bundles `torch` and `transformers`.
- The frontend still emits a large `vendor-three` chunk warning during build, but the packaged app completes successfully.
