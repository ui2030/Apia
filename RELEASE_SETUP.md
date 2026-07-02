# Release Setup

This guide covers the packaged Windows build created by `npm run dist:dir` or `npm run dist:win`.

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
APIA_MODEL_ID=Qwen/Qwen2.5-7B-Instruct
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
