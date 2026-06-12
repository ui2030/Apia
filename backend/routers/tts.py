"""
routers/tts.py - 텍스트 → 음성.

TTSService 인스턴스는 voice.py와 공유한다 (`from routers.voice import get_tts`).
별도 인스턴스를 만들면 pyttsx3 init이 두 번 돌고, 음성 선택 상태가 라우터 사이에
어긋난다 (voice 라우터에서 바꾼 voice가 tts 라우터엔 반영 안 됨).
"""
from fastapi import APIRouter
from fastapi.responses import Response

from routers.voice import get_tts
from schemas import TTSRequest

router = APIRouter()


@router.post("")
async def tts(req: TTSRequest):
    tts_service = await get_tts()
    audio_bytes, mime = await tts_service.synthesize(req.text, req.voice_id)
    return Response(content=audio_bytes, media_type=mime)
