"""
Domain-level tests for the provider warmup aggregate logic in
backend/services/claude_service.py.

These don't touch FastAPI — they exercise ClaudeService directly. The init
error capture path was the heart of the 3C fix (don't infer failure from
`self.mode == "fallback"`; record at the catch site), and the aggregate
invariant (`auto_target ∈ available_modes`) is part of the WarmupState VO
contract.

These tests deliberately bypass conftest's fake claude module (which serves
the contract tests) and load the REAL services.claude_service from disk via
importlib — otherwise every test would receive the mock instance instead of
the actual class under test.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _load_real_claude_module():
    spec = importlib.util.spec_from_file_location(
        "real_claude_service_for_domain_tests",
        BACKEND_ROOT / "services" / "claude_service.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_real_claude_service():
    return _load_real_claude_module().ClaudeService


@pytest.fixture()
def fresh_service(monkeypatch):
    """A real ClaudeService instance with controllable prereqs and no real
    provider init. Loaded via importlib so the conftest fake module
    installed for contract tests doesn't shadow the implementation here."""
    ClaudeService = _load_real_claude_service()
    service = ClaudeService()
    prereqs = set()
    monkeypatch.setattr(service, "_mode_has_prereqs", lambda mode: mode in prereqs)
    return service, prereqs


def test_resolve_auto_target_returns_first_priority_candidate(fresh_service):
    service, prereqs = fresh_service
    # Even though `list_available_modes` sorts alphabetically, auto target
    # must respect AUTO_MODE_PRIORITY. Default priority is
    # ['groq', 'claude', 'hf_api', 'local'] — so when both claude and groq
    # have prereqs, groq wins.
    prereqs.update({"claude", "groq"})
    assert service.resolve_auto_target() == "groq"


def test_resolve_auto_target_returns_none_when_nothing_satisfied(fresh_service):
    service, _prereqs = fresh_service
    assert service.resolve_auto_target() is None


def test_aggregate_invariant_auto_target_in_available(fresh_service):
    # When auto_target is set, it MUST be a member of list_available_modes.
    # This is the same invariant the warmup router asserts before returning.
    service, prereqs = fresh_service
    prereqs.update({"claude", "groq"})
    target = service.resolve_auto_target()
    assert target is not None
    assert target in service.list_available_modes()


def test_get_last_init_error_starts_clean(fresh_service):
    service, _ = fresh_service
    assert service.get_last_init_error() is None


def test_record_init_error_captures_mode_and_message(fresh_service):
    service, _ = fresh_service
    service._record_init_error("claude", RuntimeError("bad key"))
    err = service.get_last_init_error()
    assert err == {"mode": "claude", "message": "RuntimeError: bad key"}


def test_clear_init_error_only_on_same_mode_success(fresh_service):
    """A fallback provider succeeding must NOT silently hide the original
    provider's failure. Only clearing when the *same* mode subsequently
    succeeds preserves the swallowed failure signal."""
    service, _ = fresh_service
    service._record_init_error("claude", RuntimeError("bad key"))

    # Groq succeeds (fallback path). claude's error must still be visible.
    service._clear_init_error_if_recovered("groq")
    err = service.get_last_init_error()
    assert err is not None and err["mode"] == "claude"

    # Now claude itself succeeds — clear.
    service._clear_init_error_if_recovered("claude")
    assert service.get_last_init_error() is None


# ── local 모델 유휴 해제 ────────────────────────────────────────────────
# 4bit 양자화라도 7B는 VRAM을 수 GB 물고 있는데, 한 번 쓰고 몇 시간 방치되는 게
# 이 앱의 보통 사용 패턴이다. 새 타이머 없이 어차피 _init_lock을 잡는 경로에
# 검사를 얹는 방식이라, 검사 자체의 조건(유휴/in-flight/knob)이 정확해야 한다.
@pytest.fixture()
def local_service(monkeypatch):
    """`local`이 로드된 것처럼 꾸민 실 ClaudeService + 가짜 torch."""
    import types

    module = _load_real_claude_module()
    service = module.ClaudeService()
    monkeypatch.setattr(module, "LOCAL_IDLE_UNLOAD_MIN", 30)

    emptied = []
    service._torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(empty_cache=lambda: emptied.append(1))
    )
    service._model = object()
    service._tok = object()
    service._initialized_modes.add("local")
    service.mode = "local"
    return module, service, emptied


def _make_idle(service):
    import time

    service._local_last_used = time.monotonic() - 31 * 60


def test_idle_local_model_is_released(local_service):
    _module, service, emptied = local_service
    _make_idle(service)

    assert service._maybe_unload_local() is True
    assert service._model is None
    assert service._tok is None
    assert "local" not in service._initialized_modes
    assert emptied == [1]  # torch.cuda.empty_cache 호출됨


def test_recent_local_use_is_not_released(local_service):
    import time

    _module, service, _emptied = local_service
    service._local_last_used = time.monotonic()

    assert service._maybe_unload_local() is False
    assert service._model is not None


def test_in_flight_local_call_blocks_unload(local_service):
    """추론이 도는 중에 해제하면 그 요청이 터진다 — 카운터로 막는다."""
    _module, service, _emptied = local_service
    _make_idle(service)
    service._local_active = 1

    assert service._maybe_unload_local() is False
    assert service._model is not None
    assert "local" in service._initialized_modes

    service._local_active = 0  # 추론 종료 → 이제는 놓아준다
    assert service._maybe_unload_local() is True


def test_zero_knob_disables_unload(local_service, monkeypatch):
    module, service, _emptied = local_service
    monkeypatch.setattr(module, "LOCAL_IDLE_UNLOAD_MIN", 0)
    _make_idle(service)

    assert service._maybe_unload_local() is False
    assert service._model is not None


def test_local_reinitializes_after_release(local_service, monkeypatch):
    _module, service, _emptied = local_service
    _make_idle(service)
    assert service._maybe_unload_local() is True

    inits = []

    def _fake_init_local():
        inits.append(1)
        service._model = object()
        service._tok = object()

    monkeypatch.setattr(service, "_init_local", _fake_init_local)
    monkeypatch.setattr(service, "_mode_has_prereqs", lambda mode: mode == "local")

    assert service._ensure_mode("local") == "local"
    assert inits == [1]
    assert service.is_mode_initialized("local")


def test_ensure_mode_to_other_provider_releases_idle_local(local_service, monkeypatch):
    """해제 검사는 별도 타이머가 아니라 ensure_mode 경로에 얹혀 있다."""
    _module, service, _emptied = local_service
    _make_idle(service)
    service._initialized_modes.add("groq")
    monkeypatch.setattr(service, "_mode_has_prereqs", lambda mode: mode in {"groq", "local"})

    assert service._ensure_mode("groq") == "groq"
    assert service._model is None
    assert "local" not in service._initialized_modes


def test_ensure_mode_to_local_does_not_release_it(local_service, monkeypatch):
    _module, service, _emptied = local_service
    _make_idle(service)
    monkeypatch.setattr(service, "_mode_has_prereqs", lambda mode: mode == "local")

    assert service._ensure_mode("local") == "local"
    assert service._model is not None  # 바로 쓸 건데 내렸다 다시 올리면 손해
