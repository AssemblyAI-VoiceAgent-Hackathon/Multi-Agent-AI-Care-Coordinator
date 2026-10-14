"""Document Classifier (Worker 2): sorts and indexes every uploaded document by type and date
(FR-3). Rules first (header titles are reliable for these records); the model is only asked
about documents the rules cannot place."""
from __future__ import annotations

import re

from ..context import RunContext
from ..llm import LLMError, llm
from ..schemas import DocIndexEntry, Flag

TITLE_TYPES = [
    (r"medication and allergy list|medication list|prescription", "medication_list"),
    (r"discharge summary", "discharge_summary"),
    (r"emergency", "emergency_summary"),
    (r"laboratory report|lab report", "lab_report"),
    (r"pathology|biopsy", "pathology_report"),
    (r"imaging|radiology|ct |mri|x-ray|ultrasound|fundoscopy", "imaging_report"),
    (r"procedure report", "procedure_report"),
    (r"clinical note|progress note|consult", "clinical_note"),
]
VALID = {t for _, t in TITLE_TYPES}


async def run(ctx: RunContext) -> tuple[list[DocIndexEntry], list[Flag]]:
    ctx.emit("classifier", "start", f"Indexing {len(ctx.run.documents)} documents")
    index: list[DocIndexEntry] = []
    flags: list[Flag] = []
    for d in ctx.run.documents:
        if not d.readable:
            index.append(DocIndexEntry(doc_id=d.doc_id, filename=d.filename, doc_type="unknown",
                                       doc_date=None, title="(unreadable)"))
            flags.append(Flag(level="amber", category="missing", section="needs_clinician_review",
                              text=f"'{d.filename}' could not be read (it may be a scanned image). It was not used."))
            ctx.emit("classifier", "flag", f"{d.filename}: unreadable")
            continue
        hay = f"{d.title} {d.filename.replace('-', ' ').replace('_', ' ')}".lower()
        dtype = next((t for pat, t in TITLE_TYPES if re.search(pat, hay)), "unknown")
        method = "rules"
        if dtype == "unknown" and llm.enabled:
            try:
                head = "\n".join(ln.text for ln in d.lines[:25])
                out = await llm.chat_json("classifier", f"Classify this medical document. Return {{\"type\": one of {sorted(VALID)}}}.",
                                          head, max_tokens=40)
                if out.get("type") in VALID:
                    dtype, method = out["type"], "llm"
            except LLMError:
                pass
        index.append(DocIndexEntry(doc_id=d.doc_id, filename=d.filename, doc_type=dtype,
                                   doc_date=d.doc_date, title=d.title or d.filename, method=method))
        if d.doc_date is None:
            flags.append(Flag(level="amber", category="missing", section="needs_clinician_review",
                              text=f"No date found in '{d.filename}'. It is left out of the timeline instead of guessing.",
                              source_ids=[d.lines[0].id]))
    index.sort(key=lambda e: (e.doc_date or "9999", e.doc_id))
    counts: dict[str, int] = {}
    for e in index:
        counts[e.doc_type] = counts.get(e.doc_type, 0) + 1
    ctx.run.index = index
    ctx.emit("classifier", "finish", "Indexed: " + ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in counts.items()),
             counts=counts)
    return index, flags
