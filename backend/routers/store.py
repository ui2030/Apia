"""
/store router — read-only surface for the shared data infrastructure.

For now this only exposes embedding-model status. Future endpoints will land
here as the higher-level features wire up (memory turns count, indexed-folder
stats, etc.).
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from schemas import EmbeddingStatusResponse

router = APIRouter()


@router.get("/embedding/status", response_model=EmbeddingStatusResponse)
async def embedding_status(request: Request) -> EmbeddingStatusResponse:
    embedding = request.app.state.embedding
    return EmbeddingStatusResponse(**embedding.status())


@router.post("/embedding/warmup", response_model=EmbeddingStatusResponse)
async def embedding_warmup(request: Request) -> EmbeddingStatusResponse:
    """Trigger model load explicitly. Returns the post-attempt status. Errors
    during load are caught and surfaced through the status payload — a 200 with
    `error: "<msg>"` is the contract, not a 500. The renderer reads `error` to
    decide whether to show a retry banner."""
    embedding = request.app.state.embedding
    try:
        await embedding.ensure_ready()
    except Exception:  # noqa: BLE001 — surfaced via status payload
        pass
    return EmbeddingStatusResponse(**embedding.status())
