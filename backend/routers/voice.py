"""
routers/voice.py - 목소리 모델 관리
"""
from fastapi import APIRouter, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse
from services.voice_manager import VoiceManager

router = APIRouter()
vm = VoiceManager()


@router.get("")
async def list_voices():
    voices = vm.list_voices()
    return {"voices": voices}


@router.post("/upload")
async def upload_voice(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    name: str = Form(...)
):
    """WAV 업로드 → 학습 시작"""
    job_id = await vm.start_training(file, name)
    return {"job_id": job_id, "message": f"'{name}' 학습이 시작됐어요!"}


@router.get("/train/{job_id}")
async def training_progress(job_id: str):
    """학습 진행률 조회"""
    progress = vm.get_progress(job_id)
    return progress


@router.get("/{voice_id}/preview")
async def preview_voice(voice_id: str):
    """미리듣기 오디오 반환"""
    path = vm.get_preview_path(voice_id)
    if path and path.exists():
        return FileResponse(path, media_type="audio/wav")
    return {"error": "미리듣기 파일이 없어요"}


@router.delete("/{voice_id}")
async def delete_voice(voice_id: str):
    vm.delete_voice(voice_id)
    return {"ok": True}
