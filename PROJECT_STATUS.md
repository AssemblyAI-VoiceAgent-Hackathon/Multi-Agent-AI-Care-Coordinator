# Multi-Agent AI Care Coordinator: honest project status

*Written for our team and for the hackathon judges. Last updated 2026-10-14.*

This page says plainly what works, what is not built yet, and what each number means. The project document (Part 5 "CarePilot AI Features", section 8) asks us to separate mock-ups, features built in Python, model features we have tested, and future goals. This page follows that split.

---

## 1. What the product does

A patient or caregiver uploads a cancer patient's medical PDFs and types what they need, for example "Help me prepare for the oncology appointment next week". The system returns one summary with four fixed parts:

1. **Plain-language summary**: the main facts, in simple words
2. **Questions for the doctor**: based on the request and on what is missing or unclear in the records
3. **Medication and allergy checklist**: each medicine checked against drug data; "cannot confirm" when we have no data
4. **Needs clinician review**: red and amber flags for things a doctor should look at

Every statement has a link to the exact line in the uploaded document it came from. If the request describes an emergency happening now, the system stops and tells the person to call emergency services. Nothing is final until the person presses **Approve**.

It does **not** diagnose, recommend treatment, or replace a doctor or pharmacist.

## 2. Status of each part

| Part | Status | Notes |
|---|---|---|
| Upload many PDFs or text files on the web page (drag and drop) | ✅ Built and tested | Text PDFs only. Scanned images need OCR, which is not built; these files are flagged "unreadable", never guessed. |
| Ask who is submitting (patient or caregiver) | ✅ Built | A caregiver must give their relationship. Wording changes for each. |
| Emergency hard stop | ✅ Built (keyword rules) | The model-based safety classifier is wired in but needs the AMD endpoint. |
| Main Agent: care contract and routing | ✅ Built (rules) | Uses the model for intent once AMD is connected. |
| Intake Agent: choose relevant documents | ✅ Built (rules) | Same as above. |
| Document Classifier | ✅ Built (rules) | Uses the model only for documents the rules can't place. |
| Record Summarizer | ✅ Built (rules) | Once connected, the model rewrites facts in simpler words. It cannot add facts (see section 4). |
| Medication Checker | ✅ Built | Uses a **small demo drug list we wrote**, not a licensed clinical database. |
| Manager/Compiler: check every claim, 2 retries, confidence | ✅ Built and tested | |
| Approve / Improve / Reject, export after approval | ✅ Built | Without the model, "Improve" can add questions but cannot rewrite text. |
| Live dashboard: agent status and event log | ✅ Built | |
| GPU metrics from amd-smi | ⏳ Code ready, **no AMD GPU yet** | The panel says "not connected". We never show made-up numbers. |
| Open model on AMD MI300X (ROCm + vLLM) | ⏳ **Waiting for AMD access** | Only `.env` needs filling in. No code changes. |
| Baseline-vs-pipeline comparison | ⏳ Needs the model | The script exists and reports "not run" until the model is connected. |
| Login and accounts | ❌ Not built | Out of scope for this prototype (PRD non-goal). |
| Real patient data, hospital system integration | ❌ Not in scope | Synthetic data only. |

## 3. What we have measured so far

These are real results from `python -m eval.run_eval` and `pytest`, in **rules mode (no AI model)**, on one synthetic patient (Clair Armstrong, 19 PDFs):

| Measure | Result | Note |
|---|---|---|
| Time from upload to a summary ready for review | ~1.6 s | Rules mode. It will be slower with the model; we will re-measure. |
| Statements shown that could not be traced to a source | 0 of 46 | In rules mode, statements are copied from the record, so this is expected. The meaningful test is with the model. |
| Reading level (Flesch-Kincaid) | grade 6.5 | Target was about 8th grade. |
| Emergency phrases caught (keyword rules only) | 8 of 9 | **Missed:** "my heart feels like it is going to explode". This is why the safety model is needed. 0 false alarms on 3 normal requests. |
| Automated tests | 18 passing | Includes a second made-up patient (prostate cancer) and a mixed-patient upload. |

We have **not** measured the baseline comparison or any model results yet. We will not claim them until we do.

## 4. How we keep the AI honest

- **Every claim needs a source.** Each statement carries the ids of the lines it came from and a word-for-word quote. The Compiler checks that the quote really appears in those lines. It also checks that every number and date in the sentence appears in the source.
- **Bad claims go back.** If a check fails, the Main Agent sends the claim back to the agent that wrote it, at most 2 times. After that the claim is removed and listed for human review.
- **No medical advice.** Sentences with diagnosis or treatment language ("you should stop taking…") fail the check.
- **Interactions never come from the model.** Only the drug data list decides them. A medicine not on the list is "cannot confirm", and its pairs are "could not be checked". Every interaction says "Please confirm this with your doctor or pharmacist."
- **Nothing is guessed.** Missing dates, missing directions, missing reference ranges, missing findings and conflicting values are flagged, not filled in.
- **Sensitive history is protected.** Items like abuse or substance use are flagged for the clinician. The details are not repeated in the summary, and source lines are redacted in the viewer, because a caregiver may be reading.
- **Data privacy.** Documents stay on our own server. Once connected, the model runs on our own AMD endpoint; no third-party AI API is used.

## 5. Known limitations

- The keyword emergency check can miss unusual wording (measured above).
- The drug list is a small demo. It is not complete and not a clinical reference.
- Text extraction is tuned for Synthea-style PDFs. Other layouts work but may give less structured results.
- Scanned (image) PDFs are not read yet.
- Tested on synthetic data only; no clinician has reviewed the output.
- Without a model, wording is template-based and less natural.

## 6. How to run it

**Windows**, from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File run.ps1
```

**macOS, Linux, or an AMD cloud VM:**

```bash
bash run.sh
```

Both scripts install everything and start the app at http://localhost:8000; the Windows script also opens the browser. Python 3.12 must be installed. On the page:

1. Choose **I am the patient** or **I am a caregiver**.
2. Type the request, or click an example.
3. Drag the PDFs into the upload box. To try it quickly, open "Try a synthetic sample patient" instead.
4. Press **Start**. Watch the agents on the right, then click the source chips, use Improve, and press **Approve**.

To show the hard stop, click the red example "She has chest pain right now…".

**Tests and evaluation:**

```powershell
.venv\Scripts\python -m pytest -q
.venv\Scripts\python -m eval.run_eval
```

## 7. When AMD access arrives

Fill these in `.env` and restart. No code changes are needed:

```
LLM_BASE_URL=   # the vLLM / AMD endpoint, ending in /v1
LLM_API_KEY=
LLM_MODEL=
SAFETY_MODEL=   # small classifier, or the same model
AMD_SMI_PATH=   # e.g. /opt/rocm/bin/amd-smi, only if the app runs on the GPU machine
```

Then re-run `python -m eval.run_eval`, and update section 3 with the real model numbers, including any that miss the target.
