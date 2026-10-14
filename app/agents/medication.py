"""Medication Checker (Worker 4): checks every current medicine against the drug data source and
reports 'cannot confirm' when there is no match (FR-6). Every pair of confirmed medicines is
looked up for interactions; any pair that includes an unconfirmed medicine is 'cannot confirm'
(FR-13). The model is never used to decide an interaction - only the data source is."""
from __future__ import annotations

import itertools
import json
import re
from pathlib import Path

from ..context import RunContext
from ..schemas import Claim, Document, Flag, Interaction, MedItem
from .oncology import ONCOLOGY_DRUG_RE

DB_PATH = Path(__file__).resolve().parent.parent / "drugdata" / "demo_drugdb.json"
MED_TABLE_SECTIONS = ("ACTIVE PRESCRIPTIONS", "MEDICATIONS PRESCRIBED", "PRESCRIPTIONS WRITTEN", "MEDICATIONS")


class DrugDB:
    def __init__(self, path: Path = DB_PATH):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.meta = data["_meta"]
        self.drugs = data["drugs"]
        self.pairs = {frozenset(i["pair"]): i for i in data["interactions"]}

    def match(self, name: str) -> str | None:
        n = name.lower()
        for ingredient, info in self.drugs.items():
            if any(re.search(rf"\b{re.escape(m)}", n) for m in info["match"]):
                return ingredient
        return None


def current_medicine_rows(docs: list[Document]) -> tuple[Document | None, list[tuple[list[str], list[str], str]]]:
    """Rows from the newest medication list; if none was uploaded, from the newest prescriptions table."""
    def tables(d: Document):
        return [t for t in d.tables if t.header and t.header[0].lower().startswith("medication")]

    dated = sorted([d for d in docs if d.readable], key=lambda d: d.doc_date or "", reverse=True)
    src = next((d for d in dated if "medication" in d.title.lower() and tables(d)), None)
    src = src or next((d for d in dated if tables(d)), None)
    if not src:
        return None, []
    rows = [(t.header, r, lid) for t in tables(src) for r, lid in zip(t.rows, t.row_line_ids)]
    return src, rows


def _cell(header: list[str], row: list[str], *names: str) -> str:
    for i, h in enumerate(header):
        if h.lower() in names and i < len(row):
            return row[i]
    return ""


async def run(ctx: RunContext, db: DrugDB | None = None):
    ctx.emit("medication", "start", "Checking medicines against the drug data source")
    db = db or DrugDB()
    src, rows = current_medicine_rows(ctx.run.documents)
    meds: list[MedItem] = []
    flags: list[Flag] = []
    interactions: list[Interaction] = []
    allergies: list[Claim] = []

    if not src:
        flags.append(Flag(level="red", category="missing", section="medication_checklist",
                          text="No current medicine list was found in the uploaded documents. Please bring one to the visit."))
        ctx.emit("medication", "flag", "No medicine list found")
    for header, row, lid in rows:
        name = _cell(header, row, "medication")
        directions = _cell(header, row, "directions")
        started = _cell(header, row, "started", "ordered") or None
        ingredient = db.match(name)
        item = MedItem(name=name, normalized=ingredient,
                       drug_class=db.drugs[ingredient]["class"] if ingredient else None,
                       directions=directions, started=started,
                       status="confirmed" if ingredient else "cannot_confirm", source_ids=[lid])
        if not ingredient:
            item.note = "Not found in the drug data source. Cannot confirm what it is or what it interacts with."
            flags.append(Flag(level="amber", category="cannot_confirm", section="medication_checklist",
                              text=f"Cannot confirm '{name}'. Please check it with a pharmacist.", source_ids=[lid]))
            ctx.emit("medication", "flag", f"Cannot confirm: {name}")
        meds.append(item)
    no_dir = [m for m in meds if not m.directions or m.directions.lower() == "not recorded"]
    if no_dir:
        flags.append(Flag(level="amber", category="missing", section="medication_checklist",
                          text=f"No directions are written for {len(no_dir)} medicine(s): "
                               + "; ".join(m.name for m in no_dir) + ". Ask how and when to take each one.",
                          source_ids=[s for m in no_dir for s in m.source_ids]))

    # pairwise interaction check
    for a, b in itertools.combinations(meds, 2):
        if a.normalized and b.normalized and a.normalized != b.normalized:
            hit = db.pairs.get(frozenset((a.normalized, b.normalized)))
            if hit:
                interactions.append(Interaction(drugs=[a.name, b.name], ingredients=[a.normalized, b.normalized], severity=hit["severity"],
                                                description=hit["description"], confirmed=True,
                                                source_ids=a.source_ids + b.source_ids))
        elif a.status == "cannot_confirm" or b.status == "cannot_confirm":
            interactions.append(Interaction(drugs=[a.name, b.name], severity="unknown",
                                            description="This pair could not be checked because one medicine is not in the drug data source.",
                                            confirmed=False, source_ids=a.source_ids + b.source_ids))
    for it in interactions:
        if it.confirmed:
            flags.append(Flag(level="red" if it.severity == "major" else "amber", category="interaction",
                              section="medication_checklist",
                              text=f"Possible interaction ({it.severity}): {it.drugs[0]} + {it.drugs[1]}. {it.description} "
                                   "Please confirm this with your doctor or pharmacist.",
                              source_ids=it.source_ids))
            ctx.emit("medication", "flag", f"{it.severity} interaction: {' + '.join(it.drugs)}")
    unchecked = [i for i in interactions if not i.confirmed]
    if unchecked:
        flags.append(Flag(level="amber", category="cannot_confirm", section="medication_checklist",
                          text=f"{len(unchecked)} medicine pair(s) could not be checked for interactions. "
                               "Please confirm these with your doctor or pharmacist.",
                          source_ids=sorted({s for i in unchecked for s in i.source_ids})[:6]))

    # cancer medicines named in notes of the latest visit but missing from the current list
    current = " ".join(m.name.lower() for m in meds)
    if src:
        seen: dict[str, str] = {}
        notes = [d for d in ctx.run.documents if d.readable and d.doc_date and d is not src
                 and not re.search(r"laboratory|medication", d.title, re.I)]
        latest_notes = sorted(notes, key=lambda d: d.doc_date, reverse=True)[:3]
        for d in latest_notes:
            for ln in d.lines:
                for m in ONCOLOGY_DRUG_RE.finditer(ln.text):
                    drug = m.group(1).lower()
                    if drug not in current and drug not in seen:
                        seen[drug] = ln.id
        for drug, lid in seen.items():
            flags.append(Flag(level="amber", category="conflict", section="medication_checklist",
                              text=f"{drug.capitalize()} is mentioned in a recent note but is not on the current medicine list. "
                                   "Cannot confirm whether it is still being taken.", source_ids=[lid]))
            ctx.emit("medication", "flag", f"{drug} in notes, not on current list")

    # allergies: report exactly what the newest documents say
    for d in sorted([d for d in ctx.run.documents if d.readable], key=lambda d: d.doc_date or "", reverse=True):
        allergy_lines = [ln for ln in d.lines if ln.section == "ALLERGIES" and ln.text != "ALLERGIES"]
        if allergy_lines:
            for ln in allergy_lines:
                allergies.append(Claim(text=ln.text, source_ids=[ln.id], quote=ln.text, kind="medication", worker="medication"))
            break
    if not allergies:
        flags.append(Flag(level="amber", category="missing", section="medication_checklist",
                          text="No allergy information was found. Please confirm allergies with the care team."))

    n_conf = sum(m.status == "confirmed" for m in meds)
    ctx.emit("medication", "finish",
             f"{len(meds)} medicines: {n_conf} confirmed, {len(meds) - n_conf} cannot confirm; "
             f"{sum(i.confirmed for i in interactions)} possible interactions found",
             source=src.doc_id if src else None, dataset=db.meta["version"])
    return meds, interactions, allergies, flags
