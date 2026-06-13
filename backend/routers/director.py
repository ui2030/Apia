"""
routers/director.py — J단계 LLM 행동 디렉터.

채팅(/chat)과 분리된 경량 엔드포인트. 컴팩트 컨텍스트(시간대/성격/대화최근성)를
받아 LLM에게 캐릭터의 "지금 무드/의도"를 엄격 JSON으로 묻고 raw 문자열을 돌려준다.
검증·clamp·폴백은 클라이언트(src/behaviorDirector.js)가 전담하므로 여기선
실패 시에도 500을 던지지 않고 raw=None을 돌려 앱이 규칙기반으로 계속 돌게 한다.

로컬 모델 중복 로드를 피하려고 routers.chat의 ClaudeService 싱글톤을 그대로 share.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from schemas import DirectorRequest, DirectorResponse
from routers.chat import claude  # 공유 ClaudeService 인스턴스(중복 init 방지)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("", response_model=DirectorResponse)
async def director(req: DirectorRequest) -> DirectorResponse:
    try:
        raw = await claude.decide_directive(req.context, ai_mode=req.ai_mode)
        return DirectorResponse(raw=raw)
    except Exception as error:  # noqa: BLE001
        # 디렉터는 보조 기능 — 실패는 조용히 흡수, 클라이언트는 규칙기반 폴백.
        logger.warning("[director] decide failed: %r", error)
        return DirectorResponse(raw=None)
