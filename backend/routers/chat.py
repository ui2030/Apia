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
import logging
from typing import List, Set

from fastapi import APIRouter, Request

from ai_config import CONTEXT_MAX_CHARS
from schemas import ChatCitation, ChatRequest, ChatResponse
from services.claude_service import ClaudeService
from services.context_assembler import (
    SECTION_FILES,
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


def _web_results_to_items(results: List[WebResult]) -> List[ContextItem]:
    items: List[ContextItem] = []
    for i, r in enumerate(results, start=1):
        # [N] 형식의 마커가 본문에 노출되도록 컨텍스트 섹션 안에 인덱스를 그대로 포함.
        body = f"- [{i}] {r.title or r.url}\n  {r.snippet}\n  ({r.url})"
        items.append(ContextItem(section="웹", body=body, score=r.score))
    return items


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
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

    reply, emotion = await claude.chat(
        req.message,
        req.history,
        ai_mode=req.ai_mode,
        memory_turns=req.memory_turns,
        context_blocks=context_blocks or None,
    )

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

    return ChatResponse(reply=reply, emotion=emotion, citations=citations_out)


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
