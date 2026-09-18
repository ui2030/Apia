"""
routers/classify.py — 눈치 원장 계측기의 화제 분류.

사용자 발화 한 줄 + 고정 화제 목록을 받아 **로컬 provider로만** 분류한다.
계측 전용 부수 호출이라 실패는 전부 raw=None으로 흡수한다 — 원장은 분류가
안 된 교환을 그냥 버리고, 대화 경로는 이 엔드포인트를 기다리지 않는다.

원문은 프롬프트로만 흘러가고 저장하지 않는다(원장에도 topic_id만 남는다).
로컬 모델 중복 로드를 피하려고 routers.chat의 ClaudeService 싱글톤을 share.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from schemas import ClassifyRequest, ClassifyResponse
from routers.chat import claude  # 공유 ClaudeService 인스턴스(중복 init 방지)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    if not req.text.strip() or not req.topics:
        return ClassifyResponse(raw=None, reason="empty request")
    try:
        raw = await claude.classify_topic(req.text, req.topics)
        return ClassifyResponse(raw=raw)
    except Exception as error:  # noqa: BLE001
        logger.debug("[classify] failed: %r", error)
        return ClassifyResponse(raw=None, reason=str(error)[:120])
