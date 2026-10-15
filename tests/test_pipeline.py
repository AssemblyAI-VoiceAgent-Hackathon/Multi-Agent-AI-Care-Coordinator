"""Run: .venv/Scripts/python -m pytest -q"""
import asyncio
from pathlib import Path

import pymupdf
import pytest

from app import pipeline, report, safety
from app.agents.compiler import verify
from app.agents.medication import DrugDB
from app.context import RunContext
from app.ingest import ingest_paths, line_lookup
from app.schemas import Claim, Run, Submitter

SAMPLE_ROOT = Path(__file__).resolve().parent.parent / "document-testing-cancer-patient"
PATIENTS = sorted(p for p in SAMPLE_ROOT.glob("*") if p.is_dir()) if SAMPLE_ROOT.exists() else []
needs_sample = pytest.mark.skipif(not PATIENTS, reason="no sample patient folders")


def make_run(paths, request="Help me prepare for the oncology appointment", role="caregiver"):
    docs = ingest_paths(paths)
    run = Run(run_id="test", submitter=Submitter(role=role, relationship="daughter"), request=request, documents=docs)
    return RunContext(run)


# ---------- safety ----------
@pytest.mark.parametrize("text", [
    "My mother has chest pain right now", "he can't breathe", "I think she took too many pills, overdose",
    "I want to kill myself", "her face is drooping and slurred speech", "heavy bleeding after surgery",
])
def test_emergency_triggers(text):
    assert safety.keyword_emergency(text)


@pytest.mark.parametrize("text", [
    "Help me prepare for my oncology appointment", "Explain the discharge summary in simple words",
    "Check my medicines for interactions",
])
def test_no_false_emergency(text):
    assert not safety.keyword_emergency(text)


def test_redact_hides_sensitive_history():
    out = safety.redact("anxiety (finding), victim of intimate partner abuse (finding), sprain")
    assert "abuse" not in out and "clinician only" in out


# ---------- verification ----------
def _lines(tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("LAB RESULTS\nCreatinine | 2.43 | mg/dL\nCollected 2026-09-25\n", encoding="utf-8")
    docs = ingest_paths([f])
    return line_lookup(docs)


def test_verify_accepts_traceable_claim(tmp_path):
    lines = _lines(tmp_path)
    ok, why = verify(Claim(text="Creatinine was 2.43 mg/dL.", source_ids=["D01:p1:L2"], quote="2.43"), lines)
    assert ok, why


def test_verify_rejects_invented_number(tmp_path):
    lines = _lines(tmp_path)
    ok, why = verify(Claim(text="Creatinine was 3.1 mg/dL.", source_ids=["D01:p1:L2"], quote="Creatinine"), lines)
    assert not ok and "3.1" in why


def test_verify_rejects_missing_source_and_advice(tmp_path):
    lines = _lines(tmp_path)
    assert not verify(Claim(text="Creatinine is fine.", source_ids=[]), lines)[0]
    assert not verify(Claim(text="Creatinine: 2.43. You should stop taking aspirin.", source_ids=["D01:p1:L2"],
                            quote="2.43"), lines)[0]
    assert not verify(Claim(text="Creatinine 2.43", source_ids=["D09:p1:L1"]), lines)[0]


# ---------- full pipeline on every sample cancer patient ----------
@needs_sample
@pytest.mark.parametrize("folder", PATIENTS, ids=[p.name for p in PATIENTS])
def test_pipeline_every_patient(folder):
    ctx = make_run(sorted(folder.glob("*.pdf")))
    asyncio.run(pipeline.run_pipeline(ctx))
    run = ctx.run
    assert run.status == "awaiting_review", [e.message for e in run.events if e.type == "error"]
    s = run.summary
    assert [x.key for x in s.sections] == ["plain_language_summary", "questions_for_doctor",
                                           "medication_checklist", "needs_clinician_review"]
    for sec in s.sections[:3]:  # every shown claim is verified and source-linked
        for c in sec.items:
            assert c.verified and (c.source_ids or c.origin == "user_request"), c
    assert all(sid in ctx.lines for sec in s.sections for c in sec.items for sid in c.source_ids)
    assert {e.agent for e in run.events} >= {"safety", "main", "intake", "classifier", "summarizer", "medication", "compiler"}


@needs_sample
def test_hard_stop_produces_no_summary():
    ctx = make_run(sorted(PATIENTS[0].glob("*.pdf")), request="She has chest pain right now")
    asyncio.run(pipeline.run_pipeline(ctx))
    assert ctx.run.status == "hard_stop" and ctx.run.summary is None


@needs_sample
def test_medication_checks_and_approval_flow():
    folder = next((p for p in PATIENTS if "Clair" in p.name), PATIENTS[0])
    ctx = make_run(sorted(folder.glob("*.pdf")))
    asyncio.run(pipeline.run_pipeline(ctx))
    s = ctx.run.summary
    if "Clair" in folder.name:
        pairs = {frozenset(i.ingredients) for i in s.interactions if i.confirmed}
        assert frozenset({"clopidogrel", "prasugrel"}) in pairs
        assert any("Tamoxifen" in f.text for f in s.flags)  # in notes, not on current list
    asyncio.run(pipeline.improve(ctx, "add a question about my allergy history"))
    q = next(x for x in ctx.run.summary.sections if x.key == "questions_for_doctor").items[-1]
    assert "allergy" in q.text.lower() and q.verified
    assert ctx.run.status == "awaiting_review"
    pipeline.approve(ctx)
    assert ctx.run.status == "approved"

    # the approved summary downloads as a PDF with its citations, disclaimer and source list
    pdf = report.render_pdf(ctx.run)
    assert pdf.startswith(b"%PDF")
    text = "".join(page.get_text() for page in pymupdf.open("pdf", pdf))
    assert ctx.run.summary.patient_name in text and "not medical advice" in text.lower()
    assert "Source documents" in text and ctx.run.documents[0].doc_id in text
    assert "intimate partner" not in text.lower() and "misuses drugs" not in text.lower()  # sensitive history stays redacted


# ---------- generic: works for a different (text) cancer patient ----------
def _write(p: Path, name: str, mrn: str, body: str) -> Path:
    p.write_text(f"CITY HOSPITAL | Clinical Note\nPatient | {name} | MRN | {mrn}\nDate of birth | 1960-01-01 (age 66 at this date)\n"
                 f"Visit date | 2026-08-01 10:00\n{body}\n", encoding="utf-8")
    return p


def test_other_patient_and_mixed_upload(tmp_path):
    a = _write(tmp_path / "a.txt", "John Doe", "MRN-1",
               "ACTIVE PROBLEMS AT TIME OF VISIT\nMalignant neoplasm of prostate | 2025-03-01\nMedications\nleuprolide injection")
    ctx = make_run([a], request="prepare for my oncology visit", role="patient")
    asyncio.run(pipeline.run_pipeline(ctx))
    assert ctx.run.status == "awaiting_review"
    assert ctx.run.summary.patient_name == "John Doe"
    b = _write(tmp_path / "b.txt", "Jane Roe", "MRN-2", "Some note")
    ctx2 = make_run([a, b], role="patient")
    asyncio.run(pipeline.run_pipeline(ctx2))
    assert any(f.level == "red" and "more than one patient" in f.text for f in ctx2.run.summary.flags)


def test_drug_db_unknown_is_cannot_confirm():
    db = DrugDB()
    assert db.match("Clopidogrel 75 MG Oral Tablet") == "clopidogrel"
    assert db.match("ribociclib 200 mg oral tablet") is None
