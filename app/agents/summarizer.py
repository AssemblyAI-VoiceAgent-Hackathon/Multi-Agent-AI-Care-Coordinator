"""Record Summarizer (Worker 3): extracts facts from the relevant documents, each tagged with the
exact source line(s) and a verbatim quote (FR-5). Also builds the timeline, spots missing or
conflicting details (project doc Part 5, Feature 6) and drafts questions for the doctor.

Rules path: deterministic extraction from the record structure; works for any Synthea-style
cancer patient. Model path: the model only REWRITES the extracted facts into ~8th-grade
language and drafts questions; it cannot add facts, because the Compiler re-checks every number,
date and quote against the cited lines."""
from __future__ import annotations

import re
from collections import defaultdict

from ..context import RunContext
from ..llm import LLMError, llm
from ..schemas import CareContract, Claim, Document, Flag, SubmitterRole
from .oncology import CANCER_DX, CANCER_EVENTS, plain

NUM_RE = re.compile(r"^-?\d+(\.\d+)?$")


# ---------- voice: patient vs caregiver ----------
class Voice:
    def __init__(self, ctx: RunContext, patient_name: str):
        self.role = ctx.run.submitter.role
        self.first = (patient_name.split() or ["the patient"])[0]

    @property
    def poss(self) -> str:  # "your" / "Clair's"
        return "your" if self.role == SubmitterRole.patient else f"{self.first}'s"

    @property
    def Poss(self) -> str:
        return self.poss[0].upper() + self.poss[1:]

    def q(self, patient_form: str, caregiver_form: str) -> str:
        return patient_form if self.role == SubmitterRole.patient else caregiver_form.replace("{name}", self.first)


def _find_line(doc: Document, needle: str):
    return next((ln for ln in doc.lines if needle in ln.text), None)


def _short_test(name: str) -> str:
    return re.sub(r"\s*\[.*?\]\s*", " ", name).replace(" in Blood", " (blood)").replace(" in Serum or Plasma", " (serum)") \
        .replace(" in Urine by Test strip", " (urine)").replace(" in Urine", " (urine)").strip()


def patient_identity(docs: list[Document]) -> tuple[str, list[Flag]]:
    flags: list[Flag] = []
    mrns = {d.mrn for d in docs if d.mrn}
    names = {d.patient_name for d in docs if d.patient_name}
    if len(mrns) > 1 or len(names) > 1:
        flags.append(Flag(level="red", category="conflict", section="needs_clinician_review",
                          text="The uploaded documents belong to more than one patient (different names or record numbers: "
                               f"{', '.join(sorted(names | mrns))}). Please check the upload before using this summary.",
                          source_ids=[next(ln.id for ln in d.lines if ln.text.startswith("Patient")) for d in docs
                                      if d.readable and any(ln.text.startswith("Patient") for ln in d.lines)][:6]))
    name = sorted(names)[0] if names else "the patient"
    return name, flags


def extract_facts(ctx: RunContext, contract: CareContract) -> tuple[list[Claim], list[Claim], list[Flag], str]:
    docs = [d for d in ctx.run.documents if d.doc_id in set(ctx.relevant_doc_ids) and d.readable]
    all_docs = [d for d in ctx.run.documents if d.readable]
    name, flags = patient_identity(all_docs)
    v = Voice(ctx, name)
    facts: list[Claim] = []
    timeline: list[Claim] = []
    by_date = sorted(docs, key=lambda d: d.doc_date or "")
    newest = sorted(all_docs, key=lambda d: d.doc_date or "", reverse=True)

    # overview
    if by_date:
        first, last = by_date[0], by_date[-1]
        dob = _find_line(last, "Date of birth")
        facts.append(Claim(
            text=f"This summary uses {len(docs)} of {len(all_docs)} uploaded documents, dated "
                 f"{first.doc_date} to {last.doc_date}.",
            source_ids=[ln.id for ln in (_find_line(first, first.doc_date or "~"), _find_line(last, last.doc_date or "~")) if ln],
            quote=last.doc_date or "", kind="meta"))
        if dob:
            age = re.search(r"age (\d+)", dob.text)
            if age:
                facts.append(Claim(text=f"{v.Poss} age in the newest record is {age.group(1)}.",
                                   source_ids=[dob.id], quote=f"age {age.group(1)}"))

    # problems: newest "ACTIVE PROBLEMS" table across ALL docs (current state), cancer first
    prob_doc = next((d for d in newest if any(t.header[:1] == ["Problem"] for t in d.tables)), None)
    if prob_doc:
        rows = [(r, lid) for t in prob_doc.tables if t.header[:1] == ["Problem"] for r, lid in zip(t.rows, t.row_line_ids)]
        cancer = [(r, lid) for r, lid in rows if CANCER_DX.search(r[0])]
        other = [(r, lid) for r, lid in rows if not CANCER_DX.search(r[0])]
        for r, lid in cancer:
            since = r[1] if len(r) > 1 else ""
            facts.append(Claim(text=f"{v.Poss} records list {plain(r[0])}" + (f", first noted on {since}." if since else "."),
                               source_ids=[lid], quote=r[0]))
        for r, lid in other[:8]:
            since = r[1] if len(r) > 1 else ""
            facts.append(Claim(text=f"Other health problem on the list: {plain(r[0])}" + (f" (since {since})." if since else "."),
                               source_ids=[lid], quote=r[0]))
        if len(other) > 8:
            facts.append(Claim(text=f"{len(other) - 8} more older problems are listed in the record.",
                               source_ids=[other[8][1]], quote=other[8][0][0], kind="meta"))
    else:
        flags.append(Flag(level="amber", category="missing", section="plain_language_summary",
                          text="No problem list was found in the uploaded documents."))

    # timeline: one entry per document + cancer treatment events from procedure tables
    for d in by_date:
        if not d.doc_date:
            continue
        ln = _find_line(d, d.doc_date)
        timeline.append(Claim(text=f"{d.doc_date}: {d.title}" + (f" ({d.facility})" if d.facility else ""),
                              source_ids=[ln.id] if ln else [], quote=d.doc_date, kind="timeline"))
        for t in d.tables:
            if t.header[:1] == ["Procedure"]:
                for r, lid in zip(t.rows, t.row_line_ids):
                    if r[0].lower() in d.title.lower():
                        continue  # same event as the document entry
                    if CANCER_EVENTS.search(r[0]) or (len(r) > 2 and CANCER_DX.search(r[2])):
                        when = (r[1] if len(r) > 1 else "")[:10] or d.doc_date
                        timeline.append(Claim(text=f"{when}: {plain(r[0])}", source_ids=[lid], quote=r[0], kind="timeline"))
    timeline.sort(key=lambda c: c.text[:10])

    # labs: group the same test across documents; newest values first
    series: dict[str, list[tuple[str, str, str, str, str]]] = defaultdict(list)  # test -> (date, value, unit, lid, date_lid)
    lab_docs = [d for d in docs if "laboratory" in d.title.lower()]
    for d in lab_docs:
        date_ln = _find_line(d, d.doc_date or "~")
        for t in d.tables:
            if t.header[:1] == ["Test"] and "Result" in t.header:
                ri, ui = t.header.index("Result"), (t.header.index("Units") if "Units" in t.header else None)
                for r, lid in zip(t.rows, t.row_line_ids):
                    val = r[ri] if ri < len(r) else ""
                    if NUM_RE.match(val):
                        unit = r[ui] if ui is not None and ui < len(r) else ""
                        series[_short_test(r[0])].append((d.doc_date or "", val, unit, lid, date_ln.id if date_ln else ""))
    if series:
        newest_date = max(x[0] for s in series.values() for x in s)
        shown = 0
        cutoff = str(int(newest_date[:4]) - 1)
        ordered = sorted(series.items(), key=lambda kv: kv[0])
        ordered.sort(key=lambda kv: max(p[0] for p in kv[1]), reverse=True)
        for test, pts in ordered:
            pts.sort(key=lambda p: p[0], reverse=True)
            if pts[0][0][:4] < cutoff or shown >= 10:
                continue
            vals = "; ".join(f"{p[1]} {p[2]} on {p[0]}" for p in pts[:3])
            facts.append(Claim(text=f"{test}: {vals}.", source_ids=sorted({p[3] for p in pts[:3]} | {p[4] for p in pts[:3] if p[4]}),
                               quote=pts[0][1], kind="lab"))
            shown += 1
            same_day = defaultdict(set)
            for p in pts:
                same_day[p[0]].add(p[1])
            for day, vs in same_day.items():
                if len(vs) > 1:
                    flags.append(Flag(level="amber", category="conflict", section="needs_clinician_review",
                                      text=f"Two different {test} results are recorded on {day} ({', '.join(sorted(vs))}). "
                                           "The system does not decide which is correct.",
                                      source_ids=[p[3] for p in pts if p[0] == day]))
        no_ref = [ln.id for d in lab_docs for ln in d.lines if "Reference ranges" in ln.text and "not supplied" in ln.text]
        if no_ref:
            flags.append(Flag(level="amber", category="lab_no_reference", section="plain_language_summary",
                              text="The lab reports do not include normal ranges, so this summary cannot say whether any "
                                   "result is high or low. Ask the doctor what the results mean.", source_ids=no_ref[:4]))

    # recent visits and missing details (last ~2 years of the record)
    latest_year = max((int(d.doc_date[:4]) for d in docs if d.doc_date), default=0)
    for d in docs:
        if not d.doc_date or int(d.doc_date[:4]) < latest_year - 1:
            continue
        reason = _find_line(d, "Reason for visit")
        if "emergency" in d.title.lower() or "discharge" in d.title.lower():
            ln = _find_line(d, d.doc_date)
            facts.append(Claim(text=f"{d.title} on {d.doc_date}" + (f" at {d.facility}." if d.facility else "."),
                               source_ids=[x.id for x in (ln, reason) if x], quote=d.doc_date, kind="visit"))
        if reason and re.search(r"Reason for visit \| Not recorded", reason.text):
            flags.append(Flag(level="amber", category="missing", section="needs_clinician_review",
                              text=f"The reason for the {d.title.lower()} on {d.doc_date} is not recorded.", source_ids=[reason.id]))
        no_narr = _find_line(d, "No radiologist narrative")
        if no_narr:
            flags.append(Flag(level="amber", category="missing", section="needs_clinician_review",
                              text=f"The {d.title} on {d.doc_date} has no written findings in the record. Ask for the result.",
                              source_ids=[no_narr.id]))

    # discharge explanation
    if contract.intent == "explain_discharge":
        dis = next((d for d in sorted(docs, key=lambda d: d.doc_date or "", reverse=True) if "discharge" in d.title.lower()), None)
        if dis:
            for label in ("Reason for visit", "Length of stay", "Admitted"):
                ln = _find_line(dis, label)
                if ln:
                    parts = [p.strip() for p in ln.text.split("|")]
                    i = parts.index(label)
                    if i + 1 < len(parts) and parts[i + 1] != "Not recorded":
                        facts.append(Claim(text=f"Hospital stay - {label.lower()}: {plain(parts[i + 1])}.",
                                           source_ids=[ln.id], quote=parts[i + 1], kind="discharge"))
    return facts, timeline, flags, name


def draft_questions(ctx: RunContext, contract: CareContract, flags: list[Flag], name: str,
                    interactions: list | None = None) -> list[Claim]:
    v = Voice(ctx, name)
    qs: list[Claim] = []

    def add(text: str, flag: Flag | None = None, quote: str = ""):
        qs.append(Claim(text=text, source_ids=flag.source_ids if flag else [], quote=quote, kind="question"))

    for it in interactions or []:
        if it.confirmed and it.severity == "major" and len(it.ingredients) == 2:
            a, b = it.ingredients
            qs.append(Claim(text=v.q(f"My list shows both {a} and {b}. Should I be taking both?",
                                     f"{{name}}'s list shows both {a} and {b}. Should {{name}} be taking both?".replace("{name}", v.first)),
                            source_ids=it.source_ids, kind="question"))
    for f in flags:
        if f.category == "conflict" and "not on the current medicine list" in f.text:
            drug = f.text.split(" ")[0]
            add(v.q(f"A recent note mentions {drug}, but it is not on my medicine list. Am I still meant to take it?",
                    f"A recent note mentions {drug}, but it is not on {{name}}'s medicine list. Is {{name}} still meant to take it?"), f)
    if any(f.category == "missing" and "directions" in f.text for f in flags):
        f = next(f for f in flags if f.category == "missing" and "directions" in f.text)
        add(v.q("Several of my medicines have no directions written. How and when should I take each one?",
                "Several of {name}'s medicines have no directions written. How and when should each one be taken?"), f)
    if any(f.category == "lab_no_reference" for f in flags):
        f = next(f for f in flags if f.category == "lab_no_reference")
        add(v.q("What do my latest lab results mean for me? Are any of them outside the normal range?",
                "What do {name}'s latest lab results mean? Are any of them outside the normal range?"), f)
    for f in flags:
        if f.category == "missing" and "reason for the" in f.text:
            add(v.q(f"What was {f.text.split('reason for the ')[1].split(' is not')[0]} about? Do I need any follow-up?",
                    f"What was {f.text.split('reason for the ')[1].split(' is not')[0]} about? Does {{name}} need any follow-up?"), f)
        if f.category == "missing" and "no written findings" in f.text:
            add(v.q("Can you tell me the result of " + f.text.split("The ")[1].split(" has no")[0] + "?",
                    "Can you tell us the result of " + f.text.split("The ")[1].split(" has no")[0] + "?"), f)
    if contract.specialty == "oncology" or any(CANCER_DX.search(ln.text) for ln in ctx.lines.values()):
        cancer_line = next((ln for ln in ctx.lines.values() if CANCER_DX.search(ln.text) and "|" in ln.text), None)
        if cancer_line:
            qs.append(Claim(text=v.q("What is the current plan for my cancer care, and what follow-up tests do I need?",
                                     "What is the current plan for {name}'s cancer care, and what follow-up tests are needed?"),
                            source_ids=[cancer_line.id], quote=cancer_line.text.split(" | ")[0], kind="question"))
    allergy = next((ln for ln in ctx.lines.values() if ln.section == "ALLERGIES" and "allerg" in ln.text.lower()
                    and ln.text != "ALLERGIES"), None)
    if allergy:
        qs.append(Claim(text=v.q("My record lists no allergies. Can we confirm that is correct?",
                                 "{name}'s record lists no allergies. Can we confirm that is correct?")
                        if "no allergy" in allergy.text.lower() else
                        v.q("Can we review my allergy list together?", "Can we review {name}'s allergy list together?"),
                        source_ids=[allergy.id], quote=allergy.text, kind="question"))
    return qs[:10]


async def simplify(ctx: RunContext, claims: list[Claim], extra_instruction: str = "") -> list[Claim]:
    """Model path: rewrite claim text in ~8th-grade language without adding facts."""
    if not llm.enabled or not claims:
        return claims
    items = "\n".join(f"{i}. {c.text}" for i, c in enumerate(claims))
    try:
        out = await llm.chat_json(
            "summarizer",
            "Rewrite each numbered sentence for a patient or caregiver at about an 8th-grade reading level. "
            "Keep every number, date, unit and medicine name exactly. Do not add facts, diagnoses or advice. "
            f"{extra_instruction} Return {{\"items\": [{{\"i\": 0, \"text\": \"...\"}}]}}.",
            items, max_tokens=1600,
        )
        new = {int(x["i"]): str(x["text"]) for x in out.get("items", []) if "i" in x and "text" in x}
        for i, c in enumerate(claims):
            if i in new and new[i].strip():
                c.text = new[i].strip()
    except (LLMError, ValueError, TypeError) as e:
        ctx.emit("summarizer", "info", f"Model rewrite unavailable, kept rules text: {e}")
    return claims


async def run(ctx: RunContext, contract: CareContract):
    ctx.emit("summarizer", "start", f"Extracting facts from {len(ctx.relevant_doc_ids)} documents")
    facts, timeline, flags, name = extract_facts(ctx, contract)
    if llm.enabled:
        facts = await simplify(ctx, facts)
    ctx.emit("summarizer", "finish", f"{len(facts)} facts, {len(timeline)} timeline entries, {len(flags)} flags")
    return facts, timeline, flags, name
