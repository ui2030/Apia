"""
routers/stt.py - 음성 → 텍스트 (Whisper)
"""
from fastapi import APIRouter, UploadFile, File
from services.whisper_service import WhisperService

router = APIRouter()
whisper = WhisperService()


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    text = await whisper.transcribe(audio_bytes)
    return {"text": text}
