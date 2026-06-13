"""
Contract tests for routers/director.py — the J-stage LLM behavior director.

The director endpoint is a *best-effort* helper: it must never 500, it must
pass the raw LLM string straight through (validation/clamp/fallback all live
client-side in src/behaviorDirector.js), and it must forward context + ai_mode
to the shared ClaudeService. These tests use the conftest fake_claude stub, so
no real provider / local model loads.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

from schemas import DirectorResponse


def test_director_returns_raw(client, fake_claude):
    fake_claude.decide_directive = AsyncMock(
        return_value='{"mood":"sleepy","activityBias":-0.4,"ttlSec":300}'
    )
    response = client.post("/director", json={"context": {"hour": 2}, "ai_mode": "local"})
    assert response.status_code == 200
    data = response.json()
    DirectorResponse.model_validate(data)
    assert data["raw"].startswith("{")

    fake_claude.decide_directive.assert_awaited_once()
    args, kwargs = fake_claude.decide_directive.call_args
    assert args[0] == {"hour": 2}            # context forwarded verbatim
    assert kwargs.get("ai_mode") == "local"  # ai_mode forwarded


def test_director_absorbs_provider_failure(client, fake_claude):
    # No provider / model error → must still be 200 with raw=None so the
    # renderer falls back to rule-based behavior instead of erroring.
    fake_claude.decide_directive = AsyncMock(side_effect=RuntimeError("no provider"))
    response = client.post("/director", json={"context": {}})
    assert response.status_code == 200
    assert response.json()["raw"] is None


def test_director_passes_through_unparsed_text(client, fake_claude):
    # The server does NOT validate the JSON — it forwards raw text and lets the
    # client parse. Garbage stays garbage here (client rejects it later).
    fake_claude.decide_directive = AsyncMock(return_value="not json at all")
    response = client.post("/director", json={})
    assert response.status_code == 200
    assert response.json()["raw"] == "not json at all"
