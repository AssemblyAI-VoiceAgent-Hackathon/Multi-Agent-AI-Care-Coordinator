"""PDF / text ingestion with provenance.

Every visual row of every page becomes a SourceLine with a stable id (D03:p1:L12). Tables are
extracted cell-by-cell and each table row is stored as ONE source line ("cell | cell | cell"),
so a claim like "Creatinine 2.43 mg/dL" can point at exactly the row it came from.
"""
from __future__ import annotations

import re
from pathlib import Path

import pymupdf

from .schemas import Document, SourceLine, Table

DATE_RE = re.compile(r"\b(19|20)\d{2}-\d{2}-\d{2}\b")
HEADING_RE = re.compile(r"^[A-Z][A-Z0-9 ()&/,\-]{3,}$")
FOOTER_RE = re.compile(r"SYNTHETIC RECORD generated with Synthea|^Page \d+ of \d+$")

KNOWN_TITLES = (
    "Discharge Summary", "Laboratory Report", "Medication and Allergy List", "Clinical Note",
    "Procedure Report", "Imaging Report", "Emergency Department Visit Summary", "Pathology Report",
)

# label on the left of the header box -> which field it gives us
DATE_LABELS = ("List as of", "Discharged", "Collected", "Performed", "Visit date", "Arrived", "Date")


def _rows_from_words(page: pymupdf.Page, skip_rects: list[pymupdf.Rect], ytol: float = 3.0, gap: float = 14.0):
    words = [w for w in page.get_text("words") if not any(pymupdf.Rect(w[:4]).intersects(r) for r in skip_rects)]
    words.sort(key=lambda w: (round(w[3]), w[0]))
    rows: list[dict] = []
    for w in words:
        if rows and abs(rows[-1]["y"] - w[3]) <= ytol:
            rows[-1]["w"].append(w)
        else:
            rows.append({"y": w[3], "w": [w]})
    out = []
    for r in rows:
        ws = sorted(r["w"], key=lambda w: w[0])
        s = ws[0][4]
        for a, b in zip(ws, ws[1:]):
            s += (" | " if b[0] - a[2] > gap else " ") + b[4]
        out.append((r["y"], s))
    return out


def ingest_pdf(path: Path, doc_id: str) -> Document:
    doc = Document(doc_id=doc_id, filename=path.name)
    try:
        pdf = pymupdf.open(path)
    except Exception:  # corrupted / not a PDF
        doc.readable = False
        return doc

    doc.pages = len(pdf)
    line_no = 0
    section = ""
    for pno, page in enumerate(pdf, start=1):
        items: list[tuple[float, str, Table | None, int]] = []  # (y, text, table, row_index)
        tables = page.find_tables().tables
        rects = [pymupdf.Rect(t.bbox) for t in tables]
        for t in tables:
            data = [[(c or "").replace("\n", " ").strip() for c in row] for row in t.extract()]
            if not data:
                continue
            header, body = data[0], data[1:]
            tb = Table(doc_id=doc_id, page=pno, section="", header=header, rows=[], row_line_ids=[])
            # y position of each body row, so table rows interleave correctly with text
            row_ys = [r.bbox[1] for r in t.rows[1:]] if len(t.rows) == len(data) else [t.bbox[1]] * len(body)
            items.append((t.bbox[1] - 0.1, " | ".join(header), None, -1))
            for i, (row, y) in enumerate(zip(body, row_ys)):
                tb.rows.append(row)
                items.append((y, " | ".join(c for c in row if c), tb, i))
            doc.tables.append(tb)
        for y, text in _rows_from_words(page, rects):
            items.append((y, text, None, -1))
        items.sort(key=lambda it: it[0])

        for _, text, tb, ri in items:
            text = text.strip()
            if not text or FOOTER_RE.search(text):
                continue
            if HEADING_RE.match(text) and "|" not in text:
                section = text
            line_no += 1
            lid = f"{doc_id}:p{pno}:L{line_no}"
            doc.lines.append(SourceLine(id=lid, doc_id=doc_id, page=pno, line=line_no, text=text, section=section))
            if tb is not None:
                if not tb.section:
                    tb.section = section
                tb.row_line_ids.append(lid)

    if not doc.lines:
        doc.readable = False  # likely a scanned image; OCR is a later step
        return doc

    _header_fields(doc)
    return doc


def ingest_text(path: Path, doc_id: str) -> Document:
    doc = Document(doc_id=doc_id, filename=path.name, pages=1)
    section = ""
    for i, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        text = raw.strip()
        if not text:
            continue
        if HEADING_RE.match(text):
            section = text
        doc.lines.append(SourceLine(id=f"{doc_id}:p1:L{i}", doc_id=doc_id, page=1, line=i, text=text, section=section))
    doc.readable = bool(doc.lines)
    _header_fields(doc)
    return doc


def _header_fields(doc: Document) -> None:
    first = doc.lines[:12]
    head_parts = [p.strip() for ln in doc.lines[:4] for p in ln.text.split("|")]
    head_parts = head_parts[: head_parts.index("Patient")] if "Patient" in head_parts else head_parts
    kind = next((p for p in head_parts if p in KNOWN_TITLES), "")
    rest = [p for p in head_parts if p != kind]
    doc.facility = next((p for p in rest if p.isupper() or p.endswith(("Clinic", "LLC", "PC"))), rest[0] if rest else "")
    subtitle = next((p for p in rest if p != doc.facility), "")
    doc.title = f"{kind}: {subtitle}" if kind and subtitle else (kind or subtitle)
    for ln in first:
        parts = [p.strip() for p in ln.text.split("|")]
        for i, p in enumerate(parts[:-1]):
            if p == "Patient" and not doc.patient_name:
                doc.patient_name = parts[i + 1]
            if p == "MRN" and not doc.mrn:
                doc.mrn = parts[i + 1]
    # document date: first labelled date in the header area
    for ln in doc.lines[:20]:
        parts = [p.strip() for p in ln.text.split("|")]
        for i, p in enumerate(parts[:-1]):
            if p in DATE_LABELS:
                m = DATE_RE.search(parts[i + 1])
                if m:
                    doc.doc_date = m.group(0)
                    return
    # never guess from body text; the filename date is used only if it is explicit
    m = DATE_RE.search(doc.filename)
    doc.doc_date = m.group(0) if m else None


def ingest_paths(paths: list[Path]) -> list[Document]:
    docs = []
    for i, p in enumerate(sorted(paths), start=1):
        did = f"D{i:02d}"
        if p.suffix.lower() == ".pdf":
            docs.append(ingest_pdf(p, did))
        elif p.suffix.lower() in (".txt", ".md"):
            docs.append(ingest_text(p, did))
        else:
            docs.append(Document(doc_id=did, filename=p.name, readable=False))
    return docs


def line_lookup(docs: list[Document]) -> dict[str, SourceLine]:
    return {ln.id: ln for d in docs for ln in d.lines}
