"""
routers/chat.py
대화 엔드포인트 + 장기 기억(2단계) + 파일 검색(3단계) + 웹 검색·citations(4단계).

기본 흐름:
  1. memory.retrieve + files.retrieve [+ web.search use_web=True] 병렬.
  2. 세 결과를 context_blocks dict로 합치고(점수 기반 cap) claude.chat 호출.
  3. 응답 받으면 [N] 마커 파싱 → assistant turn을 동기 저장 → citations 행 작성.
     (citations FK가 chat_turns.id를 가리키므로 background 저장으로는 race가 생긴다.
      웹 결과/마커가 있을 때만 동기 경로를 탄다.)
  4. 그 외엔 기존 background record_chat_exchange 경로.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import List, Optional, Set, Tuple

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ai_config import CONTEXT_MAX_CHARS
from schemas import ChatCitation, ChatRequest, ChatResponse
from services.claude_service import ClaudeService
from services.context_assembler import (
    SECTION_CARE,
    SECTION_COURSEWARE,
    SECTION_FILES,
    SECTION_SPECTATE,
    assemble_context_blocks,
    file_recalls_to_items,
    memory_recalls_to_items,
)
from services.context_assembler import ContextItem
from services.web_search_service import WebResult, WebSearchService

logger = logging.getLogger(__name__)

router = APIRouter()
claude = ClaudeService()

_BACKGROUND_TASKS: Set["asyncio.Task[None]"] = set()


# A-2 참조 카드 상한. electron이 이미 3장으로 잘라 보내지만 프롬프트에 그대로
# 들어가는 값이라 라우터에서도 자른다(신뢰 경계).
_REFERENCE_MAX_CARDS = 3
_REFERENCE_MAX_CHARS = 400  # 정규화·직렬화가 끝난 **카드 한 줄 전체** 기준

# 카드 본문은 교사 모델이 쓴 텍스트다 = 신뢰 경계 바깥. 개행이나 `##`가 그대로
# 들어가면 카드가 "교재" 섹션을 빠져나가 상위 지시문 행세를 할 수 있다.
# 제어문자(개행·탭·NUL 포함)를 전부 공백으로 접어 카드 한 장을 한 줄에 가둔다.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")


def _flatten_field(text: str) -> str:
    """카드 필드 → 항상 한 줄. 제어문자는 공백으로, 연속 공백은 하나로."""
    # 따옴표는 홑따옴표로 바꾼다 — 인용으로 감싼 카드를 안에서 닫지 못하게.
    return " ".join(_CONTROL_RE.sub(" ", text or "").replace('"', "'").split())


def _cap_quoted(line: str, limit: int) -> str:
    """인용으로 끝나는 한 줄을 상한에 맞춘다 — 잘려도 인용은 닫는다."""
    return line if len(line) <= limit else line[:limit - 1] + '"'


def _reference_block(cards) -> Optional[str]:
    """참조 카드 → 시스템 프롬프트 섹션 본문. 쓸 게 없으면 None.

    카드는 **데이터**다. 한 장이 정확히 한 줄이고 각 필드는 따옴표로 감싸
    어디까지가 카드인지 구조로 드러낸다. 길이는 정규화가 끝난 줄 전체를
    기준으로 자른다 — 필드마다 따로 자르면 카드 하나가 상한의 두 배가 된다.
    """
    lines = []
    for card in (cards or [])[:_REFERENCE_MAX_CARDS]:
        u, a = _flatten_field(card.u), _flatten_field(card.a)
        if not u and not a:
            continue
        lines.append(_cap_quoted(f'- "{u}" → "{a}"', _REFERENCE_MAX_CHARS))
    return "\n".join(lines) or None


# 관전 문맥 상한. electron이 이미 3건으로 잘라 보내지만 프롬프트에 그대로 들어가는
# 값이라 라우터에서도 자른다(참조 카드와 같은 신뢰 경계 규약).
_SPECTATE_MAX_OBSERVATIONS = 3
_SPECTATE_MAX_CHARS = 240  # 정규화·직렬화가 끝난 **관찰 한 줄 전체** 기준
_SPECTATE_WINDOW_MAX_CHARS = 140


def _spectate_age(value) -> int:
    """경과초 → 0 이상의 정수. 알아볼 수 없으면 0 — 시각을 지어내는 것보다 '방금'이 낫다."""
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _spectate_block(spectate) -> Optional[str]:
    """관전 문맥 → 시스템 프롬프트 섹션 본문. 쓸 게 없으면 None.

    스키마가 아니라 **여기서** 검증한다(ChatRequest.spectate는 Any). 관전 문맥은
    대화의 부속물이라, 모양이 깨진 값 하나로 422를 내서 대화 자체를 못 하게 만드는
    것이 가장 나쁜 결과다 — 알아볼 수 없는 값은 조용히 버리고 대화는 계속한다.

    창 제목도 관찰 문장도 **사용자 화면에서 읽어온 글자**다 = 신뢰 경계 바깥.
    웹페이지 제목 하나로 "이전 지시를 무시하라"를 심을 수 있으므로 참조 카드와
    똑같이 한 줄씩 인용에 가둔다(평탄화 + 줄 전체 기준 절단).
    """
    if not isinstance(spectate, dict):
        return None
    lines = []
    # 문자열이 아닌 값은 통째로 버린다 — dict를 str()로 눌러 담으면 프롬프트에
    # 쓰레기가 남을 뿐 정보가 되지 않는다.
    window_raw = spectate.get("window")
    window = _flatten_field(window_raw) if isinstance(window_raw, str) else ""
    if window:
        lines.append(_cap_quoted(f'- 보고 있는 창: "{window}"', _SPECTATE_WINDOW_MAX_CHARS))
    observations = spectate.get("observations")
    if not isinstance(observations, list):
        observations = []
    # 상한은 **유효 관찰** 기준이다. 먼저 자르고 나서 버리면 불량 항목 하나가
    # 슬롯을 먹어 멀쩡한 관찰이 프롬프트에 못 들어간다(창 제목은 별도 줄이라 무관).
    # 훑는 범위 자체는 여전히 유한하다 — 신뢰 경계 바깥 입력이라 무한 스캔은 안 준다.
    kept = 0
    for obs in observations[: _SPECTATE_MAX_OBSERVATIONS * 4]:
        if kept >= _SPECTATE_MAX_OBSERVATIONS:
            break
        if not isinstance(obs, dict):
            continue
        text_raw = obs.get("text")
        text = _flatten_field(text_raw) if isinstance(text_raw, str) else ""
        if not text:
            continue
        age = _spectate_age(obs.get("age_sec"))
        lines.append(_cap_quoted(f'- {age}초 전 관찰: "{text}"', _SPECTATE_MAX_CHARS))
        kept += 1
    return "\n".join(lines) or None


# 배려 화제 화이트리스트 = electron/services/topicLedger.js TOPICS의 라벨(단일 출처는
# 저쪽, 동기화는 tests/test_care_topics.py가 지킨다). 목록 밖 문자열은 버린다 —
# 요청 body의 자유 문자열이 시스템 프롬프트에 들어가는 인젝션 통로를 막는다.
_CARE_TOPIC_LABELS = frozenset((
    "일상", "가벼운 잡담", "농담·장난", "업무·일", "공부·학습", "진로·이직",
    "돈·재정", "게임", "취미", "음악", "영화·드라마", "책", "기술·컴퓨터",
    "뉴스·사회", "여행", "음식", "건강", "마음·스트레스", "수면", "운동", "외모",
    "가족", "연애", "친구·인간관계", "반려동물", "계획·미래",
))
_CARE_MAX_TOPICS = 8


def _care_block(care_topics) -> Optional[str]:
    """배려 화제 라벨 → 섹션 본문. 쓸 게 없으면 None(= 프롬프트 바이트 동일)."""
    if not isinstance(care_topics, list):
        return None
    kept: List[str] = []
    for label in care_topics:
        if isinstance(label, str) and label in _CARE_TOPIC_LABELS and label not in kept:
            kept.append(label)
            if len(kept) >= _CARE_MAX_TOPICS:
                break
    return "\n".join(f"- {label}" for label in kept) or None


def _web_results_to_items(results: List[WebResult]) -> List[ContextItem]:
    items: List[ContextItem] = []
    for i, r in enumerate(results, start=1):
        # [N] 형식의 마커가 본문에 노출되도록 컨텍스트 섹션 안에 인덱스를 그대로 포함.
        body = f"- [{i}] {r.title or r.url}\n  {r.snippet}\n  ({r.url})"
        items.append(ContextItem(section="웹", body=body, score=r.score))
    return items


async def _gather_context(req: ChatRequest, request: Request) -> Tuple[Any, Any, Optional[dict], list]:
    """retrieve memory/files/web in parallel and assemble context_blocks.

    Returns (memory_service, web_service, context_blocks, web_results). Shared
    by the non-streaming and streaming endpoints so retrieval logic lives once.
    """
    memory = getattr(request.app.state, "memory", None)
    files = getattr(request.app.state, "files", None)
    web = getattr(request.app.state, "web", None)

    coros = []
    sources = []
    if memory is not None and memory.enabled:
        coros.append(memory.retrieve_relevant(req.message))
        sources.append("memory")
    if files is not None and files.enabled:
        coros.append(files.retrieve_relevant(req.message))
        sources.append("files")
    if req.use_web and web is not None and web.enabled:
        coros.append(web.search(req.message))
        sources.append("web")

    memory_recalls: list = []
    file_recalls: list = []
    web_results: list = []
    if coros:
        results = await asyncio.gather(*coros, return_exceptions=True)
        for source, result in zip(sources, results):
            if isinstance(result, Exception):
                logger.warning("[chat] %s retrieve failed: %r", source, result)
                continue
            if source == "memory":
                memory_recalls = result
            elif source == "files":
                file_recalls = result
            else:
                web_results = result

    items = []
    items.extend(memory_recalls_to_items(memory_recalls))
    items.extend(file_recalls_to_items(file_recalls))
    items.extend(_web_results_to_items(web_results))
    context_blocks = assemble_context_blocks(items, max_total_chars=CONTEXT_MAX_CHARS)

    # If web context was prepared, nudge the assistant to actually cite with [N].
    if web_results and "웹" in context_blocks:
        context_blocks["웹"] = (
            "출처를 인용할 때는 `[1]`, `[2]` 같은 마커를 답변 본문에 그대로 써 주세요.\n"
            + context_blocks["웹"]
        )

    # A-2 교재 참조는 점수 cap 바깥이다 — 이미 상위 3장이고, 낮은 점수부터
    # 떨구는 assemble에 섞으면 웹 결과가 많은 턴에 조용히 사라진다.
    reference = _reference_block(req.reference_cards)
    if reference:
        context_blocks[SECTION_COURSEWARE] = reference

    # 관전도 점수 cap 바깥 + 맨 뒤(교재 뒤). 미관전이면 키 자체가 안 생긴다.
    spectate = _spectate_block(req.spectate)
    if spectate:
        context_blocks[SECTION_SPECTATE] = spectate

    # 배려는 관전보다도 뒤(서빙 전용 — 그림자·교재·교사 경로엔 이 body가 안 간다).
    care = _care_block(req.care_topics)
    if care:
        context_blocks[SECTION_CARE] = care

    return memory, web, (context_blocks or None), web_results


async def _finalize_reply(
    req: ChatRequest, reply: str, web_results: list, memory: Any, web: Any
) -> List[ChatCitation]:
    """Resolve citations + persist the exchange. Shared by both endpoints — the
    only difference upstream is how `reply` was produced (blocking vs. stream)."""
    citations_out: List[ChatCitation] = []
    markers = WebSearchService.parse_markers(reply) if web_results else []

    if web_results and markers and memory is not None and memory.enabled:
        # Persisted path: write user+assistant turn so citations FK has a target,
        # then write citation rows, then background-summarize only.
        try:
            await memory.record_turn("user", req.message)
            assistant_turn_id = await memory.record_turn("assistant", reply)
        except Exception:  # noqa: BLE001
            logger.exception("[chat] sync record_turn failed")
            assistant_turn_id = None

        if assistant_turn_id is not None:
            try:
                await web.record_citations(assistant_turn_id, markers, web_results)
            except Exception:  # noqa: BLE001
                logger.exception("[chat] record_citations failed")
            else:
                rows = await web.list_citations_for_turn(assistant_turn_id)
                citations_out = [
                    ChatCitation(
                        marker_number=r["marker_number"],
                        source_kind=r["source_kind"],
                        source_path=r["source_path"],
                        title=r["title"],
                        snippet=r["snippet"],
                        page=r["page"],
                    )
                    for r in rows
                ]

        task = asyncio.create_task(_summarize_only(memory))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_release_and_log)
    elif web_results and markers:
        # Codex MUST-FIX (4단계 verification): memory가 꺼져 있어도 사용자는
        # 인용 출처를 봐야 한다. citations 테이블엔 영구화하지 않고 응답에만
        # in-memory 객체로 채운다. 영구 보관은 memory 활성화 시에만.
        citations_out = [
            ChatCitation(
                marker_number=marker,
                source_kind="web",
                source_path=web_results[marker - 1].url,
                title=web_results[marker - 1].title,
                snippet=web_results[marker - 1].snippet,
                page=None,
            )
            for marker in markers
            if 1 <= marker <= len(web_results)
        ]
        if memory is not None and memory.enabled:
            task = asyncio.create_task(
                memory.record_chat_exchange(req.message, reply)
            )
            _BACKGROUND_TASKS.add(task)
            task.add_done_callback(_release_and_log)
    elif memory is not None and memory.enabled:
        # 일반 경로(웹 결과/마커 없음): user→assistant→summarize를 background.
        task = asyncio.create_task(memory.record_chat_exchange(req.message, reply))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_release_and_log)

    return citations_out


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    memory, web, context_blocks, web_results = await _gather_context(req, request)

    reply, emotion = await claude.chat(
        req.message,
        req.history,
        ai_mode=req.ai_mode,
        memory_turns=req.memory_turns,
        context_blocks=context_blocks,
    )

    citations_out = await _finalize_reply(req, reply, web_results, memory, web)
    return ChatResponse(reply=reply, emotion=emotion, citations=citations_out)


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


# Streaming variant. SSE frames (one JSON object per `data:` line):
#   {"type":"delta","text":"..."}                     — 0..N token deltas
#   {"type":"final","reply":str,"emotion":str,        — exactly 1, terminal
#                   "citations":[ChatCitation,...],
#                   "fallback"?:"local", "fallback_reason"?:"budget"|"error"}
#   {"type":"error","message":str}                    — on unexpected failure
# The final frame carries the authoritative reply (emotion marker stripped) +
# all ChatResponse metadata; the client replaces the live bubble with it.
_EMOTION_HOLDBACK = 24  # ponytail: assumes [EMOTION:...] is trailing — hold back
                        # enough tail chars to never stream a partial/whole marker.


@router.post("/stream")
async def chat_stream(req: ChatRequest, request: Request):
    memory, web, context_blocks, web_results = await _gather_context(req, request)

    async def event_gen():
        buf = ""
        emitted = 0
        meta: dict = {}  # deepseek→로컬 폴백이면 fallback/fallback_reason이 채워진다
        try:
            async for delta in claude.chat_stream(
                req.message,
                req.history,
                ai_mode=req.ai_mode,
                memory_turns=req.memory_turns,
                context_blocks=context_blocks,
                meta=meta,
            ):
                if not delta:
                    continue
                buf += delta
                safe = len(buf) - _EMOTION_HOLDBACK
                if safe > emitted:
                    yield _sse({"type": "delta", "text": buf[emitted:safe]})
                    emitted = safe

            reply, emotion = claude.parse_emotion(buf)
            # Flush any cleaned tail we held back so the live bubble is complete
            # even before the final swap.
            if len(reply) > emitted:
                yield _sse({"type": "delta", "text": reply[emitted:]})

            citations = await _finalize_reply(req, reply, web_results, memory, web)
            yield _sse({
                "type": "final",
                "reply": reply,
                "emotion": emotion,
                "citations": [c.model_dump() for c in citations],
                **meta,
            })
        except Exception as error:  # noqa: BLE001
            logger.exception("[chat/stream] failed")
            yield _sse({"type": "error", "message": str(error)})

    return StreamingResponse(event_gen(), media_type="text/event-stream")


async def _summarize_only(memory) -> None:
    try:
        await memory.summarize_if_needed()
    except Exception:  # noqa: BLE001
        logger.exception("[chat] background summarize failed")


def _release_and_log(task: "asyncio.Task[None]") -> None:
    _BACKGROUND_TASKS.discard(task)
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.warning("[chat] background memory write task failed: %r", exc)
