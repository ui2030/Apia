"""발주서 16 — 채팅 deepseek provider + 로컬 응답 수리.

지키는 계약:
  1. deepseek 스트림은 교사와 **같은 장부·같은 상한**을 쓴다(bucket=chat).
  2. 상한·키 없음·네트워크 실패 → **로컬로만** 폴백, meta에 fallback='local'.
  3. 키 값은 로그·메타 어디에도 안 나온다.
  4. auto 1순위는 키가 있을 때만 deepseek, 그리고 채팅에만.
  5. 로컬은 토큰 단위로 흘리고, 일본어 가나 토큰은 생성 단계에서 막힌다.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from services import teacher_service

FAKE_KEY = "sk-test-not-real-0123456789"


def _real_module():
    """conftest가 services.claude_service를 stub으로 갈아끼웠으므로 파일에서 직접 로드."""
    path = Path(__file__).resolve().parent.parent / "services" / "claude_service.py"
    spec = importlib.util.spec_from_file_location("_real_claude_service_ds", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _real_module()


@pytest.fixture(autouse=True)
def _ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(teacher_service, "_ledger_broken", None)
    monkeypatch.setattr(teacher_service, "_inflight_usd", 0.0)  # 선점액이 테스트 사이로 새지 않게
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    return tmp_path


def _usage(tmp_path):
    path = tmp_path / "teacher_usage.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _sse_lines(pieces, usage=None):
    lines = []
    for piece in pieces:
        lines.append(f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n".encode())
        lines.append(b"\n")
    if usage:
        lines.append(f"data: {json.dumps({'choices': [], 'usage': usage})}\n".encode())
    lines.append(b"data: [DONE]\n")
    return lines


class _FakeResponse:
    def __init__(self, lines):
        self._lines = lines

    def __iter__(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def _service():
    service = object.__new__(MOD.ClaudeService)
    service._build_system_prompt = lambda _blocks=None: "SYS"
    service._normalize_mode = lambda mode: mode or "auto"
    return service


async def _collect(agen):
    return [piece async for piece in agen]


# ── 1. SSE 파서 ─────────────────────────────────────────────────────────────

def test_sse_parser_yields_pieces_and_usage():
    usage = {}
    pieces = list(MOD.parse_openai_sse(
        [b": keep-alive\n", b"data: not-json\n"] + _sse_lines(["안", "녕"], {"prompt_tokens": 10, "completion_tokens": 2}),
        usage,
    ))
    assert pieces == ["안", "녕"]
    assert usage["completion_tokens"] == 2


# ── 2. 장부 합산 ────────────────────────────────────────────────────────────

def test_deepseek_stream_streams_and_records_chat_bucket(_ledger, monkeypatch):
    usage = {"prompt_tokens": 100, "prompt_cache_hit_tokens": 40, "completion_tokens": 20}
    sent = {}

    def _urlopen(request, timeout):
        sent["body"] = json.loads(request.data)
        return _FakeResponse(_sse_lines(["안녕", "하세요", " [EMOTION:happy]"], usage))

    monkeypatch.setattr(MOD.urllib.request, "urlopen", _urlopen)
    service = _service()
    service.ensure_mode = AsyncMock(return_value="deepseek")
    meta = {}
    pieces = asyncio.run(_collect(service.chat_stream("hi", [], "auto", meta=meta)))

    assert len(pieces) >= 2 and "".join(pieces).startswith("안녕하세요")
    assert sent["body"]["stream"] is True
    assert sent["body"]["stream_options"] == {"include_usage": True}
    assert meta == {}
    day = _usage(_ledger)[teacher_service._today()]
    assert day["calls"] == 1 and day["in_hit"] == 40 and day["in_miss"] == 60 and day["out"] == 20
    assert day["usd_chat"] == pytest.approx(day["usd"]) and day["usd"] > 0


def test_missing_usage_records_conservative_estimate(_ledger):
    teacher_service.chat_record({}, est_in_chars=300, est_out_chars=50)
    day = _usage(_ledger)[teacher_service._today()]
    assert day["in_miss"] == 300 and day["out"] == 50 and day["usd_chat"] > 0


# ── 3. 폴백 ────────────────────────────────────────────────────────────────

def _fallback_run(monkeypatch, urlopen):
    monkeypatch.setattr(MOD.urllib.request, "urlopen", urlopen)
    service = _service()
    service.ensure_mode = AsyncMock(side_effect=["deepseek", "local"])

    async def _local(*_a, **_k):
        yield "로컬"
        yield "답"

    service._chat_local_stream = _local
    meta = {}
    pieces = asyncio.run(_collect(service.chat_stream("hi", [], "auto", meta=meta)))
    return service, pieces, meta


def test_budget_exhausted_falls_back_to_local_without_http(_ledger, monkeypatch):
    (_ledger / "teacher_usage.json").write_text(json.dumps({
        teacher_service._today(): {"calls": 1, "usd": teacher_service.DAILY_BUDGET_USD}
    }), encoding="utf-8")

    def _boom(*_a, **_k):
        raise AssertionError("budget guard leaked an HTTP call")

    service, pieces, meta = _fallback_run(monkeypatch, _boom)
    assert pieces == ["로컬", "답"]
    assert meta == {"fallback": "local", "fallback_reason": "budget"}
    service.ensure_mode.assert_awaited_with("local")


def test_network_failure_falls_back_and_never_logs_key(_ledger, monkeypatch, capsys):
    def _leaky(*_a, **_k):
        raise RuntimeError("Authorization: Bearer " + FAKE_KEY)  # 키를 문 예외

    _service_, pieces, meta = _fallback_run(monkeypatch, _leaky)
    assert pieces == ["로컬", "답"]
    assert meta == {"fallback": "local", "fallback_reason": "error"}
    out = capsys.readouterr()
    assert FAKE_KEY not in out.out + out.err + json.dumps(meta)


def test_no_key_falls_back(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    _service_, pieces, meta = _fallback_run(monkeypatch, lambda *_a, **_k: None)
    assert pieces == ["로컬", "답"] and meta["fallback"] == "local"


def test_fallback_never_reaches_another_cloud(_ledger, monkeypatch):
    """로컬이 안 뜨면 다른 클라우드가 아니라 '사용 불가' 안내."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    service = _service()
    service.ensure_mode = AsyncMock(side_effect=["deepseek", "groq"])
    service._build_unavailable_reply = lambda _mode: "UNAVAILABLE"
    pieces = asyncio.run(_collect(service.chat_stream("hi", [], "auto", meta={})))
    assert pieces == ["UNAVAILABLE"]


# ── 4. prereqs / auto 우선순위 ───────────────────────────────────────────────

def test_prereqs_follow_key(monkeypatch):
    service = MOD.ClaudeService()
    assert service._mode_has_prereqs("deepseek") is True
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    assert service._mode_has_prereqs("deepseek") is False


def test_auto_priority_deepseek_first_only_with_key_and_only_for_chat(monkeypatch):
    service = MOD.ClaudeService()
    assert service.auto_mode_priority[0] == "deepseek"
    assert service._select_auto_mode() == "deepseek"
    assert service._select_auto_mode(chat=False) != "deepseek"  # 요약·디렉터·비전엔 안 씀

    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    legacy = [m for m in service.auto_mode_priority[1:] if service._mode_has_prereqs(m)]
    assert service._select_auto_mode() == (legacy[0] if legacy else "fallback")


# ── 5. 로컬 스트리밍 + 가나 금지 ─────────────────────────────────────────────

def test_local_stream_yields_multiple_chunks():
    torch = pytest.importorskip("torch")
    pytest.importorskip("transformers")

    class _Model:
        def generate(self, *_a, streamer, stopping_criteria, **_k):
            for piece in ["안녕", "하세요", "!"]:
                streamer.on_finalized_text(piece)
            streamer.on_finalized_text("", stream_end=True)

    class _Tok:
        eos_token_id = 0

    service = _service()
    service._model = _Model()
    service._tok = _Tok()
    service._torch = torch
    service._local_active = 0
    service._local_input_ids = lambda _messages: torch.zeros((1, 3), dtype=torch.long)
    service._local_logits_processor = lambda: None
    service._build_messages = lambda *_a: []

    async def _run():
        service._local_gen_lock = asyncio.Lock()
        return await _collect(service._chat_local_stream("hi", [], 4, None))

    pieces = asyncio.run(_run())
    assert len(pieces) >= 2 and "".join(pieces) == "안녕하세요!"
    assert service._local_active == 0


def test_local_prompt_limits_emoji_but_cloud_prompt_does_not():
    service = _service()
    service._build_messages = lambda *_a: []
    local = service._local_chat_messages("hi", [], 4, None)[0]["content"]
    assert local.endswith("이모지는 한 답에 최대 1개.")
    assert service._build_system_prompt(None) == "SYS"


def test_kana_processor_blocks_only_kana_tokens():
    torch = pytest.importorskip("torch")
    from transformers.models.gpt2.tokenization_gpt2 import bytes_to_unicode

    to_piece = bytes_to_unicode()

    def byte_piece(raw: bytes) -> str:  # 바이트 BPE가 vocab에 적는 모양
        return "".join(to_piece[b] for b in raw)

    # (디코드 글자, vocab 조각). 7·8은 바이트 조각 토큰: " カ"의 앞 조각 / 。의 앞 조각.
    vocab = [("안녕", byte_piece("안녕".encode())), ("漢字", byte_piece("漢字".encode())),
             ("ひら", byte_piece("ひら".encode())), ("カタ", byte_piece("カタ".encode())),
             ("ｱ", byte_piece("ｱ".encode())), ("abc", "abc"), ("ㇰ", byte_piece("ㇰ".encode())),
             (" \ufffd", byte_piece(b" \xe3\x82")), ("\ufffd", byte_piece(b"\xe3"))]

    class _Tok:
        def __len__(self):
            return len(vocab)

        def batch_decode(self, ids):
            return [vocab[i[0]][0] for i in ids]

        def convert_ids_to_tokens(self, ids):
            return [vocab[i][1] for i in ids]

    tok = _Tok()
    ids = MOD.kana_token_ids(tok)
    assert ids == [2, 3, 4, 6, 7]
    assert MOD.kana_token_ids(tok) is ids  # 1회 스캔 후 캐시

    scores = MOD.BanTokenIds(ids)(None, torch.zeros((1, len(vocab))))
    assert torch.isinf(scores[0, ids]).all()
    assert (scores[0, [0, 1, 5, 8]] == 0).all()  # 한글·한자·영문·모호한 E3 조각은 그대로


def test_chat_guard_keeps_a_slice_for_courseware(tmp_path):
    """채팅 몫 상한(CHAT_DAILY_CAP_USD)에 닿으면 일일 예산이 남아도 채팅은 막힌다 —
    밤 교재 변환 몫을 채팅이 다 먹지 못하게."""
    today = teacher_service._today()
    (tmp_path / "teacher_usage.json").write_text(json.dumps({
        today: {"calls": 1, "in_hit": 0, "in_miss": 0, "out": 0,
                "usd": teacher_service.CHAT_DAILY_CAP_USD, "usd_chat": teacher_service.CHAT_DAILY_CAP_USD}
    }), encoding="utf-8")
    assert teacher_service.CHAT_DAILY_CAP_USD < teacher_service.DAILY_BUDGET_USD
    with pytest.raises(teacher_service.TeacherUnavailable, match="budget"):
        teacher_service.chat_guard()


def test_chat_guard_passes_under_the_chat_cap(tmp_path):
    today = teacher_service._today()
    (tmp_path / "teacher_usage.json").write_text(json.dumps({
        today: {"calls": 1, "in_hit": 0, "in_miss": 0, "out": 0, "usd": 0.01, "usd_chat": 0.01}
    }), encoding="utf-8")
    key, base, model = teacher_service.chat_guard()
    assert key == FAKE_KEY and base and model


# ── 6. astra 재심 반영: 선점·취소·부분응답 ───────────────────────────────────

def test_chat_guard_reserves_so_concurrent_turns_cannot_both_pass(tmp_path, monkeypatch):
    """판정과 기록 사이에 두 번째 턴이 끼어도 선점액 때문에 같은 잔액으로 통과 못 한다."""
    monkeypatch.setattr(teacher_service, "_inflight_usd", 0.0)
    today = teacher_service._today()
    spent = teacher_service.CHAT_DAILY_CAP_USD - teacher_service.CHAT_RESERVE_USD * 0.5
    (tmp_path / "teacher_usage.json").write_text(json.dumps({
        today: {"calls": 1, "in_hit": 0, "in_miss": 0, "out": 0, "usd": spent, "usd_chat": spent}
    }), encoding="utf-8")
    teacher_service.chat_guard()  # 1번째: 통과(선점)
    with pytest.raises(teacher_service.TeacherUnavailable, match="budget"):
        teacher_service.chat_guard()  # 2번째: 선점 포함하면 상한 초과
    teacher_service.chat_release()
    teacher_service.chat_guard()  # 해제 뒤엔 다시 통과
    teacher_service.chat_release()
    assert teacher_service._inflight_usd == 0.0


def test_reservation_is_released_even_when_http_fails_before_streaming(_ledger, monkeypatch):
    monkeypatch.setattr(teacher_service, "_inflight_usd", 0.0)
    _service_, pieces, meta = _fallback_run(monkeypatch, lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("down")))
    assert meta["fallback"] == "local"
    assert teacher_service._inflight_usd == 0.0


def test_midstream_failure_marks_reply_partial(_ledger, monkeypatch):
    """첫 조각 뒤 끊기면 로컬을 이어 붙이지 않고, 잘렸다는 메타를 남긴다."""
    class _Broken(_FakeResponse):
        def __iter__(self):
            yield _sse_lines(["앞부분"])[0]
            raise ConnectionResetError("reset")

    monkeypatch.setattr(MOD.urllib.request, "urlopen", lambda *_a, **_k: _Broken([]))
    service = _service()
    service.ensure_mode = AsyncMock(return_value="deepseek")
    local_called = []

    async def _local(*_a, **_k):
        local_called.append(True)
        yield "로컬"

    service._chat_local_stream = _local
    meta = {}
    pieces = asyncio.run(_collect(service.chat_stream("hi", [], "auto", meta=meta)))
    assert pieces == ["앞부분"] and not local_called
    assert meta == {"fallback": "partial", "fallback_reason": "error"}


def test_client_disconnect_cancels_worker_and_closes_source(_ledger):
    """소비자가 중간에 닫으면 cancel이 켜지고 소스 제너레이터의 finally가 돈다."""
    service = _service()
    closed = []

    def _source():
        try:
            for i in range(1000):
                yield f"p{i}"
        finally:
            closed.append(True)

    async def _run():
        import threading
        cancel = threading.Event()
        agen = service._stream_sync_iter(_source, lambda p: p, cancel=cancel)
        first = await agen.__anext__()
        await agen.aclose()
        return first, cancel.is_set()

    first, cancelled = asyncio.run(_run())
    assert first == "p0" and cancelled
    import time
    for _ in range(50):
        if closed:
            break
        time.sleep(0.02)
    assert closed, "source generator finally did not run after cancel"
