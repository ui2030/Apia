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

from typing import List, Literal, Optional, Union

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


class ChatResponse(BaseModel):
    reply: str
    emotion: Optional[str] = "neutral"  # happy | sad | angry | surprised | neutral


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
