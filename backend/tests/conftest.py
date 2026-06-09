"""
Shared pytest fixtures for backend contract tests.

These tests do not exercise any real AI provider, TTS, or Whisper — they only
verify that the FastAPI route layer produces payloads that match the models in
backend/schemas.py. Heavy services are replaced before app construction so the
import side-effects (ClaudeService(), pyttsx3 init) do not run.

A subtle trap worth flagging for future readers: `routers.chat` instantiates
`ClaudeService()` at module load. The fixture must patch `ClaudeService`
*before* `chat` is imported by `main`, otherwise the real constructor runs and
prints `[AI] default_mode=...` during test collection. We do this by inserting
a fake module into `sys.modules` ahead of the `from main import app` import.
"""
from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

# Make `backend/` itself importable as the project root. We run pytest from
# backend/ via pytest.ini's testpaths, so adding the parent of `tests/` covers
# both `from schemas import X` and `from routers.chat import claude` styles.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Redirect the FastAPI lifespan's data dir to a temp folder for the entire test
# session so a `pytest backend` run never writes `apia.db` next to the source
# tree — or worse, into the user's real %APPDATA%/apia. main.py's
# `_resolve_data_dir` reads this env var. We deliberately assign (not
# setdefault) so that a developer with DATA_DIR exported in their shell
# doesn't accidentally point pytest at production data. Codex MUST-FIX.
_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="apia-pytest-data-"))
os.environ["DATA_DIR"] = str(_TEST_DATA_DIR)


def _install_fake_claude_module() -> MagicMock:
    """Replace `services.claude_service.ClaudeService` before chat.py imports it."""
    fake_claude = MagicMock(name="ClaudeService_instance")
    fake_claude.chat = AsyncMock(return_value=("Hello! [EMOTION:happy]", "happy"))
    fake_claude.is_mode_initialized = MagicMock(return_value=True)
    fake_claude.list_initialized_modes = MagicMock(return_value=["groq"])
    fake_claude.list_available_modes = MagicMock(return_value=["claude", "groq"])
    fake_claude.resolve_auto_target = MagicMock(return_value="groq")
    fake_claude.get_last_init_error = MagicMock(return_value=None)
    fake_claude.select_auto_mode = MagicMock(return_value="groq")
    fake_claude.ensure_mode = AsyncMock(return_value="groq")
    fake_claude.default_mode = "auto"
    fake_claude.mode = "groq"

    claude_service_module = types.ModuleType("services.claude_service")

    def _factory(*_args: Any, **_kwargs: Any) -> MagicMock:
        return fake_claude

    claude_service_module.ClaudeService = _factory  # type: ignore[attr-defined]

    # `services` package itself may or may not exist depending on import order.
    services_pkg = sys.modules.get("services")
    if services_pkg is None:
        services_pkg = types.ModuleType("services")
        services_pkg.__path__ = [str(BACKEND_ROOT / "services")]  # type: ignore[attr-defined]
        sys.modules["services"] = services_pkg

    sys.modules["services.claude_service"] = claude_service_module
    return fake_claude


# Install the claude stub at conftest import time, BEFORE any test file can
# transitively import `main` (which constructs ClaudeService() at module load).
# Doing this in a fixture is too late if anything outside the fixture chain
# pulls in `main` — collection-time imports, autouse fixtures from other
# packages, IDEs eagerly resolving modules, etc.
_FAKE_CLAUDE = _install_fake_claude_module()


@pytest.fixture(scope="session")
def fake_claude() -> MagicMock:
    return _FAKE_CLAUDE


@pytest.fixture(scope="session")
def app(fake_claude: MagicMock):
    """Import the FastAPI app once, after claude is patched."""
    from main import app as fastapi_app  # type: ignore  # noqa: WPS433

    return fastapi_app


@pytest.fixture()
def client(app):
    # Wrap in `with` so FastAPI's lifespan runs — without it, app.state.store
    # and app.state.embedding are never set, and any test that calls the new
    # /store/* endpoints fails with `'State' object has no attribute …`.
    # TestClient avoids needing pytest-asyncio + httpx.AsyncClient just for
    # shape assertions. FastAPI's own TestClient runs the app in a sync way.
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def patched_voice(monkeypatch: pytest.MonkeyPatch):
    """Stub voice/tts/vm internals for /voices, /tts, and POST /warmup paths."""
    from routers import voice, tts as tts_router

    fake_tts = MagicMock()
    fake_tts.list_voices = MagicMock(return_value=[
        {"id": "sys-1", "name": "System Voice 1"},
    ])
    fake_tts.synthesize = AsyncMock(return_value=b"RIFF\x00\x00\x00\x00WAVEfake-audio-bytes")
    fake_vm = MagicMock()
    fake_vm.list_voices = MagicMock(return_value=[])

    async def _get_tts() -> Any:
        return fake_tts

    async def _get_vm() -> Any:
        return fake_vm

    async def _prime() -> None:
        return None

    monkeypatch.setattr(voice, "get_tts", _get_tts)
    monkeypatch.setattr(voice, "get_vm", _get_vm)
    monkeypatch.setattr(voice, "prime", _prime)
    # tts.py captured `get_tts` at module import time. The router calls its
    # own reference, not voice.get_tts, so patch both for the /tts test.
    monkeypatch.setattr(tts_router, "get_tts", _get_tts)


@pytest.fixture()
def patched_stt(monkeypatch: pytest.MonkeyPatch):
    """Stub whisper for /stt and warmup."""
    from routers import stt

    fake_whisper = MagicMock()
    fake_whisper.transcribe = AsyncMock(return_value="hello world")

    async def _get_whisper() -> Any:
        return fake_whisper

    async def _prime() -> None:
        return None

    monkeypatch.setattr(stt, "get_whisper", _get_whisper)
    monkeypatch.setattr(stt, "prime", _prime)
