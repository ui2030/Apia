"""
File search / indexing service (step 3).

Owns:
  - the indexed_folders allowlist (only folders the user explicitly authorized
    get walked; *any* path passed through retrieve/index is rejected unless
    it resolves under one of those folders)
  - text extraction for TXT / MD / PDF (PDF is graceful-skip when pypdf is
    missing — we don't make pdf parsing a hard runtime dep)
  - chunking (char-based, configurable size + overlap)
  - per-file atomic reindex: DELETE old chunks for the path, INSERT the new
    set inside one transaction (StoreService.execute_script) so a crash
    mid-file can't leave a half-written chunk pile
  - drag-and-drop ingestion (ingest_text) — the user pastes/drops a snippet
    and it lands in file_chunks with source_kind='dropped' and a UUID label

Does NOT own:
  - calling the embedding model (delegates to EmbeddingService)
  - persistence shape (delegates to StoreService + 001/002 migrations)

Security notes (Codex MUST-FIX rounds 1-2):
  - allowlist check uses `Path.resolve().is_relative_to()` not string prefix.
    Prefix matching lets `C:\\a` match `C:\\a2` and gets bypassed by `..`
    or symlinks. `resolve()` collapses both before comparison.
  - `add_folder` rejects an overlap with an existing entry (parent OR child).
    Otherwise a cascade delete on `C:\\a` would silently take `C:\\a\\b`'s
    chunks too, and allowlist semantics get muddled.
  - `remove_folder` cascades to `file_chunks` BUT filters with
    `is_path_under()` on every candidate row — DELETE-by-LIKE could prefix-
    bleed into unrelated paths.
  - `retrieve_relevant` applies the same allowlist filter at scan time so a
    row written before the allowlist changed can never resurface in chat
    context.

Concurrency:
  - `_folder_lock` serializes index/remove on the same folder so concurrent
    reindex requests can't both rewrite the same chunk row.
  - per-file work is one execute_script transaction; cross-file rollback is
    not attempted (one bad file shouldn't fail the whole folder run).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence

from services.embedding_service import (
    EmbeddingService,
    blob_to_vec,
    cosine_similarity,
)
from services.store_service import StoreService

logger = logging.getLogger(__name__)

# Directory names to skip when walking an indexed folder. Build outputs and
# VCS metadata produce massive low-signal trees that blow up indexing time
# and pollute search results. Codex NICE-TO-HAVE round 1.
_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn",
    "node_modules", "__pycache__",
    ".venv", "venv", "env",
    "dist", "build",
    ".next", ".nuxt", ".cache",
    ".idea", ".vscode",
})

_SUPPORTED_TEXT_EXTS = frozenset({".txt", ".md", ".markdown", ".rst", ".log"})
_PDF_EXTS = frozenset({".pdf"})


@dataclass
class FileRecall:
    """One ranked recall result from file_chunks. Kept loose so callers can
    decide how to render — chat builds a body string for context, future
    citation logic (step 4) consumes source_path/page directly."""
    content: str
    score: float
    source_path: str
    source_kind: str
    chunk_index: int
    page: Optional[int]
    chunk_id: int


@dataclass
class IndexResult:
    """One indexing pass over a folder."""
    folder: str
    files_seen: int = 0
    files_indexed: int = 0
    files_unchanged: int = 0
    chunks_added: int = 0
    files_failed: int = 0
    warnings: dict = field(default_factory=dict)

    def warn(self, key: str) -> None:
        self.warnings[key] = self.warnings.get(key, 0) + 1


def is_path_under(child: Path, parent: Path) -> bool:
    """resolve() + is_relative_to() avoids string-prefix bypass and symlinks.

    Used by both the allowlist gate (is this file allowed to be indexed?) and
    the cascade-delete filter (is this stored chunk under the folder being
    removed?). Codex MUST-FIX rounds 1-2.
    """
    try:
        return Path(child).resolve().is_relative_to(Path(parent).resolve())
    except (OSError, ValueError):
        return False


def _hash_chunk(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _chunk_text(text: str, size: int, overlap: int) -> List[str]:
    """Character-based chunker. Python str slicing is codepoint-safe (no UTF-8
    mid-byte split) so multi-byte CJK text is fine. Overlap > 0 keeps semantic
    bridges across chunk boundaries.

    Empty/whitespace text returns []. Single chunk shorter than `size` is
    returned as-is.
    """
    text = text.strip()
    if not text:
        return []
    size = max(64, size)
    overlap = max(0, min(overlap, size - 1))
    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = end - overlap
    return chunks


def _read_text_file(path: Path, max_bytes: int) -> Optional[str]:
    """Read a TXT/MD-like file as UTF-8 with errors='replace'. Refuses files
    over the byte cap to keep one huge log from dominating the index."""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > max_bytes:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _read_pdf_pages(path: Path, max_bytes: int) -> Optional[List[str]]:
    """Return a list of per-page text strings, or None on failure / unsupported.

    Page-level extraction (Codex NICE-TO-HAVE 3단계 round 1) so we can keep
    chunks single-page — file_chunks.page is unambiguous and step 4 citations
    can show a precise page number.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > max_bytes:
        return None
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        logger.info("[files] pypdf not installed — skipping %s", path)
        return None
    try:
        reader = PdfReader(str(path))
    except Exception as error:  # noqa: BLE001 — vendor lib boundary
        logger.warning("[files] pdf open failed (%s): %s", path, error)
        return None
    pages: List[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception as error:  # noqa: BLE001
            logger.warning("[files] pdf page extract failed (%s): %s", path, error)
            pages.append("")
    return pages


class FileIndexService:
    def __init__(
        self,
        store: StoreService,
        embedding: EmbeddingService,
        enabled: bool = True,
        chunk_chars: int = 1000,
        chunk_overlap: int = 200,
        max_file_bytes: int = 5 * 1024 * 1024,
        max_files_per_folder: int = 5000,
        retrieve_top_k: int = 4,
        min_score: float = 0.55,
    ) -> None:
        self._store = store
        self._embedding = embedding
        self._enabled = enabled
        self._chunk_chars = max(64, chunk_chars)
        self._chunk_overlap = max(0, min(chunk_overlap, self._chunk_chars - 1))
        self._max_file_bytes = max_file_bytes
        self._max_files_per_folder = max_files_per_folder
        self._top_k = max(1, retrieve_top_k)
        self._min_score = min_score
        # 폴더별 lock. 동시 index/remove를 직렬화. resolved 절대경로 문자열을 key로.
        self._folder_locks: dict[str, asyncio.Lock] = {}
        self._lifetime_warnings: dict[str, int] = {}
        self._last_error: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    # ── allowlist ─────────────────────────────────────────────────────────

    async def list_folders(self) -> List[dict]:
        rows = await self._store.fetchall(
            "SELECT id, path, added_at, last_indexed_at FROM indexed_folders "
            "ORDER BY id"
        )
        return [
            {
                "id": int(r["id"]),
                "path": r["path"],
                "added_at": int(r["added_at"]),
                "last_indexed_at": (
                    int(r["last_indexed_at"]) if r["last_indexed_at"] is not None else None
                ),
            }
            for r in rows
        ]

    async def add_folder(self, path: str) -> dict:
        """등록. 절대경로로 정규화 후 indexed_folders INSERT.

        Codex MUST-FIX round 2: 기존 등록과 부모/자식 겹침이면 거부. 그래야
        cascade delete 시 부모를 지우면서 자식 폴더의 chunk를 같이 날리거나
        allowlist 검사가 모호해지지 않는다.
        """
        if not self._enabled:
            raise RuntimeError("file indexing disabled")
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_dir():
            raise FileNotFoundError(f"not a directory: {resolved}")

        existing = await self.list_folders()
        for entry in existing:
            other = Path(entry["path"])
            if resolved == other:
                return {"id": entry["id"], "path": str(resolved), "status": "exists"}
            if is_path_under(resolved, other) or is_path_under(other, resolved):
                raise ValueError(
                    f"folder overlaps existing entry: {other}"
                )

        now = int(time.time() * 1000)
        folder_id = await self._store.execute(
            "INSERT INTO indexed_folders (path, added_at) VALUES (?, ?)",
            (str(resolved), now),
        )
        return {"id": int(folder_id), "path": str(resolved), "status": "added"}

    async def remove_folder(self, path: str) -> dict:
        """cascade delete: indexed_folders 행 + 그 폴더 하위의 indexed file_chunks.

        Codex MUST-FIX round 2: LIKE prefix는 `C:\\a`가 `C:\\a2`를 잡으므로
        후보 row를 id+path 로 조회한 다음 application 레벨에서
        `is_path_under()`로 필터해서 DELETE.
        """
        if not self._enabled:
            return {"removed": False, "chunks_deleted": 0}
        resolved = Path(path).expanduser().resolve()
        async with self._folder_lock_for(str(resolved)):
            folder_row = await self._store.fetchone(
                "SELECT id FROM indexed_folders WHERE path = ?",
                (str(resolved),),
            )
            if folder_row is None:
                return {"removed": False, "chunks_deleted": 0}

            candidate_rows = await self._store.fetchall(
                "SELECT id, source_path FROM file_chunks "
                "WHERE source_kind = 'indexed'"
            )
            doomed_ids = [
                int(r["id"]) for r in candidate_rows
                if is_path_under(Path(r["source_path"]), resolved)
            ]

            statements: list[tuple[str, Sequence]] = [
                ("DELETE FROM indexed_folders WHERE id = ?", (int(folder_row["id"]),)),
            ]
            statements.extend(
                ("DELETE FROM file_chunks WHERE id = ?", (chunk_id,))
                for chunk_id in doomed_ids
            )
            await self._store.execute_script(statements)
            return {"removed": True, "chunks_deleted": len(doomed_ids)}

    async def is_allowed(self, path: Path) -> bool:
        folders = await self.list_folders()
        for entry in folders:
            if is_path_under(path, Path(entry["path"])):
                return True
        return False

    # ── indexing ──────────────────────────────────────────────────────────

    async def index_folder(self, path: str, *, force: bool = False) -> IndexResult:
        """폴더 walk → 각 파일을 자기 트랜잭션으로 reindex."""
        if not self._enabled:
            return IndexResult(folder=path)
        resolved = Path(path).expanduser().resolve()
        # 등록된 폴더 중 하나여야 함.
        folders = await self.list_folders()
        match = next(
            (f for f in folders if Path(f["path"]) == resolved),
            None,
        )
        if match is None:
            raise ValueError(f"folder not in allowlist: {resolved}")

        result = IndexResult(folder=str(resolved))
        async with self._folder_lock_for(str(resolved)):
            for file_path in self._walk(resolved, result):
                result.files_seen += 1
                if result.files_seen > self._max_files_per_folder:
                    result.warn("max_files_per_folder")
                    break
                try:
                    indexed, n_chunks = await self._reindex_file(file_path, force=force)
                except Exception as error:  # noqa: BLE001 — per-file boundary
                    self._record_warn(result, "files_failed")
                    self._last_error = (
                        f"index_file: {type(error).__name__}: {error}"
                    )
                    logger.exception("[files] index_file failed: %s", file_path)
                    result.files_failed += 1
                    continue
                if indexed:
                    result.files_indexed += 1
                    result.chunks_added += n_chunks
                else:
                    result.files_unchanged += 1

            await self._store.execute(
                "UPDATE indexed_folders SET last_indexed_at = ? WHERE id = ?",
                (int(time.time() * 1000), int(match["id"])),
            )
        return result

    async def ingest_text(self, label: str, text: str) -> dict:
        """사용자가 드롭한 텍스트를 file_chunks(source_kind='dropped')로 저장.

        Codex MUST-FIX round 2: source_path는 라벨이 아니라 항상 unique한
        식별자(`dropped:<uuid>`). 라벨은 별도 표시용으로 만 — 같은 라벨로
        두 번 ingest 해도 UNIQUE 충돌 없음.
        """
        if not self._enabled:
            return {"chunks_added": 0, "source_path": None}
        text = text.strip()
        if not text:
            return {"chunks_added": 0, "source_path": None}
        source_path = f"dropped:{label}:{uuid.uuid4().hex[:12]}"
        chunks = _chunk_text(text, self._chunk_chars, self._chunk_overlap)
        now = int(time.time() * 1000)
        added = await self._insert_chunks(
            source_path=source_path,
            source_kind="dropped",
            chunks=chunks,
            now=now,
            existing_purge=False,  # dropped는 매번 새 source_path라 purge 무의미
            page_for_chunk=None,
        )
        return {"chunks_added": added, "source_path": source_path}

    # ── retrieval ─────────────────────────────────────────────────────────

    async def retrieve_relevant(
        self,
        query: str,
        top_k: Optional[int] = None,
        min_score: Optional[float] = None,
    ) -> List[FileRecall]:
        """file_chunks 전수 스캔 → cosine top_k. allowlist 외 indexed 행은 제외."""
        if not self._enabled or not query.strip():
            return []
        k = top_k if top_k is not None else self._top_k
        floor = min_score if min_score is not None else self._min_score
        try:
            query_blob = await self._embedding.embed_one(query)
        except Exception as error:  # noqa: BLE001
            self._last_error = f"retrieve_embed: {type(error).__name__}: {error}"
            logger.warning("[files] query embed failed: %s", error)
            return []
        expected = self._embedding.dim * 4
        if len(query_blob) != expected:
            self._last_error = (
                f"retrieve_embed dim mismatch: blob={len(query_blob)} expected={expected}"
            )
            return []

        folders = await self.list_folders()
        allowed_paths = [Path(f["path"]) for f in folders]
        rows = await self._store.fetchall(
            "SELECT id, source_path, source_kind, chunk_index, content, page, embedding "
            "FROM file_chunks WHERE embedding IS NOT NULL"
        )
        return await asyncio.to_thread(
            self._rank_rows, query_blob, rows, allowed_paths, k, floor
        )

    # ── stats / state ─────────────────────────────────────────────────────

    async def stats(self) -> dict:
        if not self._enabled:
            return {
                "enabled": False,
                "folder_count": 0,
                "chunk_count": 0,
                "indexed_count": 0,
                "dropped_count": 0,
                "warnings": dict(self._lifetime_warnings),
                "last_error": None,
            }
        folder_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM indexed_folders"
        )
        chunk_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM file_chunks"
        )
        indexed_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM file_chunks WHERE source_kind = 'indexed'"
        )
        dropped_row = await self._store.fetchone(
            "SELECT count(*) AS n FROM file_chunks WHERE source_kind = 'dropped'"
        )
        return {
            "enabled": True,
            "folder_count": int(folder_row["n"]) if folder_row else 0,
            "chunk_count": int(chunk_row["n"]) if chunk_row else 0,
            "indexed_count": int(indexed_row["n"]) if indexed_row else 0,
            "dropped_count": int(dropped_row["n"]) if dropped_row else 0,
            "warnings": dict(self._lifetime_warnings),
            "last_error": self._last_error,
        }

    # ── internals ─────────────────────────────────────────────────────────

    def _folder_lock_for(self, key: str) -> asyncio.Lock:
        lock = self._folder_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._folder_locks[key] = lock
        return lock

    def _walk(self, root: Path, result: IndexResult):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                if name.startswith("."):
                    continue
                full = Path(dirpath) / name
                ext = full.suffix.lower()
                if ext not in _SUPPORTED_TEXT_EXTS and ext not in _PDF_EXTS:
                    self._record_warn(result, "unsupported_ext")
                    continue
                # 보안 검증 (paranoid): walk 결과가 root 밖이면 (symlink 등) 거부.
                if not is_path_under(full, root):
                    self._record_warn(result, "outside_root")
                    continue
                yield full

    def _record_warn(self, result: IndexResult, key: str) -> None:
        result.warn(key)
        self._lifetime_warnings[key] = self._lifetime_warnings.get(key, 0) + 1

    async def _reindex_file(self, path: Path, *, force: bool) -> tuple[bool, int]:
        """단일 파일 인덱싱. (indexed, n_chunks). 변경 없으면 (False, 0)."""
        ext = path.suffix.lower()
        if ext in _PDF_EXTS:
            pages = _read_pdf_pages(path, self._max_file_bytes)
            if pages is None:
                return False, 0
            return await self._reindex_pdf(path, pages, force=force)
        if ext in _SUPPORTED_TEXT_EXTS:
            text = _read_text_file(path, self._max_file_bytes)
            if text is None:
                return False, 0
            return await self._reindex_text(path, text, force=force)
        return False, 0

    async def _reindex_text(self, path: Path, text: str, *, force: bool) -> tuple[bool, int]:
        chunks = _chunk_text(text, self._chunk_chars, self._chunk_overlap)
        return await self._upsert_chunks_for_path(
            str(path), "indexed", chunks, force=force, page_for_chunk=None
        )

    async def _reindex_pdf(self, path: Path, pages: List[str], *, force: bool) -> tuple[bool, int]:
        """페이지별로 청킹 후 한 source_path 트랜잭션으로 일괄 reindex.

        page_for_chunk: chunk_index → page 번호 매핑(1-based). 청크가 한 페이지
        안에서만 형성되므로 ambiguity 없음.
        """
        chunks: List[str] = []
        page_for_chunk: dict[int, int] = {}
        for page_no, page_text in enumerate(pages, start=1):
            page_chunks = _chunk_text(page_text, self._chunk_chars, self._chunk_overlap)
            for chunk in page_chunks:
                page_for_chunk[len(chunks)] = page_no
                chunks.append(chunk)
        return await self._upsert_chunks_for_path(
            str(path), "indexed", chunks, force=force, page_for_chunk=page_for_chunk
        )

    async def _upsert_chunks_for_path(
        self,
        source_path: str,
        source_kind: str,
        new_chunks: List[str],
        *,
        force: bool,
        page_for_chunk: Optional[dict[int, int]],
    ) -> tuple[bool, int]:
        """force=False면 (chunk_index, content_hash) 일치 시 임베딩 재계산 없이 skip.

        force=True 또는 변경 감지되면 해당 source_path의 기존 청크를 모두 DELETE
        하고 새 청크를 INSERT — 한 트랜잭션(execute_script)으로.
        """
        # 기존 청크 (id, chunk_index, content_hash) 조회.
        rows = await self._store.fetchall(
            "SELECT id, chunk_index, content_hash FROM file_chunks "
            "WHERE source_path = ? AND source_kind = ? "
            "ORDER BY chunk_index",
            (source_path, source_kind),
        )
        existing = {int(r["chunk_index"]): r["content_hash"] for r in rows}

        if not force and len(existing) == len(new_chunks):
            # chunk_index별 hash 비교.
            unchanged = all(
                existing.get(i) == _hash_chunk(c)
                for i, c in enumerate(new_chunks)
            )
            if unchanged:
                return False, 0

        # 변경 또는 force: 기존 다 지우고 새로 쓰기. 한 트랜잭션.
        now = int(time.time() * 1000)
        # 임베딩 일괄 계산 (긴 리스트라도 한 번에).
        try:
            blobs = await self._embedding.embed(new_chunks) if new_chunks else []
        except Exception as error:  # noqa: BLE001
            self._last_error = f"embed: {type(error).__name__}: {error}"
            logger.warning("[files] embed failed for %s: %s", source_path, error)
            blobs = [None] * len(new_chunks)
        expected = self._embedding.dim * 4

        statements: list[tuple[str, Sequence]] = [
            (
                "DELETE FROM file_chunks WHERE source_path = ? AND source_kind = ?",
                (source_path, source_kind),
            ),
        ]
        for i, chunk in enumerate(new_chunks):
            blob = blobs[i] if i < len(blobs) else None
            if blob is not None and len(blob) != expected:
                logger.warning(
                    "[files] chunk %d of %s embed dim mismatch — storing NULL",
                    i, source_path,
                )
                blob = None
            page = page_for_chunk.get(i) if page_for_chunk else None
            chunk_hash = _hash_chunk(chunk)
            statements.append((
                "INSERT INTO file_chunks "
                "(source_path, source_kind, chunk_index, content, page, "
                " char_offset_start, char_offset_end, content_hash, "
                " created_at, embedding) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    source_path, source_kind, i, chunk, page,
                    0, len(chunk), chunk_hash, now, blob,
                ),
            ))
        await self._store.execute_script(statements)
        return True, len(new_chunks)

    async def _insert_chunks(
        self,
        *,
        source_path: str,
        source_kind: str,
        chunks: List[str],
        now: int,
        existing_purge: bool,
        page_for_chunk: Optional[dict[int, int]],
    ) -> int:
        if not chunks:
            return 0
        try:
            blobs = await self._embedding.embed(chunks)
        except Exception as error:  # noqa: BLE001
            self._last_error = f"embed: {type(error).__name__}: {error}"
            logger.warning("[files] embed failed for %s: %s", source_path, error)
            blobs = [None] * len(chunks)
        expected = self._embedding.dim * 4

        statements: list[tuple[str, Sequence]] = []
        if existing_purge:
            statements.append((
                "DELETE FROM file_chunks WHERE source_path = ? AND source_kind = ?",
                (source_path, source_kind),
            ))
        for i, chunk in enumerate(chunks):
            blob = blobs[i] if i < len(blobs) else None
            if blob is not None and len(blob) != expected:
                blob = None
            page = page_for_chunk.get(i) if page_for_chunk else None
            statements.append((
                "INSERT INTO file_chunks "
                "(source_path, source_kind, chunk_index, content, page, "
                " char_offset_start, char_offset_end, content_hash, "
                " created_at, embedding) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    source_path, source_kind, i, chunk, page,
                    0, len(chunk), _hash_chunk(chunk), now, blob,
                ),
            ))
        await self._store.execute_script(statements)
        return len(chunks)

    def _rank_rows(
        self,
        query_blob: bytes,
        rows: Sequence,
        allowed_paths: Sequence[Path],
        top_k: int,
        floor: float,
    ) -> List[FileRecall]:
        try:
            query_vec = blob_to_vec(query_blob)
        except ValueError:
            return []
        expected_dim = self._embedding.dim

        scored: List[FileRecall] = []
        for row in rows:
            kind = row["source_kind"]
            source_path = row["source_path"]
            if kind == "indexed":
                # allowlist 외 인덱스 row는 제외 (Codex MUST-FIX round 1).
                if not any(is_path_under(Path(source_path), p) for p in allowed_paths):
                    continue
            try:
                vec = blob_to_vec(row["embedding"])
                if len(vec) != expected_dim:
                    logger.warning(
                        "[files] skip chunk id=%s due to dim=%d != expected=%d",
                        row["id"], len(vec), expected_dim,
                    )
                    continue
                score = cosine_similarity(query_vec, vec)
            except ValueError as error:
                logger.warning("[files] skip chunk id=%s due to %s", row["id"], error)
                continue
            if score < floor:
                continue
            scored.append(FileRecall(
                content=row["content"],
                score=score,
                source_path=source_path,
                source_kind=kind,
                chunk_index=int(row["chunk_index"]),
                page=(int(row["page"]) if row["page"] is not None else None),
                chunk_id=int(row["id"]),
            ))
        scored.sort(key=lambda r: r.score, reverse=True)
        return scored[:top_k]
