"""
TTSService 단위 테스트 — 네트워크·오디오 장치 없이 엔진 라우팅과 폴백을 고정.

실제 edge_tts / pyttsx3 / seed-vc 대신 인스턴스 메서드·모듈 함수를 스텁해서:
  - edge 성공 → (mp3, "audio/mpeg", fallback=False)
  - edge 실패 → 같은 요청 안에서 pyttsx3 → silent 폴백
  - "system:" voice_id → edge를 아예 타지 않음
  - "custom:" voice_id → 변환 성공/실패/미설치/미로드 각 경로와 fallback 플래그
"""
import asyncio
import threading
from pathlib import Path
from unittest.mock import MagicMock

from services.tts_service import DEFAULT_EDGE_VOICE, EDGE_VOICES, TTSService
from services import voice_clone_service as clone
from services import voice_manager


def make_service(edge: bool = True, pyttsx3: bool = True) -> TTSService:
    svc = TTSService.__new__(TTSService)
    svc._edge_available = edge
    svc._engine_lock = threading.Lock()
    svc._available_voices = (
        [{"id": "system:v1", "name": "Sys", "source": "system"}] if pyttsx3 else []
    )
    if pyttsx3:
        svc._pyttsx3 = MagicMock()
        svc.engine_type = "edge" if edge else "pyttsx3"
    else:
        svc.engine_type = "edge" if edge else "silent"
    return svc


def stub_edge(svc: TTSService, *, data: bytes = b"mp3-bytes", fail: bool = False):
    calls = []

    async def _fake(text: str, voice: str) -> bytes:
        calls.append({"text": text, "voice": voice})
        if fail:
            raise RuntimeError("offline")
        return data

    svc._synthesize_edge = _fake
    return calls


def stub_pyttsx3(svc: TTSService, data: bytes = b"RIFF-wav"):
    calls = []

    def _fake(text: str, voice_id=None) -> bytes:
        calls.append({"text": text, "voice_id": voice_id})
        return data

    svc._synthesize_pyttsx3 = _fake
    return calls


# ── 기본 엔진 라우팅 ────────────────────────────────────────────────────

def test_edge_success_returns_mpeg_with_default_voice():
    svc = make_service()
    edge_calls = stub_edge(svc)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None))
    assert (audio, mime, fallback) == (b"mp3-bytes", "audio/mpeg", False)
    assert edge_calls[0]["voice"] == DEFAULT_EDGE_VOICE


def test_edge_voice_id_resolves_short_name():
    svc = make_service()
    edge_calls = stub_edge(svc)
    asyncio.run(svc.synthesize("안녕", "edge:ko-KR-InJoonNeural"))
    assert edge_calls[0]["voice"] == "ko-KR-InJoonNeural"


def test_unknown_edge_voice_falls_back_to_default():
    svc = make_service()
    edge_calls = stub_edge(svc)
    asyncio.run(svc.synthesize("안녕", "edge:no-such-voice"))
    assert edge_calls[0]["voice"] == DEFAULT_EDGE_VOICE


def test_edge_failure_falls_back_to_pyttsx3():
    svc = make_service()
    stub_edge(svc, fail=True)
    py_calls = stub_pyttsx3(svc)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None))
    assert (audio, mime, fallback) == (b"RIFF-wav", "audio/wav", False)
    assert py_calls[0]["voice_id"] is None


def test_system_voice_skips_edge():
    svc = make_service()
    edge_calls = stub_edge(svc)
    py_calls = stub_pyttsx3(svc)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", "system:v1"))
    assert mime == "audio/wav" and fallback is False
    assert edge_calls == []
    assert py_calls[0]["voice_id"] == "system:v1"


def test_edge_failure_without_pyttsx3_falls_to_silent():
    svc = make_service(pyttsx3=False)
    stub_edge(svc, fail=True)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav" and fallback is False
    assert audio.startswith(b"RIFF")


def test_pyttsx3_runtime_failure_falls_to_silent():
    svc = make_service()
    stub_edge(svc, fail=True)

    def _boom(text, voice_id=None):
        raise RuntimeError("sapi died")

    svc._synthesize_pyttsx3 = _boom
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav" and fallback is False
    assert audio.startswith(b"RIFF")


def test_silent_when_no_engines():
    svc = make_service(edge=False, pyttsx3=False)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav" and fallback is False
    assert audio.startswith(b"RIFF")


def test_list_voices_edge_first_system_retained():
    svc = make_service()
    voices = svc.list_voices()
    assert voices[0]["id"] == EDGE_VOICES[0]["id"]
    assert {"id": "system:v1", "name": "Sys", "source": "system"} in voices


def test_list_voices_without_edge_only_system():
    svc = make_service(edge=False)
    assert [v["id"] for v in svc.list_voices()] == ["system:v1"]


# ── custom(복제) 음성 경로 ──────────────────────────────────────────────

def _custom_env(monkeypatch, tmp_path: Path, *, available=True, loaded=True,
                convert_result: bytes | Exception = b"converted-wav"):
    """voice_clone_service/voice_manager를 스텁하고 참조 음성 디렉터리 생성."""
    dir_id = "voice_0a1b2c3d"
    voice_dir = tmp_path / dir_id
    voice_dir.mkdir(parents=True)
    (voice_dir / "reference.wav").write_bytes(b"RIFF-ref")
    monkeypatch.setattr(voice_manager, "VOICES_DIR", tmp_path)

    monkeypatch.setattr(clone, "is_available", lambda: available)
    monkeypatch.setattr(clone, "is_loaded", lambda: loaded)

    load_calls = []

    async def _fake_ensure_loaded(progress_cb=None):
        load_calls.append(True)

    monkeypatch.setattr(clone, "ensure_loaded", _fake_ensure_loaded)

    convert_calls = []

    async def _fake_convert(audio, mime, ref_path):
        convert_calls.append({"audio": audio, "mime": mime, "ref": str(ref_path)})
        if isinstance(convert_result, Exception):
            raise convert_result
        return convert_result

    monkeypatch.setattr(clone, "convert", _fake_convert)
    return dir_id, load_calls, convert_calls


def test_custom_voice_converts(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    dir_id, _, convert_calls = _custom_env(monkeypatch, tmp_path)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", f"custom:{dir_id}"))
    assert (audio, mime, fallback) == (b"converted-wav", "audio/wav", False)
    assert convert_calls[0]["mime"] == "audio/mpeg"  # edge 원음이 입력
    assert convert_calls[0]["ref"].endswith("reference.wav")


def test_custom_voice_unavailable_falls_back_with_flag(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    dir_id, _, convert_calls = _custom_env(monkeypatch, tmp_path, available=False)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", f"custom:{dir_id}"))
    assert (audio, mime, fallback) == (b"mp3-bytes", "audio/mpeg", True)
    assert convert_calls == []


def test_custom_voice_not_loaded_kicks_warmup_and_falls_back(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    dir_id, load_calls, convert_calls = _custom_env(monkeypatch, tmp_path, loaded=False)

    async def _run():
        result = await svc.synthesize("안녕", f"custom:{dir_id}")
        await asyncio.sleep(0)  # ensure_future로 띄운 로드 태스크 소진
        return result

    audio, mime, fallback = asyncio.run(_run())
    assert fallback is True and mime == "audio/mpeg"
    assert load_calls == [True]
    assert convert_calls == []


def test_custom_voice_convert_failure_falls_back(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    dir_id, _, _ = _custom_env(
        monkeypatch, tmp_path, convert_result=RuntimeError("gpu oom")
    )
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", f"custom:{dir_id}"))
    assert (audio, mime, fallback) == (b"mp3-bytes", "audio/mpeg", True)


def test_custom_voice_invalid_dir_id_falls_back(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    _custom_env(monkeypatch, tmp_path)
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", "custom:../evil"))
    assert fallback is True


def test_custom_voice_missing_reference_falls_back(monkeypatch, tmp_path):
    svc = make_service()
    stub_edge(svc)
    dir_id, _, _ = _custom_env(monkeypatch, tmp_path)
    (tmp_path / dir_id / "reference.wav").unlink()
    audio, mime, fallback = asyncio.run(svc.synthesize("안녕", f"custom:{dir_id}"))
    assert fallback is True
