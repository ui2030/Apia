"""Unit tests for `services.embedding_service.EmbeddingService`.

We never actually download the sentence-transformers model in tests — that
would pull ~90 MB on first run of CI/local pytest, which is unacceptable. We
patch `_load_sync` to return a fake model that mimics the surface
EmbeddingService relies on (`get_sentence_embedding_dimension`, `encode`).

What we ARE testing:
  - lazy load: status() reports `loaded:false` until first ensure_ready
  - concurrent first calls don't trigger two loads (dedup via _lock)
  - encode round-trips through `_vec_to_blob` and produces stable bytes
  - blob_to_vec inverts _vec_to_blob exactly
  - cosine_similarity matches dot product for normalized vectors
  - errors during load surface via status() and re-raise
"""

from __future__ import annotations

import asyncio
import struct
from unittest.mock import MagicMock

import pytest

from services.embedding_service import (
    EmbeddingService,
    blob_to_vec,
    cosine_similarity,
)


class _FakeModel:
    def __init__(self, dim: int = 4) -> None:
        self._dim = dim
        self.calls: list[list[str]] = []

    def get_sentence_embedding_dimension(self) -> int:
        return self._dim

    def encode(self, texts, normalize_embeddings: bool = True, convert_to_numpy: bool = True):
        # Return a deterministic vector per text so tests can assert stable
        # bytes. The exact values don't matter — only that the shape and the
        # normalize flag are honored at call time.
        self.calls.append(list(texts))
        # Pretend we returned normalized vectors. Yield a Python list-of-lists
        # so the service's encode path works without a real numpy array.
        out = []
        for i, _t in enumerate(texts):
            base = [0.0] * self._dim
            base[i % self._dim] = 1.0
            out.append(base)
        return out


@pytest.mark.asyncio
async def test_status_before_any_call() -> None:
    svc = EmbeddingService(model_name="fake/model")
    s = svc.status()
    assert s["loaded"] is False
    assert s["loading"] is False
    assert s["error"] is None
    assert s["model_name"] == "fake/model"


@pytest.mark.asyncio
async def test_ensure_ready_loads_once(monkeypatch: pytest.MonkeyPatch) -> None:
    svc = EmbeddingService(model_name="fake/model")
    fake = _FakeModel(dim=4)
    load_calls = MagicMock(return_value=fake)
    monkeypatch.setattr(svc, "_load_sync", load_calls)

    await svc.ensure_ready()
    await svc.ensure_ready()  # second call: must not re-load
    assert load_calls.call_count == 1
    assert svc.status()["loaded"] is True
    assert svc.dim == 4


@pytest.mark.asyncio
async def test_concurrent_ensure_ready_dedup(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two ensure_ready() calls fired in parallel must result in exactly one
    _load_sync invocation — important because the real one downloads 90 MB."""
    svc = EmbeddingService(model_name="fake/model")
    fake = _FakeModel(dim=4)
    load_calls = MagicMock(return_value=fake)
    monkeypatch.setattr(svc, "_load_sync", load_calls)

    await asyncio.gather(svc.ensure_ready(), svc.ensure_ready(), svc.ensure_ready())
    assert load_calls.call_count == 1


@pytest.mark.asyncio
async def test_embed_returns_one_blob_per_input(monkeypatch: pytest.MonkeyPatch) -> None:
    svc = EmbeddingService(model_name="fake/model")
    fake = _FakeModel(dim=4)
    monkeypatch.setattr(svc, "_load_sync", lambda: fake)

    blobs = await svc.embed(["hello", "world", "안녕"])
    assert len(blobs) == 3
    # Each blob is 4 floats * 4 bytes = 16 bytes for our dim=4 fake.
    for b in blobs:
        assert len(b) == 4 * 4
        # Round-trip through blob_to_vec must give us the original vector.
        vec = blob_to_vec(b)
        assert len(vec) == 4
        assert sum(vec) == pytest.approx(1.0)  # one-hot from _FakeModel.encode


@pytest.mark.asyncio
async def test_embed_empty_input_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    svc = EmbeddingService(model_name="fake/model")
    monkeypatch.setattr(svc, "_load_sync", lambda: _FakeModel())
    out = await svc.embed([])
    assert out == []


@pytest.mark.asyncio
async def test_load_failure_surfaces_via_status_and_reraises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    svc = EmbeddingService(model_name="fake/model")

    def _boom():
        raise RuntimeError("simulated download failure")

    monkeypatch.setattr(svc, "_load_sync", _boom)

    with pytest.raises(RuntimeError):
        await svc.ensure_ready()

    s = svc.status()
    assert s["loaded"] is False
    assert s["loading"] is False
    assert "simulated download failure" in (s["error"] or "")


def test_blob_round_trip_exact() -> None:
    original = [0.1, -0.5, 0.7, 0.3]
    blob = struct.pack(f"<{len(original)}f", *original)
    vec = blob_to_vec(blob)
    for orig, got in zip(original, vec):
        assert orig == pytest.approx(got, rel=1e-6)


def test_cosine_similarity_orthogonal_and_parallel() -> None:
    # Hand-rolled vectors. cosine_similarity is just dot product (we assume
    # callers stored normalized vectors), so these checks verify the math, not
    # the encoding path.
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine_similarity([0.6, 0.8], [0.8, 0.6]) == pytest.approx(0.96)


def test_blob_to_vec_rejects_misaligned_blob() -> None:
    # Anything not a multiple of 4 bytes is corrupt: float32 occupies exactly
    # 4 bytes. zip-style silent truncation was the original bug (Codex MUST-FIX).
    with pytest.raises(ValueError):
        blob_to_vec(b"\x00\x00\x00")
    with pytest.raises(ValueError):
        blob_to_vec(b"\x00" * 13)


def test_cosine_similarity_rejects_dim_mismatch() -> None:
    # The retrieval pipeline can mix rows from two models if the user swaps
    # APIA_EMBEDDING_MODEL without re-embedding existing rows. zip() would
    # silently truncate to the shorter dim and produce a plausible-looking
    # score; we want a loud error instead so the operator notices.
    with pytest.raises(ValueError):
        cosine_similarity([1.0, 0.0, 0.0], [1.0, 0.0])
