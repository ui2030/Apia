"""
routers/tts.py - 텍스트 → 음성
"""
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional
from services.tts_service import TTSService

router = APIRouter()
tts_service = TTSService()


class TTSRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None


@router.post("")
async def tts(req: TTSRequest):
    audio_bytes = await tts_service.synthesize(req.text, req.voice_id)
    return Response(content=audio_bytes, media_type="audio/wav")
