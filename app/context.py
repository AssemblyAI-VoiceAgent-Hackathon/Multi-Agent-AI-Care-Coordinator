"""Per-run context: the Run record, live event fan-out (FR-14) and an on-disk audit trail."""
from __future__ import annotations

import asyncio
import json

from .config import ROOT
from .ingest import line_lookup
from .schemas import Event, Run, SourceLine

RUNS_DIR = ROOT / "data" / "runs"

AGENTS = ["safety", "main", "intake", "classifier", "summarizer", "medication", "compiler"]


class RunContext:
    def __init__(self, run: Run):
        self.run = run
        self.subscribers: list[asyncio.Queue] = []
        self.agent_state: dict[str, str] = {a: "idle" for a in AGENTS}
        self.relevant_doc_ids: list[str] = []
        self.retries: dict[str, int] = {}
        self._lines: dict[str, SourceLine] | None = None

    @property
    def lines(self) -> dict[str, SourceLine]:
        if self._lines is None:
            self._lines = line_lookup(self.run.documents)
        return self._lines

    def emit(self, agent: str, type_: str, message: str, **data) -> None:
        ev = Event(agent=agent, type=type_, message=message, data=data)
        if type_ == "start":
            self.agent_state[agent] = "active"
        elif type_ == "finish":
            self.agent_state[agent] = "finished"
        elif type_ == "retry":
            self.agent_state[agent] = "retrying"
        elif type_ == "error":
            self.agent_state[agent] = "error"
        elif type_ == "hard_stop":
            self.agent_state[agent] = "stopped"
        self.run.events.append(ev)
        payload = {"event": ev.model_dump(), "agents": dict(self.agent_state), "status": self.run.status}
        for q in list(self.subscribers):
            q.put_nowait(payload)

    def save(self) -> None:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        (RUNS_DIR / f"{self.run.run_id}.json").write_text(
            json.dumps(self.run.model_dump(exclude={"documents"}), indent=2), encoding="utf-8"
        )
