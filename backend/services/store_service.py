"""
Singleton SQLite store for Apia.

Owns:
  - the open sqlite3 connection (WAL mode, foreign keys on, Row factory)
  - the migrations runner (lexicographic application of `store/migrations/*.sql`,
    each tracked in `schema_version` so re-runs are idempotent)
  - thin async wrappers that hand sync work to `asyncio.to_thread`, matching the
    pattern used by claude_service / tts_service / whisper_service

Does NOT own:
  - what tables exist (those live in SQL migration files — Codex review:
    schema lives in version-controlled SQL, not Python literals, so a future
    sqlite-vec migration is one file add, not a rewrite)
  - feature-specific queries (memoryService / fileIndexService own those and
    take a Store handle via dependency injection)

Concurrency model:
  - One process-wide connection. sqlite3 in WAL mode tolerates concurrent
    reader+writer without an explicit lock here. We hold a single
    `asyncio.Lock` only around writes to serialize them on the asyncio side;
    parallel reads stay unlocked.
  - All sync DB calls go through `asyncio.to_thread` so the event loop never
    blocks on disk.

Lifecycle:
  - Created at FastAPI startup (see main.py lifespan). `initialize()` opens
    the DB and applies pending migrations. Safe to call repeatedly.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

logger = logging.getLogger(__name__)

# Migration files live here. Layout: backend/store/migrations/NNN_*.sql
_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "store" / "migrations"


class StoreService:
    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._conn: sqlite3.Connection | None = None
        self._init_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._initialized = False

    @property
    def db_path(self) -> Path:
        return self._db_path

    async def initialize(self) -> None:
        async with self._init_lock:
            if self._initialized:
                return
            await asyncio.to_thread(self._initialize_sync)
            self._initialized = True

    def _initialize_sync(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False so asyncio.to_thread (which can run callbacks
        # on different worker threads) can reuse the same connection. WAL mode
        # makes that safe for concurrent read/write at the SQLite level.
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        self._conn = conn
        self._ensure_version_table()
        self._apply_pending_migrations()

    def _ensure_version_table(self) -> None:
        assert self._conn is not None
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                version    INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )
            """
        )
        self._conn.commit()

    def _applied_versions(self) -> set[int]:
        assert self._conn is not None
        return {row["version"] for row in self._conn.execute("SELECT version FROM schema_version")}

    def _discover_migrations(self) -> list[tuple[int, Path]]:
        if not _MIGRATIONS_DIR.is_dir():
            return []
        out: list[tuple[int, Path]] = []
        for path in sorted(_MIGRATIONS_DIR.glob("*.sql")):
            # filename pattern: NNN_label.sql. Parse N as an int; anything
            # that doesn't parse is skipped with a warning rather than
            # crashing migrations on stray files.
            stem = path.stem
            head, _, _ = stem.partition("_")
            try:
                version = int(head)
            except ValueError:
                logger.warning("[store] skipping migration with unparseable name: %s", path.name)
                continue
            out.append((version, path))
        return out

    def _apply_pending_migrations(self) -> None:
        assert self._conn is not None
        applied = self._applied_versions()
        for version, path in self._discover_migrations():
            if version in applied:
                continue
            logger.info("[store] applying migration %s", path.name)
            sql = path.read_text(encoding="utf-8")
            self._apply_one_migration(version, sql)

    def _apply_one_migration(self, version: int, sql: str) -> None:
        """Apply a single migration *atomically*. Naive `executescript(sql)`
        followed by an INSERT does NOT compose: sqlite3's executescript
        issues an implicit COMMIT before the script runs, so a failure inside
        the script can leave half-applied DDL with no transaction to roll
        back into. Codex MUST-FIX.

        We wrap the migration body + the version row in one explicit
        BEGIN…COMMIT block executed via executescript, so the whole thing is
        a single atomic transaction. If it raises, we try a best-effort
        ROLLBACK (it may or may not still be open, depending on where in the
        script the failure landed).
        """
        assert self._conn is not None
        applied_at = int(time.time() * 1000)
        # Quote the integer so SQL parses cleanly; we control `version` (it
        # came from a filename int conversion), so concatenation here is safe.
        wrapped = (
            "BEGIN;\n"
            f"{sql}\n"
            "INSERT INTO schema_version (version, applied_at) "
            f"VALUES ({int(version)}, {applied_at});\n"
            "COMMIT;\n"
        )
        try:
            self._conn.executescript(wrapped)
        except sqlite3.DatabaseError:
            try:
                self._conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                # "cannot rollback - no transaction is active" — the failure
                # happened after the script already committed something, or
                # the BEGIN itself failed. Either way there's nothing to
                # undo here.
                pass
            raise

    # ── async query helpers ────────────────────────────────────────────────

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        await self.initialize()
        return await asyncio.to_thread(self._fetchall_sync, sql, params)

    def _fetchall_sync(self, sql: str, params: Sequence[Any]) -> list[sqlite3.Row]:
        assert self._conn is not None
        cur = self._conn.execute(sql, params)
        try:
            return cur.fetchall()
        finally:
            cur.close()

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        await self.initialize()
        return await asyncio.to_thread(self._fetchone_sync, sql, params)

    def _fetchone_sync(self, sql: str, params: Sequence[Any]) -> sqlite3.Row | None:
        assert self._conn is not None
        cur = self._conn.execute(sql, params)
        try:
            return cur.fetchone()
        finally:
            cur.close()

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run a single INSERT/UPDATE/DELETE. Returns lastrowid for INSERT,
        else rowcount. Serializes writes through `_write_lock` so two callers
        don't trample each other's lastrowid."""
        await self.initialize()
        async with self._write_lock:
            return await asyncio.to_thread(self._execute_sync, sql, params)

    def _execute_sync(self, sql: str, params: Sequence[Any]) -> int:
        assert self._conn is not None
        cur = self._conn.execute(sql, params)
        try:
            self._conn.commit()
            return cur.lastrowid if cur.lastrowid is not None else cur.rowcount
        finally:
            cur.close()

    async def executemany(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> int:
        await self.initialize()
        async with self._write_lock:
            return await asyncio.to_thread(self._executemany_sync, sql, list(seq_of_params))

    def _executemany_sync(self, sql: str, params_list: list[Sequence[Any]]) -> int:
        assert self._conn is not None
        cur = self._conn.executemany(sql, params_list)
        try:
            self._conn.commit()
            return cur.rowcount
        finally:
            cur.close()

    async def execute_script(
        self, statements: Iterable[tuple[str, Sequence[Any]]]
    ) -> None:
        """Run multiple parameterized SQL statements atomically.

        Used by per-file reindex: DELETE stale chunks for a path, then INSERT
        the new chunks, all-or-nothing. If any statement raises, ROLLBACK is
        attempted and the original error bubbles up.

        Codex MUST-FIX (step 3 round 2): MUST run inside `_write_lock` so a
        concurrent caller can't slip an unrelated commit between our BEGIN and
        COMMIT (sqlite3's autocommit boundary). Also MUST use explicit
        `BEGIN` + statement-by-statement execute + `COMMIT`/`ROLLBACK` —
        `executescript` strips parameters, so we can't shove `(?, ?, ?)` args
        through it; the textual concatenation fallback was a SQL-injection
        magnet that we are not introducing.
        """
        await self.initialize()
        statements_list = list(statements)
        async with self._write_lock:
            await asyncio.to_thread(self._execute_script_sync, statements_list)

    def _execute_script_sync(
        self, statements_list: list[tuple[str, Sequence[Any]]]
    ) -> None:
        assert self._conn is not None
        self._conn.execute("BEGIN")
        try:
            for sql, params in statements_list:
                cur = self._conn.execute(sql, params)
                cur.close()
        except Exception:
            try:
                self._conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            raise
        else:
            self._conn.commit()

    # ── lifecycle ───────────────────────────────────────────────────────────

    async def close(self) -> None:
        if self._conn is None:
            return
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        assert self._conn is not None
        self._conn.close()
        self._conn = None
        self._initialized = False
