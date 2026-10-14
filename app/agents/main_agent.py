"""Main Agent: understands intent, writes the shared care contract, routes fixes and change
requests to the right Worker, and enforces the retry limit (FR-2, FR-10, FR-11)."""
from __future__ import annotations

import re

from ..context import RunContext
from ..llm import LLMError, llm
from ..schemas import CareContract, WorkerAssignment

INTENT_RULES = [
    ("explain_discharge", r"discharge|instructions|explain|simple words|what does .* mean"),
    ("medication_review", r"medic|medicine|meds\b|pill|drug|prescription|interaction|dose"),
    ("appointment_prep", r"appointment|visit|prepare|prep\b|see (the|my|her|his|their) doctor|tomorrow|next week|oncolog|cardiolog"),
]

SPECIALTIES = {
    "cardiology": r"cardio|heart",
    "oncology": r"onco|cancer|tumou?r|chemo|breast",
    "nephrology": r"nephro|kidney|renal",
    "endocrinology": r"endocr|diabet|sugar|insulin",
    "orthopedics": r"ortho|bone|fracture|hip",
    "primary care": r"primary care|family doctor|gp\b|check-?up",
}

REQUIRED_INFO = {
    "appointment_prep": ["current problems", "recent results", "current medicines", "recent visits", "open questions"],
    "explain_discharge": ["reason for stay", "procedures", "medicines at discharge", "follow-up items"],
    "medication_review": ["current medicine list", "directions", "possible interactions", "allergies"],
    "record_overview": ["timeline", "current problems", "recent results", "current medicines"],
}


def _rules_contract(ctx: RunContext) -> CareContract:
    req = ctx.run.request.lower()
    intent = next((name for name, pat in INTENT_RULES if re.search(pat, req)), "record_overview")
    specialty = next((s for s, pat in SPECIALTIES.items() if re.search(pat, req)), "")
    return CareContract(
        goal=ctx.run.request.strip(),
        intent=intent,
        specialty=specialty,
        audience=ctx.run.submitter.role,
        required_information=REQUIRED_INFO[intent],
        assignments=[
            WorkerAssignment(worker="intake", task=f"Pick the documents relevant to: {intent.replace('_', ' ')}"
                                                   + (f" ({specialty})" if specialty else "")),
            WorkerAssignment(worker="classifier", task="Sort and index every uploaded document by type and date"),
            WorkerAssignment(worker="summarizer", task="Extract source-cited facts, a timeline and doctor questions"),
            WorkerAssignment(worker="medication", task="Check each current medicine and pair against the drug data source"),
        ],
    )


async def plan(ctx: RunContext) -> CareContract:
    contract = _rules_contract(ctx)
    if llm.enabled:
        try:
            out = await llm.chat_json(
                "main",
                "You are the Main Agent of a care-coordination system. Classify the request. Do not give medical "
                'advice. Return {"intent": one of [appointment_prep, explain_discharge, medication_review, '
                'record_overview], "specialty": short string or "", "required_information": [short strings]}.',
                f"Request from a {ctx.run.submitter.role.value}: {ctx.run.request}", max_tokens=200,
            )
            if out.get("intent") in REQUIRED_INFO:
                contract.intent = out["intent"]
            contract.specialty = str(out.get("specialty") or contract.specialty)[:40]
            info = [str(x)[:60] for x in out.get("required_information") or []][:8]
            contract.required_information = info or REQUIRED_INFO[contract.intent]
        except LLMError as e:
            ctx.emit("main", "info", f"Model unavailable for planning, used rules: {e}")
    return contract


# ---- routing for Improve requests (FR-11) ----
ROUTES = [
    ("medication", r"medic|medicine|meds\b|pill|drug|dose|interaction"),
    ("summarizer", r"question|ask|allerg|simpl|easier|shorter|explain|summary|timeline|add"),
]


def route_change(text: str) -> list[str]:
    t = text.lower()
    workers = [w for w, pat in ROUTES if re.search(pat, t)]
    return workers or ["summarizer"]


def may_retry(ctx: RunContext, key: str, limit: int) -> bool:
    n = ctx.retries.get(key, 0)
    if n >= limit:
        return False
    ctx.retries[key] = n + 1
    return True
