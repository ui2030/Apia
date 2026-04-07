"""
routers/chat.py
Claude API 연동 대화 엔드포인트
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional
from services.claude_service import ClaudeService

router = APIRouter()
claude = ClaudeService()


class Message(BaseModel):
    role: str    # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: Optional[List[Message]] = []


class ChatResponse(BaseModel):
    reply: str
    emotion: Optional[str] = "neutral"  # happy | sad | angry | surprised | neutral


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest):
    reply, emotion = await claude.chat(req.message, req.history)
    return ChatResponse(reply=reply, emotion=emotion)
