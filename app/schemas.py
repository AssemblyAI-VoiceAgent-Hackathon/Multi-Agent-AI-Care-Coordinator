"""Typed data shared by every agent. Source traceability lives in `source_ids`:
each id points at one line of one uploaded document (see ingest.SourceLine)."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- who is submitting ----------
class SubmitterRole(str, Enum):
    patient = "patient"
    caregiver = "caregiver"


class Submitter(BaseModel):
    role: SubmitterRole
    name: str = ""
    relationship: str = ""  # required when role == caregiver (e.g. "daughter")


# ---------- documents ----------
class SourceLine(BaseModel):
    id: str  # "D03:p1:L12"
    doc_id: str
    page: int
    line: int
    text: str
    section: str = ""  # nearest upper-case heading, e.g. "ACTIVE PRESCRIPTIONS"


class Table(BaseModel):
    doc_id: str
    page: int
    section: str
    header: list[str]
    rows: list[list[str]]
    row_line_ids: list[str]  # SourceLine id for each row


class Document(BaseModel):
    doc_id: str
    filename: str
    title: str = ""
    facility: str = ""
    doc_date: str | None = None  # ISO date, None if not found (flagged, never guessed)
    pages: int = 0
    readable: bool = True
    lines: list[SourceLine] = []
    tables: list[Table] = []
    patient_name: str = ""
    mrn: str = ""


DocType = Literal[
    "discharge_summary", "lab_report", "medication_list", "clinical_note",
    "procedure_report", "imaging_report", "emergency_summary", "pathology_report", "unknown",
]


class DocIndexEntry(BaseModel):
    doc_id: str
    filename: str
    doc_type: DocType
    doc_date: str | None
    title: str
    method: Literal["rules", "llm"] = "rules"


# ---------- care contract ----------
class WorkerAssignment(BaseModel):
    worker: Literal["intake", "classifier", "summarizer", "medication"]
    task: str


class CareContract(BaseModel):
    goal: str
    intent: Literal["appointment_prep", "explain_discharge", "medication_review", "record_overview"]
    specialty: str = ""
    audience: SubmitterRole
    required_information: list[str]
    assignments: list[WorkerAssignment]
    output_sections: list[str] = [
        "plain_language_summary", "questions_for_doctor", "medication_checklist", "needs_clinician_review",
    ]
    rules: list[str] = [
        "Every claim must cite at least one source line id.",
        "No diagnosis, no treatment advice.",
        "Missing evidence is reported as uncertainty, never filled in.",
        "Reading level about 8th grade.",
    ]


# ---------- worker outputs ----------
class Claim(BaseModel):
    text: str
    source_ids: list[str] = []
    quote: str = ""  # verbatim span from a cited line; the Compiler checks it is really there
    kind: str = "fact"  # fact | question | timeline | medication
    worker: str = "summarizer"  # who produced it, so a failed check is routed back to them
    origin: Literal["record", "user_request"] = "record"
    verified: bool | None = None
    attempts: int = 0
    note: str = ""


class MedItem(BaseModel):
    name: str  # as written in the record
    normalized: str | None = None  # ingredient in the drug data source
    drug_class: str | None = None
    directions: str = ""
    started: str | None = None
    status: Literal["confirmed", "cannot_confirm"]
    source_ids: list[str] = []
    note: str = ""


class Interaction(BaseModel):
    drugs: list[str]
    ingredients: list[str] = []
    severity: Literal["major", "moderate", "minor", "unknown"]
    description: str
    confirmed: bool  # True only if the pair is present in the drug data source
    source_ids: list[str] = []
    note: str = "Please confirm this with your doctor or pharmacist."


class Flag(BaseModel):
    level: Literal["red", "amber"]
    category: Literal[
        "history_risk", "interaction", "cannot_confirm", "conflict", "missing", "unverified_claim",
        "low_confidence", "lab_no_reference",
    ]
    text: str
    section: str
    source_ids: list[str] = []


Confidence = Literal["high", "medium", "low"]


class Section(BaseModel):
    key: str
    title: str
    confidence: Confidence
    items: list[Claim] = []


class CareSummary(BaseModel):
    audience: SubmitterRole
    patient_name: str
    sections: list[Section]
    medications: list[MedItem] = []
    allergies: list[Claim] = []
    interactions: list[Interaction] = []
    flags: list[Flag] = []
    timeline: list[Claim] = []
    reading_grade: float | None = None
    removed_claims: list[Claim] = []
    disclaimer: str = (
        "Synthetic data only. This summary organizes what is written in the uploaded records. "
        "It is not a diagnosis or medical advice. Always check with your doctor or pharmacist."
    )


# ---------- run state ----------
RunStatus = Literal[
    "running", "hard_stop", "awaiting_review", "approved", "rejected", "error",
]


class Event(BaseModel):
    ts: str = Field(default_factory=now)
    agent: str
    type: Literal["start", "finish", "flag", "retry", "info", "error", "hard_stop", "status"]
    message: str
    data: dict = {}


class Run(BaseModel):
    run_id: str
    created: str = Field(default_factory=now)
    submitter: Submitter
    request: str
    status: RunStatus = "running"
    mode: Literal["rules", "llm"] = "rules"
    documents: list[Document] = []
    index: list[DocIndexEntry] = []
    contract: CareContract | None = None
    summary: CareSummary | None = None
    hard_stop_message: str | None = None
    events: list[Event] = []
    chat: list[dict] = []
    timings: dict[str, float] = {}
    llm_stats: dict = {}
