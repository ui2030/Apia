"""
routers/training.py — 야간 학습기(A-3)의 백엔드 표면 두 개.

  POST /training/correct  on-policy 교정. 학습 프로세스가 배치로 부른다.
  POST /training/shadow   로컬 학생(베이스+채택 델타) 생성 1회.

/training/shadow는 두 호출자를 갖는다. 그림자(A-3)는 교환이 **끝난 뒤** 비동기로
부르고(지연 0), 승격 서빙(A-4)은 교환 **앞에서** 짧은 타임아웃으로 부른다 —
하는 일이 글자 그대로 같아서("모델을 올리지 말고, 떠 있으면 델타를 붙여 한 번
생성") 표면을 나누지 않았다. 어느 쪽이든 모델을 올리지 않는다는 계약은 같고,
승격 서빙은 dormant를 받으면 사용자 모르게 API로 넘어간다.

둘 다 **대화 경로를 건드리지 않는다**. 교정은 교사 키와 예산 장부를 백엔드가
단독 관할하기 때문에 여기 있고(학습 프로세스가 DeepSeek을 직접 치면 일일 상한이
두 장부로 갈라져 무력해진다), 그림자는 로컬 모델 싱글톤이 여기 있기 때문에 여기
있다(중복 로드 방지 — classify와 같은 이유로 routers.chat의 인스턴스를 공유).

**인증**: 이 라우터만 토큰을 요구한다. 다른 엔드포인트와 달리 여기는 부르는
것만으로 돈(교사 예산)과 GPU가 나가므로, localhost에 붙을 수 있는 아무 프로세스나
호출하게 두면 안 된다. 토큰은 Electron이 실행할 때마다 새로 만들어 백엔드와
학습 프로세스에 **env로만** 건네고(명령줄은 프로세스 목록에 노출된다), 어디에도
기록하지 않는다. 토큰이 설정돼 있지 않으면 전부 403 — 외부에서 따로 띄운
백엔드에서는 학습·그림자가 조용히 비활성된다(fail-closed).

그림자의 불변식 둘:
  * 로컬 모델을 **올리지 않는다** — 이미 떠 있을 때만 답한다.
  * 응답 원문은 돌려만 주고 저장하지 않는다. 점수로 바꾸는 것도 보관하는 것도
    Electron 몫이다(교재 파일과 같은 소유 규약).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException

from routers.chat import claude  # 공유 ClaudeService 인스턴스(중복 init 방지)
from schemas import (
    ShadowRequest,
    ShadowResponse,
    TrainingCorrectRequest,
    TrainingCorrectResponse,
)
from services import teacher_service

logger = logging.getLogger(__name__)

TOKEN_ENV = "APIA_TRAINING_TOKEN"
TOKEN_HEADER = "X-Apia-Training-Token"


def require_token(x_apia_training_token: str = Header(default="")) -> None:
    """토큰 불일치 = 403. 사유는 한 가지 문구로만 돌려준다 — "토큰이 설정되지
    않았다"와 "틀렸다"를 구분해 주면 그 자체가 정보가 된다."""
    expected = os.environ.get(TOKEN_ENV, "")
    given = x_apia_training_token or ""
    if not expected or not hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=403, detail="training token mismatch")


# 라우터 단위로 건다 — 나중에 엔드포인트가 하나 더 늘어도 인증이 빠질 자리가 없다.
router = APIRouter(dependencies=[Depends(require_token)])

# 고정 시스템 프롬프트 — 글자 하나 바꾸면 DeepSeek prefix 캐시가 깨져 단가가 오른다.
CORRECT_SYSTEM = (
    "너는 개인 비서 모델의 답을 교정하는 교사다. 각 항목에 질문 q, 정답 참조 ref, "
    "학생 답 a 가 주어진다.\n"
    "규칙: ref 의 사실 값을 글자 그대로 담고, 비서다운 말투로 학생 답을 고쳐라. "
    "학생 답이 이미 맞으면 표현만 다듬는다. 각 답은 3문장 이내로 쓴다. "
    "지어내지 않는다 — ref 에 없는 사실은 넣지 않는다.\n"
    '출력은 JSON 하나: {"answers":["...", ...]} — 입력 항목 순서와 개수를 그대로 지킨다.'
)

MAX_ITEMS = 20  # 한 배치 상한. 더 주면 교사가 항목 개수를 흘린다(실험에서 확인).


@router.post("/correct", response_model=TrainingCorrectResponse)
async def correct(req: TrainingCorrectRequest) -> TrainingCorrectResponse:
    snapshot = teacher_service.on_policy_snapshot()
    items = req.items[:MAX_ITEMS]
    if not items:
        return TrainingCorrectResponse(status="ok", answers=[], **snapshot)

    payload = json.dumps(
        [{"q": i.q, "ref": i.ref, "a": i.a[:400]} for i in items], ensure_ascii=False
    )
    try:
        parsed, _ = await asyncio.to_thread(
            teacher_service.ask_json,
            CORRECT_SYSTEM,
            payload,
            max_tokens=2500,
            temperature=0.3,
            bucket=teacher_service.ON_POLICY_BUCKET,
            bucket_weekly_cap=teacher_service.ON_POLICY_WEEKLY_USD,
        )
    except teacher_service.TeacherUnavailable as error:
        return TrainingCorrectResponse(status="deferred", reason=str(error),
                                       **teacher_service.on_policy_snapshot())
    except teacher_service.TeacherFailed as error:
        return TrainingCorrectResponse(status="failed", reason=str(error),
                                       **teacher_service.on_policy_snapshot())
    except Exception as error:  # noqa: BLE001
        logger.debug("[training] correct failed: %r", error)
        return TrainingCorrectResponse(status="failed", reason=type(error).__name__,
                                       **teacher_service.on_policy_snapshot())

    raw = parsed.get("answers")
    snapshot = teacher_service.on_policy_snapshot()
    if not isinstance(raw, list) or len(raw) != len(items):
        # 개수가 어긋난 교정은 카드와 답이 밀려 붙는다 — 통째로 버리는 게 맞다.
        return TrainingCorrectResponse(
            status="failed", reason="answer count mismatch", **snapshot
        )
    answers = [str(x).strip() for x in raw]
    if any(not a for a in answers):
        return TrainingCorrectResponse(status="failed", reason="empty answer", **snapshot)
    return TrainingCorrectResponse(status="ok", answers=answers, **snapshot)


@router.post("/shadow", response_model=ShadowResponse)
async def shadow(req: ShadowRequest) -> ShadowResponse:
    if not req.message.strip():
        return ShadowResponse(status="dormant", reason="empty message")
    if not req.delta_dir:
        return ShadowResponse(status="dormant", reason="no adopted delta")
    # 모델을 올리지 않는다. 떠 있지 않으면 그냥 쉰다.
    if not claude.local_loaded():
        return ShadowResponse(status="dormant", reason="local model not resident")
    try:
        reply = await claude.shadow_reply(req.message, req.delta_dir)
    except RuntimeError as error:
        # 모델 미상주·델타 없음·경로 혼잡 — 전부 '오늘은 안 한다'지 실패가 아니다.
        return ShadowResponse(status="dormant", reason=str(error)[:160])
    except Exception as error:  # noqa: BLE001
        logger.debug("[training] shadow failed: %r", error)
        return ShadowResponse(status="failed", reason=f"{type(error).__name__}: {error}"[:160])
    return ShadowResponse(status="ok", reply=reply)
