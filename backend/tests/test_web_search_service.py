"""Unit tests for `services.web_search_service.WebSearchService`.

Network calls are forbidden in tests — the real Tavily/Brave paths are
covered only by stubbed search_fn that returns hand-crafted WebResult lists.
What we DO test:
  - marker parser handles single/multiple/duplicate/out-of-range markers
  - record_citations writes rows keyed off turn_id, skips out-of-range markers
  - search() returns empty + last_error when provider is "none" / key missing
  - search() respects max_results trim + score-desc ordering
  - list_citations_for_turn round-trip
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.store_service import StoreService
from services.web_search_service import WebResult, WebSearchService


async def _make_service(tmp_path: Path, **kwargs) -> tuple[WebSearchService, StoreService]:
    store = StoreService(tmp_path / "web.db")
    await store.initialize()
    svc = WebSearchService(store=store, **kwargs)
    return svc, store


@pytest.mark.asyncio
async def test_parse_markers_orders_first_appearance():
    text = "사실 [3] 그리고 [1] 또 [3] 다시 [2]"
    assert WebSearchService.parse_markers(text) == [3, 1, 2]


@pytest.mark.asyncio
async def test_parse_markers_rejects_out_of_range_or_huge():
    text = "본문 [12345] 그리고 [0] 그리고 [9999]"
    assert WebSearchService.parse_markers(text) == [9999]


@pytest.mark.asyncio
async def test_parse_markers_no_marker_returns_empty():
    assert WebSearchService.parse_markers("그냥 평범한 답변") == []


@pytest.mark.asyncio
async def test_search_disabled_when_provider_none(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="none", api_key="")
    assert svc.enabled is False
    results = await svc.search("anything")
    assert results == []
    stats = await svc.stats()
    assert stats["enabled"] is False
    assert "not configured" in (stats["last_error"] or "")
    await store.close()


@pytest.mark.asyncio
async def test_search_disabled_when_api_key_missing(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="tavily", api_key="")
    assert svc.enabled is False
    results = await svc.search("anything")
    assert results == []
    await store.close()


@pytest.mark.asyncio
async def test_search_fn_injection_trims_and_orders(tmp_path: Path):
    async def fake_search(query: str):
        return [
            WebResult(title="C", url="https://c", snippet="lo", score=0.3),
            WebResult(title="A", url="https://a", snippet="hi", score=0.9),
            WebResult(title="B", url="https://b", snippet="mid", score=0.6),
            WebResult(title="D", url="https://d", snippet="lower", score=0.1),
        ]

    svc, store = await _make_service(
        tmp_path, provider="none", api_key="",
        max_results=2, search_fn=fake_search,
    )
    assert svc.enabled is True  # search_fn 주입 시 무조건 enabled.
    results = await svc.search("anything")
    assert [r.title for r in results] == ["A", "B"]  # score desc, then take 2.
    await store.close()


@pytest.mark.asyncio
async def test_search_fn_failure_surfaces_last_error(tmp_path: Path):
    async def boom(query: str):
        raise RuntimeError("simulated provider down")

    svc, store = await _make_service(
        tmp_path, provider="none", search_fn=boom,
    )
    results = await svc.search("anything")
    assert results == []
    stats = await svc.stats()
    assert "simulated provider down" in (stats["last_error"] or "")
    await store.close()


@pytest.mark.asyncio
async def test_record_citations_writes_rows(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="none")
    # citations.turn_id는 chat_turns에 FK라 row가 실제로 있어야 한다.
    turn_id = await store.execute(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        ("assistant", "본문 [1] 그리고 [2]", 1_000),
    )
    results = [
        WebResult(title="t1", url="https://1", snippet="s1"),
        WebResult(title="t2", url="https://2", snippet="s2"),
    ]
    added = await svc.record_citations(turn_id, [1, 2], results)
    assert added == 2
    rows = await svc.list_citations_for_turn(turn_id)
    assert {r["marker_number"] for r in rows} == {1, 2}
    assert {r["source_path"] for r in rows} == {"https://1", "https://2"}
    await store.close()


@pytest.mark.asyncio
async def test_record_citations_skips_out_of_range_markers(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="none")
    turn_id = await store.execute(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        ("assistant", "[1] only", 1_000),
    )
    results = [WebResult(title="t1", url="https://1", snippet="s1")]
    added = await svc.record_citations(turn_id, [1, 5, 99], results)
    assert added == 1
    rows = await svc.list_citations_for_turn(turn_id)
    assert len(rows) == 1
    assert rows[0]["marker_number"] == 1
    await store.close()


@pytest.mark.asyncio
async def test_record_citations_noop_when_empty(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="none")
    assert await svc.record_citations(1, [], [WebResult("t", "u", "s")]) == 0
    assert await svc.record_citations(1, [1], []) == 0
    await store.close()


@pytest.mark.asyncio
async def test_stats_citation_count(tmp_path: Path):
    svc, store = await _make_service(tmp_path, provider="none")
    turn_id = await store.execute(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        ("assistant", "[1] [2]", 1_000),
    )
    await svc.record_citations(turn_id, [1, 2], [
        WebResult("t1", "https://1", "s1"),
        WebResult("t2", "https://2", "s2"),
    ])
    stats = await svc.stats()
    assert stats["citation_count"] == 2
    await store.close()
