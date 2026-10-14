"""Manager/Compiler Agent: merges the Worker outputs into the fixed four-section structure (FR-7),
verifies every claim against its source lines (FR-8), runs the bounded retry loop (FR-10),
assigns per-section confidence (FR-9) and measures reading level."""
from __future__ import annotations

import re

import textstat

from ..config import settings
from ..context import RunContext
from ..schemas import CareSummary, Claim, Flag, Interaction, MedItem, Section, SourceLine
from . import main_agent, summarizer

NUM_RE = re.compile(r"\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?")
ADVICE_RE = re.compile(r"\byou (should|must) (take|stop|start|increase|decrease)\b|\byou have been diagnosed\b|"
                       r"\bdiagnos(e|is) (is|of)\b|\bwe recommend\b|\bstop taking\b|\bincrease (the|your) dose\b", re.I)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def verify(claim: Claim, lines: dict[str, SourceLine]) -> tuple[bool, str]:
    if claim.origin == "user_request":
        return True, "added at the user's request (not from the record)"
    if ADVICE_RE.search(claim.text):
        return False, "contains diagnosis or treatment language"
    if not claim.source_ids:
        return False, "no source cited"
    missing = [s for s in claim.source_ids if s not in lines]
    if missing:
        return False, f"cites lines that do not exist: {missing}"
    cited = _norm(" ".join(lines[s].text for s in claim.source_ids))
    if claim.quote and _norm(claim.quote) not in cited:
        return False, f"quote not found in cited lines: '{claim.quote[:60]}'"
    if claim.kind not in ("meta", "question"):
        for n in NUM_RE.findall(claim.text):
            if n not in cited:
                return False, f"number/date '{n}' is not in the cited source"
    return True, ""


def med_claims(meds: list[MedItem]) -> list[Claim]:
    out = []
    for m in meds:
        parts = [m.name + "."]
        parts.append(f"Directions: {m.directions}." if m.directions and m.directions != "Not recorded" else "Directions: not recorded.")
        if m.started:
            parts.append(f"Started {m.started}.")
        status = f"Checked: {m.drug_class}." if m.status == "confirmed" else "Cannot confirm: not in the drug data source."
        out.append(Claim(text=" ".join(parts), source_ids=m.source_ids, quote=m.name, kind="medication",
                         worker="medication", note=status))
    return out


async def _verify_with_retries(ctx: RunContext, claims: list[Claim], originals: list[Claim],
                               section: str, removed: list[Claim], flags: list[Flag]) -> list[Claim]:
    kept: list[Claim] = []
    for i, c in enumerate(claims):
        ok, why = verify(c, ctx.lines)
        key = f"{section}:{i}"
        while not ok and main_agent.may_retry(ctx, key, settings.max_retries):
            c.attempts += 1
            ctx.emit("main", "retry", f"Claim failed check ({why}); sent back to {c.worker} "
                                      f"(retry {c.attempts}/{settings.max_retries})", claim=c.text[:120])
            orig = originals[i] if i < len(originals) else c
            fixed = Claim(**orig.model_dump())
            fixed.attempts = c.attempts
            if c.worker == "summarizer":
                [fixed] = await summarizer.simplify(ctx, [fixed], "Copy every number and date exactly. Use only the given facts.")
            c = fixed
            ok, why = verify(c, ctx.lines)
        c.verified = ok
        if ok:
            kept.append(c)
        else:
            c.note = why
            removed.append(c)
            flags.append(Flag(level="red", category="unverified_claim", section="needs_clinician_review",
                              text=f"A statement could not be traced to the record after {settings.max_retries} retries and was "
                                   f"removed ({why}). Needs human review.", source_ids=[s for s in c.source_ids if s in ctx.lines]))
            ctx.emit("compiler", "flag", f"Removed unverifiable claim after retries: {why}")
    return kept


def _confidence(items: list[Claim], removed_here: int, section_flags: list[Flag], empty_is_low: bool = True) -> str:
    if (empty_is_low and not items) or removed_here:
        return "low"
    if any(f.level == "red" for f in section_flags) or any(f.category in ("cannot_confirm", "conflict", "missing", "lab_no_reference", "low_confidence")
                                                           for f in section_flags):
        return "medium"
    return "high"


async def run(ctx: RunContext, *, facts, fact_originals, timeline, questions, meds, interactions: list[Interaction],
              allergies, flags: list[Flag], patient_name: str) -> CareSummary:
    ctx.emit("compiler", "start", "Merging worker outputs and checking every claim against its source")
    removed: list[Claim] = []
    n_removed_before = 0

    facts = await _verify_with_retries(ctx, facts, fact_originals, "summary", removed, flags)
    removed_summary = len(removed) - n_removed_before
    n_removed_before = len(removed)
    questions = await _verify_with_retries(ctx, questions, questions, "questions", removed, flags)
    removed_q = len(removed) - n_removed_before
    n_removed_before = len(removed)
    mclaims = await _verify_with_retries(ctx, med_claims(meds) + allergies, med_claims(meds) + allergies,
                                         "medication", removed, flags)
    removed_m = len(removed) - n_removed_before
    timeline = [c for c in timeline if verify(c, ctx.lines)[0]]
    for c in timeline:
        c.verified = True

    grade = None
    text = " ".join(c.text for c in facts if c.kind != "lab")
    if text.strip():
        grade = round(textstat.flesch_kincaid_grade(text), 1)
        if grade > settings.target_grade + 2:
            flags.append(Flag(level="amber", category="low_confidence", section="plain_language_summary",
                              text=f"Reading level is about grade {grade}, above the target of grade {settings.target_grade:.0f}. "
                                   "Medical terms from the record are kept so they can be checked."))

    # de-duplicate flags (same text)
    seen, uniq = set(), []
    for f in flags:
        if f.text not in seen:
            seen.add(f.text)
            uniq.append(f)
    flags = sorted(uniq, key=lambda f: (f.level != "red", f.section))

    by_sec = lambda key: [f for f in flags if f.section == key]  # noqa: E731
    review_items = [Claim(text=f.text, source_ids=f.source_ids, kind=f"flag:{f.level}:{f.category}", verified=True)
                    for f in flags]
    sections = [
        Section(key="plain_language_summary", title="1. Plain-language summary",
                confidence=_confidence(facts, removed_summary, by_sec("plain_language_summary")), items=facts),
        Section(key="questions_for_doctor", title="2. Questions for the doctor",
                confidence=_confidence(questions, removed_q, []), items=questions),
        Section(key="medication_checklist", title="3. Medication and allergy checklist",
                confidence=_confidence(mclaims, removed_m, by_sec("medication_checklist")), items=mclaims),
        Section(key="needs_clinician_review", title="4. Needs clinician review",
                confidence="high", items=review_items),
    ]
    summary = CareSummary(audience=ctx.run.submitter.role, patient_name=patient_name, sections=sections,
                          medications=meds, allergies=allergies, interactions=interactions, flags=flags,
                          timeline=timeline, reading_grade=grade, removed_claims=removed)
    ctx.emit("compiler", "finish",
             f"Verified {sum(len(s.items) for s in sections[:3])} claims; removed {len(removed)}; "
             f"{sum(f.level == 'red' for f in flags)} red and {sum(f.level == 'amber' for f in flags)} amber flags; "
             f"reading grade {grade}",
             confidence={s.key: s.confidence for s in sections})
    return summary
