"""
routers/stt.py - 음성 → 텍스트 (Whisper).

WhisperService는 lazy로 인스턴스화한다. `whisper.load_model("small")`이 ~500MB의
모델을 동기로 로드하므로 module import 시점에 인스턴스화하면 uvicorn startup이 그
시간만큼 통째로 블록된다 (packaged 환경에서 backend readiness 타임아웃을 넘길 수
있음 — REGRESSION_NOTES 'Backend readiness probes' 참고).

voice.py / claude_service.py와 같은 패턴: asyncio.Lock으로 동시 첫 요청 race 막고,
init은 asyncio.to_thread로 이벤트 루프에서 떼어낸다.
"""
import asyncio

from fastapi import APIRouter, UploadFile, File

from schemas import STTResponse

router = APIRouter()
_whisper = None
_whisper_lock = asyncio.Lock()


async def get_whisper():
    global _whisper
    if _whisper is not None:
        return _whisper
    async with _whisper_lock:
        if _whisper is None:
            from services.whisper_service import WhisperService

            _whisper = await asyncio.to_thread(WhisperService)
    return _whisper


async def prime() -> None:
    """warmup 라우터에서 호출. Whisper가 설치돼 있으면 background에서 미리 로드해
    첫 /stt/transcribe 요청이 ~10s 모델 로드 비용을 떠안지 않게 한다. 미설치 환경
    (packaged exe)에선 WhisperService 생성자가 즉시 실패-fallback이라 거의 무료."""
    await get_whisper()


@router.post("/transcribe", response_model=STTResponse)
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    whisper = await get_whisper()
    text = await whisper.transcribe(audio_bytes)
    return {"text": text}
