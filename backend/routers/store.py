"""
/store router — read-only surface for the shared data infrastructure.

Now hosts two feature sub-trees:
  - /store/embedding/{status,warmup}: lifecycle for the embedding model.
  - /store/memory/{stats,summarize}: long-term memory diagnostics + manual
    force-summarize. summarize returns 200 even when nothing happened — the
    `summary_id: null` + `stats.last_error` payload tells the renderer why.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from schemas import (
    ChatCitation,
    EmbeddingStatusResponse,
    FileFolderAddRequest,
    FileFolderAddResponse,
    FileFolderReindexRequest,
    FileFolderReindexResponse,
    FileFolderRemoveResponse,
    FileFoldersResponse,
    FileIngestTextRequest,
    FileIngestTextResponse,
    FileStatsResponse,
    MemoryStatsResponse,
    MemorySummarizeResponse,
    TurnCitationsResponse,
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
    WebStatsResponse,
)

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


@router.get("/memory/stats", response_model=MemoryStatsResponse)
async def memory_stats(request: Request) -> MemoryStatsResponse:
    memory = request.app.state.memory
    return MemoryStatsResponse(**await memory.stats())


@router.post("/memory/summarize", response_model=MemorySummarizeResponse)
async def memory_summarize(request: Request) -> MemorySummarizeResponse:
    """Force a roll-up summary now (instead of waiting for the next chat to
    cross the threshold). Returns `summary_id` if a row was written, else null.

    Always 200: provider-unavailable / disabled / below-threshold all have to
    distinguish from genuine errors, so the body carries the reason in
    `stats.last_error`. A 4xx here would force the UI to parse status codes."""
    memory = request.app.state.memory
    summary_id = await memory.summarize_if_needed()
    stats = await memory.stats()
    return MemorySummarizeResponse(
        summary_id=summary_id,
        stats=MemoryStatsResponse(**stats),
    )


# ── /store/files ───────────────────────────────────────────────────────────

@router.get("/files/folders", response_model=FileFoldersResponse)
async def files_list_folders(request: Request) -> FileFoldersResponse:
    files = request.app.state.files
    folders = await files.list_folders() if files.enabled else []
    return FileFoldersResponse(enabled=files.enabled, folders=folders)


@router.post("/files/folders", response_model=FileFolderAddResponse)
async def files_add_folder(
    req: FileFolderAddRequest, request: Request
) -> FileFolderAddResponse:
    """Always 200. status='rejected' carries `reason` when add_folder raised
    (overlap with an existing entry, path not a directory, indexing
    disabled). The renderer surfaces `reason` to the user inline."""
    files = request.app.state.files
    if not files.enabled:
        return FileFolderAddResponse(
            id=None, path=req.path, status="rejected",
            reason="file indexing disabled",
        )
    try:
        result = await files.add_folder(req.path)
    except (FileNotFoundError, ValueError) as error:
        return FileFolderAddResponse(
            id=None, path=req.path, status="rejected", reason=str(error),
        )
    return FileFolderAddResponse(
        id=result.get("id"),
        path=result["path"],
        status=result["status"],
    )


@router.delete("/files/folders", response_model=FileFolderRemoveResponse)
async def files_remove_folder(
    req: FileFolderAddRequest, request: Request
) -> FileFolderRemoveResponse:
    files = request.app.state.files
    result = await files.remove_folder(req.path)
    return FileFolderRemoveResponse(**result)


@router.post("/files/reindex", response_model=FileFolderReindexResponse)
async def files_reindex(
    req: FileFolderReindexRequest, request: Request
) -> FileFolderReindexResponse:
    files = request.app.state.files
    if not files.enabled:
        return FileFolderReindexResponse(
            folder=req.path, files_seen=0, files_indexed=0,
            files_unchanged=0, files_failed=0, chunks_added=0, warnings={},
        )
    try:
        result = await files.index_folder(req.path, force=req.force)
    except ValueError as error:
        # 화이트리스트 외 경로 — UI 흐름에서는 폴더 추가 후에만 reindex가 가능해야
        # 한다. 발생했다면 클라이언트 측 버그라 400으로 명시.
        raise HTTPException(status_code=400, detail=str(error)) from error
    return FileFolderReindexResponse(
        folder=result.folder,
        files_seen=result.files_seen,
        files_indexed=result.files_indexed,
        files_unchanged=result.files_unchanged,
        files_failed=result.files_failed,
        chunks_added=result.chunks_added,
        warnings=dict(result.warnings),
    )


@router.post("/files/ingest_text", response_model=FileIngestTextResponse)
async def files_ingest_text(
    req: FileIngestTextRequest, request: Request
) -> FileIngestTextResponse:
    files = request.app.state.files
    result = await files.ingest_text(req.label, req.text)
    return FileIngestTextResponse(**result)


@router.get("/files/stats", response_model=FileStatsResponse)
async def files_stats(request: Request) -> FileStatsResponse:
    files = request.app.state.files
    stats = await files.stats()
    return FileStatsResponse(**stats)


# ── /store/web ─────────────────────────────────────────────────────────────

@router.get("/web/stats", response_model=WebStatsResponse)
async def web_stats(request: Request) -> WebStatsResponse:
    web = request.app.state.web
    return WebStatsResponse(**await web.stats())


@router.post("/web/search", response_model=WebSearchResponse)
async def web_search(req: WebSearchRequest, request: Request) -> WebSearchResponse:
    """단건 검색. provider 미설정/키 없음 시 200 + enabled=false + last_error 채움.
    UI에서 "검색 한 번 돌려보기" 버튼이 누른 사람에게 사유를 그대로 보여주기 위함."""
    web = request.app.state.web
    results = await web.search(req.query)
    stats = await web.stats()
    return WebSearchResponse(
        enabled=stats["enabled"],
        provider=stats["provider"],
        results=[
            WebSearchResultItem(
                title=r.title, url=r.url, snippet=r.snippet, score=r.score,
            )
            for r in results
        ],
        last_error=stats["last_error"],
    )


@router.get(
    "/web/citations/{turn_id}",
    response_model=TurnCitationsResponse,
)
async def web_citations_for_turn(turn_id: int, request: Request) -> TurnCitationsResponse:
    web = request.app.state.web
    rows = await web.list_citations_for_turn(turn_id)
    return TurnCitationsResponse(
        turn_id=turn_id,
        citations=[
            ChatCitation(
                marker_number=r["marker_number"],
                source_kind=r["source_kind"],
                source_path=r["source_path"],
                title=r["title"],
                snippet=r["snippet"],
                page=r["page"],
            )
            for r in rows
        ],
    )
