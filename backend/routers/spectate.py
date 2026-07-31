"""
routers/spectate.py — M2 관전 모드. 사용자가 고른 창 한 장을 보고 상황/주목좌표/
흥미도를 읽는다.

director.py와 같은 분담: 검증·clamp·침묵 게이트는 전부 클라이언트
(src/spectateDriver.js)가 하고 여기선 raw 문자열만 돌려준다. 실패도 500이 아니라
raw=None — 관전이 조용히 쉬는 것이 앱을 흔드는 것보다 낫다.

로컬 모델 중복 로드를 피하려고 routers.chat의 ClaudeService 싱글톤을 share.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from routers.chat import claude  # 공유 ClaudeService 인스턴스(중복 init 방지)
from schemas import SpectateRequest, SpectateResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("", response_model=SpectateResponse)
async def spectate(req: SpectateRequest) -> SpectateResponse:
    try:
        raw = await claude.describe_screen(
            req.image_b64, req.context, ai_mode=req.ai_mode
        )
        return SpectateResponse(raw=raw)
    except Exception as error:  # noqa: BLE001
        # 관전은 보조 기능 — 실패는 조용히 흡수, 클라이언트는 다음 tick에 재시도.
        logger.warning("[spectate] describe failed: %r", error)
        return SpectateResponse(raw=None)
