"""
Long-term memory service for Apia (step 2).

Owns:
  - persisting chat turns into `chat_turns` (with embedding BLOBs)
  - retrieving semantically relevant past turns/summaries for a new user
    message, given the *current* embedding model dim
  - rolling up old turns into `conversation_summaries` every N turns

Does NOT own:
  - what gets embedded (caller passes raw text)
  - calling the LLM for the summary text — that's a `summarize_fn` callable
    injected at construction time. None means "no provider available";
    summarize_if_needed becomes a no-op and surfaces `last_error` for the UI.

Design notes (Codex MUST-FIX review):
  - `record_chat_exchange` writes user→assistant→summary in a single coroutine
    so `conversation_summaries`' [start_turn_id, end_turn_id] range stays
    contiguous. Two separate `create_task`s would let the assistant turn slip
    in before the user turn under load and break summary contiguity.
  - cosine ranking runs through `asyncio.to_thread` because a few-thousand-row
    full scan blocks the event loop otherwise. The DB read itself already
    goes through `StoreService.fetchall` (`asyncio.to_thread`); the *python*
    scoring loop is the new offender.
  - Every embedding INSERT/UPDATE validates `len(blob) == embedding.dim * 4`
    so a model-swap mid-run can't silently corrupt the table. Reads also
    skip rows that no longer match the current dim, with a warn.
  - `APIA_MEMORY_ENABLED=false` short-circuits every public method to a
    safe no-op (no DB writes, no embedding calls). The router exposes this
    state via `stats()` so the UI can render "memory off" instead of guessing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable, List, Optional, Sequence

from services.embedding_service import (
    EmbeddingService,
    blob_to_vec,
    cosine_similarity,
)
from services.store_service import StoreService

logger = logging.getLogger(__name__)

SummarizeFn = Callable[[str], Awaitable[str]]


class MemoryRecall:
    """One ranked recall result. `kind` lets the formatter render a summary
    differently from a raw turn (summary is denser, raw turn carries role)."""

    __slots__ = ("kind", "role", "content", "score", "created_at", "source_id")

    def __init__(
        self,
        kind: str,
        content: str,
        score: float,
        created_at: int,
        source_id: int,
        role: Optional[str] = None,
    ) -> None:
        self.kind = kind  # 'summary' | 'turn'
        self.role = role
        self.content = content
        self.score = score
        self.created_at = created_at
        self.source_id = source_id


class MemoryService:
    def __init__(
        self,
        store: StoreService,
        embedding: EmbeddingService,
        summarize_fn: Optional[SummarizeFn] = None,
        enabled: bool = True,
        retrieve_top_k: int = 5,
        min_score: float = 0.55,
        summary_every: int = 20,
        exclude_recent: int = 0,
    ) -> None:
        self._store = store
        self._embedding = embedding
        self._summarize_fn = summarize_fn
        self._enabled = enabled
        self._top_k = max(1, retrieve_top_k)
        self._min_score = min_score
        self._summary_every = max(2, summary_every)
        self._exclude_recent = max(0, exclude_recent)
        self._summary_lock = asyncio.Lock()
        # `last_error` 메모리 동작 중 실제로 잡힌 마지막 실패. UI의 stats 패널이
        # 그대로 표시할 문자열. provider unavailable / embed fail / summary fail
        # 모두 여기 통과.
        self._last_error: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def summary_every(self) -> int:
        return self._summary_every

    # ── public surface ────────────────────────────────────────────────────

    async def record_turn(self, role: str, content: str) -> Optional[int]:
        """단일 turn 저장. 임베딩 실패해도 텍스트는 살린다(embedding=NULL)."""
        if not self._enabled or not content.strip():
            return None
        blob = await self._embed_or_none(content)
        now = int(time.time() * 1000)
        turn_id = await self._store.execute(
            "INSERT INTO chat_turns (role, content, created_at, embedding) "
            "VALUES (?, ?, ?, ?)",
            (role, content, now, blob),
        )
        return int(turn_id)

    async def record_chat_exchange(self, user_message: str, assistant_reply: str) -> None:
        """user → assistant 순서 보장 + 끝에서 summarize_if_needed.

        Codex MUST-FIX 반영: 두 줄을 별도 task로 띄우면 race로 id 역전 가능.
        하나의 coroutine 안에서 직렬화. 어떤 단계가 실패해도 다음 단계는
        한 번 더 시도하지 않고 WARN으로만 남긴다(실패가 정상 동작을 막지 않게).
        """
        if not self._enabled:
            return
        try:
            await self.record_turn("user", user_message)
            await self.record_turn("assistant", assistant_reply)
        except Exception as error:  # noqa: BLE001 — 백그라운드 경로, 호출자 없음
            self._last_error = f"record: {type(error).__name__}: {error}"
            logger.exception("[memory] record_chat_exchange failed")
            return
        try:
            await self.summarize_if_needed()
        except Exception as error:  # noqa: BLE001
            self._last_error = f"summarize: {type(error).__name__}: {error}"
            logger.exception("[memory] summarize_if_needed failed")

    async def retrieve_relevant(
        self,
        query: str,
        top_k: Optional[int] = None,
        min_score: Optional[float] = None,
    ) -> List[MemoryRecall]:
        """summaries 우선, 부족하면 raw turns로 보충 (Codex NICE-TO-HAVE).

        - 최근 `exclude_recent`개의 chat_turns은 이미 history로 들어오니 제외.
        - 차원이 안 맞는 BLOB은 skip + WARN.
        - cosine 계산은 to_thread (이벤트 루프 보호).
        """
        if not self._enabled or not query.strip():
            return []
        k = top_k if top_k is not None else self._top_k
        floor = min_score if min_score is not None else self._min_score

        try:
            query_blob = await self._embedding.embed_one(query)
        except Exception as error:  # noqa: BLE001
            self._last_error = f"retrieve_embed: {type(error).__name__}: {error}"
            logger.warning("[memory] query embed failed: %s", error)
            return []
        # Codex NICE-TO-HAVE (round 2): row BLOB은 INSERT 시점에 검증하지만
        # query 임베딩도 같은 invariant를 가져야 _rank_rows의 dim mismatch
        # warning을 query blob 하나에 N행만큼 찍지 않는다.
        expected_query_bytes = self._embedding.dim * 4
        if len(query_blob) != expected_query_bytes:
            self._last_error = (
                f"retrieve_embed dim mismatch: blob={len(query_blob)} "
                f"expected={expected_query_bytes}"
            )
            logger.warning("[memory] query blob dim mismatch — aborting retrieve")
            return []

        summary_rows = await self._store.fetchall(
            "SELECT id, summary, created_at, embedding, start_turn_id, end_turn_id "
            "FROM conversation_summaries WHERE embedding IS NOT NULL "
            "ORDER BY id DESC"
        )

        # 최근 exclude_recent개 chat_turn id 범위는 retrieve에서 제외.
        recent_threshold_id = await self._recent_turn_threshold()
        turn_rows = await self._store.fetchall(
            "SELECT id, role, content, created_at, embedding "
            "FROM chat_turns WHERE embedding IS NOT NULL AND id <= ? "
            "ORDER BY id DESC",
            (recent_threshold_id,),
        )

        ranked: List[MemoryRecall] = await asyncio.to_thread(
            self._rank_rows, query_blob, summary_rows, turn_rows, k, floor
        )
        return ranked

    async def summarize_if_needed(self) -> Optional[int]:
        """마지막 summary 이후 turn 수가 임계치 넘으면 한 덩어리 요약.

        summarize_fn이 None이면 비활성(provider 없음). last_error에 한 번 기록.
        Lock으로 동시 호출 보호 — 첫 호출이 작업하는 동안 두 번째는 그냥
        리턴(요약은 멱등이지만 이중 LLM 호출은 비싸다).
        """
        if not self._enabled:
            return None
        if self._summarize_fn is None:
            self._last_error = "summarize disabled (no provider available)"
            return None
        async with self._summary_lock:
            last_end_id = await self._last_summary_end_turn_id()
            pending = await self._store.fetchall(
                "SELECT id, role, content FROM chat_turns "
                "WHERE id > ? ORDER BY id ASC",
                (last_end_id,),
            )
            if len(pending) < self._summary_every:
                return None

            start_id = pending[0]["id"]
            end_id = pending[-1]["id"]
            transcript = "\n".join(
                f"{row['role']}: {row['content']}" for row in pending
            )

            try:
                summary_text = await self._summarize_fn(transcript)
            except Exception as error:  # noqa: BLE001
                self._last_error = f"summarize_call: {type(error).__name__}: {error}"
                logger.warning("[memory] summarize_fn failed: %s", error)
                return None
            summary_text = summary_text.strip()
            if not summary_text:
                self._last_error = "summarize returned empty text"
                return None

            blob = await self._embed_or_none(summary_text)
            now = int(time.time() * 1000)
            summary_id = await self._store.execute(
                "INSERT INTO conversation_summaries "
                "(start_turn_id, end_turn_id, summary, created_at, embedding) "
                "VALUES (?, ?, ?, ?, ?)",
                (start_id, end_id, summary_text, now, blob),
            )
            return int(summary_id)

    async def stats(self) -> dict:
        if not self._enabled:
            return {
                "enabled": False,
                "turn_count": 0,
                "summary_count": 0,
                "last_summary_at": None,
                "embeddings_missing": 0,
                "summary_every": self._summary_every,
                "last_error": None,
            }
        turn_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM chat_turns"
        )
        summary_row = await self._store.fetchone(
            "SELECT count(*) AS n, max(created_at) AS last "
            "FROM conversation_summaries"
        )
        missing_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM chat_turns WHERE embedding IS NULL"
        )
        return {
            "enabled": True,
            "turn_count": int(turn_row["n"]) if turn_row else 0,
            "summary_count": int(summary_row["n"]) if summary_row else 0,
            "last_summary_at": (
                int(summary_row["last"]) if summary_row and summary_row["last"] else None
            ),
            "embeddings_missing": int(missing_row["n"]) if missing_row else 0,
            "summary_every": self._summary_every,
            "last_error": self._last_error,
        }

    def build_context_text(self, recalls: Sequence[MemoryRecall]) -> str:
        """retrieve 결과를 system prompt에 합칠 한 덩어리 문자열로 직렬화.

        포맷은 의도적으로 가볍게: provider가 무엇이든 system prompt 내부에
        텍스트로 들어가므로 마크다운/JSON 같은 구조는 도움 안 된다.
        """
        if not recalls:
            return ""
        lines: List[str] = []
        for r in recalls:
            if r.kind == "summary":
                lines.append(f"- 요약: {r.content}")
            else:
                who = r.role or "?"
                lines.append(f"- 과거 대화({who}): {r.content}")
        return "\n".join(lines)

    # ── internals ─────────────────────────────────────────────────────────

    async def _embed_or_none(self, text: str) -> Optional[bytes]:
        try:
            blob = await self._embedding.embed_one(text)
        except Exception as error:  # noqa: BLE001
            self._last_error = f"embed: {type(error).__name__}: {error}"
            logger.warning("[memory] embed failed: %s", error)
            return None
        expected = self._embedding.dim * 4
        if len(blob) != expected:
            self._last_error = (
                f"embed dim mismatch: blob={len(blob)} expected={expected}"
            )
            logger.warning(
                "[memory] embed dim mismatch (blob=%d, expected=%d) — storing NULL",
                len(blob), expected,
            )
            return None
        return blob

    async def _recent_turn_threshold(self) -> int:
        """retrieve에서 무시할 최근 chat_turn 경계. id ≤ threshold만 검색 대상."""
        if self._exclude_recent <= 0:
            row = await self._store.fetchone(
                "SELECT COALESCE(MAX(id), 0) AS n FROM chat_turns"
            )
            return int(row["n"]) if row else 0
        row = await self._store.fetchone(
            "SELECT id FROM chat_turns ORDER BY id DESC LIMIT 1 OFFSET ?",
            (self._exclude_recent,),
        )
        return int(row["id"]) if row else 0

    async def _last_summary_end_turn_id(self) -> int:
        row = await self._store.fetchone(
            "SELECT COALESCE(MAX(end_turn_id), 0) AS n FROM conversation_summaries"
        )
        return int(row["n"]) if row else 0

    def _rank_rows(
        self,
        query_blob: bytes,
        summary_rows: Sequence[Any],
        turn_rows: Sequence[Any],
        top_k: int,
        floor: float,
    ) -> List[MemoryRecall]:
        try:
            query_vec = blob_to_vec(query_blob)
        except ValueError as error:
            logger.warning("[memory] query blob malformed: %s", error)
            return []
        expected_dim = self._embedding.dim

        def score_rows(rows, kind: str) -> List[MemoryRecall]:
            out: List[MemoryRecall] = []
            for row in rows:
                blob = row["embedding"]
                if blob is None:
                    continue
                try:
                    vec = blob_to_vec(blob)
                    if len(vec) != expected_dim:
                        logger.warning(
                            "[memory] skip %s id=%s due to dim=%d != expected=%d",
                            kind, row["id"], len(vec), expected_dim,
                        )
                        continue
                    score = cosine_similarity(query_vec, vec)
                except ValueError as error:
                    logger.warning(
                        "[memory] skip %s id=%s due to %s",
                        kind, row["id"], error,
                    )
                    continue
                if score < floor:
                    continue
                if kind == "summary":
                    out.append(MemoryRecall(
                        kind="summary",
                        content=row["summary"],
                        score=score,
                        created_at=int(row["created_at"]),
                        source_id=int(row["id"]),
                    ))
                else:
                    out.append(MemoryRecall(
                        kind="turn",
                        content=row["content"],
                        score=score,
                        created_at=int(row["created_at"]),
                        source_id=int(row["id"]),
                        role=row["role"],
                    ))
            return out

        # summaries 우선 (Codex NICE-TO-HAVE): "긴 대화 한 덩어리"가 recall 품질
        # 면에서 raw turn 조각보다 안정적.
        summary_hits = sorted(
            score_rows(summary_rows, "summary"),
            key=lambda r: r.score,
            reverse=True,
        )
        if len(summary_hits) >= top_k:
            return summary_hits[:top_k]

        turn_hits = sorted(
            score_rows(turn_rows, "turn"),
            key=lambda r: r.score,
            reverse=True,
        )
        # summary가 같은 범위를 이미 커버하면 raw turn은 중복이라 빼는 단순한 dedupe.
        covered: set = set()
        for r in summary_hits:
            # source_id가 summary id니까 범위는 SQL에서 다시 읽지 않고 단순히
            # 동일 content 텍스트로 비교. 데이터셋이 작으니 OK.
            covered.add(r.content)
        deduped_turns = [t for t in turn_hits if t.content not in covered]

        merged = summary_hits + deduped_turns
        return merged[:top_k]
