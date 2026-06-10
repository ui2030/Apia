"""Unit tests for `services.context_assembler`.

The assembler decides what *makes it into the LLM prompt* when we have more
memory + file recalls than the char budget allows. It's small, but it's the
one place that knows the relative trade-off: when context is too long,
drop the lowest-scoring item, not the longest.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.context_assembler import (
    SECTION_FILES,
    SECTION_MEMORY,
    ContextItem,
    assemble_context_blocks,
    file_recalls_to_items,
    memory_recalls_to_items,
)


def _memory_recall(kind: str, content: str, score: float, role: str | None = None):
    return SimpleNamespace(kind=kind, content=content, score=score, role=role)


def _file_recall(content: str, score: float, *, source_kind="indexed",
                 source_path="C:/data/notes.md", page=None):
    return SimpleNamespace(
        kind="file", content=content, score=score,
        source_kind=source_kind, source_path=source_path,
        chunk_index=0, page=page, chunk_id=1,
    )


def test_memory_summary_recall_renders_as_summary_line():
    items = memory_recalls_to_items([_memory_recall("summary", "한 줄 요약", 0.9)])
    assert items[0].section == SECTION_MEMORY
    assert items[0].body.startswith("- 요약:")


def test_memory_turn_recall_renders_with_role():
    items = memory_recalls_to_items([_memory_recall("turn", "안녕", 0.8, role="user")])
    assert "(user)" in items[0].body


def test_file_recall_includes_path_and_page_for_indexed():
    items = file_recalls_to_items([
        _file_recall("본문", 0.7, source_path="C:/data/x.md", page=3),
    ])
    assert "(p.3)" in items[0].body
    assert "C:/data/x.md" in items[0].body


def test_file_recall_dropped_label_used_instead_of_path():
    items = file_recalls_to_items([
        _file_recall("본문", 0.7, source_kind="dropped",
                     source_path="dropped:label:abc"),
    ])
    assert "드롭한 문서" in items[0].body


def test_assemble_groups_by_section():
    items = [
        ContextItem(SECTION_MEMORY, "- 요약: A", 0.9),
        ContextItem(SECTION_FILES, "- header\nbody", 0.8),
    ]
    blocks = assemble_context_blocks(items, max_total_chars=10_000)
    assert SECTION_MEMORY in blocks
    assert SECTION_FILES in blocks
    assert "- 요약: A" in blocks[SECTION_MEMORY]
    assert "header" in blocks[SECTION_FILES]


def test_assemble_drops_lowest_score_first_under_cap():
    items = [
        ContextItem(SECTION_MEMORY, "M-A" * 100, 0.95),
        ContextItem(SECTION_FILES, "F-LOW" * 100, 0.40),
        ContextItem(SECTION_FILES, "F-HIGH" * 100, 0.90),
    ]
    # Tight cap: only the two highest can fit. Lowest (0.40) gets dropped.
    blocks = assemble_context_blocks(items, max_total_chars=1500)
    assert SECTION_MEMORY in blocks
    assert "F-LOW" not in blocks.get(SECTION_FILES, "")
    assert "F-HIGH" in blocks[SECTION_FILES]


def test_assemble_returns_empty_dict_when_no_items():
    assert assemble_context_blocks([], max_total_chars=10_000) == {}


def test_assemble_cap_can_drop_everything():
    items = [ContextItem(SECTION_MEMORY, "x" * 500, 0.9)]
    # Cap below the single item's body + overhead — must drop it.
    blocks = assemble_context_blocks(items, max_total_chars=100)
    assert blocks == {}
