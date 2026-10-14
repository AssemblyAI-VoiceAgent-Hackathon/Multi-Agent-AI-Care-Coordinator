# CPU image for the app/orchestrator. The model itself runs in a separate vLLM (ROCm) container
# on the AMD GPU host - point LLM_BASE_URL at it. See README "Deploying on AMD".
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY web ./web
COPY eval ./eval
COPY document-testing-cancer-patient ./document-testing-cancer-patient
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
