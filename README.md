# Multi-Agent AI Care Coordinator

AMD Developer Hackathon ACT III · Track 2: Health and Wellbeing · Team: Ishaan, Mariam, Mozzam / Askeri

The Multi-Agent AI Care Coordinator turns a cancer patient's scattered records (discharge summaries, labs, medicine lists, procedure and imaging reports) into a **source-checked care summary**. It has four fixed sections:

1. Plain-language summary (about 8th-grade reading level)
2. Questions for the doctor
3. Medication and allergy checklist (each medicine checked against drug data; "cannot confirm" when there is no match)
4. Needs clinician review (red and amber flags)

Every statement links to the exact line of the source document. Emergencies in the request cause a **hard stop**. Nothing is final until the patient or caregiver **approves** it.

> Synthetic data only (Synthea). Not medical advice. No diagnosis or treatment recommendations.

## Status: prototype, AMD not connected yet

| Part | State |
|---|---|
| 6 agents + safety gate, care contract, verification, 2-retry loop, approval flow | **Working** (rules mode) |
| Dashboard with live agent events, source viewer, approve / improve / reject, export | **Working** |
| Works for any cancer patient folder or upload; mixed-patient check | **Working** |
| Open model on AMD MI300X via ROCm + vLLM | **Ready to plug in**: fill `LLM_*` in `.env` |
| Safety classifier model on the same GPU | **Ready to plug in**: fill `SAFETY_*` |
| Live GPU metrics (amd-smi) | **Ready to plug in**: set `AMD_SMI_PATH`. Shows "not connected" until then (never simulated) |
| Drug data source | **Demo dataset** (`app/drugdata/demo_drugdb.json`). Replace with a licensed source |

**Rules mode vs model mode.** With the `.env` AMD fields empty, every agent runs on deterministic Python rules. As Part 5 of the project document notes, not every component needs a model. Once the endpoint is set, the agents use the model:

- Main Agent: intent
- Intake: document choice
- Classifier: documents the rules can't place
- Summarizer: 8th-grade rewriting
- Safety: classifier

The model is never trusted blindly. The Compiler re-checks every quote, number and date against the cited source line. A claim that fails goes back to its worker (at most 2 retries); after that it is removed and flagged for human review. Interactions come **only** from the drug data, never from the model.

**What is real and what is not yet: see [PROJECT_STATUS.md](PROJECT_STATUS.md).**

## Quick start

One command: `powershell -ExecutionPolicy Bypass -File run.ps1` (Windows) or `bash run.sh` (macOS / Linux / AMD VM).

Manual steps (Windows / PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env          # leave AMD fields empty for now
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000, then:

1. Choose **patient** or **caregiver** (a caregiver must give their relationship).
2. Type a request, or click an example.
3. Pick a sample patient or upload PDFs, then press **Start**.

Click any `D19 L12` chip to see the exact source line.

```powershell
.venv\Scripts\python -m pytest -q          # 18 tests
.venv\Scripts\python -m eval.run_eval      # pipeline vs baseline report -> data/eval_report.json
```

### Adding more cancer patients

Put each patient in their own folder under `document-testing-cancer-patient/`, for example `cancer_03_<Name>/`, as PDFs or `.txt` files. The folder appears in the patient dropdown automatically, and the eval and tests run over every folder. Ingestion is built for the Synthea PDF layout (header box, tables) and also accepts plain text.

## Plugging in AMD (when access arrives)

1. Serve one open model with vLLM on the MI300X / AMD Developer Cloud (ROCm image). For example:
   ```bash
   docker run --rm --device=/dev/kfd --device=/dev/dri --group-add video --ipc=host -p 8000:8000 \
     rocm/vllm:latest vllm serve <model-id> --max-model-len 32768
   ```
   If the hackathon gives an AMD token-factory API instead, use its OpenAI-compatible base URL and key.
2. Fill in `.env`:
   ```
   LLM_BASE_URL=http://<gpu-host>:8000/v1
   LLM_API_KEY=<key or empty>
   LLM_MODEL=<model-id>
   SAFETY_MODEL=<small classifier, or the same model>
   AMD_SMI_PATH=/opt/rocm/bin/amd-smi     # only if the app runs on the GPU host
   ```
3. Restart. The header badge turns green ("Model: … (AMD)"). The dashboard then shows calls, tokens per second and latency, plus GPU utilization and VRAM from amd-smi.
4. Run `python -m eval.run_eval` to get the real baseline-vs-pipeline numbers for the pitch.

## Architecture

```
request + documents
   │
   ▼
[Safety gate]  keyword triggers + safety model ──► HARD STOP (no summary)
   │
   ▼
[Main Agent]   intent + care contract (goal, required info, worker tasks, output format, rules)
   │
   ├──► [Intake]      relevant documents   ┐ parallel
   ├──► [Classifier]  type + date index    ┘
   │
   ├──► [Record Summarizer]   facts + quotes + source line ids, timeline   ┐ parallel
   ├──► [Medication Checker]  drug data check, interactions, cannot-confirm ┘
   │
   ▼
[Manager / Compiler]  verify every claim ─ fail ─► Main Agent routes back to worker (≤2 retries) ─► remove + human review
   │                  confidence per section, reading grade
   ▼
Patient / caregiver review:  Approve │ Improve (routed + re-verified) │ Reject
```

| File | What it does |
|---|---|
| `app/ingest.py` | PDF/text → numbered source lines (`D03:p1:L12`). Each table row is one line. |
| `app/safety.py` | Emergency gate, history-only risk flags, sensitive-history redaction |
| `app/agents/*.py` | The six agents (`main_agent`, `intake`, `classifier`, `summarizer`, `medication`, `compiler`) and cancer vocabulary (`oncology.py`) |
| `app/pipeline.py` | Orchestration, improve, approve, reject |
| `app/llm.py` | OpenAI-compatible client for the vLLM endpoint, with per-agent stats |
| `app/telemetry.py` | amd-smi adapter |
| `app/main.py` | FastAPI: REST + server-sent events |
| `web/` | Dashboard (vanilla JS, no build step) |
| `eval/run_eval.py` | PRD evaluation harness |

### Safety behaviour

| Situation | Behaviour |
|---|---|
| Current emergency in the request (chest pain, breathing, overdose, bleeding, self-harm, stroke signs) | Hard stop, no summary, emergency-number message |
| Risk only in history (past heart attack, pregnancy, kidney disease) | No stop; amber flag in "Needs clinician review" |
| Sensitive history (abuse, substance use) | Red flag for the clinician; details are **not** repeated, and source lines are redacted in the viewer, since a caregiver may be reading |
| Medicine not in drug data | "Cannot confirm"; its pairs are "could not be checked" |
| Claim not traceable | Retried at most 2 times, then removed and flagged for human review |
| Documents from different patients (different name or MRN) | Red flag |
| Missing dates, directions, findings, reference ranges | Amber flag; never guessed |

Known limitation: keyword rules can miss unusual wording. The eval reports the miss, for example "my heart feels like it is going to explode". The safety model is meant to cover this once connected.
