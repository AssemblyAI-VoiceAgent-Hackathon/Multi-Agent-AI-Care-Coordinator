"""amd-smi adapter for the dashboard's hardware panel.

Per the project doc (Part 5, Feature 10): GPU numbers are shown ONLY when real hardware is connected.
With AMD_SMI_PATH empty this returns {"connected": False} and the UI says so. No simulated values.
"""
from __future__ import annotations

import asyncio
import json
import shutil
from typing import Any

from .config import settings


def _find(obj: Any, *keys: str) -> Any:
    """Depth-first search for the first matching key (amd-smi JSON layout differs by version)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in keys:
                return v
        for v in obj.values():
            r = _find(v, *keys)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find(v, *keys)
            if r is not None:
                return r
    return None


def _num(v: Any) -> float | None:
    if isinstance(v, dict):
        v = v.get("value")
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def gpu_metrics() -> dict:
    exe = settings.amd_smi_path
    if not exe:
        return {"connected": False, "reason": "AMD_SMI_PATH not set (no AMD GPU connected yet)"}
    if not shutil.which(exe):
        return {"connected": False, "reason": f"amd-smi not found at '{exe}'"}
    try:
        proc = await asyncio.create_subprocess_exec(
            exe, "metric", "--usage", "--mem-usage", "--json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        data = json.loads(out.decode() or "null")
    except Exception as e:  # pragma: no cover - needs real hardware
        return {"connected": False, "reason": f"amd-smi failed: {e}"}
    gpu0 = data[0] if isinstance(data, list) and data else data
    used = _num(_find(gpu0, "used_vram", "vram_used"))
    total = _num(_find(gpu0, "total_vram", "vram_total"))
    return {
        "connected": True,
        "gpu_util_pct": _num(_find(gpu0, "gfx_activity", "gfx_usage", "gpu_use")),
        "vram_used_mb": used,
        "vram_total_mb": total,
        "vram_pct": round(100 * used / total, 1) if used and total else None,
    }
