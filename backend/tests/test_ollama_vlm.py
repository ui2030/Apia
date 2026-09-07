"""
Tests for the `ollama_vlm` provider — the 관전(spectate) 전용 비전 모드가 로컬
Ollama HTTP API를 부르는 경로.

No real Ollama runs here: `httpx.AsyncClient` is swapped for a fake. What's
pinned is the *invocation contract*, because each item is a real failure mode:

  * the image goes as **raw base64** — a `data:image/jpeg;base64,` prefix makes
    Ollama fail to decode, and the cloud paths (which do use that prefix) are
    right next door in the same file;
  * the model name / base URL come from env knobs, so a user on a different
    box or a different VLM never has to edit source;
  * **every** failure (connection refused, 404 model-missing, 500, malformed
    body, timeout) leaves as a RuntimeError that routers.spectate absorbs into
    `raw=None` — an exception escaping there would kill the 관전 루프;
  * the availability probe is cached briefly, so `ollama pull` recovers without
    an app restart.

conftest.py swaps `services.claude_service` for a MagicMock before any test
imports it, so this file loads the real module straight off disk under a
different name (same trick as test_claude_code_provider.py).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, BACKEND_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


real_claude_service = _load("real_claude_service_ollama", "services/claude_service.py")
ClaudeService = real_claude_service.ClaudeService

_JSON_REPLY = '{"summary":"코드를 보고 있어요","interest":0.2,"comment":"","emotion":"neutral"}'


class FakeResponse:
    def __init__(self, payload, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("POST", "http://localhost:11434/api/chat"),
                response=httpx.Response(self.status_code),
            )

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeClient:
    """Stand-in for httpx.AsyncClient. `box` carries the scripted responses."""

    def __init__(self, box, timeout=None):
        self.box = box
        box["timeouts"].append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        self.box["posts"].append({"url": url, "json": json})
        result = self.box["post"]
        if isinstance(result, Exception):
            raise result
        return result

    async def get(self, url):
        self.box["gets"].append(url)
        result = self.box["get"]
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture()
def calls(monkeypatch: pytest.MonkeyPatch):
    box = {
        "posts": [],
        "gets": [],
        "timeouts": [],
        "post": FakeResponse({"message": {"content": _JSON_REPLY}}),
        # 기본 프로브 응답: 모델이 pull 되어 있는 상태.
        "get": FakeResponse({"models": [{"name": "qwen3-vl:4b-instruct"}]}),
    }
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda timeout=None, **kw: FakeClient(box, timeout)
    )
    return box


@pytest.fixture()
def service():
    return ClaudeService()


async def _describe(service, image="BASE64IMAGE"):
    return await service.describe_screen(image, {"recent": []}, ai_mode="ollama_vlm")


# ── 요청 payload 계약 ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_posts_raw_base64_to_ollama_chat(calls, service):
    raw = await _describe(service)

    assert raw == _JSON_REPLY
    assert len(calls["posts"]) == 1
    sent = calls["posts"][0]
    assert sent["url"] == f"{real_claude_service.OLLAMA_BASE_URL}/api/chat"

    body = sent["json"]
    assert body["model"] == real_claude_service.OLLAMA_VLM_MODEL
    assert body["stream"] is False
    assert body["options"] == {"num_predict": 160}

    assert len(body["messages"]) == 1
    message = body["messages"][0]
    assert message["role"] == "user"
    # 지시문(schema)이 이미지와 같은 메시지에 실려 있어야 한다.
    assert "JSON" in message["content"]
    # data: URL 접두사 금지 — 원형 base64 그대로.
    assert message["images"] == ["BASE64IMAGE"]
    assert not message["images"][0].startswith("data:")


@pytest.mark.asyncio
async def test_uses_generous_timeout_for_cold_load(calls, service):
    await _describe(service)
    assert calls["timeouts"][0] == 45.0


@pytest.mark.asyncio
async def test_model_name_comes_from_the_env_knob(calls, service, monkeypatch):
    monkeypatch.setattr(real_claude_service, "OLLAMA_VLM_MODEL", "llava:13b")
    await _describe(service)
    assert calls["posts"][0]["json"]["model"] == "llava:13b"


def test_env_knobs_are_read_by_ai_config(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("APIA_OLLAMA_VLM_MODEL", "llava:13b")
    monkeypatch.setenv("APIA_OLLAMA_BASE_URL", "http://box:1234/")
    fresh = _load("ai_config_ollama_probe", "ai_config.py")
    assert fresh.OLLAMA_VLM_MODEL == "llava:13b"
    # 뒤에 /api/chat을 붙이므로 trailing slash는 벗겨져 있어야 한다.
    assert fresh.OLLAMA_BASE_URL == "http://box:1234"


def test_ollama_vlm_is_never_an_auto_candidate(service):
    assert "ollama_vlm" not in service.auto_mode_priority
    assert service.select_auto_mode() != "ollama_vlm"


def test_ollama_vlm_is_not_counted_as_a_chat_provider(service):
    """설정 창의 provider 패널과 main.py의 summarize_fn 게이트가 이 목록을 읽는다 —
    관전 전용 모드가 끼면 키가 하나도 없는 사용자에게 'provider 있음'으로 보인다."""
    assert "ollama_vlm" not in service.list_available_modes()
    assert service.vision_model_for("ollama_vlm")  # 그래도 관전엔 쓰인다


# ── 실패 5종: 전부 우아한 스킵 ─────────────────────────────────────────────

@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("connection refused"),          # Ollama가 안 떠 있음
        FakeResponse({"error": "model not found"}, 404),   # pull 안 함
        FakeResponse({"error": "boom"}, 500),              # 서버 오류
        FakeResponse({"nonsense": True}),                  # 비정형 응답
        httpx.ReadTimeout("timed out"),                    # 콜드 로드가 너무 김
    ],
    ids=["connect-refused", "model-404", "server-500", "malformed", "timeout"],
)
@pytest.mark.asyncio
async def test_every_failure_becomes_a_runtime_error(calls, service, failure):
    calls["post"] = failure
    with pytest.raises(RuntimeError, match="ollama_vlm vision failed"):
        await _describe(service)


@pytest.mark.asyncio
async def test_empty_content_is_a_failure_not_an_empty_comment(calls, service):
    calls["post"] = FakeResponse({"message": {"content": "   "}})
    with pytest.raises(RuntimeError, match="ollama_vlm vision failed"):
        await _describe(service)


@pytest.mark.asyncio
async def test_failure_hint_names_the_missing_model(calls, service):
    calls["post"] = httpx.ConnectError("connection refused")
    calls["get"] = httpx.ConnectError("connection refused")
    with pytest.raises(RuntimeError) as excinfo:
        await _describe(service)
    assert "ollama pull" in str(excinfo.value)


@pytest.mark.asyncio
async def test_router_absorbs_the_failure_into_raw_none(monkeypatch):
    """관전 루프의 진짜 계약: 예외가 라우터 밖으로 새면 안 된다."""
    import routers.spectate as spectate_router
    from schemas import SpectateRequest

    async def _boom(*args, **kwargs):
        raise RuntimeError("ollama_vlm vision failed: connection refused")

    monkeypatch.setattr(spectate_router.claude, "describe_screen", _boom)
    response = await spectate_router.spectate(
        SpectateRequest(image_b64="x", context={}, ai_mode="ollama_vlm")
    )
    assert response.raw is None


# ── 가용성 프로브 ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_probe_reports_the_pulled_model(calls, service):
    assert await service.probe_ollama_vlm() is True
    assert calls["gets"] == [f"{real_claude_service.OLLAMA_BASE_URL}/api/tags"]


@pytest.mark.asyncio
async def test_probe_accepts_the_implicit_latest_tag(calls, service, monkeypatch):
    monkeypatch.setattr(real_claude_service, "OLLAMA_VLM_MODEL", "qwen3-vl")
    calls["get"] = FakeResponse({"models": [{"name": "qwen3-vl:latest"}]})
    assert await service.probe_ollama_vlm() is True


@pytest.mark.asyncio
async def test_probe_is_false_when_the_model_is_missing(calls, service):
    calls["get"] = FakeResponse({"models": [{"name": "llama3:8b"}]})
    assert await service.probe_ollama_vlm() is False


@pytest.mark.asyncio
async def test_probe_result_is_cached_within_its_ttl(calls, service):
    calls["get"] = FakeResponse({"models": []})
    assert await service.probe_ollama_vlm() is False
    assert await service.probe_ollama_vlm() is False
    assert len(calls["gets"]) == 1  # 두 번째는 캐시


@pytest.mark.asyncio
async def test_probe_recovers_after_a_pull_without_restart(calls, service):
    calls["get"] = FakeResponse({"models": []})
    assert await service.probe_ollama_vlm() is False

    # TTL 경과를 흉내낸다 — 사용자가 그 사이 `ollama pull`을 했다.
    stamp, value = service._ollama_probe
    service._ollama_probe = (stamp - service._OLLAMA_PROBE_TTL_SEC - 1, value)
    calls["get"] = FakeResponse({"models": [{"name": "qwen3-vl:4b-instruct"}]})

    assert await service.probe_ollama_vlm() is True
    assert len(calls["gets"]) == 2


@pytest.mark.asyncio
async def test_probe_never_raises_when_ollama_is_down(calls, service):
    calls["get"] = httpx.ConnectError("connection refused")
    assert await service.probe_ollama_vlm() is False


@pytest.mark.asyncio
async def test_probe_uses_a_short_timeout(calls, service):
    # 프로브는 참고용이라 본 호출(45s)만큼 기다리면 안 된다.
    await service.probe_ollama_vlm()
    assert calls["timeouts"] == [3.0]
