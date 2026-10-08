"""발주서 23 — 클라우드→다른 클라우드 폴백은 한 번 묻는다.

고른 클라우드 모델이 init에 실패하면 예전엔 키가 있는 다른 클라우드로 말없이
넘어갔다(그 키의 요금이 나간다). 이제 허락(allow_cloud_fallback)이 없으면
넘어가지 않고 meta에 fallback_offer를 싣는다. 로컬로 넘어가는 건 그대로.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _real_module():
    spec = importlib.util.spec_from_file_location(
        "real_claude_service_for_cloud_fallback", BACKEND_ROOT / "services" / "claude_service.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _real_module()


@pytest.fixture()
def svc(monkeypatch):
    """claude는 키가 있지만 init이 실패한다. prereqs는 테스트가 고른다."""
    service = MOD.ClaudeService()
    service.auto_mode_priority = ["groq", "claude", "hf_api", "local"]
    prereqs = {"claude", "groq"}
    monkeypatch.setattr(service, "_mode_has_prereqs", lambda mode: mode in prereqs)
    inits = []

    def _fake_init(mode):
        inits.append(mode)
        if mode == "claude":
            service.mode = "fallback"
            return False
        service.mode = mode
        service._initialized_modes.add(mode)
        return True

    monkeypatch.setattr(service, "_initialize_mode", _fake_init)
    return service, prereqs, inits


def test_cloud_to_cloud_offers_instead_of_switching(svc):
    service, _prereqs, inits = svc
    meta = {}
    assert service._ensure_mode("claude", meta=meta) == "fallback"
    assert meta == {"fallback_offer": {"from": "claude", "to": "groq", "to_label": "Groq API"}}
    assert inits == ["claude"]  # groq는 건드리지도 않는다


def test_allowed_cloud_fallback_switches_and_marks_meta(svc):
    service, _prereqs, _inits = svc
    meta = {}
    assert service._ensure_mode("claude", allow_cloud_fallback=True, meta=meta) == "groq"
    assert meta == {"fallback": {"from": "claude", "to": "groq"}}


def test_local_fallback_unchanged(svc):
    service, prereqs, _inits = svc
    # 폴백은 auto 1순위 후보로 간다 — 로컬이 1순위인 구성
    service.auto_mode_priority = ["local", "claude"]
    prereqs.add("local")
    meta = {}
    assert service._ensure_mode("claude", meta=meta) == "local"
    assert meta == {}


def test_no_other_cloud_key_means_no_offer(svc):
    service, prereqs, _inits = svc
    prereqs.discard("groq")
    meta = {}
    assert service._ensure_mode("claude", meta=meta) == "fallback"
    assert meta == {}


def test_auto_calls_never_hop_even_if_allowed(svc):
    """관전·디렉터·요약(chat=False)은 보는 사람이 없다 — 묻지도 넘어가지도 않는다."""
    service, _prereqs, inits = svc
    meta = {}
    assert service._ensure_mode("claude", chat=False, allow_cloud_fallback=True, meta=meta) == "fallback"
    assert meta == {}
    assert inits == ["claude"]
    with pytest.raises(RuntimeError):
        asyncio.run(service.decide_directive({}, ai_mode="claude"))


def test_chat_stream_offer_yields_unavailable_reply(svc):
    service, _prereqs, _inits = svc
    meta = {}

    async def _run():
        return [p async for p in service.chat_stream("hi", [], "claude", meta=meta)]

    pieces = asyncio.run(_run())
    assert "Claude API" in "".join(pieces)
    assert meta["fallback_offer"]["to"] == "groq"


# ── 라우터: 메타가 응답(비스트리밍)·final 프레임(스트리밍)에 실린다 ──────────────

def test_chat_response_carries_offer(client, fake_claude, monkeypatch):
    async def _chat(*_a, meta=None, allow_cloud_fallback=False, **_k):
        assert allow_cloud_fallback is True
        meta["fallback"] = {"from": "claude", "to": "groq"}
        return "hi", "neutral"

    monkeypatch.setattr(fake_claude, "chat", _chat)
    r = client.post("/chat", json={"message": "hi", "allow_cloud_fallback": True})
    assert r.status_code == 200
    assert r.json()["fallback"] == {"from": "claude", "to": "groq"}
    assert r.json()["fallback_offer"] is None


def test_stream_final_frame_carries_offer(client, fake_claude, monkeypatch):
    async def _stream(*_a, meta=None, allow_cloud_fallback=False, **_k):
        assert allow_cloud_fallback is False
        meta["fallback_offer"] = {"from": "claude", "to": "groq", "to_label": "Groq API"}
        yield "쓸 수 없어요 [EMOTION:sad]"

    monkeypatch.setattr(fake_claude, "chat_stream", _stream)
    with client.stream("POST", "/chat/stream", json={"message": "hi"}) as r:
        frames = [json.loads(l[5:]) for l in r.iter_lines() if l.startswith("data:")]
    final = frames[-1]
    assert final["type"] == "final"
    assert final["fallback_offer"]["to"] == "groq"


def test_auto_mode_skips_failed_candidate_and_offers_next_cloud(svc):
    """auto에서 1순위(claude)가 죽으면 같은 후보를 다시 고르지 않고 2순위(groq)로 —
    둘 다 클라우드라 허락 없이는 넘어가지 않고 제안만 한다(astra 지적 회귀)."""
    service, _prereqs, inits = svc
    service.auto_mode_priority = ["claude", "groq", "hf_api", "local"]
    meta = {}
    assert service._ensure_mode("auto", meta=meta) == "fallback"
    assert inits == ["claude"]                      # groq는 허락 전엔 init하지 않는다
    assert meta == {"fallback_offer": {"from": "claude", "to": "groq", "to_label": "Groq API"}}
    meta2 = {}
    assert service._ensure_mode("auto", allow_cloud_fallback=True, meta=meta2) == "groq"
    assert meta2 == {"fallback": {"from": "claude", "to": "groq"}}
