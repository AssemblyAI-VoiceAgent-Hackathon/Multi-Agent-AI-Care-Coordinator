"""FastAPI app: REST + server-sent events for the care dashboard. Run with:
    uvicorn app.main:app --reload
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import pipeline, safety, telemetry
from .agents.medication import DrugDB
from .config import ROOT, settings
from .context import RunContext
from .ingest import ingest_paths
from .llm import llm, safety_llm
from .schemas import Run, Submitter, SubmitterRole

app = FastAPI(title="Multi-Agent AI Care Coordinator")
RUNS: dict[str, RunContext] = {}
STATIC = ROOT / "web"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def _ctx(run_id: str) -> RunContext:
    ctx = RUNS.get(run_id)
    if not ctx:
        raise HTTPException(404, "run not found")
    return ctx


@app.get("/api/config")
async def config():
    return {
        "mode": "llm" if llm.enabled else "rules",
        "llm": {"configured": llm.enabled, "model": settings.llm_model or None,
                "endpoint_set": bool(settings.llm_base_url)},
        "safety_classifier": {"configured": safety_llm.enabled, "model": settings.safety_model or None},
        "amd_smi": {"configured": bool(settings.amd_smi_path)},
        "drug_data": DrugDB().meta,
        "max_retries": settings.max_retries,
        "emergency_categories": list(safety.EMERGENCY_TRIGGERS),
    }


@app.get("/api/patients")
async def patients():
    base = settings.sample_data_dir
    if not base.exists():
        return []
    out = []
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        files = sorted(d.glob("*.pdf")) + sorted(d.glob("*.txt"))
        label = re.sub(r"^[a-z]+_\d+_", "", d.name).replace("_", " ")
        out.append({"id": d.name, "label": label, "documents": len(files)})
    return out


@app.post("/api/runs")
async def create_run(
    role: SubmitterRole = Form(...),
    request: str = Form(...),
    name: str = Form(""),
    relationship: str = Form(""),
    patient_id: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    if role == SubmitterRole.caregiver and not relationship.strip():
        raise HTTPException(422, "Please say how you are related to the patient (for example: daughter, husband, friend).")
    if not request.strip():
        raise HTTPException(422, "Please type what you need help with.")
    run_id = uuid.uuid4().hex[:10]
    paths: list[Path] = []
    if files and any(f.filename for f in files):
        dest = settings.upload_dir / run_id
        dest.mkdir(parents=True, exist_ok=True)
        for f in files:
            if not f.filename:
                continue
            fname = Path(f.filename).name
            if Path(fname).suffix.lower() not in (".pdf", ".txt", ".md"):
                raise HTTPException(422, f"Unsupported file type: {fname} (use PDF or text)")
            data = await f.read()
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, f"{fname} is larger than 20 MB")
            (dest / fname).write_bytes(data)
            paths.append(dest / fname)
    elif patient_id:
        folder = (settings.sample_data_dir / patient_id).resolve()
        if settings.sample_data_dir.resolve() not in folder.parents or not folder.is_dir():
            raise HTTPException(404, "patient folder not found")
        paths = sorted(folder.glob("*.pdf")) + sorted(folder.glob("*.txt"))
    if not paths:
        raise HTTPException(422, "Upload documents or pick a sample patient.")

    docs = await asyncio.to_thread(ingest_paths, paths)
    run = Run(run_id=run_id, submitter=Submitter(role=role, name=name.strip(), relationship=relationship.strip()),
              request=request.strip(), documents=docs)
    ctx = RunContext(run)
    RUNS[run_id] = ctx
    asyncio.create_task(pipeline.run_pipeline(ctx))
    return {"run_id": run_id}


def _public(run: Run) -> dict:
    data = run.model_dump(exclude={"documents"})
    data["documents"] = [{"doc_id": d.doc_id, "filename": d.filename, "title": d.title, "doc_date": d.doc_date,
                          "facility": d.facility, "pages": d.pages, "readable": d.readable, "lines": len(d.lines)}
                         for d in run.documents]
    return data


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    ctx = _ctx(run_id)
    return {**_public(ctx.run), "agents": ctx.agent_state}


@app.get("/api/runs/{run_id}/events")
async def events(run_id: str):
    ctx = _ctx(run_id)
    q: asyncio.Queue = asyncio.Queue()
    ctx.subscribers.append(q)

    async def stream():
        try:
            for ev in ctx.run.events:  # replay history first
                yield f"data: {json.dumps({'event': ev.model_dump(), 'agents': ctx.agent_state, 'status': ctx.run.status})}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            ctx.subscribers.remove(q)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/runs/{run_id}/source/{line_id}")
async def source(run_id: str, line_id: str):
    ctx = _ctx(run_id)
    ln = ctx.lines.get(line_id)
    if not ln:
        raise HTTPException(404, "source line not found")
    doc = next(d for d in ctx.run.documents if d.doc_id == ln.doc_id)
    i = doc.lines.index(ln)
    around = doc.lines[max(0, i - 2): i + 3]
    return {"doc": {"doc_id": doc.doc_id, "filename": doc.filename, "title": doc.title, "doc_date": doc.doc_date},
            "line": {**ln.model_dump(), "text": safety.redact(ln.text)},
            "context": [{"id": x.id, "text": safety.redact(x.text), "is_target": x.id == line_id} for x in around]}


class ImproveBody(BaseModel):
    message: str


@app.post("/api/runs/{run_id}/improve")
async def improve(run_id: str, body: ImproveBody):
    ctx = _ctx(run_id)
    if ctx.run.status != "awaiting_review":
        raise HTTPException(409, f"run is {ctx.run.status}")
    await pipeline.improve(ctx, body.message)
    return await get_run(run_id)


@app.post("/api/runs/{run_id}/approve")
async def approve(run_id: str):
    ctx = _ctx(run_id)
    if ctx.run.status != "awaiting_review":
        raise HTTPException(409, f"run is {ctx.run.status}")
    pipeline.approve(ctx)
    return await get_run(run_id)


@app.post("/api/runs/{run_id}/reject")
async def reject(run_id: str):
    ctx = _ctx(run_id)
    if ctx.run.status != "awaiting_review":
        raise HTTPException(409, f"run is {ctx.run.status}")
    pipeline.reject(ctx)
    return await get_run(run_id)


@app.get("/api/runs/{run_id}/export.txt", response_class=PlainTextResponse)
async def export(run_id: str):
    run = _ctx(run_id).run
    if run.status != "approved" or not run.summary:
        raise HTTPException(409, "Only an approved summary can be exported.")
    s = run.summary
    out = [f"Care summary for {s.patient_name}", f"Approved by: {run.submitter.role.value}"
           + (f" ({run.submitter.relationship})" if run.submitter.relationship else ""),
           f"Request: {run.request}", s.disclaimer, ""]
    for sec in s.sections:
        out.append(f"{sec.title}  [confidence: {sec.confidence}]")
        for c in sec.items:
            out.append(f"  - {safety.redact(c.text)}  [sources: {', '.join(c.source_ids) or 'your request'}]")
        out.append("")
    return "\n".join(out)


@app.get("/api/telemetry")
async def telemetry_endpoint():
    return {"gpu": await telemetry.gpu_metrics(), "llm": llm.stats.as_dict(), "mode": "llm" if llm.enabled else "rules"}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
