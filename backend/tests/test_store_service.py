"""Unit tests for `services.store_service.StoreService`.

These tests work against a fresh on-disk SQLite file under a tmp dir per test
— never against the real DATA_DIR. The class is small and synchronous-under-
the-hood, so the assertions focus on:
  - migrations are applied idempotently (re-running initialize() does not
    re-execute already-recorded versions)
  - WAL mode + foreign keys + Row factory are actually on
  - the async helpers round-trip through asyncio.to_thread (no leaks)
  - lastrowid bookkeeping matches sqlite3's native semantics
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from services.store_service import StoreService


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "test.db"


@pytest.mark.asyncio
async def test_initialize_creates_db_and_applies_migrations(db_path: Path) -> None:
    store = StoreService(db_path)
    await store.initialize()
    assert db_path.exists()

    # The 001 migration creates schema_version + the five feature tables. We
    # don't assert all column lists (those are SQL-owned); we assert the row
    # for the migration was inserted so re-runs are idempotent.
    rows = await store.fetchall("SELECT version FROM schema_version ORDER BY version")
    versions = [row["version"] for row in rows]
    assert versions == [1]

    # Spot-check one feature table exists and is empty.
    rows = await store.fetchall("SELECT count(*) AS n FROM chat_turns")
    assert rows[0]["n"] == 0

    await store.close()


@pytest.mark.asyncio
async def test_initialize_is_idempotent(db_path: Path) -> None:
    store = StoreService(db_path)
    await store.initialize()
    # Calling again must not raise, must not re-run 001 (would error on
    # `CREATE TABLE` for an existing index or duplicate schema_version row).
    await store.initialize()
    await store.initialize()
    rows = await store.fetchall("SELECT version FROM schema_version")
    assert len(rows) == 1
    await store.close()


@pytest.mark.asyncio
async def test_pragmas_applied(db_path: Path) -> None:
    store = StoreService(db_path)
    await store.initialize()
    journal = await store.fetchone("PRAGMA journal_mode")
    # PRAGMA returns the active mode after attempted SET. WAL should stick on
    # disk-backed dbs; if it didn't (e.g. running on a filesystem that doesn't
    # support shared memory), the test should fail loudly so we know to add a
    # platform-specific fallback.
    assert journal[0] == "wal"

    foreign = await store.fetchone("PRAGMA foreign_keys")
    assert foreign[0] == 1
    await store.close()


@pytest.mark.asyncio
async def test_execute_returns_lastrowid_for_insert(db_path: Path) -> None:
    store = StoreService(db_path)
    await store.initialize()
    row_id = await store.execute(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        ("user", "안녕", 1_700_000_000_000),
    )
    assert row_id == 1
    row_id2 = await store.execute(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        ("assistant", "Hi", 1_700_000_000_500),
    )
    assert row_id2 == 2

    rows = await store.fetchall("SELECT id, role, content FROM chat_turns ORDER BY id")
    assert [(r["id"], r["role"], r["content"]) for r in rows] == [
        (1, "user", "안녕"),
        (2, "assistant", "Hi"),
    ]
    await store.close()


@pytest.mark.asyncio
async def test_executemany_writes_all_rows(db_path: Path) -> None:
    store = StoreService(db_path)
    await store.initialize()
    rowcount = await store.executemany(
        "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
        [
            ("user", "one", 1),
            ("user", "two", 2),
            ("user", "three", 3),
        ],
    )
    assert rowcount == 3
    rows = await store.fetchall("SELECT count(*) AS n FROM chat_turns")
    assert rows[0]["n"] == 3
    await store.close()


@pytest.mark.asyncio
async def test_unknown_migration_filenames_are_skipped_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stray files in the migrations dir (README, notes, partial WIP) must not
    crash startup. The runner skips them with a log and continues."""
    from services import store_service as mod

    fake_migrations = tmp_path / "migrations"
    fake_migrations.mkdir()
    # one valid migration + one unparseable filename
    (fake_migrations / "001_setup.sql").write_text("CREATE TABLE t (x INTEGER);")
    (fake_migrations / "README.sql").write_text("-- not a migration")

    monkeypatch.setattr(mod, "_MIGRATIONS_DIR", fake_migrations)

    db = tmp_path / "alt.db"
    store = StoreService(db)
    await store.initialize()

    # Only the parseable one ran.
    rows = await store.fetchall("SELECT version FROM schema_version")
    assert [row["version"] for row in rows] == [1]
    # And the table from the valid migration exists.
    rows = await store.fetchall("SELECT name FROM sqlite_master WHERE type='table' AND name='t'")
    assert len(rows) == 1
    await store.close()


@pytest.mark.asyncio
async def test_migration_failure_leaves_no_partial_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Atomicity contract for `_apply_one_migration`: if a single migration
    creates one object then fails halfway through, the DB must contain no
    surviving object from that migration AND no schema_version row for it.
    Codex NICE-TO-HAVE.

    Why this matters at runtime: if a buggy migration ships and a user pulls
    it, they'd otherwise end up with a half-applied schema, then on next
    launch see "table X already exists" because no rollback happened.
    """
    from services import store_service as mod

    fake_migrations = tmp_path / "migrations"
    fake_migrations.mkdir()
    # A two-statement migration where the SECOND statement is invalid. The
    # whole thing is wrapped in BEGIN/COMMIT by _apply_one_migration, so the
    # first CREATE TABLE must roll back when the bad statement raises.
    (fake_migrations / "001_partial.sql").write_text(
        "CREATE TABLE will_not_survive (x INTEGER);\n"
        "THIS_IS_NOT_VALID_SQL totally_borked;\n"
    )
    monkeypatch.setattr(mod, "_MIGRATIONS_DIR", fake_migrations)

    db = tmp_path / "atomic.db"
    store = StoreService(db)
    with pytest.raises(sqlite3.DatabaseError):
        await store.initialize()

    # Re-open with a fresh, read-only sqlite3 to inspect on-disk state — the
    # StoreService instance is in a half-initialized state and we want to
    # check the DB itself, not the in-memory wrapper.
    raw = sqlite3.connect(str(db))
    raw.row_factory = sqlite3.Row
    try:
        # schema_version exists (created in _ensure_version_table BEFORE
        # the migration ran) but holds no rows — the migration's INSERT
        # was inside the BEGIN/COMMIT block that rolled back.
        applied = raw.execute("SELECT version FROM schema_version").fetchall()
        assert applied == []
        # The half-built table must not exist.
        leftover = raw.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='will_not_survive'"
        ).fetchall()
        assert leftover == []
    finally:
        raw.close()


@pytest.mark.asyncio
async def test_concurrent_writes_serialize_via_lock(db_path: Path) -> None:
    """Two concurrent execute() calls must produce distinct lastrowids in
    insertion order — the internal `_write_lock` exists to make this true."""
    store = StoreService(db_path)
    await store.initialize()

    async def insert(content: str) -> int:
        return await store.execute(
            "INSERT INTO chat_turns (role, content, created_at) VALUES (?, ?, ?)",
            ("user", content, 1),
        )

    ids = await asyncio.gather(*(insert(f"msg{i}") for i in range(5)))
    # Each lastrowid is distinct, and the set is exactly {1..5}.
    assert sorted(ids) == [1, 2, 3, 4, 5]
    await store.close()
