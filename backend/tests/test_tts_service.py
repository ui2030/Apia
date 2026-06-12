"""
TTSService 단위 테스트 — 네트워크·오디오 장치 없이 엔진 라우팅과 폴백을 고정.

실제 edge_tts.Communicate / pyttsx3 대신 인스턴스 메서드를 스텁해서:
  - edge 성공 → (mp3 bytes, "audio/mpeg")
  - edge 실패 → 같은 요청 안에서 pyttsx3 폴백 → (wav, "audio/wav")
  - "system:" voice_id → edge를 아예 타지 않음
  - 알 수 없는 "edge:" id → 기본 음성으로 강등
  - 엔진 전무 → silent wav
  - /voices 노출 순서: edge 먼저(신규 기본), system 유지(기존 선택 존중)
"""
import asyncio
import threading
from unittest.mock import MagicMock

from services.tts_service import DEFAULT_EDGE_VOICE, EDGE_VOICES, TTSService


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


def test_edge_success_returns_mpeg_with_default_voice():
    svc = make_service()
    edge_calls = stub_edge(svc)
    audio, mime = asyncio.run(svc.synthesize("안녕", None))
    assert (audio, mime) == (b"mp3-bytes", "audio/mpeg")
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
    audio, mime = asyncio.run(svc.synthesize("안녕", None))
    assert (audio, mime) == (b"RIFF-wav", "audio/wav")
    # 폴백은 system 음성 미지정 — pyttsx3 기본(한국어 탐색 결과)을 쓴다.
    assert py_calls[0]["voice_id"] is None


def test_system_voice_skips_edge():
    svc = make_service()
    edge_calls = stub_edge(svc)
    py_calls = stub_pyttsx3(svc)
    audio, mime = asyncio.run(svc.synthesize("안녕", "system:v1"))
    assert mime == "audio/wav"
    assert edge_calls == []
    assert py_calls[0]["voice_id"] == "system:v1"


def test_edge_failure_without_pyttsx3_falls_to_silent():
    svc = make_service(pyttsx3=False)
    stub_edge(svc, fail=True)
    audio, mime = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav"
    assert audio.startswith(b"RIFF")


def test_pyttsx3_runtime_failure_falls_to_silent():
    svc = make_service()
    stub_edge(svc, fail=True)

    def _boom(text, voice_id=None):
        raise RuntimeError("sapi died")

    svc._synthesize_pyttsx3 = _boom
    audio, mime = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav"
    assert audio.startswith(b"RIFF")


def test_silent_when_no_engines():
    svc = make_service(edge=False, pyttsx3=False)
    audio, mime = asyncio.run(svc.synthesize("안녕", None))
    assert mime == "audio/wav"
    assert audio.startswith(b"RIFF")


def test_list_voices_edge_first_system_retained():
    svc = make_service()
    voices = svc.list_voices()
    assert voices[0]["id"] == EDGE_VOICES[0]["id"]
    assert {"id": "system:v1", "name": "Sys", "source": "system"} in voices


def test_list_voices_without_edge_only_system():
    svc = make_service(edge=False)
    assert [v["id"] for v in svc.list_voices()] == ["system:v1"]
