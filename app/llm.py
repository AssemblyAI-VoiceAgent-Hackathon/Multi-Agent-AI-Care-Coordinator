"""OpenAI-compatible client for the model served by vLLM on AMD (MI300X / Developer Cloud).

All six agents share ONE endpoint and ONE model, as the PRD specifies. If LLM_BASE_URL /
LLM_MODEL are empty, `enabled` is False and every agent uses its rules-based path instead.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

import httpx

from .config import settings


@dataclass
class LLMStats:
    calls: int = 0
    failures: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_latency_s: float = 0.0
    last_latency_s: float = 0.0
    last_tokens_per_s: float = 0.0
    per_agent: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        avg = self.total_latency_s / self.calls if self.calls else 0.0
        return {
            "calls": self.calls, "failures": self.failures,
            "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
            "avg_latency_s": round(avg, 3), "last_latency_s": round(self.last_latency_s, 3),
            "last_tokens_per_s": round(self.last_tokens_per_s, 1), "per_agent": self.per_agent,
        }


class LLMError(RuntimeError):
    pass


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.stats = LLMStats()

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.model)

    async def chat(self, agent: str, system: str, user: str, *, max_tokens: int = 1200,
                   temperature: float = 0.1, json_mode: bool = False) -> str:
        if not self.enabled:
            raise LLMError("LLM endpoint not configured")
        body: dict = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
                if r.status_code == 400 and json_mode:  # server without response_format support
                    body.pop("response_format")
                    r = await client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
                r.raise_for_status()
                data = r.json()
        except Exception as e:
            self.stats.failures += 1
            raise LLMError(str(e)) from e
        dt = time.perf_counter() - t0
        usage = data.get("usage") or {}
        ct = int(usage.get("completion_tokens") or 0)
        s = self.stats
        s.calls += 1
        s.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        s.completion_tokens += ct
        s.total_latency_s += dt
        s.last_latency_s = dt
        s.last_tokens_per_s = ct / dt if dt > 0 else 0.0
        pa = s.per_agent.setdefault(agent, {"calls": 0, "latency_s": 0.0, "completion_tokens": 0})
        pa["calls"] += 1
        pa["latency_s"] = round(pa["latency_s"] + dt, 3)
        pa["completion_tokens"] += ct
        return data["choices"][0]["message"]["content"] or ""

    async def chat_json(self, agent: str, system: str, user: str, **kw) -> dict:
        text = await self.chat(agent, system + "\nRespond with one JSON object only.", user, json_mode=True, **kw)
        return parse_json(text)


def parse_json(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()  # reasoning models
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise LLMError("model did not return JSON")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise LLMError(f"bad JSON from model: {e}") from e


llm = LLMClient(settings.llm_base_url, settings.llm_api_key, settings.llm_model, settings.llm_timeout_s)
safety_llm = LLMClient(
    settings.safety_base_url or settings.llm_base_url,
    settings.safety_api_key or settings.llm_api_key,
    settings.safety_model,
    30.0,
)
