"""Unit tests for `services.memory_service.MemoryService`.

These tests run against a real on-disk SQLite (per-test tmp dir) and a *fake*
EmbeddingService. The real embedding model would download ~480 MB on first
run, which is unacceptable in CI/local pytest, so we substitute a small
deterministic encoder so we can hand-craft "obviously similar" vs. "obviously
different" embeddings and assert ranking behavior precisely.

What we ARE testing:
  - record_turn round-trip: row + BLOB length matches embedding.dim*4
  - record_turn drops the BLOB when the model produces the wrong dim
  - retrieve_relevant ranks closer vectors higher, respects min_score
  - retrieve_relevant skips rows whose BLOB dim no longer matches current model
  - retrieve_relevant prefers summaries when they cover, falls back to turns
  - retrieve_relevant excludes the most recent N turns (history already covers)
  - summarize_if_needed triggers at the threshold + idempotent + provider-disabled
  - record_chat_exchange serializes user→assistant→summarize in order
  - APIA_MEMORY_ENABLED=false makes every method a no-op
"""

from __future__ import annotations

import asyncio
import struct
from pathlib import Path
from typing import List, Optional

import pytest

from services.embedding_service import EmbeddingService
from services.memory_service import MemoryService
from services.store_service import StoreService


def _vec_to_blob(vec: List[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *(float(x) for x in vec))


class _FakeEncoder:
    """Tiny stand-in for sentence-transformers' SentenceTransformer.

    Produces a fixed-dim vector keyed off the first character of the input,
    so the test can write "apple" / "apricot" / "zebra" and know which two
    end up close. The encoder is L2-normalized at the vector level.
    """

    def __init__(self, dim: int = 4) -> None:
        self._dim = dim

    def get_sentence_embedding_dimension(self) -> int:
        return self._dim

    def encode(self, texts, normalize_embeddings: bool = True, convert_to_numpy: bool = True):
        out = []
        for t in texts:
            base = [0.0] * self._dim
            # 첫 글자(소문자) 기준 슬롯. 같은 첫 글자면 같은 one-hot.
            key = (t or " ")[0].lower()
            slot = (ord(key) - ord("a")) % self._dim
            base[slot] = 1.0
            out.append(base)
        return out


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "memory_test.db"


async def _make_service(
    db_path: Path,
    *,
    enabled: bool = True,
    summarize_fn=None,
    summary_every: int = 5,
    exclude_recent: int = 0,
    encoder_dim: int = 4,
) -> tuple[MemoryService, StoreService, EmbeddingService]:
    store = StoreService(db_path)
    await store.initialize()
    embedding = EmbeddingService(model_name="fake/model")
    embedding._model = _FakeEncoder(dim=encoder_dim)
    embedding._dim = encoder_dim
    service = MemoryService(
        store=store,
        embedding=embedding,
        summarize_fn=summarize_fn,
        enabled=enabled,
        retrieve_top_k=5,
        min_score=0.5,
        summary_every=summary_every,
        exclude_recent=exclude_recent,
    )
    return service, store, embedding


@pytest.mark.asyncio
async def test_record_turn_round_trip(db_path: Path) -> None:
    svc, store, embedding = await _make_service(db_path)
    turn_id = await svc.record_turn("user", "apple")
    assert turn_id == 1

    row = await store.fetchone(
        "SELECT role, content, embedding FROM chat_turns WHERE id = ?",
        (turn_id,),
    )
    assert row["role"] == "user"
    assert row["content"] == "apple"
    assert row["embedding"] is not None
    # 4 floats * 4 bytes — matches encoder.dim.
    assert len(row["embedding"]) == embedding.dim * 4

    await store.close()


@pytest.mark.asyncio
async def test_record_turn_skips_blob_on_dim_mismatch(db_path: Path, monkeypatch) -> None:
    """If the embedding model later returns a vector of an unexpected dim
    (model swap mid-run, corrupted local model), the BLOB must be dropped
    rather than persisted, so retrieve doesn't later score against garbage."""
    svc, store, embedding = await _make_service(db_path)

    async def _wrong_dim(_text: str) -> bytes:
        return _vec_to_blob([0.0, 1.0, 0.0])  # dim=3 != embedding.dim=4

    monkeypatch.setattr(embedding, "embed_one", _wrong_dim)
    turn_id = await svc.record_turn("user", "anything")
    row = await store.fetchone(
        "SELECT content, embedding FROM chat_turns WHERE id = ?",
        (turn_id,),
    )
    assert row["content"] == "anything"
    assert row["embedding"] is None
    assert "dim mismatch" in (await svc.stats())["last_error"]

    await store.close()


@pytest.mark.asyncio
async def test_retrieve_relevant_ranks_close_first(db_path: Path) -> None:
    svc, store, embedding = await _make_service(db_path)
    # Same first letter → same vector slot → cosine ~= 1.0.
    await svc.record_turn("user", "apple")
    await svc.record_turn("user", "apricot")
    # Different letter → orthogonal → cosine ~= 0.0.
    await svc.record_turn("user", "zebra")

    recalls = await svc.retrieve_relevant("ant")  # 'a' slot → close to apple/apricot
    contents = [r.content for r in recalls]
    assert "zebra" not in contents
    # Both 'a' rows should come back (score == 1.0).
    assert set(contents) == {"apple", "apricot"}

    await store.close()


@pytest.mark.asyncio
async def test_retrieve_relevant_respects_min_score(db_path: Path) -> None:
    """`min_score` is the floor — orthogonal (score 0.0) rows must not appear
    even when there are no better hits."""
    svc, store, embedding = await _make_service(db_path)
    await svc.record_turn("user", "zebra")

    # Query is 'a'-slot, only stored row is 'z'-slot — cosine 0.0, below 0.5 floor.
    recalls = await svc.retrieve_relevant("ant")
    assert recalls == []

    await store.close()


@pytest.mark.asyncio
async def test_retrieve_skips_dim_mismatched_rows(db_path: Path) -> None:
    """A row written under a previous model (different dim) must be skipped
    at retrieve time, not crash the rank loop."""
    svc, store, embedding = await _make_service(db_path)
    # Manually insert a row with a wrong-dim BLOB (simulating a model swap).
    bad_blob = _vec_to_blob([0.0, 1.0, 0.0])  # dim=3 != current 4
    await store.execute(
        "INSERT INTO chat_turns (role, content, created_at, embedding) "
        "VALUES (?, ?, ?, ?)",
        ("user", "legacy-row", 1_000, bad_blob),
    )
    # A well-formed row that *should* match the query.
    await svc.record_turn("user", "apple")

    recalls = await svc.retrieve_relevant("ant")
    contents = [r.content for r in recalls]
    assert "legacy-row" not in contents
    assert "apple" in contents

    await store.close()


@pytest.mark.asyncio
async def test_retrieve_excludes_recent_turns(db_path: Path) -> None:
    """The most recent N turns are already in the chat history sent to the
    provider, so retrieve must not echo them as "long-term memory"."""
    svc, store, embedding = await _make_service(db_path, exclude_recent=2)
    await svc.record_turn("user", "apple")        # id=1
    await svc.record_turn("assistant", "apricot") # id=2 (recent, excluded)
    await svc.record_turn("user", "ant")          # id=3 (recent, excluded)

    recalls = await svc.retrieve_relevant("aardvark")  # all 'a'-slot
    contents = [r.content for r in recalls]
    # The two most-recent rows are excluded; only the oldest 'a' survives.
    assert contents == ["apple"]

    await store.close()


@pytest.mark.asyncio
async def test_summarize_if_needed_triggers_and_idempotent(db_path: Path) -> None:
    captured: list[str] = []

    async def fake_summarize(text: str) -> str:
        captured.append(text)
        return "요약: " + text[:20]

    svc, store, embedding = await _make_service(
        db_path, summarize_fn=fake_summarize, summary_every=3
    )
    # Insert 3 turns — meets the threshold exactly.
    for i in range(3):
        await svc.record_turn("user", f"apple{i}")

    summary_id = await svc.summarize_if_needed()
    assert summary_id is not None
    assert len(captured) == 1

    # Second call: no new pending turns → returns None, summarize_fn not called again.
    second = await svc.summarize_if_needed()
    assert second is None
    assert len(captured) == 1

    rows = await store.fetchall(
        "SELECT start_turn_id, end_turn_id, summary FROM conversation_summaries"
    )
    assert len(rows) == 1
    assert rows[0]["start_turn_id"] == 1
    assert rows[0]["end_turn_id"] == 3

    await store.close()


@pytest.mark.asyncio
async def test_summarize_disabled_when_no_provider(db_path: Path) -> None:
    """provider 없으면 (summarize_fn=None) 요약은 비활성. last_error에 사유 기록."""
    svc, store, embedding = await _make_service(
        db_path, summarize_fn=None, summary_every=2
    )
    for i in range(3):
        await svc.record_turn("user", f"apple{i}")
    result = await svc.summarize_if_needed()
    assert result is None
    stats = await svc.stats()
    assert stats["summary_count"] == 0
    assert "no provider" in (stats["last_error"] or "")

    await store.close()


@pytest.mark.asyncio
async def test_record_chat_exchange_orders_user_then_assistant(db_path: Path) -> None:
    """user turn id < assistant turn id, always. Without serialization the
    two background create_tasks could land in either order under load."""
    captured: list[str] = []

    async def fake_summarize(text: str) -> str:
        captured.append(text)
        return "요약 텍스트"

    svc, store, _ = await _make_service(
        db_path, summarize_fn=fake_summarize, summary_every=2
    )
    await svc.record_chat_exchange("apple", "apricot")
    rows = await store.fetchall(
        "SELECT id, role, content FROM chat_turns ORDER BY id"
    )
    assert [(r["role"], r["content"]) for r in rows] == [
        ("user", "apple"),
        ("assistant", "apricot"),
    ]
    # threshold=2 exactly hit → summary should have fired.
    summary_rows = await store.fetchall("SELECT id FROM conversation_summaries")
    assert len(summary_rows) == 1
    assert len(captured) == 1

    await store.close()


@pytest.mark.asyncio
async def test_disabled_service_is_noop(db_path: Path) -> None:
    svc, store, _ = await _make_service(db_path, enabled=False)
    assert await svc.record_turn("user", "apple") is None
    assert await svc.retrieve_relevant("apple") == []
    assert await svc.summarize_if_needed() is None
    await svc.record_chat_exchange("apple", "apricot")

    # No writes happened.
    count_row = await store.fetchone("SELECT count(*) AS n FROM chat_turns")
    assert count_row["n"] == 0

    stats = await svc.stats()
    assert stats["enabled"] is False
    assert stats["turn_count"] == 0

    await store.close()


@pytest.mark.asyncio
async def test_retrieve_prefers_summaries_over_turns(db_path: Path) -> None:
    """When a summary covers the same semantic neighborhood, it should rank
    ahead of raw turns — the summary table is denser and was the explicit
    Codex NICE-TO-HAVE for retrieval order."""

    async def fake_summarize(text: str) -> str:
        return "apple summary"  # 'a'-slot, same vector as the original turns

    svc, store, _ = await _make_service(
        db_path, summarize_fn=fake_summarize, summary_every=2
    )
    await svc.record_turn("user", "apple-1")
    await svc.record_turn("user", "apple-2")
    await svc.summarize_if_needed()

    recalls = await svc.retrieve_relevant("ant")
    assert recalls, "expected at least one recall"
    # First recall must be the summary, not a raw turn.
    assert recalls[0].kind == "summary"
    assert recalls[0].content == "apple summary"

    await store.close()
