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
    HealthResponse,
    STTResponse,
    VoicesResponse,
    WarmupReadyResponse,
    WarmupStatusResponse,
    WarmupWarmingResponse,
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
    # All seven keys must be present — this is the contract the settings UI
    # reads. `auto_target` was added so "Auto would use: <mode>" can render
    # explicitly, and `available_modes`+`last_error` already existed.
    assert set(data.keys()) >= {
        "initialized_modes", "available_modes", "auto_target",
        "mode", "default_mode", "warming", "last_error"
    }
    WarmupStatusResponse.model_validate(data)


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
