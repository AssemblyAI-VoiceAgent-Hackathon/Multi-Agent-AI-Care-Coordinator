"""Runtime configuration, read from environment / .env.

Every AMD-related field is intentionally empty by default. When LLM_BASE_URL is empty the
pipeline runs in "rules" mode (deterministic Python, no model). Fill the fields in once the
AMD Developer Cloud / token factory endpoint is available and the agents switch to the model.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default  # empty value in .env = use the default


@dataclass(frozen=True)
class Settings:
    # --- AMD / vLLM endpoint (OpenAI-compatible). Leave empty until access is granted. ---
    llm_base_url: str = field(default_factory=lambda: _env("LLM_BASE_URL"))  # e.g. http://<mi300x-host>:8000/v1
    llm_api_key: str = field(default_factory=lambda: _env("LLM_API_KEY"))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL"))  # e.g. the checkpoint served by vLLM
    llm_timeout_s: float = field(default_factory=lambda: float(_env("LLM_TIMEOUT_S", "120")))

    # --- Small safety classifier on the same GPU (optional; can be the same endpoint). ---
    safety_base_url: str = field(default_factory=lambda: _env("SAFETY_BASE_URL"))
    safety_api_key: str = field(default_factory=lambda: _env("SAFETY_API_KEY"))
    safety_model: str = field(default_factory=lambda: _env("SAFETY_MODEL"))

    # --- Hardware telemetry. Path to amd-smi on the MI300X host; empty = not connected. ---
    amd_smi_path: str = field(default_factory=lambda: _env("AMD_SMI_PATH"))

    # --- Pipeline behaviour ---
    max_retries: int = field(default_factory=lambda: int(_env("MAX_RETRIES", "2")))
    target_grade: float = field(default_factory=lambda: float(_env("TARGET_GRADE", "8")))
    sample_data_dir: Path = field(
        default_factory=lambda: Path(_env("SAMPLE_DATA_DIR", str(ROOT / "document-testing-cancer-patient")))
    )
    upload_dir: Path = field(default_factory=lambda: Path(_env("UPLOAD_DIR", str(ROOT / "data" / "uploads"))))

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_base_url and self.llm_model)

    @property
    def safety_model_enabled(self) -> bool:
        return bool(self.safety_base_url and self.safety_model)


settings = Settings()
