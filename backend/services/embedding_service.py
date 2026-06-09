"""
Local-only embedding service for Apia.

Owns:
  - the sentence-transformers model handle (lazy-loaded, single instance)
  - the async lock that serializes load attempts
  - the float32 numpy encoding helper used by memory/file/web pipelines

Does NOT own:
  - storage of embeddings (caller persists to SQLite via StoreService)
  - retrieval (the per-feature service does its own cosine ranking)

Why "local-only": the user is non-developer + wanted free + long-lasting +
self-contained. sentence-transformers downloads the model from Hugging Face on
first run (one-time ~480 MB), then everything is in-process numpy. No API key,
no per-call cost, no third-party rate limits.

Model choice: `paraphrase-multilingual-MiniLM-L12-v2` — 384-dim, 12-layer
multilingual encoder. The user is Korean-primary mixed English; the English-
only L6 model trades too much Korean semantic quality for the smaller
download. Swap by env var (APIA_EMBEDDING_MODEL) without redeploy.

Lifecycle states surfaced via `status()`:
  - { loaded:false, loading:false } → never tried
  - { loaded:false, loading:true  } → first download/load in progress
  - { loaded:true,  loading:false } → ready
  - { error: '<msg>' } overlaid on any state when last load attempt threw
"""

from __future__ import annotations

import asyncio
import logging
import os
import struct
from typing import Iterable, Sequence

logger = logging.getLogger(__name__)

# Default model. Override via APIA_EMBEDDING_MODEL for tests or for users who
# want to point at a locally pre-downloaded model dir.
#
# `paraphrase-multilingual-MiniLM-L12-v2` (384-dim, ~480 MB) over
# `all-MiniLM-L6-v2` (~90 MB) because the user is Korean-primary with mixed
# English. The L6 English-only model loses too much semantic signal on Korean
# queries to be worth the smaller download — Codex MUST-FIX called this out.
DEFAULT_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_DIM = 384


class EmbeddingService:
    def __init__(self, model_name: str | None = None) -> None:
        self._model_name = model_name or os.getenv("APIA_EMBEDDING_MODEL", DEFAULT_MODEL_NAME)
        self._model = None
        self._lock = asyncio.Lock()
        self._loading = False
        self._error: str | None = None
        self._dim = DEFAULT_DIM

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dim(self) -> int:
        return self._dim

    def status(self) -> dict:
        return {
            "model_name": self._model_name,
            "loaded": self._model is not None,
            "loading": self._loading,
            "error": self._error,
            "dim": self._dim,
        }

    async def ensure_ready(self) -> None:
        """Block until the model is loaded. Coalesces concurrent first-load
        attempts behind the same lock so we never spawn two downloads."""
        if self._model is not None:
            return
        async with self._lock:
            if self._model is not None:
                return
            self._loading = True
            self._error = None
            try:
                model = await asyncio.to_thread(self._load_sync)
                self._model = model
                # Probe dimension from a real encode so callers can size BLOB
                # storage correctly without hardcoding per-model.
                self._dim = int(model.get_sentence_embedding_dimension())
            except Exception as exc:  # noqa: BLE001 — boundary surface
                self._error = f"{type(exc).__name__}: {exc}"
                logger.exception("[embedding] load failed")
                raise
            finally:
                self._loading = False

    def _load_sync(self):
        # Import here so the module imports cheaply at process start. The real
        # cost (torch import + model download) only happens when somebody
        # actually wants an embedding.
        from sentence_transformers import SentenceTransformer

        logger.info("[embedding] loading model %s", self._model_name)
        return SentenceTransformer(self._model_name)

    async def embed(self, texts: Sequence[str]) -> list[bytes]:
        """Return a list of float32 BLOBs, one per input text, with L2-normalized
        vectors so dot-product equals cosine similarity at retrieval time."""
        if not texts:
            return []
        await self.ensure_ready()
        return await asyncio.to_thread(self._embed_sync, list(texts))

    def _embed_sync(self, texts: list[str]) -> list[bytes]:
        assert self._model is not None
        # normalize_embeddings=True so all downstream retrieval can use a plain
        # dot product instead of computing norms per query.
        vecs = self._model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return [_vec_to_blob(vecs[i]) for i in range(len(texts))]

    async def embed_one(self, text: str) -> bytes:
        out = await self.embed([text])
        return out[0]


def _vec_to_blob(vec) -> bytes:
    # Cheap, no-numpy-import path so this helper is callable from tests that
    # only have a Python list of floats. numpy arrays are iterable too.
    return struct.pack(f"<{len(vec)}f", *(float(x) for x in vec))


def blob_to_vec(blob: bytes) -> list[float]:
    """Inverse of `_vec_to_blob` for retrieval. Returns a Python list so the
    caller can choose numpy / native math without forcing numpy on import.

    Rejects non-4-byte-aligned blobs explicitly — silent truncation would let
    a corrupted DB row produce a shorter vector and skew similarity ranking
    without any error. Codex MUST-FIX.
    """
    if len(blob) % 4 != 0:
        raise ValueError(
            f"embedding blob length {len(blob)} is not a multiple of 4 bytes"
        )
    count = len(blob) // 4
    return list(struct.unpack(f"<{count}f", blob))


def cosine_similarity(a: Iterable[float], b: Iterable[float]) -> float:
    """Both vectors are L2-normalized at encode time, so the dot product *is*
    cosine similarity. Kept as a named function so call sites read clearly
    when a future migration drops the normalize-on-encode invariant.

    Raises on mismatched dimensions — Codex MUST-FIX. `zip()` would silently
    truncate to the shorter of the two, hiding a class of bug where a row was
    embedded with a different model and got mixed into the same retrieval.
    """
    a_list = list(a)
    b_list = list(b)
    if len(a_list) != len(b_list):
        raise ValueError(
            f"vector dimension mismatch: {len(a_list)} vs {len(b_list)}"
        )
    return sum(x * y for x, y in zip(a_list, b_list))
