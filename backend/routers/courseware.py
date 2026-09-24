"""
routers/courseware.py — 하루치 대화 로그를 익명 교재 카드로 바꾼다.

교재 파이프라인(A-1)의 유일한 백엔드 표면이다. 학습도, 검색 참조도, 대화 개입도
하지 않는다 — 들어온 로그를 교사에게 한 번 넘기고 Q/A 카드를 돌려줄 뿐이다.
로그 원문은 프롬프트로만 흘러가고 백엔드에 저장하지 않는다(원본 보관과 폐기는
Electron 쪽 courseware.js가 단독 관할).

응답의 `status`가 계약의 핵심이다:
  ok       — 카드가 나왔다. 클라이언트가 교재를 확정한 뒤 원본을 지워도 된다.
  deferred — 키 없음 / 예산 소진. 실패가 아니라 연기. 원본 보존, 재시도 카운트 없음.
  failed   — 호출은 했는데 쓸 결과가 없다. 원본 보존 + 연속 실패 카운트.
`ok`가 아닌 어떤 경로도 카드를 채워 보내지 않는다.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter

from schemas import CoursewareCard, CoursewareConvertRequest, CoursewareConvertResponse
from services import teacher_service

logger = logging.getLogger(__name__)

router = APIRouter()

# 고정 시스템 프롬프트 — 글자 하나 바꾸면 DeepSeek prefix 캐시가 깨져 단가가 오른다.
BOOK_SYSTEM = (
    "너는 개인 비서와 사용자의 하루치 대화 로그를 복습 교재로 바꾸는 변환기다.\n"
    "규칙:\n"
    "1. 익명화: 실명·계정명·아이디·전화번호·주소·회사명·구체적인 장소 이름은 일반 표현으로 바꾼다"
    "(예: 사람 이름 → '친구'/'동료', 'OO역 OO카페' → '자주 가는 카페').\n"
    "2. 보존: 사용자의 사실·취향·습관·관심사와 비서의 말투는 그대로 남긴다. 지어내지 않는다.\n"
    "3. 시점 표현(오늘·아까·어제·이번 주)을 지우고 언제 읽어도 참인 문장으로 쓴다.\n"
    "4. 남길 것이 없는 잡담 교환은 버린다. 전부 잡담이면 빈 배열을 낸다.\n"
    "5. 카드 하나는 질문(u)과 답(a) 한 쌍이다. 답은 비서가 말하듯 쓴다.\n"
    "6. 카드 수는 교환 수를 넘지 않는다.\n"
    '출력은 JSON 하나: {"cards":[{"u":"...","a":"..."}, ...]}'
)

MAX_CARDS = 200


def _render_log(exchanges) -> str:
    return "\n".join(f"U: {e.u}\nA: {e.a}" for e in exchanges if (e.u or e.a))


def _cards_from(parsed) -> list[CoursewareCard]:
    raw = parsed.get("cards")
    if not isinstance(raw, list):
        raise teacher_service.TeacherFailed("no cards array")
    cards = []
    for item in raw[:MAX_CARDS]:
        if not isinstance(item, dict):
            continue
        u = str(item.get("u") or "").strip()
        a = str(item.get("a") or "").strip()
        if u and a:
            cards.append(CoursewareCard(u=u, a=a))
    return cards


@router.post("/convert", response_model=CoursewareConvertResponse)
async def convert(req: CoursewareConvertRequest) -> CoursewareConvertResponse:
    snapshot = teacher_service.budget_snapshot()
    if not req.exchanges:
        return CoursewareConvertResponse(status="ok", cards=[], **snapshot)

    user_prompt = f"[{req.day} 대화 로그]\n{_render_log(req.exchanges)}"
    try:
        # urllib은 블로킹이라 이벤트 루프 밖으로 뺀다 — 변환이 도는 동안에도
        # /chat 같은 대화 경로가 그대로 응답해야 한다.
        parsed, spent = await asyncio.to_thread(
            teacher_service.ask_json, BOOK_SYSTEM, user_prompt
        )
        cards = _cards_from(parsed)
    except teacher_service.TeacherUnavailable as error:
        return CoursewareConvertResponse(status="deferred", reason=str(error), **snapshot)
    except teacher_service.TeacherFailed as error:
        return CoursewareConvertResponse(status="failed", reason=str(error), **teacher_service.budget_snapshot())
    except Exception as error:  # noqa: BLE001
        logger.debug("[courseware] convert failed: %r", error)
        return CoursewareConvertResponse(
            status="failed", reason=type(error).__name__, **teacher_service.budget_snapshot()
        )

    snapshot = teacher_service.budget_snapshot()
    snapshot["spent_today"] = spent
    return CoursewareConvertResponse(status="ok", cards=cards, **snapshot)
