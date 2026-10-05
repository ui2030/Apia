"""성격 파일 — 기본/개인 두 겹 로더 + 모든 발화 표면이 단일 출처를 쓰는지.

conftest가 `services.claude_service`를 MagicMock으로 갈아치우므로 진짜 모듈은
파일에서 직접 연다(test_spectate_context.py와 같은 이유).
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import ai_config  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "real_claude_service_persona", BACKEND_ROOT / "services" / "claude_service.py"
)
real_claude_service = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(real_claude_service)
ClaudeService = real_claude_service.ClaudeService

FAKE = "너는 테스트용 캐릭터다. 말끝마다 '삐빅'을 붙인다."


@pytest.fixture
def personal(tmp_path, monkeypatch):
    monkeypatch.setenv("PERSONAL_DIR", str(tmp_path))
    ai_config._persona_cache.update(key=None, text=None)
    return tmp_path


def _write(folder: Path, text: str, mtime_ns: int | None = None) -> Path:
    path = folder / "persona.md"
    path.write_text(text, encoding="utf-8")
    if mtime_ns is not None:
        os.utime(path, ns=(mtime_ns, mtime_ns))
    return path


def _svc() -> ClaudeService:
    return ClaudeService.__new__(ClaudeService)


# ── 로더 ────────────────────────────────────────────────────────────────────

def test_no_personal_dir_or_file_means_none(personal, monkeypatch):
    assert ai_config.load_persona() is None  # 폴더는 있는데 파일 없음
    monkeypatch.delenv("PERSONAL_DIR")
    assert ai_config.load_persona() is None


def test_personal_file_is_loaded(personal):
    _write(personal, FAKE)
    assert ai_config.load_persona() == FAKE


def test_over_8kb_keeps_head_only(personal):
    _write(personal, "가" * 5000)  # 15000B UTF-8
    text = ai_config.load_persona()
    assert len(text.encode("utf-8")) <= ai_config.PERSONA_MAX_BYTES
    assert set(text) == {"가"}  # 잘린 멀티바이트 조각이 깨진 글자로 남지 않는다


def test_reload_on_mtime_change(personal):
    path = _write(personal, FAKE, mtime_ns=1_000_000_000_000_000_000)
    assert ai_config.load_persona() == FAKE
    _write(personal, "바뀐 테스트용 캐릭터", mtime_ns=1_000_000_001_000_000_000)
    assert ai_config.load_persona() == "바뀐 테스트용 캐릭터"
    path.unlink()
    assert ai_config.load_persona() is None


# ── 조립 규칙 ────────────────────────────────────────────────────────────────

def test_default_layer_used_without_personal():
    prompt = ai_config.build_system_prompt(None)
    assert prompt.startswith(ai_config.DEFAULT_PERSONA)
    assert "'Apia'" in prompt
    assert prompt == ai_config.SYSTEM_PROMPT


def test_personal_layer_replaces_default_but_keeps_function_rules():
    prompt = ai_config.build_system_prompt(FAKE)
    assert prompt.startswith(FAKE)
    assert ai_config.DEFAULT_PERSONA not in prompt  # 합치지 않고 덮는다
    assert "'Apia'" not in prompt
    for rule in ("[EMOTION:감정]", "2~3문장", "개인정보"):
        assert rule in prompt


def test_default_persona_file_ships_in_repo():
    assert (BACKEND_ROOT / "defaults" / "persona.md").is_file()
    assert ai_config.DEFAULT_PERSONA


# ── 적용 표면 ────────────────────────────────────────────────────────────────

def test_chat_prompt_uses_personal_persona(personal):
    # 채팅(모든 provider)·선톡(/chat 경유)·그림자는 전부 _build_system_prompt를 지난다.
    _write(personal, FAKE)
    svc = _svc()
    assert svc._build_system_prompt(None).startswith(FAKE)
    assert svc._build_system_prompt({"기억": "- 테스트 기억"}).startswith(FAKE)


def test_claude_chat_sends_persona(personal):
    _write(personal, FAKE)
    svc = _svc()
    seen = {}

    class _Msgs:
        def create(self, **kw):
            seen.update(kw)
            return type("R", (), {"content": [type("C", (), {"text": "ok"})()]})()

    svc._claude = type("Client", (), {"messages": _Msgs()})()
    asyncio.run(svc._chat_claude("안녕", [], None, None))
    assert seen["system"].startswith(FAKE)


def test_local_chat_and_shadow_use_persona(personal):
    import inspect

    _write(personal, FAKE)
    svc = _svc()
    messages = svc._local_chat_messages("안녕", [], None, None)
    assert messages[0]["content"].startswith(FAKE)
    assert "self._build_system_prompt(None)" in inspect.getsource(ClaudeService.shadow_reply)


def test_spectate_payload_carries_persona(personal):
    _write(personal, FAKE)
    svc = _svc()
    seen = {}

    async def _mode(*_a, **_k):
        return "claude"

    async def _describe(model, image_b64, user):
        seen["user"] = user
        return "{}"

    svc.ensure_mode = _mode
    svc.vision_model_for = lambda _m: "vision"
    svc._describe_claude = _describe
    asyncio.run(svc.describe_screen("AAAA", {"recent": []}, "claude"))
    assert FAKE in seen["user"]
    assert "silence" in seen["user"]  # 침묵·프라이버시 규칙이 우선이라고 못 박는다


def test_teacher_conversion_never_gets_persona(personal, monkeypatch):
    _write(personal, FAKE)
    from routers import courseware
    from services import teacher_service

    seen = {}

    def _ask(system, user):
        seen["system"], seen["user"] = system, user
        return {"cards": []}, 0.0

    monkeypatch.setattr(teacher_service, "ask_json", _ask)
    req = courseware.CoursewareConvertRequest(
        day="2026-01-01", exchanges=[{"u": "안녕", "a": "응"}]
    )
    asyncio.run(courseware.convert(req))
    assert seen and FAKE not in seen["system"] and FAKE not in seen["user"]
