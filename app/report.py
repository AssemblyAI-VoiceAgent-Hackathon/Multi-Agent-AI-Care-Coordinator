"""Downloadable PDF of an approved care summary, built with PyMuPDF (no extra dependency).

The PDF shows the same content as the dashboard: every statement keeps its source IDs, sensitive
history is redacted, and the disclaimer is on the first page. A list of the source documents at
the end lets the reader match each ID (e.g. D03 L12) to the original file.
"""
from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from html import escape

import pymupdf

from . import safety
from .config import settings
from .schemas import CareSummary, Claim, Run

CSS = """
* { font-family: sans-serif; }
body { font-size: 10pt; color: #1f2933; }
h1 { font-size: 17pt; color: #1f5f8b; margin: 0 0 2pt 0; }
h2 { font-size: 12pt; color: #1f2933; margin: 14pt 0 4pt 0; border-bottom: 1px solid #e4e7eb; }
h3 { font-size: 10.5pt; margin: 8pt 0 3pt 0; }
p { margin: 0 0 4pt 0; }
.meta { color: #616e7c; font-size: 9pt; }
.note { color: #616e7c; font-size: 8.5pt; }
.disclaimer { background-color: #f7f9fb; border: 1px solid #e4e7eb; padding: 6pt; font-size: 9pt; margin: 8pt 0; }
.conf { color: #616e7c; font-size: 8.5pt; font-weight: normal; }
.src { color: #1f5f8b; font-size: 8pt; }
.red { color: #b42318; font-weight: bold; }
.amber { color: #93590b; font-weight: bold; }
.ok { color: #1d6b46; font-weight: bold; }
ul { margin: 0 0 4pt 0; }
li { margin-bottom: 3pt; }
table { border-collapse: collapse; width: 100%; margin: 2pt 0 6pt 0; }
th { background-color: #eef4f9; text-align: left; font-size: 9pt; padding: 3pt; border: 1px solid #e4e7eb; }
td { font-size: 9pt; padding: 3pt; border: 1px solid #e4e7eb; vertical-align: top; }
"""


def _t(text: str) -> str:
    return escape(safety.redact(text or ""))


def _src(ids: list[str]) -> str:
    if not ids:
        return ""
    short = ", ".join(re.sub(r":p\d+:", " ", i) for i in ids)  # D03:p1:L12 -> D03 L12, as on the dashboard
    return f' <span class="src">[{escape(short)}]</span>'


def _claim(c: Claim) -> str:
    src = ' <span class="src">[your request]</span>' if c.origin == "user_request" else _src(c.source_ids)
    note = f'<br/><span class="note">{_t(c.note)}</span>' if c.note else ""
    return f"<li>{_t(c.text)}{src}{note}</li>"


def _meds(s: CareSummary) -> str:
    rows = "".join(
        f"<tr><td>{_t(m.name)}{_src(m.source_ids)}</td><td>{_t(m.directions or 'Not recorded')}</td>"
        f"<td>{escape(m.started or '')}</td><td>"
        + (f'<span class="ok">Checked</span> {escape(m.drug_class or "")}' if m.status == "confirmed"
           else '<span class="amber">Cannot confirm</span>')
        + "</td></tr>"
        for m in s.medications
    )
    out = ("<table><tr><th>Medicine</th><th>Directions</th><th>Started</th><th>Drug data check</th></tr>"
           f"{rows}</table>") if rows else "<p>No medicines found in the documents.</p>"
    inter = "".join(
        f'<li><span class="{"red" if i.severity == "major" else "amber"}">{escape(i.severity)}:</span> '
        f"{_t(' + '.join(i.drugs))}. {_t(i.description)} <i>{_t(i.note)}</i>{_src(i.source_ids)}</li>"
        for i in s.interactions if i.confirmed
    )
    out += f"<h3>Possible interactions</h3><ul>{inter or '<li>None found in the drug data source.</li>'}</ul>"
    unchecked = sum(1 for i in s.interactions if not i.confirmed)
    if unchecked:
        out += (f'<p class="note">{unchecked} pair(s) could not be checked: cannot confirm. '
                "Please ask your doctor or pharmacist.</p>")
    allergies = "".join(_claim(c) for c in s.allergies)
    out += f"<h3>Allergies</h3><ul>{allergies or '<li>No allergy information found.</li>'}</ul>"
    return out


def report_html(run: Run) -> str:
    s = run.summary
    assert s is not None
    who = run.submitter
    approver = who.role.value + (f" ({who.relationship})" if who.relationship else "") + (f", {who.name}" if who.name else "")
    made_with = f"AI model {settings.llm_model}" if run.mode == "llm" else "rule-based agents (no AI model)"
    parts = [
        f"<h1>Care summary: {_t(s.patient_name)}</h1>",
        f'<p class="meta">Request: "{_t(run.request)}"</p>',
        f'<p class="meta">Approved by the {escape(approver)} · prepared {datetime.now(timezone.utc):%d %b %Y} · '
        f"made with {escape(made_with)}" + (f" · reading grade {s.reading_grade}" if s.reading_grade is not None else "") + "</p>",
        f'<div class="disclaimer">{escape(s.disclaimer)} <b>In an emergency, call your local emergency number.</b></div>',
        '<p class="note">Numbers in brackets, such as [D03 L12], point to the document and line each statement '
        "came from. The documents are listed at the end.</p>",
    ]
    for sec in s.sections:
        parts.append(f'<h2>{escape(sec.title)} <span class="conf">({escape(sec.confidence)} confidence)</span></h2>')
        if sec.key == "medication_checklist":
            parts.append(_meds(s))
        elif sec.key == "needs_clinician_review":
            items = "".join(
                f'<li><span class="{lvl}">{"Needs attention" if lvl == "red" else "Check"}:</span> {_t(c.text)}{_src(c.source_ids)}</li>'
                for c in sec.items for lvl in [c.kind.split(":")[-1]]
            )
            parts.append(f"<ul>{items or '<li>Nothing flagged.</li>'}</ul>")
        else:
            parts.append(f"<ul>{''.join(_claim(c) for c in sec.items) or '<li>Nothing found in the documents.</li>'}</ul>")
    if s.timeline:
        parts.append(f"<h2>Timeline</h2><ul>{''.join(_claim(c) for c in s.timeline)}</ul>")
    if s.removed_claims:
        parts.append(f'<p class="note">{len(s.removed_claims)} statement(s) were left out because they could not be '
                     "traced to the documents.</p>")
    docs = "".join(
        f"<tr><td>{escape(d.doc_id)}</td><td>{_t(d.title or d.filename)}</td><td>{escape(d.doc_date or 'no date')}</td>"
        f"<td>{escape(d.filename)}</td></tr>"
        for d in run.documents
    )
    parts.append(f"<h2>Source documents</h2><table><tr><th>ID</th><th>Title</th><th>Date</th><th>File</th></tr>{docs}</table>")
    return "<body>" + "".join(parts) + "</body>"


def render_pdf(run: Run) -> bytes:
    story = pymupdf.Story(html=report_html(run), user_css=CSS)
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    page_rect = pymupdf.paper_rect("a4")
    where = page_rect + (50, 50, -50, -60)
    more = True
    while more:
        dev = writer.begin_page(page_rect)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()

    doc = pymupdf.open("pdf", buf.getvalue())
    name = safety.redact(run.summary.patient_name if run.summary else "")
    for i, page in enumerate(doc):
        page.insert_text((50, page_rect.height - 30),
                         f"Care summary - {name} - synthetic data, not medical advice - page {i + 1} of {doc.page_count}",
                         fontsize=7.5, color=(0.38, 0.43, 0.49))
    doc.set_metadata({"title": f"Care summary - {name}", "creator": "Multi-Agent AI Care Coordinator"})
    return doc.tobytes(garbage=3, deflate=True)


def pdf_filename(run: Run) -> str:
    name = run.summary.patient_name if run.summary else "patient"
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "patient"
    return f"care-summary-{slug}.pdf"
