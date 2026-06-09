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


def _load_real_claude_service():
    spec = importlib.util.spec_from_file_location(
        "real_claude_service_for_domain_tests",
        BACKEND_ROOT / "services" / "claude_service.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ClaudeService


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
