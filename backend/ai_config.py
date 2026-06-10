"""
Runtime AI configuration for the Apia backend.
Environment variables are preferred so packaged builds can be configured
without editing source files.
"""

import os
from pathlib import Path


def _iter_env_file_candidates():
    explicit_env_file = os.getenv("APIA_ENV_FILE", "").strip()
    if explicit_env_file:
        yield Path(explicit_env_file)

    data_dir = os.getenv("DATA_DIR", "").strip()
    if data_dir:
        yield Path(data_dir) / "backend.env"

    module_dir = Path(__file__).resolve().parent
    yield module_dir / "backend.env"
    yield module_dir.parent / "backend.env"
    yield Path.cwd() / "backend.env"


def _load_env_file() -> str | None:
    seen = set()

    for candidate in _iter_env_file_candidates():
        resolved = candidate.expanduser().resolve(strict=False)
        resolved_key = str(resolved).lower()
        if resolved_key in seen or not resolved.is_file():
            continue

        seen.add(resolved_key)
        for raw_line in resolved.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip().lstrip("\ufeff")
            if not line or line.startswith("#"):
                continue

            if line.startswith("export "):
                line = line[7:].strip()

            if "=" not in line:
                continue

            name, value = line.split("=", 1)
            name = name.strip()
            value = value.strip()

            if not name or name in os.environ:
                continue

            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]

            os.environ[name] = value

        return str(resolved)

    return None


LOADED_ENV_FILE = _load_env_file()


def _read_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value not in (None, ""):
            return value
    return default


def _read_int(*names: str, default: int) -> int:
    raw = _read_env(*names, default="")
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Supported modes: auto, local, hf_api, claude, groq
AI_MODE = _read_env("APIA_AI_MODE", "AI_MODE", default="auto")
DEFAULT_MEMORY_TURNS = _read_int("APIA_DEFAULT_MEMORY_TURNS", default=10)

MODEL_ID = _read_env("APIA_MODEL_ID", "MODEL_ID", default="Qwen/Qwen2.5-7B-Instruct")

HF_TOKEN = _read_env("APIA_HF_TOKEN", "HF_TOKEN", default="")
ANTHROPIC_KEY = _read_env("APIA_ANTHROPIC_KEY", "ANTHROPIC_KEY", default="")
GROQ_KEY = _read_env("APIA_GROQ_KEY", "GROQ_KEY", default="")

CLAUDE_MODEL = _read_env("APIA_CLAUDE_MODEL", "CLAUDE_MODEL", default="claude-sonnet-4-6")
GROQ_MODEL = _read_env("APIA_GROQ_MODEL", "GROQ_MODEL", default="llama-3.3-70b-versatile")

AUTO_MODE_PRIORITY = tuple(
    item.strip()
    for item in _read_env(
        "APIA_AUTO_MODE_PRIORITY",
        default="groq,claude,hf_api,local"
    ).split(",")
    if item.strip()
)

MAX_NEW_TOKENS = _read_int("APIA_MAX_NEW_TOKENS", default=512)
TEMPERATURE = float(_read_env("APIA_TEMPERATURE", default="0.7"))
TOP_P = float(_read_env("APIA_TOP_P", default="0.9"))

# ── Long-term memory (step 2) ───────────────────────────────────────────────
# `MEMORY_ENABLED=false`는 service+router 양쪽에서 no-op으로 동작시킨다.
# Codex MUST-FIX: provider unavailable 시 echo summary 대신 비활성 + last_error.
MEMORY_ENABLED = _read_env("APIA_MEMORY_ENABLED", default="true").lower() not in (
    "0", "false", "no", "off"
)
MEMORY_RETRIEVE_TOP_K = _read_int("APIA_MEMORY_RETRIEVE_TOP_K", default=5)
MEMORY_MIN_SCORE = float(_read_env("APIA_MEMORY_MIN_SCORE", default="0.55"))
MEMORY_SUMMARY_EVERY = _read_int("APIA_MEMORY_SUMMARY_EVERY", default=20)
# retrieve 시 최근 N개의 chat_turn은 이미 `history` 인자로 들어오므로 검색에서 빼서
# system prompt에 중복 주입되지 않도록 한다. `DEFAULT_MEMORY_TURNS * 2`가 기본
# (user/assistant 쌍 기준 turns 수).
MEMORY_EXCLUDE_RECENT = _read_int(
    "APIA_MEMORY_EXCLUDE_RECENT", default=DEFAULT_MEMORY_TURNS * 2
)

# ── File search (step 3) ────────────────────────────────────────────────────
FILES_ENABLED = _read_env("APIA_FILES_ENABLED", default="true").lower() not in (
    "0", "false", "no", "off"
)
FILES_CHUNK_CHARS = _read_int("APIA_FILES_CHUNK_CHARS", default=1000)
FILES_CHUNK_OVERLAP = _read_int("APIA_FILES_CHUNK_OVERLAP", default=200)
FILES_MAX_FILE_BYTES = _read_int("APIA_FILES_MAX_FILE_BYTES", default=5 * 1024 * 1024)
FILES_MAX_FILES_PER_FOLDER = _read_int("APIA_FILES_MAX_FILES_PER_FOLDER", default=5000)
FILES_RETRIEVE_TOP_K = _read_int("APIA_FILES_RETRIEVE_TOP_K", default=4)
FILES_MIN_SCORE = float(_read_env("APIA_FILES_MIN_SCORE", default="0.55"))

# 두 출처(기억/파일)가 system prompt에 합쳐질 때의 최종 본문 글자수 cap.
# 점수 낮은 항목부터 잘려서 cap 이하로 떨어뜨린다. section label + separator
# 포함 길이까지 한 번 더 자른다(Codex NICE-TO-HAVE round 2).
CONTEXT_MAX_CHARS = _read_int("APIA_CONTEXT_MAX_CHARS", default=6000)

# ── Web search (step 4) ────────────────────────────────────────────────────
# WEB_PROVIDER ∈ {"none", "tavily", "brave"}. "none"이거나 API_KEY 없으면
# WebSearchService.enabled = False, search()는 빈 리스트 + last_error 반환.
WEB_PROVIDER = _read_env("APIA_WEB_PROVIDER", default="none").lower()
WEB_API_KEY = _read_env("APIA_WEB_API_KEY", default="")
WEB_MAX_RESULTS = _read_int("APIA_WEB_MAX_RESULTS", default=5)
WEB_TIMEOUT_SECONDS = _read_int("APIA_WEB_TIMEOUT_SECONDS", default=10)

SYSTEM_PROMPT = """당신은 사용자의 바탕화면 위에서 함께 있는 캐릭터형 AI 비서 'Apia'입니다.
3D 캐릭터 모습으로 바탕화면에 존재하며, 사용자와 자연스럽게 대화합니다.

성격:
- 밝고 친절하고 이모지를 적절히 사용
- 2~3문장으로 간결하게 답변
- 사용자의 감정에 공감하고 배려
- 바탕화면 세계에서 보고 느끼는 듯한 표현을 가끔 사용

반드시 응답 끝에 [EMOTION:감정] 태그를 추가하세요.
가능한 감정: happy, sad, angry, surprised, neutral, relaxed
"""
