"""
FastAPI backend entrypoint for the Apia desktop assistant.
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import chat, store, stt, tts, voice, warmup
from schemas import HealthResponse
from services.embedding_service import EmbeddingService
from services.store_service import StoreService

logger = logging.getLogger(__name__)


def _resolve_data_dir() -> Path:
    """DATA_DIR is set by Electron's backend spawn (electron/main.js) to point
    at %APPDATA%/apia/backend-data. In dev mode (no DATA_DIR) we fall back to
    the source-tree backend/ folder so a `python -m uvicorn` run still works."""
    raw = os.getenv("DATA_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize shared infra exactly once per process. The Store opens SQLite
    # and runs pending migrations; the Embedding service stays lazy — model
    # download fires on the first /store/embedding/warmup or actual embed
    # request, so a backend that never needs embeddings starts in <1s.
    data_dir = _resolve_data_dir()
    store_service = StoreService(data_dir / "apia.db")
    try:
        await store_service.initialize()
    except Exception:
        logger.exception("[startup] store initialize failed")
        raise

    embedding_service = EmbeddingService()

    app.state.store = store_service
    app.state.embedding = embedding_service
    app.state.data_dir = data_dir

    try:
        yield
    finally:
        await store_service.close()


app = FastAPI(title="AI Assistant Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router, prefix="/chat", tags=["chat"])
app.include_router(tts.router, prefix="/tts", tags=["tts"])
app.include_router(stt.router, prefix="/stt", tags=["stt"])
app.include_router(voice.router, prefix="/voices", tags=["voice"])
app.include_router(warmup.router, prefix="/warmup", tags=["warmup"])
app.include_router(store.router, prefix="/store", tags=["store"])


@app.get("/health", response_model=HealthResponse)
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "AI Assistant Backend is running"}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("APIA_BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("APIA_BACKEND_PORT", "8000")),
        reload=False,
        log_level="info",
    )
