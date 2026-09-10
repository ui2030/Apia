"""cosyvoice_service 단위 테스트 — 실제 워커/GPU 없이 프로토콜 계약을 고정.

워커 프로세스는 FakeProc로 대체한다(요청 라인을 받아 응답 라인을 큐에 넣는
가짜 파이프). 검증 대상:
  - 요청 id 직렬화, 응답 id 불일치 → 실패 + 재스폰
  - stdout 오염(비정형 줄) → 실패 + 재스폰
  - 청크 타임아웃 → 실패 + 재스폰
  - 경로 검증 실패 → 스폰 시도조차 안 함
  - 유휴 킬 + 다음 요청에서 재스폰
  - 긴 문장 청크 분할 후 wav 이어붙이기
  - tts_service 폴백 계약(어떤 실패든 기본 체인 + fallback=True)
"""
import asyncio
import io
import json
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest
import soundfile as sf

from services import cosyvoice_service as cosy
from services.tts_service import TTSService


def make_wav(seconds: float = 0.1, sr: int = 24000) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, np.zeros(int(sr * seconds), dtype="float32"), sr, format="WAV")
    return buffer.getvalue()


# ── 가짜 워커 프로세스 ──────────────────────────────────────────────────────

class _Stdin:
    def __init__(self, proc):
        self._proc = proc

    def write(self, data):
        request = json.loads(data.decode("utf-8"))
        self._proc.requests.append(request)
        reply = self._proc.responder(request, self._proc)
        if reply is not None:
            self._proc.queued.append(reply)

    async def drain(self):
        pass


class _Stdout:
    def __init__(self, proc):
        self._proc = proc

    async def readline(self):
        if self._proc.queued:
            return self._proc.queued.pop(0)
        if self._proc.returncode is not None:
            return b""
        await asyncio.sleep(30)  # 응답 없음 = 워커 멈춤 (타임아웃 테스트용)
        return b""


class FakeProc:
    def __init__(self, responder, ready=b'{"id": "__ready__", "sample_rate": 24000}\n'):
        self.pid = 424242
        self.returncode = None
        self.requests = []
        self.queued = [ready] if ready is not None else []
        self.responder = responder
        self.reaped = False
        self.stdin = _Stdin(self)
        self.stdout = _Stdout(self)

    def kill(self):
        self.returncode = -9

    async def wait(self):
        # kill() 뒤 반드시 거둬간다(안 거두면 asyncio가 unclosed transport를 토한다).
        self.reaped = True
        return self.returncode


def echo_ok(tmp_path, wav: bytes = None):
    """정상 응답 responder — 워커가 하듯 wav를 디스크에 쓰고 경로를 돌려준다."""
    payload = wav if wav is not None else make_wav()

    def _responder(request, proc):
        wav_path = Path(tmp_path) / f"{request['id']}.wav"
        wav_path.write_bytes(payload)
        return json.dumps({
            "id": request["id"],
            "wav_path": str(wav_path),
            "mime": "audio/wav",
            "duration_ms": 100,
        }).encode("utf-8") + b"\n"

    return _responder


@pytest.fixture(autouse=True)
def clean_state(monkeypatch, tmp_path):
    """모듈 전역(워커 핸들/유휴 시각)과 경로 구성을 테스트마다 초기화."""
    monkeypatch.setattr(cosy, "_proc", None, raising=False)
    monkeypatch.setattr(cosy, "_last_used", 0.0, raising=False)
    monkeypatch.setattr(cosy, "_lock", asyncio.Lock(), raising=False)
    monkeypatch.setattr(cosy, "WORK_DIR", tmp_path / "cosyvoice")
    monkeypatch.setattr(cosy, "OUT_DIR", tmp_path / "cosyvoice" / "out")
    monkeypatch.setattr(cosy, "USER_PROMPT_WAV", tmp_path / "cosyvoice" / "prompt.wav")
    monkeypatch.setattr(cosy, "DEFAULT_PROMPT_WAV", tmp_path / "cosyvoice" / "default_prompt.wav")
    # 실제 taskkill이 가짜 pid로 나가지 않게 — 이 프로세스 밖으로 나가는 유일한 부수효과.
    monkeypatch.setattr(cosy.subprocess, "run", MagicMock())
    # 경로 검증은 기본적으로 통과시켜 두고, 검증 테스트에서만 되돌린다.
    python_stub = tmp_path / "python.exe"
    python_stub.write_text("")
    repo = tmp_path / "repo"
    (repo / "model").mkdir(parents=True)
    monkeypatch.setattr(cosy, "COSYVOICE_PYTHON", str(python_stub))
    monkeypatch.setattr(cosy, "COSYVOICE_REPO", str(repo))
    monkeypatch.setattr(cosy, "COSYVOICE_MODEL_DIR", "model")
    monkeypatch.setattr(cosy, "COSYVOICE_PROMPT_WAV", "")
    yield


def use_worker(monkeypatch, *procs):
    """_spawn을 가짜로 대체. 여러 개 주면 재스폰 순서대로 나온다."""
    spawned = list(procs)

    async def _fake_spawn():
        return spawned.pop(0)

    monkeypatch.setattr(cosy, "_spawn", _fake_spawn)


# ── 경로 검증 ───────────────────────────────────────────────────────────────

def test_config_error_reports_unset_env(monkeypatch):
    monkeypatch.setattr(cosy, "COSYVOICE_PYTHON", "")
    assert "APIA_COSYVOICE_PYTHON not set" in cosy.config_error()
    assert cosy.is_configured() is False


def test_config_error_reports_missing_path(monkeypatch, tmp_path):
    monkeypatch.setattr(cosy, "COSYVOICE_MODEL_DIR", "nope")
    error = cosy.config_error()
    assert "APIA_COSYVOICE_MODEL_DIR path missing" in error


def test_config_ok_when_all_paths_exist():
    assert cosy.config_error() is None
    # 상대 모델 경로는 저장소 루트 기준으로 풀린다(백엔드 cwd에 딸려가지 않게).
    assert cosy.model_dir() == Path(cosy.COSYVOICE_REPO) / "model"


def test_unconfigured_never_spawns(monkeypatch, tmp_path):
    monkeypatch.setattr(cosy, "COSYVOICE_REPO", str(tmp_path / "gone"))
    spawned = []

    async def _fake_spawn():
        spawned.append(1)
        raise AssertionError("must not spawn")

    monkeypatch.setattr(cosy, "_spawn", _fake_spawn)
    with pytest.raises(RuntimeError, match="path missing"):
        asyncio.run(cosy.synthesize("안녕", tmp_path / "ref.wav"))
    assert spawned == []


# ── 문장 분할 ───────────────────────────────────────────────────────────────

def test_split_text_merges_short_sentences():
    assert cosy.split_text("안녕. 반가워!") == ["안녕. 반가워!"]


def test_split_text_breaks_at_sentence_boundary():
    long_sentence = "가나다라마바사아자차카타파하" * 6  # 84자
    chunks = cosy.split_text(f"{long_sentence}. {long_sentence}.")
    assert len(chunks) == 2
    assert all(len(c) <= cosy.CHUNK_CHARS for c in chunks)


def test_split_text_hard_cuts_runaway_text():
    chunks = cosy.split_text("가" * 500)
    assert len(chunks) == 5
    assert all(len(c) <= cosy.CHUNK_CHARS for c in chunks)


def test_split_text_empty():
    assert cosy.split_text("   ") == []


# ── 프로토콜 ────────────────────────────────────────────────────────────────

def test_synthesize_happy_path(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)

    audio, mime = asyncio.run(cosy.synthesize("안녕하세요.", Path("ref.wav"), "참조 문장"))

    assert mime == "audio/wav"
    assert audio.startswith(b"RIFF")
    assert len(proc.requests) == 1
    assert proc.requests[0]["text"] == "안녕하세요."
    assert proc.requests[0]["prompt_wav"] == "ref.wav"
    assert proc.requests[0]["prompt_text"] == "참조 문장"
    # 출력 wav는 읽은 즉시 지운다 (DATA_DIR에 쌓이지 않게).
    assert list((tmp_path).glob("*.wav")) == []


def test_worker_reused_across_calls(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)  # 두 번째 스폰은 IndexError → 재스폰하면 터진다

    async def _two():
        await cosy.synthesize("첫 번째.", Path("ref.wav"))
        await cosy.synthesize("두 번째.", Path("ref.wav"))

    asyncio.run(_two())
    assert len(proc.requests) == 2
    assert proc.returncode is None


def test_long_text_is_chunked_and_joined(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)
    long_sentence = "가나다라마바사아자차카타파하" * 6

    audio, _ = asyncio.run(
        cosy.synthesize(f"{long_sentence}. {long_sentence}.", Path("ref.wav"))
    )

    assert len(proc.requests) == 2
    assert len({r["id"] for r in proc.requests}) == 2  # 청크마다 새 id
    data, sr = sf.read(io.BytesIO(audio), dtype="float32")
    assert sr == 24000
    assert len(data) == pytest.approx(24000 * 0.2, abs=8)  # 0.1s 두 개


def test_response_id_mismatch_kills_worker(monkeypatch, tmp_path):
    def _wrong_id(request, proc):
        return b'{"id": "someone-else", "wav_path": "x.wav"}\n'

    dead = FakeProc(_wrong_id)
    fresh = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, dead, fresh)

    with pytest.raises(RuntimeError, match="id mismatch"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    assert dead.returncode == -9
    assert cosy._proc is None

    # 다음 요청은 새 워커로 재스폰된다.
    audio, _ = asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    assert audio.startswith(b"RIFF")


def test_stdout_pollution_kills_worker(monkeypatch, tmp_path):
    def _noise(request, proc):
        return b"Loading checkpoint shards: 100%|####| 2/2\n"

    proc = FakeProc(_noise)
    use_worker(monkeypatch, proc)

    with pytest.raises(RuntimeError, match="unparseable"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    assert proc.returncode == -9
    assert cosy._proc is None


def test_worker_error_payload_keeps_worker_alive(monkeypatch, tmp_path):
    def _error(request, proc):
        return json.dumps({"id": request["id"], "error": "CUDA OOM"}).encode() + b"\n"

    proc = FakeProc(_error)
    use_worker(monkeypatch, proc)

    with pytest.raises(RuntimeError, match="CUDA OOM"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    # 요청 하나가 실패한 것뿐 — 스트림은 멀쩡하므로 재스폰하지 않는다.
    assert proc.returncode is None


def test_chunk_timeout_kills_worker(monkeypatch, tmp_path):
    monkeypatch.setattr(cosy, "CHUNK_TIMEOUT_SEC", 0.05)
    proc = FakeProc(lambda request, p: None)  # 응답 없음
    use_worker(monkeypatch, proc)

    with pytest.raises(RuntimeError, match="chunk timeout"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    assert proc.returncode == -9
    assert cosy._proc is None


def test_worker_start_failure_reports_and_clears(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path), ready=b'{"id": "__ready__", "error": "ImportError: torch"}\n')
    use_worker(monkeypatch, proc)

    with pytest.raises(RuntimeError, match="start failed"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))
    assert proc.returncode == -9
    assert cosy._proc is None


def test_worker_death_at_startup(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path), ready=b"")  # EOF = 즉시 죽음
    use_worker(monkeypatch, proc)

    with pytest.raises(RuntimeError, match="start failed"):
        asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))


# ── 유휴 수명 관리 ──────────────────────────────────────────────────────────

def test_idle_unload_respects_recent_use(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)
    asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))

    assert asyncio.run(cosy.maybe_unload_idle()) is False
    assert proc.returncode is None


def test_idle_unload_kills_and_respawns(monkeypatch, tmp_path):
    old = FakeProc(echo_ok(tmp_path))
    new = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, old, new)
    asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))

    monkeypatch.setattr(cosy, "_last_used", time.monotonic() - 31 * 60)
    assert asyncio.run(cosy.maybe_unload_idle()) is True
    assert old.returncode == -9
    assert old.reaped is True
    assert cosy._proc is None
    # 트리째 죽이기(Windows) — pid를 넘긴 taskkill /T /F 한 번.
    if cosy.sys.platform == "win32":
        args = cosy.subprocess.run.call_args[0][0]
        assert args[:2] == ["taskkill", "/PID"] and "/T" in args and "/F" in args

    asyncio.run(cosy.synthesize("다시.", Path("ref.wav")))
    assert cosy._proc is new


def test_idle_unload_disabled(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)
    asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))

    monkeypatch.setattr(cosy, "COSYVOICE_IDLE_UNLOAD_MIN", 0)
    monkeypatch.setattr(cosy, "_last_used", time.monotonic() - 999 * 60)
    assert asyncio.run(cosy.maybe_unload_idle()) is False
    assert proc.returncode is None


def test_idle_unload_skips_inflight(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)

    async def _scenario():
        await cosy.synthesize("안녕.", Path("ref.wav"))
        cosy._last_used = time.monotonic() - 31 * 60
        async with cosy._lock:  # 합성 in-flight를 흉내
            return await cosy.maybe_unload_idle()

    assert asyncio.run(_scenario()) is False
    assert proc.returncode is None


def test_kill_is_idempotent(monkeypatch, tmp_path):
    proc = FakeProc(echo_ok(tmp_path))
    use_worker(monkeypatch, proc)
    asyncio.run(cosy.synthesize("안녕.", Path("ref.wav")))

    asyncio.run(cosy.kill())
    asyncio.run(cosy.kill())  # 두 번째는 no-op (lifespan shutdown 중복 호출 대비)
    assert cosy._proc is None
    assert cosy.subprocess.run.call_count <= 1


# ── 참조 음성 선택 ──────────────────────────────────────────────────────────

def test_resolve_prompt_prefers_user_upload(monkeypatch, tmp_path):
    assert cosy.resolve_prompt_wav() is None
    cosy.DEFAULT_PROMPT_WAV.parent.mkdir(parents=True, exist_ok=True)
    cosy.DEFAULT_PROMPT_WAV.write_bytes(b"x")
    assert cosy.resolve_prompt_wav() == cosy.DEFAULT_PROMPT_WAV
    cosy.USER_PROMPT_WAV.write_bytes(b"x")
    assert cosy.resolve_prompt_wav() == cosy.USER_PROMPT_WAV


def test_prompt_text_sidecar(tmp_path):
    wav = tmp_path / "ref.wav"
    wav.write_bytes(b"x")
    assert cosy.prompt_text_for(wav) == ""  # 사용자 업로드 = 전사 모름 → cross-lingual
    wav.with_suffix(".txt").write_text("안녕하세요", encoding="utf-8")
    assert cosy.prompt_text_for(wav) == "안녕하세요"


# ── tts_service 통합(폴백 계약) ─────────────────────────────────────────────

def make_tts() -> TTSService:
    svc = TTSService.__new__(TTSService)
    svc._edge_available = True
    svc._engine_lock = threading.Lock()
    svc._available_voices = []
    svc._pyttsx3 = MagicMock()
    svc.engine_type = "edge"

    async def _edge(text, voice):
        return b"edge-audio"

    svc._synthesize_edge = _edge
    svc._mp3_to_wav = lambda data: (make_wav(), "audio/wav")
    return svc


def test_tts_falls_back_when_unconfigured(monkeypatch):
    monkeypatch.setattr(cosy, "COSYVOICE_PYTHON", "")
    audio, mime, fallback = asyncio.run(make_tts().synthesize("안녕", None, "cosyvoice"))
    assert fallback is True and mime == "audio/wav" and audio


def test_tts_falls_back_when_worker_fails(monkeypatch):
    async def _boom(text, prompt_wav, prompt_text=""):
        raise RuntimeError("cosyvoice chunk timeout (30s)")

    monkeypatch.setattr(cosy, "synthesize", _boom)
    svc = make_tts()
    monkeypatch.setattr(cosy, "resolve_prompt_wav", lambda: Path("ref.wav"))
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None, "cosyvoice"))
    assert fallback is True and audio


def test_tts_falls_back_when_edge_reference_generation_fails(monkeypatch):
    svc = make_tts()

    async def _dead_edge(text, voice):
        raise RuntimeError("offline")

    svc._synthesize_edge = _dead_edge
    svc._synthesize_pyttsx3 = lambda text, voice_id=None: b"RIFFpyttsx3"
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None, "cosyvoice"))
    assert fallback is True
    assert audio == b"RIFFpyttsx3"  # edge도 죽었으니 다음 단계까지 내려간다


def test_tts_generates_default_reference_once(monkeypatch, tmp_path):
    svc = make_tts()
    seen = {}
    edge_calls = []

    async def _capture(text, prompt_wav, prompt_text=""):
        seen["prompt_wav"] = prompt_wav
        seen["prompt_text"] = prompt_text
        return make_wav(), "audio/wav"

    async def _edge(text, voice):
        edge_calls.append(text)
        return b"edge-audio"

    svc._synthesize_edge = _edge
    monkeypatch.setattr(cosy, "synthesize", _capture)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None, "cosyvoice"))
    asyncio.run(svc.synthesize("또 안녕", None, "cosyvoice"))

    # 두 번째 발화는 캐시된 참조를 재사용 — edge는 딱 한 번만 불린다.
    assert edge_calls == [cosy.DEFAULT_PROMPT_TEXT]
    assert fallback is False and mime == "audio/wav"
    assert seen["prompt_wav"] == cosy.DEFAULT_PROMPT_WAV
    # 전사를 아는 자동 생성 참조라 zero-shot 경로(sidecar 존재)를 탄다.
    assert seen["prompt_text"] == cosy.DEFAULT_PROMPT_TEXT
    assert cosy.DEFAULT_PROMPT_WAV.exists()


def test_tts_default_engine_untouched(monkeypatch):
    """엔진 미지정 = 기존 체인. cosyvoice 코드는 쳐다보지도 않는다."""
    async def _explode(*args, **kwargs):
        raise AssertionError("cosyvoice must not run for the default engine")

    monkeypatch.setattr(cosy, "synthesize", _explode)
    audio, mime, fallback = asyncio.run(make_tts().synthesize("안녕", None))
    assert fallback is False and mime == "audio/wav"
