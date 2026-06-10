-- Step 3 (file search) prerequisite: unique key on the natural identity of a
-- chunk row so per-file reindex can DELETE-then-INSERT atomically without the
-- risk of stale duplicates piling up. UNIQUE on
-- (source_path, source_kind, chunk_index) means:
--   - same file re-indexed → DELETE-by-path purges old chunks before INSERT
--   - same chunk_index can never appear twice for the same (path, kind)
--   - dropped-text ingest must use a globally-unique source_path label
--     (FileIndexService enforces this by suffixing a uuid) so dropped labels
--     can't collide.
--
-- IF NOT EXISTS lets this migration re-apply on an already-migrated DB during
-- development. Production-grade dedupe preflight is unnecessary here: the
-- table is brand new in 001 and no end-user data exists yet (Codex
-- NICE-TO-HAVE note acknowledged).
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique
    ON file_chunks(source_path, source_kind, chunk_index);
