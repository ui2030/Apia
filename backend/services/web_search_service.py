"""
Web search service (step 4).

Two responsibilities:
  1. Issue a search query against a configured external provider and return
     a small set of `WebResult` objects (title, url, snippet, score).
  2. Persist the assistant's `[N]` citation markers as rows in the
     `citations` table so the renderer can show source pop-overs and a future
     "view source" UI can resolve marker→url.

Providers (pluggable):
  - "none" (default) — disabled. stats() reports last_error="provider not configured".
  - "tavily" — Tavily AI search API (free tier, https://tavily.com).
  - "brave" — Brave search API (https://api.search.brave.com).
  - "callable" — direct injection of an async search function (used by tests
    so we never hit the network during pytest).

Why no DuckDuckGo HTML scraping: their ToS forbids it and IPs get throttled
quickly. We require a real API key for any real provider.

Markers + persistence:
  - Assistant replies may include `[1]`, `[2]`, … markers. `parse_markers()`
    extracts them with their order of appearance.
  - `record_citations()` writes rows keyed off the assistant `turn_id`.
    `source_kind='web'` rows carry `source_path=url`, `snippet`, `title`,
    `marker_number`. The reusable schema also supports `source_kind='file'`
    and `'memory'` so step-3 file recalls can flow through the same path
    later if needed.

Concurrency:
  - Searches are stateless (no shared init resource) so we run them with no
    lock. An earlier draft serialized provider dispatch behind a lock; Codex
    NICE-TO-HAVE (round 4) flagged it as pure overhead and it's gone now.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, List, Optional, Sequence

from services.store_service import StoreService

logger = logging.getLogger(__name__)

# `[1]`, `[2]`, … as standalone tokens. Captures the digits. Reject `[10000]`
# (>4 digits) so a date or accidental array index doesn't get treated as a
# citation marker — 4-digit cap is generous (no real reply cites 10000 sources).
_MARKER_RE = re.compile(r"\[(\d{1,4})\]")


@dataclass
class WebResult:
    title: str
    url: str
    snippet: str
    score: float = 0.0


SearchFn = Callable[[str], Awaitable[List[WebResult]]]


class WebSearchService:
    def __init__(
        self,
        store: StoreService,
        *,
        provider: str = "none",
        api_key: str = "",
        max_results: int = 5,
        timeout_seconds: int = 10,
        search_fn: Optional[SearchFn] = None,
    ) -> None:
        self._store = store
        self._provider = provider
        self._api_key = api_key
        self._max_results = max(1, max_results)
        self._timeout = max(1, timeout_seconds)
        # Direct injection for tests. When set, provider/api_key are ignored.
        self._search_fn = search_fn
        # Codex NICE-TO-HAVE (4단계 verification): provider 호출은 stateless이므로
        # 직렬화할 이유가 없다. 진짜 보호가 필요한 init 자원이 없으니 lock 자체를 뺐다.
        self._last_error: Optional[str] = None
        self._client: Any = None

    @property
    def enabled(self) -> bool:
        if self._search_fn is not None:
            return True
        if self._provider == "none":
            return False
        if not self._api_key:
            return False
        return True

    @property
    def provider(self) -> str:
        return self._provider

    async def search(self, query: str) -> List[WebResult]:
        """단건 검색. provider 미설정/키 없음/오류는 빈 리스트 + last_error 기록."""
        query = query.strip()
        if not query:
            return []
        if not self.enabled:
            self._last_error = "provider not configured"
            return []
        if self._search_fn is not None:
            try:
                results = await self._search_fn(query)
            except Exception as error:  # noqa: BLE001
                self._last_error = f"search: {type(error).__name__}: {error}"
                logger.warning("[web] custom search_fn failed: %s", error)
                return []
            return self._trim(results)
        try:
            results = await self._dispatch_provider(query)
        except Exception as error:  # noqa: BLE001
            self._last_error = f"search: {type(error).__name__}: {error}"
            logger.warning("[web] %s search failed: %s", self._provider, error)
            return []
        return self._trim(results)

    def _trim(self, results: List[WebResult]) -> List[WebResult]:
        # provider별 정렬 차이를 평탄화: score desc, 그 다음 입력 순.
        ordered = sorted(
            enumerate(results),
            key=lambda iv: (-iv[1].score, iv[0]),
        )
        return [r for _, r in ordered[: self._max_results]]

    async def _dispatch_provider(self, query: str) -> List[WebResult]:
        if self._provider == "tavily":
            return await self._search_tavily(query)
        if self._provider == "brave":
            return await self._search_brave(query)
        raise RuntimeError(f"unsupported provider: {self._provider}")

    async def _search_tavily(self, query: str) -> List[WebResult]:
        # Tavily는 SDK도 있지만 단순 HTTP POST면 충분. requests/httpx 의존을 새로
        # 만들지 않고 표준 urllib을 to_thread로 호출.
        import json
        import urllib.error
        import urllib.request

        def _call():
            payload = json.dumps({
                "api_key": self._api_key,
                "query": query,
                "max_results": self._max_results,
                "search_depth": "basic",
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://api.tavily.com/search",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await asyncio.to_thread(_call)
        items = data.get("results") or []
        return [
            WebResult(
                title=item.get("title", "")[:200],
                url=item.get("url", ""),
                snippet=item.get("content", "")[:1000],
                score=float(item.get("score", 0.0)),
            )
            for item in items
        ]

    async def _search_brave(self, query: str) -> List[WebResult]:
        import json
        import urllib.error
        import urllib.parse
        import urllib.request

        def _call():
            qs = urllib.parse.urlencode({"q": query, "count": self._max_results})
            req = urllib.request.Request(
                f"https://api.search.brave.com/res/v1/web/search?{qs}",
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": self._api_key,
                },
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await asyncio.to_thread(_call)
        items = (data.get("web") or {}).get("results") or []
        return [
            WebResult(
                title=item.get("title", "")[:200],
                url=item.get("url", ""),
                snippet=item.get("description", "")[:1000],
                score=0.0,
            )
            for item in items
        ]

    # ── citations persistence ─────────────────────────────────────────────

    @staticmethod
    def parse_markers(text: str) -> List[int]:
        """텍스트 안의 [1] [2] 마커를 등장 순서로(중복 허용 X) 반환.

        같은 번호가 두 번 나와도 한 번만 기록. order는 첫 등장 기준.
        """
        seen: dict[int, bool] = {}
        for match in _MARKER_RE.finditer(text):
            n = int(match.group(1))
            if 1 <= n <= 9999:
                seen.setdefault(n, True)
        return list(seen.keys())

    async def record_citations(
        self,
        turn_id: int,
        marker_numbers: Sequence[int],
        results: Sequence[WebResult],
    ) -> int:
        """marker_numbers[i]를 results[i-1] (1-based)에 매핑해서 citations 행 작성.

        results보다 큰 marker는 skip (LLM이 환각으로 [99] 같은 걸 뱉었을 때).
        results보다 짧으면 그것까지만 기록.
        """
        if not marker_numbers or not results:
            return 0
        added = 0
        for marker in marker_numbers:
            if marker < 1 or marker > len(results):
                continue
            web = results[marker - 1]
            await self._store.execute(
                "INSERT INTO citations "
                "(turn_id, marker_number, source_kind, source_path, chunk_id, "
                " snippet, title, page) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    int(turn_id),
                    int(marker),
                    "web",
                    web.url,
                    None,
                    web.snippet,
                    web.title,
                    None,
                ),
            )
            added += 1
        return added

    async def list_citations_for_turn(self, turn_id: int) -> List[dict]:
        rows = await self._store.fetchall(
            "SELECT id, marker_number, source_kind, source_path, snippet, title, page "
            "FROM citations WHERE turn_id = ? ORDER BY marker_number",
            (int(turn_id),),
        )
        return [
            {
                "id": int(r["id"]),
                "marker_number": int(r["marker_number"]),
                "source_kind": r["source_kind"],
                "source_path": r["source_path"],
                "snippet": r["snippet"],
                "title": r["title"],
                "page": r["page"],
            }
            for r in rows
        ]

    async def stats(self) -> dict:
        row = await self._store.fetchone(
            "SELECT count(*) AS n FROM citations WHERE source_kind = 'web'"
        )
        return {
            "enabled": self.enabled,
            "provider": self._provider,
            "citation_count": int(row["n"]) if row else 0,
            "last_error": self._last_error,
        }
