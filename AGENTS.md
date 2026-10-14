# Team and coding-agent guide

Read this first, whether you are a teammate (Ishaan, Mariam, Mozzam / Askeri) or a coding agent working for one (Claude Code, Codex, Cursor, Copilot). It covers what to install, how to run the project, and the rules for changing it.

Project: **Multi-Agent AI Care Coordinator**, AMD Developer Hackathon ACT III, Track 2 (Health). Submission deadline: **18 Oct 2026, 15:00 UTC**.
Full spec: `AMD_ACT_3_updated.pdf`. Honest status of each part: `PROJECT_STATUS.md`.

## 1. Install (once)

| Tool | Version | Windows | macOS / Linux |
|---|---|---|---|
| Python | 3.12 | `winget install Python.Python.3.12` | `brew install python@3.12` / `apt install python3.12 python3.12-venv` |
| Git | any recent | `winget install Git.Git` | preinstalled / `apt install git` |
| GitHub CLI (for PRs) | any recent | `winget install GitHub.cli` | `brew install gh` / see cli.github.com |
| Node.js | only if you touch `web/app.js` (for `node --check`) | `winget install OpenJS.NodeJS.LTS` | `brew install node` |

Then:

```bash
git clone https://github.com/AssemblyAI-VoiceAgent-Hackathon/Multi-Agent-AI-Care-Coordinator.git
cd Multi-Agent-AI-Care-Coordinator
gh auth login                      # once, so you can open PRs
```

## 2. Run

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File run.ps1
```
```bash
# macOS / Linux / AMD cloud VM
bash run.sh
```

Each script creates `.venv`, installs `requirements.txt`, copies `.env.example` to `.env`, and starts http://localhost:8000.

To run manually instead:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
cp .env.example .env
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

**AMD settings:** leave the `LLM_*`, `SAFETY_*` and `AMD_SMI_PATH` fields in `.env` empty until the team has AMD access; the app runs in "rules mode" without them. **Never commit `.env` or any API key.**

## 3. Test before every PR

```bash
.venv/Scripts/python -m pytest -q          # must pass (currently 18 tests)
.venv/Scripts/python -m eval.run_eval      # optional: pipeline/baseline/emergency report
node --check web/app.js                    # if you changed the front end
```

## 4. Map of the code

| Path | What it is | Owner (PRD proposal) |
|---|---|---|
| `app/ingest.py` | PDF/text to numbered source lines (`D03:p1:L12`) | Mozzam / Askeri |
| `app/safety.py` | Emergency hard stop, history flags, redaction of sensitive history | Ishaan |
| `app/agents/main_agent.py` | Care contract, routing, retry limit | Ishaan |
| `app/agents/intake.py`, `classifier.py`, `summarizer.py`, `medication.py` | The four Worker agents | Mozzam / Askeri |
| `app/agents/oncology.py` | Cancer vocabulary (keeps the system generic for any cancer patient) | Mozzam / Askeri |
| `app/agents/compiler.py` | Claim verification, retries, confidence | Mariam |
| `app/pipeline.py` | Orchestration, improve, approve, reject | Ishaan / Mariam |
| `app/llm.py`, `app/config.py`, `app/telemetry.py` | AMD vLLM client, settings, amd-smi | Ishaan |
| `app/drugdata/demo_drugdb.json` | **Demo** drug data (not clinical) | Mozzam / Askeri |
| `app/main.py` | FastAPI REST + server-sent events | everyone |
| `web/` | Dashboard: plain HTML/CSS/JS, no build step | Mozzam / Askeri |
| `eval/run_eval.py` | Evaluation harness | Mariam |
| `tests/` | pytest suite | everyone |
| `document-testing-cancer-patient/<patient>/` | Synthetic Synthea patients, one folder each | everyone |

## 5. Rules for changes (people and agents)

1. **Never push to `main`.** For every change:
   ```bash
   git checkout main && git pull
   git checkout -b <type>/<short-name>      # e.g. feat/amd-endpoint, fix/lab-parsing, docs/readme
   # ...make changes, run the tests...
   git add <files> && git commit -m "Short summary of the change"
   git push -u origin HEAD
   gh pr create --fill --base main          # then ask a teammate to review
   ```
   Keep PRs small and about one thing. Say in the PR description what you tested.
2. **Synthetic data only.** Never add real patient records.
3. **No secrets in git.** Keys go in `.env` (ignored). Only `.env.example` is committed, with empty values.
4. **Stay honest.** Do not show simulated GPU numbers as real. Do not report targets as results. If you measure something, update `PROJECT_STATUS.md` section 3 with the real number, even if it misses the target.
5. **Keep the safety rules:**
   - every claim shown must have `source_ids` that the Compiler can verify
   - no diagnosis or treatment advice
   - unknown medicines stay "cannot confirm"
   - an emergency in the request means a hard stop
   - sensitive history stays redacted
6. **Keep it generic.** Nothing may be hard-coded to one patient (for example Clair). New cancer types, drugs or document layouts go in `oncology.py` / `ingest.py`, with a test.
7. **Match the existing style.** Python 3.12 with type hints and Pydantic models. The front end stays plain JS unless the team agrees to move to React (see below).
8. If you add a dependency, add it to `requirements.txt` and say why in the PR.

## 6. Open tasks (pick one, open a PR)

- [ ] **AMD:** serve the chosen open model with vLLM on MI300X / AMD Developer Cloud, fill in `.env`, run the eval, and update `PROJECT_STATUS.md` (Ishaan)
- [ ] **Safety model:** choose and connect the small safety classifier, and re-run the emergency recall (Ishaan)
- [ ] **Drug data:** replace the demo file with a licensed or open source, keeping the "cannot confirm" behaviour (Mozzam / Askeri)
- [ ] **Patients:** add more synthetic cancer patients (other cancer types) and check that the tests still pass (everyone)
- [ ] **Baseline:** run the single-prompt baseline vs the pipeline once the model is live (Mariam)
- [ ] **Submission:** demo video, slides and cover image for lablab.ai (everyone)
- [ ] Optional: OCR for scanned PDFs; move the UI to React + Tailwind only if the dashboard grows beyond one page
