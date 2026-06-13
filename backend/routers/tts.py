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
    audio_bytes, mime, fallback = await tts_service.synthesize(req.text, req.voice_id)
    # fallback=True: 요청한 음성(주로 custom 복제 음성)이 아닌 대체 음성으로
    # 합성됨 — 프런트가 "기본 음성으로 말했어요"를 안내할 수 있게 헤더로.
    headers = {"X-Apia-Tts-Fallback": "1"} if fallback else {}
    return Response(content=audio_bytes, media_type=mime, headers=headers)
