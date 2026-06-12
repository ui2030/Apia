"""
routers/voice.py - 목소리 모델 관리.

TTSService / VoiceManager는 lazy로 인스턴스화한다. pyttsx3 init이 OS에 따라 cold
start에서 무시 못할 비용을 내는 사례가 있고, ClaudeService에서 같은 패턴으로
모듈 import-time init을 제거한 결정과 일관성을 맞추기 위해서다.

동시 첫 요청에서 같은 서비스를 두 번 생성하지 않도록 asyncio.Lock으로 보호하고,
init이 동기/블로킹이므로 asyncio.to_thread로 이벤트 루프에서 떼어낸다. warmup
라우터가 prime()을 호출하면 첫 /voices 요청 전에 미리 인스턴스화된다.

`get_tts()`는 tts.py도 import해서 공유한다 — 라우터마다 별도 인스턴스를 만들면
pyttsx3 init이 라우터 수만큼 반복되고, 음성 선택 상태도 라우터 사이에 분기된다.
"""
import asyncio

from fastapi import APIRouter, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse

from schemas import VoicesResponse

router = APIRouter()
_tts = None
_vm = None
_tts_lock = asyncio.Lock()
_vm_lock = asyncio.Lock()


async def get_tts():
    global _tts
    if _tts is not None:
        return _tts
    async with _tts_lock:
        if _tts is None:
            from services.tts_service import TTSService

            _tts = await asyncio.to_thread(TTSService)
    return _tts


async def get_vm():
    global _vm
    if _vm is not None:
        return _vm
    async with _vm_lock:
        if _vm is None:
            from services.voice_manager import VoiceManager

            _vm = await asyncio.to_thread(VoiceManager)
    return _vm


async def prime() -> None:
    """warmup 라우터에서 호출. 첫 /voices 요청 전에 TTS/VM을 미리 인스턴스화한다."""
    await get_tts()
    await get_vm()


@router.get("", response_model=VoicesResponse)
async def list_voices():
    tts = await get_tts()
    vm = await get_vm()
    return {
        "voices": tts.list_voices(),
        "unsupported_custom_voices": vm.list_voices(),
    }


@router.post("/upload")
async def upload_voice(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    name: str = Form(...)
):
    """WAV 업로드 → 학습 시작"""
    vm = await get_vm()
    job_id = await vm.start_training(file, name)
    return {"job_id": job_id, "message": f"'{name}' 학습이 시작됐어요!"}


@router.get("/train/{job_id}")
async def training_progress(job_id: str):
    """학습 진행률 조회"""
    vm = await get_vm()
    return vm.get_progress(job_id)


@router.get("/{voice_id}/preview")
async def preview_voice(voice_id: str):
    """미리듣기 오디오 반환"""
    vm = await get_vm()
    path = vm.get_preview_path(voice_id)
    if path and path.exists():
        return FileResponse(path, media_type="audio/wav")
    return {"error": "미리듣기 파일이 없어요"}


@router.delete("/{voice_id}")
async def delete_voice(voice_id: str):
    vm = await get_vm()
    vm.delete_voice(voice_id)
    return {"ok": True}
