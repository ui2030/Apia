"""
Response-shape contract tests for the FastAPI routes.

Each test validates the returned payload against the canonical pydantic model
in backend/schemas.py. If a router starts returning a different shape, or a
schema gains/loses a required field without a matching router update, the test
fails — that's the whole point.

These tests deliberately don't assert on values (e.g. the actual reply text),
only on shape and required keys. Value assertions belong in service-level
tests, not contract tests.
"""
from __future__ import annotations

from io import BytesIO

from schemas import (
    ChatResponse,
    EmbeddingStatusResponse,
    FileFolderAddResponse,
    FileFolderReindexResponse,
    FileFolderRemoveResponse,
    FileFoldersResponse,
    FileIngestTextResponse,
    FileStatsResponse,
    HealthResponse,
    MemoryStatsResponse,
    MemorySummarizeResponse,
    STTResponse,
    TurnCitationsResponse,
    VoicesResponse,
    WarmupReadyResponse,
    WarmupStatusResponse,
    WarmupWarmingResponse,
    WebSearchResponse,
    WebStatsResponse,
)


def test_health_shape(client):
    response = client.get("/health")
    assert response.status_code == 200
    HealthResponse.model_validate(response.json())


def test_chat_response_shape(client):
    payload = {"message": "hi", "history": []}
    response = client.post("/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert set(data.keys()) >= {"reply", "emotion"}
    ChatResponse.model_validate(data)


def test_voices_response_shape(client, patched_voice):
    response = client.get("/voices")
    assert response.status_code == 200
    data = response.json()
    assert "voices" in data and "unsupported_custom_voices" in data
    VoicesResponse.model_validate(data)


def test_warmup_post_ready_shape(client, patched_voice, patched_stt, fake_claude):
    # fake_claude has is_mode_initialized → True by default, so POST short-circuits
    # to the "ready" branch.
    fake_claude.is_mode_initialized.return_value = True
    response = client.post("/warmup")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    WarmupReadyResponse.model_validate(data)


def test_warmup_post_warming_shape(client, patched_voice, patched_stt, fake_claude, monkeypatch):
    # Force the warming branch by claiming the target mode is not yet initialized.
    # Also reset module-level _warm_task so the prior "ready" test doesn't leave
    # a completed task that short-circuits this one.
    from routers import warmup as warmup_module

    fake_claude.is_mode_initialized.return_value = False
    monkeypatch.setattr(warmup_module, "_warm_task", None)
    monkeypatch.setattr(warmup_module, "_last_error", None)

    response = client.post("/warmup")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "warming"
    WarmupWarmingResponse.model_validate(data)


def test_warmup_get_status_shape(client, fake_claude):
    response = client.get("/warmup")
    assert response.status_code == 200
    data = response.json()
    # All required keys must be present — this is the contract the settings UI
    # reads. step 2-4 added `memory_enabled` / `files_enabled` / `web_enabled`
    # / `web_provider` so a single warmup probe surfaces every wired feature's
    # state in one round-trip.
    assert set(data.keys()) >= {
        "initialized_modes", "available_modes", "auto_target",
        "mode", "default_mode", "warming", "last_error",
        "memory_enabled", "files_enabled", "web_enabled", "web_provider"
    }
    WarmupStatusResponse.model_validate(data)
    # In the test env the lifespan wires real MemoryService / FileIndexService
    # / WebSearchService instances; their enabled flags must be booleans (not
    # null/None) when the lifespan actually ran. web_enabled is False because
    # APIA_WEB_PROVIDER defaults to "none".
    assert data["memory_enabled"] is True
    assert data["files_enabled"] is True
    assert data["web_enabled"] is False
    assert data["web_provider"] == "none"


def test_warmup_aggregate_invariant_auto_target_in_available(client, fake_claude):
    # The aggregate invariant: auto_target is null OR present in available_modes.
    # Drift here would mean the service returned a target it can't actually use.
    response = client.get("/warmup")
    data = response.json()
    if data["auto_target"] is not None:
        assert data["auto_target"] in data["available_modes"]


def test_warmup_last_error_init_provenance(client, fake_claude, monkeypatch):
    # When a provider init failed but no warmup task error is in flight, the
    # response's last_error carries the `[init:<mode>]` prefix.
    from routers import warmup as warmup_module
    monkeypatch.setattr(warmup_module, "_last_error", None)
    fake_claude.get_last_init_error.return_value = {
        "mode": "claude", "message": "AuthenticationError: bad key"
    }
    response = client.get("/warmup")
    data = response.json()
    assert data["last_error"] == "[init:claude] AuthenticationError: bad key"


def test_warmup_last_error_task_provenance_wins(client, fake_claude, monkeypatch):
    # When BOTH a task error and an init error exist, the task error wins
    # (it's the most recent in-flight failure) and gets the `[warmup]` prefix.
    from routers import warmup as warmup_module
    monkeypatch.setattr(warmup_module, "_last_error", "TimeoutError: too slow")
    fake_claude.get_last_init_error.return_value = {
        "mode": "claude", "message": "should not appear"
    }
    response = client.get("/warmup")
    data = response.json()
    assert data["last_error"] == "[warmup] TimeoutError: too slow"


def test_tts_shape(client, patched_voice):
    # /tts returns binary audio, so no pydantic model — the contract is
    # `200 + Content-Type: audio/wav + non-empty body`. The stubbed
    # synthesize returns a tiny WAV header so we just sanity-check the wire
    # contract.
    response = client.post("/tts", json={"text": "hello", "voice_id": None})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content.startswith(b"RIFF")


def test_stt_transcribe_shape(client, patched_stt):
    # The route reads the upload via `await file.read()` but our stubbed whisper
    # returns a fixed string regardless of input. A tiny in-memory wav is enough.
    fake_audio = BytesIO(b"RIFF\x00\x00\x00\x00WAVE")
    response = client.post(
        "/stt/transcribe",
        files={"file": ("clip.wav", fake_audio, "audio/wav")},
    )
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    STTResponse.model_validate(data)


def test_embedding_status_shape_before_load(client):
    # /store/embedding/status is a read-only probe — never triggers a load —
    # so we can assert it returns `loaded:false` cleanly on a fresh process.
    response = client.get("/store/embedding/status")
    assert response.status_code == 200
    data = response.json()
    EmbeddingStatusResponse.model_validate(data)
    assert data["loaded"] is False
    assert data["loading"] is False


def test_embedding_warmup_returns_200_with_error_on_load_failure(client, monkeypatch):
    """Contract: a load failure surfaces as `200 {ok response shape + error}`
    not a 5xx. The renderer can then show a friendly retry banner. Codex
    NICE-TO-HAVE — but worth pinning because a 5xx here would break that UX."""
    embedding = client.app.state.embedding

    def _boom():
        raise RuntimeError("simulated missing torch")

    monkeypatch.setattr(embedding, "_load_sync", _boom)
    response = client.post("/store/embedding/warmup")
    assert response.status_code == 200
    data = response.json()
    EmbeddingStatusResponse.model_validate(data)
    assert data["loaded"] is False
    assert data["error"] is not None
    assert "simulated missing torch" in data["error"]


def test_memory_stats_shape(client):
    response = client.get("/store/memory/stats")
    assert response.status_code == 200
    data = response.json()
    MemoryStatsResponse.model_validate(data)
    # Memory is enabled by default in the test environment.
    assert data["enabled"] is True
    assert isinstance(data["turn_count"], int)
    assert isinstance(data["summary_count"], int)
    assert isinstance(data["summary_every"], int)


def test_memory_summarize_shape_below_threshold(client):
    """Contract: forcing summarize on an empty DB returns 200 with
    `summary_id: null`. The renderer reads this to mean "nothing happened",
    not an error."""
    response = client.post("/store/memory/summarize")
    assert response.status_code == 200
    data = response.json()
    MemorySummarizeResponse.model_validate(data)
    assert data["summary_id"] is None
    MemoryStatsResponse.model_validate(data["stats"])


def test_files_folders_list_shape(client):
    response = client.get("/store/files/folders")
    assert response.status_code == 200
    FileFoldersResponse.model_validate(response.json())


def test_files_add_folder_rejects_invalid_path_with_200_payload(client):
    """Bad input lands on a 200 with status='rejected' + reason so the renderer
    surfaces the message inline instead of needing a 4xx error path."""
    response = client.post(
        "/store/files/folders",
        json={"path": "C:/this/folder/definitely/does/not/exist/apia-test"},
    )
    assert response.status_code == 200
    data = response.json()
    FileFolderAddResponse.model_validate(data)
    assert data["status"] == "rejected"
    assert data["reason"]


def test_files_remove_folder_returns_zero_when_unknown(client):
    response = client.request(
        "DELETE", "/store/files/folders",
        json={"path": "C:/never-registered"},
    )
    assert response.status_code == 200
    data = response.json()
    FileFolderRemoveResponse.model_validate(data)
    assert data["removed"] is False
    assert data["chunks_deleted"] == 0


def test_files_ingest_text_empty_returns_zero(client):
    response = client.post(
        "/store/files/ingest_text",
        json={"label": "test", "text": "   "},
    )
    assert response.status_code == 200
    data = response.json()
    FileIngestTextResponse.model_validate(data)
    assert data["chunks_added"] == 0


def test_files_stats_shape(client):
    response = client.get("/store/files/stats")
    assert response.status_code == 200
    data = response.json()
    FileStatsResponse.model_validate(data)
    assert data["enabled"] is True


def test_web_stats_shape(client):
    response = client.get("/store/web/stats")
    assert response.status_code == 200
    data = response.json()
    WebStatsResponse.model_validate(data)
    # Test env doesn't set APIA_WEB_PROVIDER → default "none" → disabled.
    assert data["enabled"] is False
    assert data["provider"] == "none"


def test_web_search_returns_empty_when_disabled(client):
    response = client.post("/store/web/search", json={"query": "anything"})
    assert response.status_code == 200
    data = response.json()
    WebSearchResponse.model_validate(data)
    assert data["enabled"] is False
    assert data["results"] == []
    assert data["last_error"]


def test_web_citations_for_unknown_turn_returns_empty(client):
    response = client.get("/store/web/citations/999999")
    assert response.status_code == 200
    data = response.json()
    TurnCitationsResponse.model_validate(data)
    assert data["citations"] == []


def test_chat_response_includes_citations_field(client):
    """Step 4: ChatResponse always has a `citations` list (possibly empty).
    The renderer reads it unconditionally so it must never be missing."""
    response = client.post("/chat", json={"message": "hi", "history": []})
    assert response.status_code == 200
    data = response.json()
    ChatResponse.model_validate(data)
    assert "citations" in data
    assert isinstance(data["citations"], list)


def test_chat_use_web_happy_path_fills_citations(client, fake_claude, monkeypatch):
    """Codex NICE-TO-HAVE round 4: end-to-end /chat use_web=true with a
    stubbed web provider + a reply that contains `[1]` and `[2]` markers.
    The response must surface ChatCitation entries for each valid marker.
    """
    from services.web_search_service import WebResult

    async def fake_search(query: str):
        return [
            WebResult(title="첫 결과", url="https://example.com/a",
                      snippet="첫 발췌", score=0.9),
            WebResult(title="두번째 결과", url="https://example.com/b",
                      snippet="둘째 발췌", score=0.7),
        ]

    web = client.app.state.web
    monkeypatch.setattr(web, "_search_fn", fake_search)
    # `enabled`는 search_fn 주입 시 True가 되므로 추가 monkeypatch 불필요.
    fake_claude.chat.return_value = (
        "본문에 [1] 인용하고 또 [2] 인용. [EMOTION:happy]",
        "happy",
    )

    response = client.post(
        "/chat",
        json={"message": "외부 출처가 필요한 질문", "history": [], "use_web": True},
    )
    assert response.status_code == 200
    data = response.json()
    ChatResponse.model_validate(data)
    assert len(data["citations"]) == 2
    by_marker = {c["marker_number"]: c for c in data["citations"]}
    assert by_marker[1]["source_path"] == "https://example.com/a"
    assert by_marker[2]["source_path"] == "https://example.com/b"
    assert by_marker[1]["source_kind"] == "web"


def test_files_reindex_rejects_unregistered_folder_with_400(client):
    """Reindex on a non-allowlisted folder is a 400 (client error) — the only
    way to get here is a UI bug, since folders are added through the allowlist
    endpoint first. Pinning the status code catches a regression where the
    server starts silently scanning arbitrary paths."""
    response = client.post(
        "/store/files/reindex",
        json={"path": "C:/never-registered", "force": False},
    )
    assert response.status_code == 400
    assert "allowlist" in response.json()["detail"].lower()
