"""
Single source of truth for FastAPI request/response shapes.

Adding `response_model=...` on the routers makes FastAPI generate OpenAPI from
these models and enforce shape at runtime. The contract tests under
backend/tests/test_contracts.py exercise each endpoint and assert the returned
payload satisfies the matching model — so dropping a key here (or in a router)
will break the test before it ships.

Why centralize: routers used to declare ad-hoc inline models (chat.py) or raw
dict returns (voice/warmup/stt). Future-you grepping for "what does /warmup
actually return" should hit this file first.
"""

from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field


# ── /health ────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: Literal["ok"]


# ── /chat ──────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = Field(default_factory=list)
    ai_mode: Optional[str] = None
    memory_turns: Optional[int] = Field(default=None, ge=1, le=50)
    # step 4: 사용자가 명시 요청 시 (또는 설정 토글로) 웹 검색을 한 번 돈다.
    # default false — provider 미설정인 환경에서 무음 실패를 만들지 않기 위함.
    use_web: bool = False


class ChatCitation(BaseModel):
    """An assistant-emitted `[N]` marker resolved to its source. Same shape
    whether the source is web (step 4), file (future), or memory (future)."""
    marker_number: int
    source_kind: Literal["web", "file", "memory"]
    source_path: Optional[str] = None
    title: Optional[str] = None
    snippet: Optional[str] = None
    page: Optional[int] = None


class ChatResponse(BaseModel):
    reply: str
    emotion: Optional[str] = "neutral"  # happy | sad | angry | surprised | neutral
    citations: List[ChatCitation] = Field(default_factory=list)


# ── /voices ────────────────────────────────────────────────────────────────

class VoiceItem(BaseModel):
    """Loose by design: pyttsx3 / VoiceManager surface different fields per
    platform and per training pipeline. Tightening this beyond id+name would
    couple the schema to one backend and silently strip data the UI uses."""

    id: str
    name: str

    model_config = {"extra": "allow"}


class VoicesResponse(BaseModel):
    voices: List[VoiceItem]
    unsupported_custom_voices: List[VoiceItem]


# ── /warmup ────────────────────────────────────────────────────────────────
#
# POST returns one of two discriminated shapes (ready vs. warming). GET returns
# a status snapshot. Keeping these distinct lets callers branch on `status`
# without parsing other fields, and lets the contract test assert each branch
# independently.

class WarmupReadyResponse(BaseModel):
    status: Literal["ready"]
    mode: str


class WarmupWarmingResponse(BaseModel):
    status: Literal["warming"]
    mode: str


WarmupPostResponse = Union[WarmupReadyResponse, WarmupWarmingResponse]


class WarmupStatusResponse(BaseModel):
    initialized_modes: List[str]
    # `available_modes` lists every provider whose prerequisites (lib + key)
    # are satisfied right now — *not* what's been initialized yet. Settings UI
    # uses this to tell the user "auto picked nothing because no provider has
    # credentials" vs. "auto is fine, claude is just lazy-warming".
    available_modes: List[str]
    # `auto_target` is what auto mode would resolve to RIGHT NOW given
    # AUTO_MODE_PRIORITY. Null when no provider has prereqs (auto would go
    # to "fallback"). Different from `available_modes[0]` because available
    # is alphabetically sorted; this is priority-ordered.
    #
    # Aggregate invariant: auto_target is null OR present in available_modes.
    # Enforced by router-side assertion + a domain test.
    auto_target: Optional[str] = None
    mode: str
    default_mode: str
    warming: bool
    # last_error format: "[init:<mode>] <message>" for swallowed provider init
    # failures (3C), or "[warmup] <message>" for warmup-task failures (the
    # pre-existing source). UI renders the string as-is in the Error row.
    last_error: Optional[str] = None


# ── /tts ───────────────────────────────────────────────────────────────────
# Response is binary audio/wav — no pydantic model. Only the request is typed.

class TTSRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None


# ── /stt ───────────────────────────────────────────────────────────────────

class STTResponse(BaseModel):
    text: str


# ── /store ─────────────────────────────────────────────────────────────────
#
# Surfaces the embedding model lifecycle (loaded / loading / error) so the
# settings UI can show "downloading model… 90 MB" instead of a frozen-looking
# screen on first run. Wire this to a renderer toast/progress bar in step 3.

class EmbeddingStatusResponse(BaseModel):
    model_name: str
    loaded: bool
    loading: bool
    error: Optional[str] = None
    dim: int


# ── /store/memory ──────────────────────────────────────────────────────────
#
# stats() surface for the settings UI. `enabled=false` means the user (or
# packaging policy) turned memory off — the renderer should grey out the
# "기억 강제 요약" button instead of letting it fire and get a 409.
#
# `last_error` includes embed failures, BLOB dim mismatches, and summarize
# call failures with `<stage>: <type>: <message>` prefix so the UI can show
# *which* part failed without an extra field.

class MemoryStatsResponse(BaseModel):
    enabled: bool
    turn_count: int
    summary_count: int
    last_summary_at: Optional[int] = None
    embeddings_missing: int
    summary_every: int
    last_error: Optional[str] = None


class MemorySummarizeResponse(BaseModel):
    # `summary_id` is non-null iff a new summary was actually written this call.
    # `null` means: enabled=false, provider unavailable, threshold not reached,
    # or the summary call failed — in every case `stats.last_error` carries why.
    summary_id: Optional[int] = None
    stats: MemoryStatsResponse


# ── /store/files ───────────────────────────────────────────────────────────
#
# File search surface (step 3). The renderer shows the folder allowlist + a
# "재인덱싱" button + a drag-and-drop text box. Same 200-always convention as
# /store/memory: business outcomes (folder overlap rejected, file index
# yielded zero new chunks, etc.) ride on the payload, not the status code.

class FileFolderEntry(BaseModel):
    id: int
    path: str
    added_at: int
    last_indexed_at: Optional[int] = None


class FileFoldersResponse(BaseModel):
    enabled: bool
    folders: List[FileFolderEntry]


class FileFolderAddRequest(BaseModel):
    path: str


class FileFolderAddResponse(BaseModel):
    id: Optional[int] = None
    path: str
    status: str  # "added" | "exists" | "rejected"
    reason: Optional[str] = None


class FileFolderRemoveResponse(BaseModel):
    removed: bool
    chunks_deleted: int


class FileFolderReindexRequest(BaseModel):
    path: str
    force: bool = False


class FileFolderReindexResponse(BaseModel):
    folder: str
    files_seen: int
    files_indexed: int
    files_unchanged: int
    files_failed: int
    chunks_added: int
    warnings: dict


class FileIngestTextRequest(BaseModel):
    label: str
    text: str


class FileIngestTextResponse(BaseModel):
    chunks_added: int
    source_path: Optional[str] = None


class FileStatsResponse(BaseModel):
    enabled: bool
    folder_count: int
    chunk_count: int
    indexed_count: int
    dropped_count: int
    warnings: dict
    last_error: Optional[str] = None


# ── /store/web ─────────────────────────────────────────────────────────────

class WebStatsResponse(BaseModel):
    enabled: bool
    provider: str
    citation_count: int
    last_error: Optional[str] = None


class WebSearchRequest(BaseModel):
    query: str


class WebSearchResultItem(BaseModel):
    title: str
    url: str
    snippet: str
    score: float = 0.0


class WebSearchResponse(BaseModel):
    enabled: bool
    provider: str
    results: List[WebSearchResultItem] = Field(default_factory=list)
    last_error: Optional[str] = None


class TurnCitationsResponse(BaseModel):
    turn_id: int
    citations: List[ChatCitation]
