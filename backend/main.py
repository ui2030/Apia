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

from ai_config import (
    FILES_CHUNK_CHARS,
    FILES_CHUNK_OVERLAP,
    FILES_ENABLED,
    FILES_MAX_FILE_BYTES,
    FILES_MAX_FILES_PER_FOLDER,
    FILES_MIN_SCORE,
    FILES_RETRIEVE_TOP_K,
    MEMORY_ENABLED,
    MEMORY_EXCLUDE_RECENT,
    MEMORY_MIN_SCORE,
    MEMORY_RETRIEVE_TOP_K,
    MEMORY_SUMMARY_EVERY,
    WEB_API_KEY,
    WEB_MAX_RESULTS,
    WEB_PROVIDER,
    WEB_TIMEOUT_SECONDS,
)
from routers import chat, store, stt, tts, voice, warmup
from schemas import HealthResponse
from services.embedding_service import EmbeddingService
from services.file_index_service import FileIndexService
from services.memory_service import MemoryService
from services.store_service import StoreService
from services.web_search_service import WebSearchService

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

    # MemoryService는 routers.chat의 ClaudeService 인스턴스를 그대로 share한다.
    # warmup/chat 라우터와 같은 provider 객체를 쓰는 게 init lock/state 일관성에
    # 중요(따로 만들면 _initialized_modes 캐시가 따로 굴러서 같은 키 두 번 init).
    #
    # Codex MUST-FIX (round 2): provider 자체가 없으면(키 없음 + local 라이브러리도
    # 없음) summarize_fn=None을 진짜로 전달해야 MemoryService가 "summarize disabled
    # (no provider available)" 경로로 빠진다. 그래야 stats.last_error 메시지가
    # provider 없음 사유와 일반 summarize 실패를 구분해서 보여줄 수 있다.
    # 시작 시점 결정이라 사용자가 키 추가 후엔 백엔드 자동 재시작(485cc18 기능)이
    # 트리거되어 자연스럽게 갱신된다.
    summarize_fn = None
    if MEMORY_ENABLED:
        from routers.chat import claude as _claude_singleton
        if (
            _claude_singleton.resolve_auto_target() is not None
            or _claude_singleton.list_available_modes()
        ):
            summarize_fn = _claude_singleton.summarize

    memory_service = MemoryService(
        store=store_service,
        embedding=embedding_service,
        summarize_fn=summarize_fn,
        enabled=MEMORY_ENABLED,
        retrieve_top_k=MEMORY_RETRIEVE_TOP_K,
        min_score=MEMORY_MIN_SCORE,
        summary_every=MEMORY_SUMMARY_EVERY,
        exclude_recent=MEMORY_EXCLUDE_RECENT,
    )

    file_index_service = FileIndexService(
        store=store_service,
        embedding=embedding_service,
        enabled=FILES_ENABLED,
        chunk_chars=FILES_CHUNK_CHARS,
        chunk_overlap=FILES_CHUNK_OVERLAP,
        max_file_bytes=FILES_MAX_FILE_BYTES,
        max_files_per_folder=FILES_MAX_FILES_PER_FOLDER,
        retrieve_top_k=FILES_RETRIEVE_TOP_K,
        min_score=FILES_MIN_SCORE,
    )

    web_search_service = WebSearchService(
        store=store_service,
        provider=WEB_PROVIDER,
        api_key=WEB_API_KEY,
        max_results=WEB_MAX_RESULTS,
        timeout_seconds=WEB_TIMEOUT_SECONDS,
    )

    app.state.store = store_service
    app.state.embedding = embedding_service
    app.state.memory = memory_service
    app.state.files = file_index_service
    app.state.web = web_search_service
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
