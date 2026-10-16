// CareCoordinator system monitoring (Mariam's admin layout) - real run data and real AMD telemetry only, never simulated.
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } } };

const AGENTS = [
  ["safety", "Safety gate", "Stops on emergency words; flags and redacts sensitive history"],
  ["main", "Main Agent", "Reads the request and writes the care contract"],
  ["intake", "Intake", "Turns documents into numbered source lines"],
  ["classifier", "Doc Classifier", "Sorts documents by type and date"],
  ["summarizer", "Record Summarizer", "Writes the plain-language summary and questions"],
  ["medication", "Medication Checker", "Checks medicines and interactions against the drug data"],
  ["compiler", "Manager / Compiler", "Verifies every statement against its source, retries up to 2 times"],
];
const STATUS = { active: ["Working", "info"], finished: ["Completed", "success"], idle: ["Idle", "muted"], retrying: ["Retrying", "warning"], stopped: ["Stopped", "danger"], error: ["Stopped", "danger"] };
const TITLES = { overview: "System Overview", agents: "Agent Activity", documents: "Document Monitoring", verification: "Verification Results", hardware: "Hardware & Performance", logs: "Logs & Errors" };
const runId = (location.hash.match(/run=([a-f0-9]+)/) || [])[1] || store.get("carecoord.run");
let run = null, gpuSamples = [];

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}
function toast(msg) {
  const t = $("#appToast"); t.textContent = msg; t.className = "app-toast";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), 2500);
}
const setText = (s, v) => { const el = $(s); if (el) el.innerHTML = v; };
const setBar = (s, pct) => { const el = $(s); if (el) el.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`; };

// ---------- navigation ----------
function showView(name) {
  $$(".dashboard-view").forEach((v) => { const on = v.id === name; v.hidden = !on; v.classList.toggle("active", on); });
  $$(".nav-link").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#pageTitle").textContent = TITLES[name];
  $("#adminSidebar").classList.remove("open");
  if (name === "hardware") drawChart();
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) showView(b.dataset.view); });
$("#mobileMenu").addEventListener("click", () => {
  const open = $("#adminSidebar").classList.toggle("open");
  $("#mobileMenu").setAttribute("aria-expanded", String(open));
});
$("#refreshMetrics").addEventListener("click", async () => { await refresh(); toast("Refreshed from the server."); });

// ---------- run data ----------
async function loadRun() {
  if (!runId) { $("#runLine").textContent = "No run yet. Start one from the patient dashboard."; return; }
  $("#patientLink").href = `/#home&run=${runId}`;
  try { run = await api(`/api/runs/${runId}`); }
  catch { run = null; $("#runLine").textContent = "The last run is no longer on the server (it was restarted). Start a new one from the patient dashboard."; return; }
  $("#runLine").textContent = `Run ${run.run_id} · ${run.summary?.patient_name || "patient"} · “${run.request}”`;
  const st = { running: ["● Running", "info"], awaiting_review: ["● Awaiting review", "info"], approved: ["✓ Approved", "success"],
    rejected: ["Rejected", "danger"], hard_stop: ["Stopped for safety", "danger"], error: ["Error", "danger"] }[run.status] || [run.status, "muted"];
  $("#systemStatus").textContent = st[0]; $("#systemStatus").className = `status-badge ${st[1]}`;
  renderAgents(); renderDocuments(); renderVerification(); renderLogs();
}

function agentRows() {
  const state = run?.agents || {};
  return AGENTS.map(([k, name, job]) => {
    const last = [...(run?.events || [])].reverse().find((e) => e.agent === k);
    const [status, cls] = STATUS[state[k] || "idle"] || STATUS.idle;
    return { name, status, cls, task: last ? last.message : job, time: last ? last.ts.slice(11, 19) : "—" };
  });
}
function renderAgents() {
  const rows = agentRows();
  $("#overviewAgentList").innerHTML = rows.map((a) => `
    <div class="agent-mini-row"><span class="agent-dot ${a.cls}"></span><strong>${esc(a.name)}</strong>
      <span class="status-badge ${a.cls}">${esc(a.status)}</span><small>${esc(a.task)}</small></div>`).join("");
  const q = $("#agentSearch").value.toLowerCase().trim(), f = $("#agentStatusFilter").value;
  const list = rows.filter((a) => `${a.name} ${a.task}`.toLowerCase().includes(q) && (f === "all" || a.status === f));
  $("#agentTableBody").innerHTML = list.map((a) => `<tr><td><strong>${esc(a.name)}</strong></td>
    <td><span class="status-badge ${a.cls}">${esc(a.status)}</span></td><td>${esc(a.task)}</td><td>${esc(a.time)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="empty-cell">No matching agents.</td></tr>`;
}
$("#agentSearch").addEventListener("input", renderAgents);
$("#agentStatusFilter").addEventListener("change", renderAgents);

function renderDocuments() {
  const docs = run?.documents || [];
  const types = Object.fromEntries((run?.index || []).map((i) => [i.doc_id, i.doc_type]));
  const cited = new Set((run?.summary?.sections || []).flatMap((s) => s.items.flatMap((c) => (c.source_ids || []).map((x) => x.split(":")[0]))));
  const rows = docs.map((d) => ({ ...d, type: types[d.doc_id] || "—", status: !d.readable ? "Unreadable" : cited.has(d.doc_id) ? "Cited" : "Read" }));
  setText("#documentTotal", docs.length);
  setText("#documentProcessed", docs.filter((d) => d.readable).length);
  setText("#documentReview", rows.filter((d) => d.status === "Cited").length);
  setText("#documentFlagged", docs.filter((d) => !d.readable).length);
  const q = $("#documentSearch").value.toLowerCase().trim(), f = $("#documentStatusFilter").value;
  const list = rows.filter((d) => `${d.doc_id} ${d.filename} ${d.title} ${d.type}`.toLowerCase().includes(q) && (f === "all" || d.status === f));
  const cls = { Cited: "success", Read: "info", Unreadable: "danger" };
  $("#documentTableBody").innerHTML = list.map((d) => `<tr><td><strong>${esc(d.doc_id)}</strong></td>
    <td>${esc(d.filename)}<small class="cell-sub">${esc(d.title || "")} · ${d.pages} page(s), ${d.lines} lines</small></td>
    <td>${esc(String(d.type).replace(/_/g, " "))}</td><td><span class="status-badge ${cls[d.status]}">${d.status}</span></td>
    <td>${esc(d.doc_date || "—")}</td></tr>`).join("") || `<tr><td colspan="5" class="empty-cell">No documents.</td></tr>`;
}
$("#documentSearch").addEventListener("input", renderDocuments);
$("#documentStatusFilter").addEventListener("change", renderDocuments);

function renderVerification() {
  const s = run?.summary;
  const items = (s?.sections || []).filter((x) => x.key !== "needs_clinician_review").flatMap((x) => x.items.map((c) => ({ sec: x.title, c })));
  const counts = {
    Verified: items.filter((i) => i.c.verified !== false && i.c.origin !== "user_request").length,
    "From your request": items.filter((i) => i.c.origin === "user_request").length,
    Removed: s?.removed_claims.length || 0,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = (n) => (total ? (n / total) * 100 : 0);
  const v = pct(counts.Verified), u = pct(counts["From your request"]);
  const gradient = total
    ? `conic-gradient(#00d6a3 0% ${v}%, #ffbe45 ${v}% ${v + u}%, #ff5277 ${v + u}% 100%)`
    : "conic-gradient(#1c3756 0% 100%)";
  ["#overviewDonut", "#verificationDonut"].forEach((sel) => { $(sel).style.background = gradient; });
  const label = total ? `${Math.round(v)}%` : "—";
  setText("#overviewVerifiedPercent", label); setText("#verifiedPercent", label);
  const legend = [["green", "Verified"], ["yellow", "From your request"], ["red", "Removed"]].map(([c, k]) =>
    `<div class="legend-row"><span><span class="legend-dot ${c}-dot"></span>${k}</span><strong>${counts[k]}</strong></div>`).join("");
  $("#overviewVerificationLegend").innerHTML = legend; $("#verificationLegend").innerHTML = legend;

  const secs = (s?.sections || []);
  ["high", "medium", "low"].forEach((lvl) => {
    const p = secs.length ? Math.round((secs.filter((x) => x.confidence === lvl).length / secs.length) * 100) : 0;
    const L = lvl[0].toUpperCase() + lvl.slice(1);
    setText(`#confidence${L}Label`, secs.length ? `${p}%` : "—"); setBar(`#confidence${L}Bar`, p);
  });

  const rows = items.map(({ sec, c }) => [sec, c.text, c.origin === "user_request" ? ["From your request", "warning"] : ["Verified", "success"], (c.source_ids || []).join(", ")])
    .concat((s?.removed_claims || []).map((c) => ["—", c.text, ["Removed", "danger"], (c.source_ids || []).join(", ") || "none"]));
  $("#verificationTableBody").innerHTML = rows.map(([sec, text, [r, cls], src]) => `<tr><td>${esc(sec.replace(/^\d+\.\s*/, ""))}</td>
    <td>${esc(text)}</td><td><span class="status-badge ${cls}">${r}</span></td><td class="mono">${esc(src)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="empty-cell">No verified statements yet.</td></tr>`;
}

const LEVEL = (t) => (["error", "hard_stop"].includes(t) ? "ERROR" : ["flag", "retry"].includes(t) ? "WARN" : "INFO");
const LCLS = { ERROR: "danger", WARN: "warning", INFO: "info" };
function renderLogs() {
  const logs = [...(run?.events || [])].reverse().map((e) => ({ time: e.ts.slice(11, 19), level: LEVEL(e.type), event: `${e.agent} · ${e.type.replace(/_/g, " ")}`, details: e.message }));
  const q = $("#logSearch").value.toLowerCase().trim(), f = $("#logLevelFilter").value;
  const list = logs.filter((l) => `${l.time} ${l.level} ${l.event} ${l.details}`.toLowerCase().includes(q) && (f === "all" || l.level === f));
  $("#logTableBody").innerHTML = list.map((l) => `<tr><td>${esc(l.time)}</td><td><span class="status-badge ${LCLS[l.level]}">${l.level}</span></td>
    <td>${esc(l.event)}</td><td>${esc(l.details)}</td></tr>`).join("");
  $("#logEmptyState").classList.toggle("hidden", list.length > 0);
  $("#overviewRecentLogs").innerHTML = logs.slice(0, 5).map((l) => `<div class="log-mini-row"><span class="status-badge ${LCLS[l.level]}">${l.level}</span>
    <div><strong>${esc(l.event)}</strong><small>${esc(l.details)}</small></div><time>${esc(l.time)}</time></div>`).join("")
    || `<div class="empty-state">No events yet.</div>`;
}
$("#logSearch").addEventListener("input", renderLogs);
$("#logLevelFilter").addEventListener("change", renderLogs);

// ---------- telemetry (real only) ----------
async function loadTelemetry() {
  let t;
  try { t = await api("/api/telemetry"); } catch { return; }
  const g = t.gpu, l = t.llm, llm = t.mode === "llm";
  $("#modeTitle").textContent = llm ? "AMD model connected" : "Rules mode";
  $("#modeSub").textContent = g.connected ? "AMD GPU telemetry live" : "No GPU telemetry (never simulated)";
  $("#modeDot").classList.toggle("amber", !llm);
  if (g.connected) {
    const mem = g.vram_total_mb ? (g.vram_used_mb / g.vram_total_mb) * 100 : 0;
    setText("#overviewGpu", `${g.gpu_util_pct ?? "?"}%`); setBar("#overviewGpuBar", g.gpu_util_pct);
    setText("#overviewMemory", `${((g.vram_used_mb ?? 0) / 1024).toFixed(1)} GB <small>/ ${((g.vram_total_mb ?? 0) / 1024).toFixed(0)} GB</small>`);
    setBar("#overviewMemoryBar", mem);
    setText("#overviewGpuNote", "amd-smi, live"); setText("#overviewMemoryNote", "amd-smi, live");
    setText("#hardwareGpu", `${g.gpu_util_pct ?? "?"}%`); setBar("#hardwareGpuBar", g.gpu_util_pct);
    setText("#hardwareMemory", `${g.vram_used_mb ?? "?"} / ${g.vram_total_mb ?? "?"} MB`); setBar("#hardwareMemoryBar", mem);
    $("#hardwareBadge").textContent = "AMD GPU connected"; $("#hardwareBadge").className = "status-badge success";
    gpuSamples.push(g.gpu_util_pct ?? 0); if (gpuSamples.length > 60) gpuSamples.shift();
  } else {
    for (const s of ["#overviewGpu", "#overviewMemory", "#hardwareGpu", "#hardwareMemory"]) setText(s, "—");
    for (const s of ["#overviewGpuBar", "#overviewMemoryBar", "#hardwareGpuBar", "#hardwareMemoryBar"]) setBar(s, 0);
    setText("#overviewGpuNote", `Not connected: ${esc(g.reason)}`); setText("#overviewMemoryNote", "Not connected");
    $("#hardwareBadge").textContent = "GPU not connected"; $("#hardwareBadge").className = "status-badge warning";
  }
  if (llm && l.calls) {
    setText("#overviewResponse", `${l.avg_latency_s} s`); setBar("#overviewResponseBar", Math.min(100, (l.avg_latency_s / 10) * 100));
    setText("#overviewTokens", `${l.last_tokens_per_s} tok/s`); setBar("#overviewTokensBar", Math.min(100, l.last_tokens_per_s));
    setText("#overviewResponseNote", `Average over ${l.calls} model calls`);
    setText("#hardwareResponse", `${l.calls} / ${l.failures}`); setText("#hardwareTokens", `${l.last_tokens_per_s} tok/s`);
  } else {
    for (const s of ["#overviewResponse", "#overviewTokens", "#hardwareResponse", "#hardwareTokens"]) setText(s, "—");
    setText("#overviewResponseNote", llm ? "No model calls yet" : "No model connected (rules mode)");
  }
  if ($("#hardware").classList.contains("active")) drawChart();
}

function drawChart() {
  const canvas = $("#gpuChart"), empty = $("#chartEmpty");
  const has = gpuSamples.length > 1;
  canvas.classList.toggle("hidden", !has); empty.classList.toggle("hidden", has);
  if (!has) {
    empty.textContent = "No real AMD GPU is connected, so there is no chart. Numbers appear here only from amd-smi; they are never simulated.";
    $("#chartLatest").textContent = "Latest: —";
    return;
  }
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(155,178,208,.15)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = 10 + (i * (h - 20)) / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = "#00d9ff"; ctx.lineWidth = 2; ctx.beginPath();
  gpuSamples.forEach((v, i) => { const x = (i / (gpuSamples.length - 1)) * w, y = 10 + (1 - v / 100) * (h - 20); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  $("#chartLatest").textContent = `Latest: ${gpuSamples.at(-1)}%`;
}

async function refresh() { await Promise.all([loadRun(), loadTelemetry()]); }
refresh();
setInterval(refresh, 3000);
