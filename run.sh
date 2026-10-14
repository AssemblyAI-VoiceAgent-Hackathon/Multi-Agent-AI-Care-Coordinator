#!/usr/bin/env bash
# One-command start for macOS / Linux / AMD cloud VM:  bash run.sh
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
echo "Starting the Multi-Agent AI Care Coordinator at http://localhost:8000  (Ctrl+C to stop)"
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
