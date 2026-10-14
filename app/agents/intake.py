"""Intake Agent (Worker 1): interprets the request and selects relevant documents (FR-4).

Rules: the newest documents always matter for a visit; older documents are kept when they match
the request's specialty or are discharge summaries. With a model configured, the model refines
the selection, but only ids that really exist are accepted."""
from __future__ import annotations

import re

from ..context import RunContext
from ..llm import LLMError, llm
from ..schemas import CareContract, Document

SPECIALTY_TERMS = {
    "cardiology": r"heart|cardi|myocard|ischemic|lipid|cholesterol|metoprolol|clopidogrel|nitroglycerin|statin",
    "oncology": r"neoplasm|cancer|tumou?r|lumpectomy|mammogra|radiation|chemo|tamoxifen|ribociclib|biopsy|patholog",
    "nephrology": r"kidney|renal|creatinine|urea|proteinuria|albumin|urinalysis",
    "endocrinology": r"diabet|glucose|insulin|a1c|metformin",
    "orthopedics": r"fracture|osteopor|bone|hip|alendron",
}


def _latest_year(docs: list[Document]) -> int:
    years = [int(d.doc_date[:4]) for d in docs if d.doc_date]
    return max(years) if years else 0


def _rules_select(contract: CareContract, docs: list[Document]) -> dict[str, str]:
    latest = _latest_year(docs)
    pat = SPECIALTY_TERMS.get(contract.specialty)
    chosen: dict[str, str] = {}
    for d in docs:
        if not d.readable:
            continue
        title = d.title.lower()
        text = " ".join(ln.text for ln in d.lines).lower()
        recent = bool(d.doc_date) and int(d.doc_date[:4]) >= latest - 1
        if contract.intent == "explain_discharge":
            if "discharge" in title:
                chosen[d.doc_id] = "discharge summary"
            elif "medication" in title and recent:
                chosen[d.doc_id] = "current medicine list"
        elif contract.intent == "medication_review":
            if "medication" in title or "prescri" in text:
                chosen[d.doc_id] = "contains medicines"
        else:  # appointment prep / overview
            if recent:
                chosen[d.doc_id] = "recent record"
            elif pat and re.search(pat, text):
                chosen[d.doc_id] = f"matches {contract.specialty}"
            elif "discharge" in title or contract.intent == "record_overview":
                chosen[d.doc_id] = "history"
    return chosen


async def run(ctx: RunContext, contract: CareContract) -> list[str]:
    ctx.emit("intake", "start", "Choosing documents relevant to the request")
    docs = ctx.run.documents
    chosen = _rules_select(contract, docs)
    if llm.enabled:
        try:
            listing = "\n".join(f"{d.doc_id} | {d.doc_date} | {d.title}" for d in docs if d.readable)
            out = await llm.chat_json(
                "intake",
                "Pick which documents are relevant to the request. Use only ids from the list. "
                'Return {"relevant": [{"id": "D01", "reason": "..."}]}.',
                f"Request: {contract.goal}\nIntent: {contract.intent}\nDocuments:\n{listing}", max_tokens=600,
            )
            valid = {d.doc_id for d in docs}
            picked = {str(x.get("id")): str(x.get("reason", ""))[:80] for x in out.get("relevant", []) if x.get("id") in valid}
            if picked:
                chosen = picked | {k: v for k, v in chosen.items() if "medicine" in v}  # never drop the med list
        except LLMError as e:
            ctx.emit("intake", "info", f"Model unavailable, used rules: {e}")
    if not chosen:  # never return nothing; fall back to everything readable
        chosen = {d.doc_id: "fallback: all documents" for d in docs if d.readable}
    ctx.relevant_doc_ids = sorted(chosen)
    ctx.emit("intake", "finish", f"{len(chosen)} of {len(docs)} documents are relevant", relevant=chosen)
    return ctx.relevant_doc_ids
