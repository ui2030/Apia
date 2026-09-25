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


# Supported modes: auto, local, hf_api, claude, groq, claude_code, ollama_vlm
# (ollama_vlm은 관전 전용 비전 모드 — 채팅/요약 경로는 지원하지 않는다)
AI_MODE = _read_env("APIA_AI_MODE", "AI_MODE", default="auto")
DEFAULT_MEMORY_TURNS = _read_int("APIA_DEFAULT_MEMORY_TURNS", default=10)

# 로컬 학생 모델. Qwen2.5-7B에서 Qwen3-4B로 내렸다 — 7B는 한국어 답변에 중국어를
# 섞는 드리프트가 있었고(구모델의 알려진 문제), 4B는 VRAM을 절반만 쓰면서 야간
# 학습(A-3)의 QLoRA 재학습이 12GB 카드에 들어간다. night-loop-lab 실험이 검증한
# 것도 이 모델이라 학습 레시피와 서빙 모델이 같아진다.
# 구모델로 되돌리려면 backend.env에 `APIA_MODEL_ID=Qwen/Qwen2.5-7B-Instruct`.
# 주의: Qwen3 아키텍처는 transformers>=4.51을 요구한다(4.46에서는 로드 불가).
MODEL_ID = _read_env("APIA_MODEL_ID", "MODEL_ID", default="Qwen/Qwen3-4B-Instruct-2507")

HF_TOKEN = _read_env("APIA_HF_TOKEN", "HF_TOKEN", default="")
ANTHROPIC_KEY = _read_env("APIA_ANTHROPIC_KEY", "ANTHROPIC_KEY", default="")
GROQ_KEY = _read_env("APIA_GROQ_KEY", "GROQ_KEY", default="")

CLAUDE_MODEL = _read_env("APIA_CLAUDE_MODEL", "CLAUDE_MODEL", default="claude-sonnet-4-6")
GROQ_MODEL = _read_env("APIA_GROQ_MODEL", "GROQ_MODEL", default="llama-3.3-70b-versatile")
# 관전 모드(M2) 비전 호출용. GROQ_MODEL 기본값(llama-3.3-70b)은 **텍스트 전용**이라
# 그대로 이미지를 보내면 실패한다. 그래서 비전은 별도 모델 이름으로 분리한다.
# 빈 문자열이면 groq 비전 비활성(관전이 조용히 쉰다). Claude는 전 모델이 비전
# 가능이라 CLAUDE_MODEL을 그대로 쓴다.
GROQ_VISION_MODEL = _read_env(
    "APIA_GROQ_VISION_MODEL", default="meta-llama/llama-4-scout-17b-16e-instruct"
)

# ── claude_code 모드 ────────────────────────────────────────────────────────
# 로컬에 설치된 Claude Code CLI를 구독 로그인 상태 그대로 빌려 쓰는 모드.
# API 키가 없어도 되지만 그만큼 사용자의 구독 사용량을 직접 태우므로 **명시 선택
# 전용**이다 — AUTO_MODE_PRIORITY 기본값에 절대 넣지 않는다(auto가 몰래 고르면
# 사용자가 모르는 사이 구독 한도를 쓴다).
# 빈 문자열이면 CLI 기본 모델(--model 인자 자체를 생략).
CLAUDE_CODE_MODEL = _read_env("APIA_CLAUDE_CODE_MODEL", default="")
# 빈 문자열이면 PATH에서 `claude`를 찾는다(shutil.which가 Windows의 .cmd/PATHEXT를 처리).
CLAUDE_CODE_BIN = _read_env("APIA_CLAUDE_CODE_BIN", default="")

# ── ollama_vlm 모드 (관전 전용) ─────────────────────────────────────────────
# 로컬에 설치된 Ollama의 비전 모델을 HTTP로 부른다. 키가 없고 화면 이미지가 PC를
# 떠나지 않는 대신 첫 호출은 모델 콜드 로드(수 초~십수 초)가 붙는다.
# claude_code와 같은 이유로 **명시 선택 전용** — AUTO_MODE_PRIORITY에 넣지 않는다
# (auto가 몰래 고르면 관전이 로컬 VRAM을 물고 게임과 다툰다).
OLLAMA_BASE_URL = _read_env(
    "APIA_OLLAMA_BASE_URL", default="http://localhost:11434"
).rstrip("/")
OLLAMA_VLM_MODEL = _read_env("APIA_OLLAMA_VLM_MODEL", default="qwen3-vl:4b-instruct")

AUTO_MODE_PRIORITY = tuple(
    item.strip()
    for item in _read_env(
        "APIA_AUTO_MODE_PRIORITY",
        default="groq,claude,hf_api,local"
    ).split(",")
    if item.strip()
)

# local 모드 유휴 해제 — 4bit 양자화라도 7B는 VRAM을 수 GB 물고 있는데, 한 번
# 쓰고 몇 시간 방치되는 게 이 앱의 보통 사용 패턴이다. 분 단위, 0이면 비활성.
LOCAL_IDLE_UNLOAD_MIN = _read_int("APIA_LOCAL_IDLE_UNLOAD_MIN", default=30)

# ── cosyvoice TTS 엔진 (opt-in) ─────────────────────────────────────────────
# 로컬 CosyVoice3로 캐릭터 목소리를 복제해 말하는 TTS 엔진. 기본 체인
# (edge→pyttsx3→silent)은 건드리지 않고, 설정에서 명시 선택했을 때만 탄다.
# 경로가 하나라도 비었거나 존재하지 않으면 엔진은 조용히 비활성 = 기본 폴백.
COSYVOICE_PYTHON = _read_env("APIA_COSYVOICE_PYTHON", default="")
COSYVOICE_REPO = _read_env("APIA_COSYVOICE_REPO", default="")
COSYVOICE_MODEL_DIR = _read_env("APIA_COSYVOICE_MODEL_DIR", default="")
# 참조(캐릭터) 음성. 비우면 DATA_DIR/cosyvoice/prompt.wav → 없으면 edge로
# 한국어 기본 참조를 한 번 만들어 캐시한다(cosyvoice_service 참조).
COSYVOICE_PROMPT_WAV = _read_env("APIA_COSYVOICE_PROMPT_WAV", default="")
# local LLM과 같은 이유 — 0.5B라도 VRAM 4GB대를 상주로 문다. 분 단위, 0이면 비활성.
COSYVOICE_IDLE_UNLOAD_MIN = _read_int("APIA_COSYVOICE_IDLE_UNLOAD_MIN", default=30)

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
