"""
main.py - AI 비서 백엔드 서버
FastAPI + Claude API + Whisper STT + VITS/RVC TTS
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="AI Assistant Backend", version="1.0.0")

# CORS 설정 (Electron에서 접근 허용)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 개발 중엔 전체 허용
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 라우터 등록
from routers import chat, tts, stt, voice

app.include_router(chat.router,  prefix="/chat",   tags=["chat"])
app.include_router(tts.router,   prefix="/tts",    tags=["tts"])
app.include_router(stt.router,   prefix="/stt",    tags=["stt"])
app.include_router(voice.router, prefix="/voices", tags=["voice"])


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "AI Assistant Backend is running 🚀"}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,   # 개발 중 자동 재시작
        log_level="info"
    )
