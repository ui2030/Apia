"""
Cross-source context assembly for /chat (step 3).

Combines memory recalls (long-term chat memory) and file recalls (indexed
file chunks) into the single `context_blocks` dict that ClaudeService.chat
takes. The job is mechanical but had to be a real module because:

  - Codex MUST-FIX (round 1): truncating the *concatenated* string would
    cut item bodies mid-sentence and break section labels. We need
    score-aware item-level trimming, not text-level.
  - Codex NICE-TO-HAVE (round 2): the final-prompt char cap must also
    account for section labels + separators that ClaudeService later
    glues on, not just raw item bodies.

Inputs are the loose `MemoryRecall` / `FileRecall` dataclasses returned by
the two retrieval services. We avoid importing those types directly to keep
this module testable without the heavy services — duck-typed access on
score/content/kind is enough.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence

# Each label maps to a section the prompt builder will recognize. Keep these
# strings in sync with ClaudeService._CONTEXT_SECTION_ORDER.
SECTION_MEMORY = "기억"
SECTION_FILES = "파일"

# Conservative overhead estimate for section labels + separator the prompt
# builder adds *around* each section: "## <hint>\n…\n\n" — the hint is the
# longest piece, capped at ~80 chars.
_PER_SECTION_OVERHEAD = 120


@dataclass
class ContextItem:
    section: str
    body: str
    score: float

    @property
    def length(self) -> int:
        return len(self.body)


def memory_recalls_to_items(recalls: Iterable) -> List[ContextItem]:
    out: List[ContextItem] = []
    for r in recalls:
        if r.kind == "summary":
            body = f"- 요약: {r.content}"
        else:
            who = getattr(r, "role", None) or "?"
            body = f"- 과거 대화({who}): {r.content}"
        out.append(ContextItem(section=SECTION_MEMORY, body=body, score=float(r.score)))
    return out


def file_recalls_to_items(recalls: Iterable) -> List[ContextItem]:
    out: List[ContextItem] = []
    for r in recalls:
        head = _file_recall_header(r)
        out.append(ContextItem(
            section=SECTION_FILES,
            body=f"- {head}\n{r.content}",
            score=float(r.score),
        ))
    return out


def _file_recall_header(r) -> str:
    if r.source_kind == "dropped":
        return "(드롭한 문서)"
    path = r.source_path
    if r.page is not None:
        return f"{path} (p.{r.page})"
    return path


def assemble_context_blocks(
    items: Sequence[ContextItem],
    *,
    max_total_chars: int,
) -> dict:
    """Take items from any number of sections, drop the lowest-scoring ones
    until the *final-prompt char count* fits under `max_total_chars`, and
    return the surviving items grouped by section.

    The final-prompt char count includes a flat overhead per non-empty
    section (label + separator) so the budget is honest about what ends up
    in the LLM input.

    Returns: {section_label: "<body>\n<body>\n…", …}. Empty sections are
    dropped from the result.
    """
    surviving = sorted(items, key=lambda i: i.score, reverse=True)

    def total_chars(active: Sequence[ContextItem]) -> int:
        if not active:
            return 0
        # bodies + per-section overhead, counted once per active section.
        by_section: dict[str, int] = {}
        for it in active:
            by_section[it.section] = by_section.get(it.section, 0) + it.length + 1
        return sum(by_section.values()) + _PER_SECTION_OVERHEAD * len(by_section)

    while surviving and total_chars(surviving) > max_total_chars:
        surviving.pop()  # lowest score off the back

    by_section: dict[str, list[str]] = {}
    for it in surviving:
        by_section.setdefault(it.section, []).append(it.body)
    return {section: "\n".join(bodies) for section, bodies in by_section.items()}
