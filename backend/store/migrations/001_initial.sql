-- Initial Apia data schema. Shared by long-term memory, file understanding,
-- and web search citations. Designed so each downstream feature can land in a
-- later migration without rewriting earlier tables.
--
-- Storage choices:
--   - embeddings stored as raw BLOB (little-endian float32 array). No vector
--     extension required (sqlite-vec / sqlite-vss bundle awkwardly under
--     PyInstaller). Retrieval scans rows + cosine similarity in numpy. For
--     personal-scale data (≤ tens of thousands of chunks) this is fast enough.
--     If we outgrow it, swap the retrieval helper without changing schema.
--   - timestamps are Unix milliseconds (INTEGER) — matches what Electron's
--     Date.now() emits, no timezone ambiguity.
--   - source_kind is a discriminator so a single citations row can point at a
--     file chunk, a web result, or a memory summary uniformly.

CREATE TABLE IF NOT EXISTS chat_turns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role          TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content       TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    embedding     BLOB
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_created
    ON chat_turns(created_at);

-- Summaries cover a contiguous range of chat_turns rows. Built every N turns
-- by the memory service. Long-range recall prefers summaries over raw turns.
CREATE TABLE IF NOT EXISTS conversation_summaries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    start_turn_id INTEGER NOT NULL,
    end_turn_id   INTEGER NOT NULL,
    summary       TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    embedding     BLOB,
    FOREIGN KEY (start_turn_id) REFERENCES chat_turns(id),
    FOREIGN KEY (end_turn_id)   REFERENCES chat_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_summaries_range
    ON conversation_summaries(start_turn_id, end_turn_id);

-- One row per folder the user has allowed for indexing. Allow-listed at the
-- service boundary — the indexer never walks anything not in this table.
CREATE TABLE IF NOT EXISTS indexed_folders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    path             TEXT    NOT NULL UNIQUE,
    added_at         INTEGER NOT NULL,
    last_indexed_at  INTEGER
);

-- Per-chunk row from a user file. `source_kind` lets us mix folder-indexed
-- chunks ('indexed') with one-off drag-and-drop content ('dropped') in the
-- same retrieval query. content_hash lets re-index skip unchanged chunks.
CREATE TABLE IF NOT EXISTS file_chunks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path       TEXT    NOT NULL,
    source_kind       TEXT    NOT NULL CHECK (source_kind IN ('indexed', 'dropped')),
    chunk_index       INTEGER NOT NULL,
    content           TEXT    NOT NULL,
    page              INTEGER,
    char_offset_start INTEGER NOT NULL,
    char_offset_end   INTEGER NOT NULL,
    content_hash      TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    embedding         BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_source
    ON file_chunks(source_path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash
    ON file_chunks(content_hash);

-- One row per inline `[N]` marker the assistant emitted. snippet is precomputed
-- at insert time so the renderer can show a hover popover without a second
-- round-trip. source_path can be a filesystem path OR a URL — the discriminator
-- is source_kind.
CREATE TABLE IF NOT EXISTS citations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id        INTEGER NOT NULL,
    marker_number  INTEGER NOT NULL,
    source_kind    TEXT    NOT NULL CHECK (source_kind IN ('file', 'web', 'memory')),
    source_path    TEXT,
    chunk_id       INTEGER,
    snippet        TEXT    NOT NULL,
    title          TEXT,
    page           INTEGER,
    FOREIGN KEY (turn_id)  REFERENCES chat_turns(id),
    FOREIGN KEY (chunk_id) REFERENCES file_chunks(id)
);

CREATE INDEX IF NOT EXISTS idx_citations_turn
    ON citations(turn_id);
