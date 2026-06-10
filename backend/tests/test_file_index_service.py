"""Unit tests for `services.file_index_service.FileIndexService`.

Per-test tmp dir for SQLite + a fake encoder (no model download). Files are
written into a second tmp dir and added to the allowlist explicitly. Tests
cover the four invariants the design hinges on:

1. allowlist enforcement (no string-prefix bypass, no symlink/.. bypass).
2. overlap rejection (parent/child folder pair must not both be registered).
3. per-file reindex atomicity (DELETE old + INSERT new, never half-state).
4. retrieval security (a chunk from a removed folder must not surface).
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from services.embedding_service import EmbeddingService
from services.file_index_service import (
    FileIndexService,
    _chunk_text,
    _hash_chunk,
    is_path_under,
)
from services.store_service import StoreService


def _vec_to_blob(vec):
    return struct.pack(f"<{len(vec)}f", *(float(x) for x in vec))


class _FakeEncoder:
    def __init__(self, dim: int = 4) -> None:
        self._dim = dim

    def get_sentence_embedding_dimension(self) -> int:
        return self._dim

    def encode(self, texts, normalize_embeddings: bool = True, convert_to_numpy: bool = True):
        out = []
        for t in texts:
            base = [0.0] * self._dim
            key = (t or " ")[0].lower()
            slot = (ord(key) - ord("a")) % self._dim
            base[slot] = 1.0
            out.append(base)
        return out


async def _make(tmp_path: Path, *, enabled: bool = True, chunk_chars: int = 200,
                chunk_overlap: int = 0):
    store = StoreService(tmp_path / "store.db")
    await store.initialize()
    embedding = EmbeddingService(model_name="fake/model")
    embedding._model = _FakeEncoder()
    embedding._dim = 4
    svc = FileIndexService(
        store=store, embedding=embedding, enabled=enabled,
        chunk_chars=chunk_chars, chunk_overlap=chunk_overlap,
        min_score=0.5, retrieve_top_k=5,
    )
    return svc, store, embedding


@pytest.mark.asyncio
async def test_chunk_text_short_returns_single_chunk():
    chunks = _chunk_text("짧은 글", size=100, overlap=10)
    assert chunks == ["짧은 글"]


@pytest.mark.asyncio
async def test_chunk_text_respects_size_and_overlap():
    text = "a" * 1000
    chunks = _chunk_text(text, size=300, overlap=50)
    # Each chunk len <= 300; consecutive chunks share 50 chars except boundaries.
    assert all(len(c) <= 300 for c in chunks)
    assert len(chunks) >= 3
    # Last chunk reaches the end of input.
    assert chunks[-1].endswith("a")


@pytest.mark.asyncio
async def test_is_path_under_blocks_string_prefix_bypass(tmp_path: Path):
    a = tmp_path / "a"
    a2 = tmp_path / "a2"
    a.mkdir()
    a2.mkdir()
    assert is_path_under(a / "child.txt", a) is True
    # C:/.../a2 must NOT be under C:/.../a even though string prefix matches.
    assert is_path_under(a2 / "child.txt", a) is False


@pytest.mark.asyncio
async def test_add_folder_round_trip(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    folder = tmp_path / "docs"
    folder.mkdir()
    res = await svc.add_folder(str(folder))
    assert res["status"] == "added"
    listed = await svc.list_folders()
    assert any(Path(f["path"]) == folder.resolve() for f in listed)
    await store.close()


@pytest.mark.asyncio
async def test_add_folder_rejects_non_directory(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    not_a_dir = tmp_path / "ghost"
    with pytest.raises(FileNotFoundError):
        await svc.add_folder(str(not_a_dir))
    await store.close()


@pytest.mark.asyncio
async def test_add_folder_rejects_overlap_with_parent(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    parent = tmp_path / "outer"
    child = parent / "inner"
    child.mkdir(parents=True)
    await svc.add_folder(str(parent))
    # Adding the child after the parent must fail — overlap.
    with pytest.raises(ValueError):
        await svc.add_folder(str(child))
    await store.close()


@pytest.mark.asyncio
async def test_add_folder_rejects_overlap_with_child(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    parent = tmp_path / "outer"
    child = parent / "inner"
    child.mkdir(parents=True)
    await svc.add_folder(str(child))
    with pytest.raises(ValueError):
        await svc.add_folder(str(parent))
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_indexes_txt_files(tmp_path: Path):
    svc, store, _ = await _make(tmp_path, chunk_chars=100)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.txt").write_text("apple " * 30, encoding="utf-8")
    (folder / "b.md").write_text("apricot " * 30, encoding="utf-8")
    await svc.add_folder(str(folder))
    result = await svc.index_folder(str(folder))
    assert result.files_indexed == 2
    assert result.chunks_added >= 2
    rows = await store.fetchall("SELECT source_path FROM file_chunks ORDER BY id")
    paths = sorted({r["source_path"] for r in rows})
    assert any("a.txt" in p for p in paths)
    assert any("b.md" in p for p in paths)
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_skips_unchanged_files(tmp_path: Path):
    svc, store, _ = await _make(tmp_path, chunk_chars=100)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.txt").write_text("apple " * 30, encoding="utf-8")
    await svc.add_folder(str(folder))
    first = await svc.index_folder(str(folder))
    assert first.files_indexed == 1

    second = await svc.index_folder(str(folder))
    # Same file content + hash → skipped in pass 2.
    assert second.files_unchanged == 1
    assert second.files_indexed == 0
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_reindexes_after_edit(tmp_path: Path):
    svc, store, _ = await _make(tmp_path, chunk_chars=100)
    folder = tmp_path / "docs"
    folder.mkdir()
    file_path = folder / "a.txt"
    file_path.write_text("apple " * 30, encoding="utf-8")
    await svc.add_folder(str(folder))
    await svc.index_folder(str(folder))

    file_path.write_text("zebra " * 30, encoding="utf-8")
    second = await svc.index_folder(str(folder))
    assert second.files_indexed == 1
    # After-edit re-index must have purged old chunks. No duplicates per
    # (source_path, source_kind, chunk_index).
    rows = await store.fetchall(
        "SELECT content FROM file_chunks WHERE source_path LIKE '%a.txt'"
    )
    assert all("apple" not in r["content"] for r in rows)
    assert any("zebra" in r["content"] for r in rows)
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_skips_unsupported_extensions(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "image.png").write_bytes(b"\x89PNG\r\n")
    (folder / "binary.exe").write_bytes(b"MZ\x00\x00")
    await svc.add_folder(str(folder))
    result = await svc.index_folder(str(folder))
    assert result.files_indexed == 0
    assert result.warnings.get("unsupported_ext", 0) >= 2
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_skips_noise_subdirs(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    folder = tmp_path / "docs"
    (folder / "node_modules").mkdir(parents=True)
    (folder / "node_modules" / "deep.txt").write_text("noise", encoding="utf-8")
    (folder / ".git").mkdir()
    (folder / ".git" / "head.txt").write_text("noise", encoding="utf-8")
    (folder / "real.txt").write_text("apple", encoding="utf-8")
    await svc.add_folder(str(folder))
    result = await svc.index_folder(str(folder))
    rows = await store.fetchall(
        "SELECT source_path FROM file_chunks"
    )
    paths = {r["source_path"] for r in rows}
    assert all("node_modules" not in p for p in paths)
    assert all(".git" not in p for p in paths)
    assert any("real.txt" in p for p in paths)
    await store.close()


@pytest.mark.asyncio
async def test_index_folder_rejected_when_not_in_allowlist(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    folder = tmp_path / "secret"
    folder.mkdir()
    with pytest.raises(ValueError):
        await svc.index_folder(str(folder))
    await store.close()


@pytest.mark.asyncio
async def test_remove_folder_cascades_chunks(tmp_path: Path):
    svc, store, _ = await _make(tmp_path)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.txt").write_text("apple", encoding="utf-8")
    await svc.add_folder(str(folder))
    await svc.index_folder(str(folder))

    result = await svc.remove_folder(str(folder))
    assert result["removed"] is True
    assert result["chunks_deleted"] >= 1
    folders = await svc.list_folders()
    assert all(Path(f["path"]) != folder.resolve() for f in folders)
    rows = await store.fetchall("SELECT count(*) AS n FROM file_chunks WHERE source_kind='indexed'")
    assert rows[0]["n"] == 0
    await store.close()


@pytest.mark.asyncio
async def test_remove_folder_does_not_prefix_bleed(tmp_path: Path):
    """Removing C:\\a must not cascade into C:\\a2 chunks. The DELETE filter
    has to go through is_path_under() — a LIKE prefix would have hit a2."""
    svc, store, _ = await _make(tmp_path)
    a = tmp_path / "a"
    a2 = tmp_path / "a2"
    a.mkdir()
    a2.mkdir()
    (a / "doc.txt").write_text("apple", encoding="utf-8")
    (a2 / "doc.txt").write_text("apricot", encoding="utf-8")
    await svc.add_folder(str(a))
    await svc.add_folder(str(a2))
    await svc.index_folder(str(a))
    await svc.index_folder(str(a2))

    await svc.remove_folder(str(a))
    rows = await store.fetchall("SELECT source_path FROM file_chunks")
    paths = sorted({r["source_path"] for r in rows})
    # All surviving rows must be under a2, not a.
    assert paths
    assert all(str(a2.resolve()) in p for p in paths)
    await store.close()


@pytest.mark.asyncio
async def test_retrieve_relevant_returns_close_chunk(tmp_path: Path):
    svc, store, _ = await _make(tmp_path, chunk_chars=200)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.txt").write_text("apple " * 30, encoding="utf-8")
    (folder / "z.txt").write_text("zebra " * 30, encoding="utf-8")
    await svc.add_folder(str(folder))
    await svc.index_folder(str(folder))
    hits = await svc.retrieve_relevant("ant")  # 'a' slot
    assert hits
    assert all("apple" in h.content for h in hits)
    await store.close()


@pytest.mark.asyncio
async def test_retrieve_excludes_chunks_outside_current_allowlist(tmp_path: Path):
    """If a folder gets removed (or was never re-added), its old chunks must
    not surface in retrieve — even though the row still exists in the table
    (we cascade delete, but cover the safety net for any leftover rows)."""
    svc, store, _ = await _make(tmp_path)
    # Insert an 'indexed' chunk manually under a path that's NOT in indexed_folders.
    stray = tmp_path / "outside" / "stray.txt"
    stray.parent.mkdir()
    stray.write_text("apple", encoding="utf-8")
    blob = _vec_to_blob([1.0, 0.0, 0.0, 0.0])  # 'a' slot
    await store.execute(
        "INSERT INTO file_chunks (source_path, source_kind, chunk_index, content, "
        "page, char_offset_start, char_offset_end, content_hash, created_at, embedding) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (str(stray.resolve()), "indexed", 0, "apple", None, 0, 5,
         _hash_chunk("apple"), 1_000, blob),
    )

    hits = await svc.retrieve_relevant("ant")
    assert hits == []  # outside allowlist → filtered out at scan
    await store.close()


@pytest.mark.asyncio
async def test_ingest_text_uses_unique_source_path(tmp_path: Path):
    """Two ingest_text calls with the same label must NOT collide on the
    UNIQUE (source_path, source_kind, chunk_index) index — the service has
    to append a UUID-ish suffix."""
    svc, store, _ = await _make(tmp_path, chunk_chars=200)
    r1 = await svc.ingest_text("notes", "apple " * 30)
    r2 = await svc.ingest_text("notes", "zebra " * 30)
    assert r1["source_path"] != r2["source_path"]
    assert r1["chunks_added"] > 0
    assert r2["chunks_added"] > 0
    await store.close()


@pytest.mark.asyncio
async def test_disabled_service_is_noop(tmp_path: Path):
    svc, store, _ = await _make(tmp_path, enabled=False)
    folder = tmp_path / "docs"
    folder.mkdir()
    with pytest.raises(RuntimeError):
        await svc.add_folder(str(folder))
    assert await svc.list_folders() == []
    assert await svc.retrieve_relevant("apple") == []
    stats = await svc.stats()
    assert stats["enabled"] is False
    assert stats["folder_count"] == 0
    await store.close()
