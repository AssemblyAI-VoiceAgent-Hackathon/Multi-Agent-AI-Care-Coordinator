"""Safety layer.

1. Emergency gate (SR-1): a fixed trigger list in code + an optional model classifier on the
   same GPU. EITHER one triggers a hard stop. The trigger list is a conservative safety net and
   can miss unusual phrasing (SR-2) - the UI says so.
2. History-only risks: risky items found in the documents (not the request) never stop the run;
   they are flagged for clinician review.
3. Sensitive social history (abuse, substance misuse, self-harm history): flagged to the clinician
   WITHOUT printing the detail in a summary a caregiver may read.
"""
from __future__ import annotations

import re

from .llm import LLMError, safety_llm
from .schemas import Document, Flag

EMERGENCY_TRIGGERS: dict[str, list[str]] = {
    "chest pain": [r"chest pain", r"chest (is )?(hurting|tight)", r"pain in (my|her|his|their) chest",
                   r"having a heart attack"],
    "breathing": [r"can'?t breathe", r"cannot breathe", r"(trouble|difficulty|hard) breathing", r"not breathing",
                  r"short(ness)? of breath", r"gasping", r"choking"],
    "overdose": [r"overdos", r"took too (many|much)", r"swallowed (a|the) (whole )?bottle", r"poison"],
    "heavy bleeding": [r"(heavy|heavily|severe) bleeding", r"bleeding (heavily|a lot|badly)", r"won'?t stop bleeding",
                       r"coughing (up )?blood", r"vomiting blood"],
    "self-harm": [r"suicid", r"kill (my|him|her|them)sel", r"end (my|his|her|their) life", r"self[- ]?harm",
                  r"hurt (my|him|her|them)sel", r"want to die"],
    "stroke / collapse": [r"unconscious", r"passed out", r"unresponsive", r"seizure", r"face (is )?droop",
                          r"slurred speech", r"stroke"],
    "severe allergic reaction": [r"anaphyla", r"throat (is )?(closing|swelling)", r"severe allergic"],
}

HARD_STOP_MESSAGE = (
    "This sounds like it could be an emergency. We have stopped and will not make a summary. "
    "Please call your local emergency number now (for example 911 in the US, 112 in Europe, 1122 in Pakistan) "
    "or contact a clinician right away."
)

HISTORY_RISKS: dict[str, str] = {
    r"myocardial infarction|heart attack": "Past heart attack is recorded",
    r"ischemic heart disease": "Ischemic heart disease is recorded",
    r"pregnan": "A pregnancy is recorded in the history",
    r"chronic kidney disease": "Chronic kidney disease is recorded",
    r"stroke|cerebrovascular": "A stroke is recorded in the history",
    r"anaphyla": "A severe allergic reaction is recorded",
    r"fracture of hip|hip fracture": "A hip fracture is recorded",
}

SENSITIVE_TERMS = {
    r"intimate partner abuse|domestic (abuse|violence)|reports of violence": "abuse or violence",
    r"misuses drugs|substance (use|abuse)|unhealthy alcohol": "substance or alcohol use",
    r"suicid|self[- ]harm": "self-harm",
}


def keyword_emergency(text: str) -> list[str]:
    t = text.lower()
    return [cat for cat, pats in EMERGENCY_TRIGGERS.items() if any(re.search(p, t) for p in pats)]


async def classifier_emergency(text: str) -> tuple[bool | None, str]:
    """Model-based classifier. Returns (None, reason) when no safety model is configured."""
    if not safety_llm.enabled:
        return None, "safety classifier not configured"
    try:
        out = await safety_llm.chat_json(
            "safety",
            "You are a triage safety classifier. Decide if the user's message describes a CURRENT medical "
            "emergency or immediate danger happening now (chest pain, trouble breathing, overdose, heavy "
            "bleeding, thoughts of self-harm, stroke signs, collapse). Past events mentioned as history are NOT "
            'current emergencies. Return {"emergency": true|false, "reason": "..."}.',
            text, max_tokens=120,
        )
        return bool(out.get("emergency")), str(out.get("reason", ""))
    except LLMError as e:
        return None, f"classifier error: {e}"


def history_flags(docs: list[Document]) -> list[Flag]:
    """History-only risks: one flag per risk type, citing every line it appears on (max 5)."""
    flags: list[Flag] = []
    for pat, label in HISTORY_RISKS.items():
        hits = [ln.id for d in docs for ln in d.lines if re.search(pat, ln.text, re.I)]
        if hits:
            flags.append(Flag(level="amber", category="history_risk", section="needs_clinician_review",
                              text=f"{label} (history only, not a current emergency). Please review with a clinician.",
                              source_ids=hits[:5]))
    return flags


def redact(text: str) -> str:
    """Applied to every source line shown in the UI, so a citation can't leak sensitive history."""
    for pat in SENSITIVE_TERMS:
        text = re.sub(rf"[^,;.]*(?:{pat})[^,;.]*", " [sensitive: clinician only]", text, flags=re.I)
    return text


def sensitive_flags(docs: list[Document]) -> list[Flag]:
    flags: list[Flag] = []
    for pat, label in SENSITIVE_TERMS.items():
        hits = [ln.id for d in docs for ln in d.lines if re.search(pat, ln.text, re.I)]
        if hits:
            flags.append(Flag(level="red", category="history_risk", section="needs_clinician_review",
                              text=f"Sensitive history item ({label}) is recorded. Details are not repeated in this "
                                   "summary; a clinician should review it privately with the patient.",
                              source_ids=hits[:3]))
    return flags
