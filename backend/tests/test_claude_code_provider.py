"""
Tests for the `claude_code` provider — the mode that shells out to the locally
installed Claude Code CLI instead of calling an API with a key.

No real CLI runs here: `asyncio.create_subprocess_exec` is monkeypatched with a
fake process. What's pinned is the *invocation contract*, because every item
below is a real failure mode if it regresses:

  * the prompt goes over **stdin**, never argv — argv is visible in the process
    list to other users on the machine, and Windows caps command line length;
  * `--model` is omitted entirely when the env knob is empty, so the CLI picks
    its own default instead of being handed an empty string;
  * built-in tools are off for chat (`--tools ""`), so a chat turn can't read
    files or run commands;
  * a timeout kills **and reaps** the process instead of leaving a zombie.

conftest.py swaps `services.claude_service` for a MagicMock before any test
imports it, so this file loads the real module straight off disk under a
different name.
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

_spec = importlib.util.spec_from_file_location(
    "real_claude_service", BACKEND_ROOT / "services" / "claude_service.py"
)
real_claude_service = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(real_claude_service)
ClaudeService = real_claude_service.ClaudeService


class FakeProcess:
    """Minimal stand-in for asyncio.subprocess.Process."""

    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0, hang: bool = False):
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = returncode
        self._hang = hang
        self.stdin_payload: bytes | None = None
        self.killed = False
        self.reaped = False

    async def communicate(self, payload: bytes | None = None):
        self.stdin_payload = payload
        if self._hang:
            await asyncio.sleep(30)
        return self._stdout, self._stderr

    def kill(self):
        self.killed = True

    async def wait(self):
        self.reaped = True
        return self.returncode


def _cli_json(result: str) -> bytes:
    return json.dumps({"is_error": False, "subtype": "success", "result": result}).encode("utf-8")


@pytest.fixture()
def spawns(monkeypatch: pytest.MonkeyPatch):
    """Capture every create_subprocess_exec call; the fake process is swappable."""
    calls: list[dict] = []
    box = {"process": FakeProcess(stdout=_cli_json("ok"))}

    async def _fake_exec(*args, **kwargs):
        calls.append({"args": list(args), "kwargs": kwargs})
        return box["process"]

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    return {"calls": calls, "box": box}


def _service(tmp_path: Path) -> ClaudeService:
    service = ClaudeService()
    service._claude_code_bin = "claude"
    service._claude_code_cwd = str(tmp_path)
    return service


async def test_prompt_travels_on_stdin_and_model_is_omitted(spawns, tmp_path):
    service = _service(tmp_path)
    spawns["box"]["process"] = FakeProcess(stdout=_cli_json("안녕! [EMOTION:happy]"))

    reply = await service._chat_claude_code(
        "오늘 뭐 했어?",
        [{"role": "user", "content": "지난 얘기"}],
        memory_turns=10,
    )

    assert reply == "안녕! [EMOTION:happy]"
    assert len(spawns["calls"]) == 1
    argv = spawns["calls"][0]["args"]

    # The user's message must not appear anywhere in argv.
    assert not any("오늘 뭐 했어?" in a for a in argv), argv
    payload = spawns["box"]["process"].stdin_payload.decode("utf-8")
    assert "오늘 뭐 했어?" in payload
    assert "지난 얘기" in payload

    # APIA_CLAUDE_CODE_MODEL defaults to '' — the flag must be absent, not empty.
    assert "--model" not in argv

    # Locked down: no tools for chat, no user settings/plugins/MCP, one-shot JSON.
    assert argv[argv.index("--tools") + 1] == ""
    assert "--allowedTools" not in argv
    assert "--safe-mode" in argv
    assert "--strict-mcp-config" in argv
    assert "--no-session-persistence" in argv
    assert argv[argv.index("--output-format") + 1] == "json"

    # cwd is the isolated work dir so the CLI can't see any project files.
    assert spawns["calls"][0]["kwargs"]["cwd"] == str(tmp_path)


async def test_model_flag_is_passed_when_configured(spawns, tmp_path, monkeypatch):
    monkeypatch.setattr(real_claude_service, "CLAUDE_CODE_MODEL", "sonnet")
    service = _service(tmp_path)

    await service._summarize_claude_code("system", "user")

    argv = spawns["calls"][0]["args"]
    assert argv[argv.index("--model") + 1] == "sonnet"


async def test_cli_error_payload_raises_with_stderr_excerpt(spawns, tmp_path):
    service = _service(tmp_path)
    spawns["box"]["process"] = FakeProcess(
        stdout=json.dumps({"is_error": True, "subtype": "error_max_turns", "result": ""}).encode(),
        stderr=b"quota exhausted",
        returncode=1,
    )

    with pytest.raises(RuntimeError, match="error_max_turns"):
        await service._summarize_claude_code("system", "user")


async def test_unparseable_output_raises(spawns, tmp_path):
    service = _service(tmp_path)
    spawns["box"]["process"] = FakeProcess(stdout=b"not json at all", stderr=b"boom")

    with pytest.raises(RuntimeError, match="unparseable"):
        await service._summarize_claude_code("system", "user")


async def test_timeout_kills_and_reaps_the_process(spawns, tmp_path):
    service = _service(tmp_path)
    hung = FakeProcess(hang=True)
    spawns["box"]["process"] = hung

    with pytest.raises(asyncio.TimeoutError):
        await service._run_claude_code("prompt", "system", timeout=0.05)

    assert hung.killed is True
    assert hung.reaped is True
    # 락이 풀렸어야 다음 호출이 영원히 매달리지 않는다.
    assert not real_claude_service._CLAUDE_CODE_LOCK.locked()


async def test_vision_sends_the_image_inline_with_no_tools_and_no_temp_file(spawns, tmp_path):
    """화면 내용은 신뢰할 수 없는 입력이다 — 화면 속 텍스트가 "이 파일을 읽어라"라고
    지시할 수 있으므로 비전 호출에도 도구를 하나도 주지 않는다. 이미지는 파일이
    아니라 stdin의 content block으로 간다(디스크에 캡처가 남지 않는 부수효과 포함).
    """
    service = _service(tmp_path)
    # stream-json 출력: 여러 줄 중 type=="result" 한 줄이 최종 답.
    stream = (
        b'{"type":"system"}\n'
        b'{"type":"assistant"}\n'
        + json.dumps(
            {"type": "result", "is_error": False, "subtype": "success", "result": '{"interest":0.1}'}
        ).encode()
        + b"\n"
    )
    spawns["box"]["process"] = FakeProcess(stdout=stream)

    raw = await service._describe_claude_code("QUJD", "Context: {}")

    assert raw == '{"interest":0.1}'
    argv = spawns["calls"][0]["args"]
    # 도구는 여전히 0개. Read도, allowedTools도 없다.
    assert argv[argv.index("--tools") + 1] == ""
    assert "Read" not in argv
    assert "--allowedTools" not in argv
    assert argv[argv.index("--input-format") + 1] == "stream-json"
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv  # stream-json 출력이 요구한다

    # 이미지는 stdin의 image content block으로 간다.
    sent = json.loads(spawns["box"]["process"].stdin_payload.decode("utf-8"))
    blocks = sent["message"]["content"]
    assert blocks[0]["source"]["data"] == "QUJD"
    assert blocks[0]["source"]["media_type"] == "image/jpeg"
    assert blocks[1]["text"] == "Context: {}"

    # 캡처는 어디에도 저장되지 않는다 — 작업 디렉터리가 비어 있어야 한다.
    assert list(tmp_path.iterdir()) == []


async def test_vision_raises_when_no_result_line_arrives(spawns, tmp_path):
    service = _service(tmp_path)
    spawns["box"]["process"] = FakeProcess(stdout=b'{"type":"system"}\n', stderr=b"died early")

    with pytest.raises(RuntimeError, match="unparseable"):
        await service._describe_claude_code("QUJD", "Context: {}")


def test_claude_code_is_a_valid_mode_but_never_auto_selected():
    service = ClaudeService()
    assert "claude_code" in service.valid_modes
    # auto가 몰래 고르면 사용자가 모르는 사이 구독 사용량을 태운다.
    assert "claude_code" not in service.auto_mode_priority
    assert "claude_code" not in service._get_auto_candidates()


def test_prompt_is_capped_and_drops_oldest_history_first(tmp_path):
    service = _service(tmp_path)
    history = [{"role": "user", "content": f"turn-{i} " + "가" * 3000} for i in range(20)]

    prompt = service._build_claude_code_prompt("마지막 질문", history, 10, "system")

    assert len(prompt) <= real_claude_service._CLAUDE_CODE_MAX_CHARS
    assert "마지막 질문" in prompt
    assert "turn-0" not in prompt  # 오래된 것부터 버려진다
    assert "turn-19" in prompt
