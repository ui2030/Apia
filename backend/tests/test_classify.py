"""
Contract tests for routers/classify.py — 눈치 원장 계측기의 화제 분류.

계측용 부수 호출이라 지켜야 할 것은 두 가지뿐이다: 절대 500을 내지 않을 것,
그리고 **로컬 provider가 아니면 아예 부르지 않을 것**(계측이 클라우드 API로
사용자 발화를 흘리면 안 된다). raw는 클라이언트가 파싱하므로 그대로 통과시킨다.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

from schemas import ClassifyResponse


def test_classify_returns_raw(client, fake_claude):
    fake_claude.classify_topic = AsyncMock(
        return_value='{"topic_id":"game","confidence":0.82}'
    )
    response = client.post("/classify", json={"text": "어제 그 판 봤어?", "topics": ["game", "work"]})
    assert response.status_code == 200
    data = response.json()
    ClassifyResponse.model_validate(data)
    assert data["raw"] == '{"topic_id":"game","confidence":0.82}'

    args, _ = fake_claude.classify_topic.call_args
    assert args[0] == "어제 그 판 봤어?"
    assert args[1] == ["game", "work"]


def test_classify_absorbs_provider_failure(client, fake_claude):
    fake_claude.classify_topic = AsyncMock(side_effect=RuntimeError("local provider unavailable"))
    response = client.post("/classify", json={"text": "안녕", "topics": ["game"]})
    assert response.status_code == 200
    assert response.json()["raw"] is None


def test_classify_skips_empty_requests(client, fake_claude):
    fake_claude.classify_topic = AsyncMock(return_value="{}")
    assert client.post("/classify", json={"text": "  ", "topics": ["game"]}).json()["raw"] is None
    assert client.post("/classify", json={"text": "안녕", "topics": []}).json()["raw"] is None
    fake_claude.classify_topic.assert_not_awaited()


def test_classify_never_falls_back_to_a_cloud_provider():
    """로컬이 없으면 ensure 계열을 부르지도 않는다 — ensure_mode('local')은
    local이 없을 때 **다른 provider를 대신 init하기 때문**이다."""
    import asyncio
    from unittest.mock import MagicMock

    import pytest

    real_class = _real_class()
    service = object.__new__(real_class)  # __init__은 provider를 건드리므로 건너뛴다
    service.list_available_modes = MagicMock(return_value=["claude", "groq"])
    service.ensure_mode = AsyncMock(return_value="claude")
    service._initialize_mode = MagicMock()

    with pytest.raises(RuntimeError):
        asyncio.run(real_class.classify_topic(service, "안녕", ["game"]))
    service.ensure_mode.assert_not_awaited()
    service._initialize_mode.assert_not_called()


def test_classify_local_init_failure_does_not_pollute_provider_state():
    """Codex MUST-FIX 회귀: local prereqs는 있는데 init이 **실패**하는 경우.

    옛 구현은 ensure_mode('local')를 불렀고, 그 경로는 실패 시 클라우드
    provider를 대신 init하며 self.mode를 바꿨다(대화 상태 오염). 새 구현은
    폴백 없이 RuntimeError를 내고 self.mode를 원래대로 되돌려야 한다."""
    import asyncio
    from unittest.mock import MagicMock

    import pytest

    real_class = _real_class()
    service = object.__new__(real_class)
    service.list_available_modes = MagicMock(return_value=["local", "claude"])
    service._initialized_modes = set()
    service._init_lock = asyncio.Lock()
    service.mode = "claude"  # 대화는 클라우드 모드로 돌던 중

    def failing_local_init(mode):
        assert mode == "local"  # local 외 다른 provider init 시도 자체가 위반
        service.mode = "fallback"  # 실제 _initialize_mode의 실패 시 변이 재현
        return False

    service._initialize_mode = MagicMock(side_effect=failing_local_init)
    service._summarize_local = AsyncMock()

    with pytest.raises(RuntimeError, match="init failed"):
        asyncio.run(real_class.classify_topic(service, "안녕", ["game"]))

    service._initialize_mode.assert_called_once_with("local")
    assert service.mode == "claude"  # 상태 복원 — 오염 없음
    service._summarize_local.assert_not_awaited()  # 실패 시 추론까지 못 간다


def _real_class():
    """conftest가 sys.modules의 services.claude_service를 stub으로 갈아끼웠기
    때문에 진짜 클래스는 파일에서 직접 로드한다."""
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "services" / "claude_service.py"
    spec = importlib.util.spec_from_file_location("_real_claude_service", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ClaudeService
