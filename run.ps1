# One-command start for Windows:  powershell -ExecutionPolicy Bypass -File run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
}
Write-Host "Installing requirements..."
.venv\Scripts\python -m pip install -q -r requirements.txt
if (-not (Test-Path ".env")) { Copy-Item .env.example .env }
Write-Host "Starting the Multi-Agent AI Care Coordinator at http://localhost:8000  (Ctrl+C to stop)"
Start-Process "http://localhost:8000"
.venv\Scripts\python -m uvicorn app.main:app --port 8000
