// CarePilot dashboard - vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const AGENTS = [
  ["safety", "Safety gate"], ["main", "Main Agent"], ["intake", "Intake"], ["classifier", "Doc Classifier"],
  ["summarizer", "Record Summarizer"], ["medication", "Medication Checker"], ["compiler", "Manager / Compiler"],
];
let runId = null, es = null, telTimer = null;

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.detail ? (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)) : r.statusText);
  return body;
}

// ---------- setup ----------
async function init() {
  renderAgents({});
  const cfg = await api("/api/config");
  const b = $("#modeBadge");
  if (cfg.mode === "llm") { b.textContent = `Model: ${cfg.llm.model} (AMD)`; b.className = "badge llm"; }
  else { b.textContent = "AMD model not connected · rules mode"; b.className = "badge rules"; }
  $("#clfNote").textContent = cfg.safety_classifier.configured ? "plus a safety model on the AMD GPU" : "(the safety model is not connected yet)";
  const pts = await api("/api/patients");
  for (const p of pts) $("#patientSelect").insertAdjacentHTML("beforeend", `<option value="${esc(p.id)}">${esc(p.label)} (${p.documents} docs)</option>`);
  telemetry(); telTimer = setInterval(telemetry, 3000);
  const m = location.hash.match(/run=([a-f0-9]+)/);  // reopen a run after refresh
  if (m) startRun(m[1]);
}

document.querySelectorAll('input[name="role"]').forEach((r) => r.addEventListener("change", () => {
  $("#caregiverFields").hidden = r.value !== "caregiver" || !r.checked;
}));
$("#examples").addEventListener("click", (e) => { if (e.target.matches(".chip")) $('textarea[name="request"]').value = e.target.textContent; });

// ---------- multi-file upload (drag & drop + picker) ----------
let chosen = [];
const OK_EXT = /\.(pdf|txt|md)$/i;
function addFiles(list) {
  for (const f of list) {
    if (!OK_EXT.test(f.name)) { showError(`${f.name}: only PDF or text files`); continue; }
    if (f.size > 20 * 1024 * 1024) { showError(`${f.name} is larger than 20 MB`); continue; }
    if (!chosen.some((c) => c.name === f.name && c.size === f.size)) chosen.push(f);
  }
  renderFiles();
}
function renderFiles() {
  $("#fileList").innerHTML = chosen.map((f, i) =>
    `<li><span>${esc(f.name)} <span class="note">${(f.size / 1024).toFixed(0)} KB</span></span>
     <button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`).join("");
  if (chosen.length) $("#patientSelect").value = "";
}
function showError(msg) { const err = $("#formError"); err.textContent = msg; err.hidden = false; }
$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("#fileList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  chosen.splice(+b.dataset.rm, 1); renderFiles();
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

$("#runForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#formError"); err.hidden = true;
  const fd = new FormData(e.target);
  if (chosen.length) { fd.delete("patient_id"); chosen.forEach((f) => fd.append("files", f)); }
  else if (!fd.get("patient_id")) { showError("Please upload at least one document, or pick a sample patient."); return; }
  $("#startBtn").disabled = true; $("#startBtn").textContent = "Reading documents…";
  try {
    const { run_id } = await api("/api/runs", { method: "POST", body: fd });
    startRun(run_id);
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { $("#startBtn").disabled = false; $("#startBtn").textContent = "Start"; }
});

function startRun(id) {
  runId = id;
  history.replaceState(null, "", `#run=${id}`);
  $("#eventLog").innerHTML = ""; $("#emptyState").hidden = true; $("#hardStop").hidden = true; $("#summaryWrap").hidden = true;
  if (es) es.close();
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (m) => {
    const p = JSON.parse(m.data);
    logEvent(p.event); renderAgents(p.agents);
  };
  // Poll until the run leaves "running", so the result shows even if the event stream is delayed or buffered.
  const poll = async () => {
    if (runId !== id) return;
    const run = await api(`/api/runs/${id}`);
    if (run.status === "running") setTimeout(poll, 800);
    else { render(run); renderAgents(run.agents); }
  };
  poll();
}

async function refresh() {
  if (!runId) return;
  render(await api(`/api/runs/${runId}`));
}

// ---------- rendering ----------
function renderAgents(state) {
  $("#agents").innerHTML = AGENTS.map(([k, label]) => {
    const st = state[k] || "idle";
    return `<li class="agent ${st}"><span>${label}</span><span class="st">${st}</span></li>`;
  }).join("");
}

function logEvent(ev) {
  const t = ev.ts.slice(11, 19);
  $("#eventLog").insertAdjacentHTML("afterbegin",
    `<li class="t-${ev.type}"><span class="ag">${esc(ev.agent)}</span> · ${esc(ev.type)} · ${esc(ev.message)} <span class="note">${t}</span></li>`);
}

function cites(ids) {
  return (ids || []).map((id) => `<button class="cite" data-src="${esc(id)}" title="Show source">${esc(id.replace(/:p\d+:/, " "))}</button>`).join("");
}

function render(run) {
  $("#docList").hidden = false;
  $("#docs").innerHTML = run.documents.map((d) =>
    `<li>${esc(d.doc_id)} · ${esc(d.doc_date || "no date")} · ${esc(d.title || d.filename)}${d.readable ? "" : " <b>(unreadable)</b>"}</li>`).join("");
  const sb = $("#statusBadge"); sb.textContent = run.status.replace("_", " "); sb.className = `badge ${run.status}`;

  if (run.status === "hard_stop") {
    $("#summaryWrap").hidden = true;
    $("#hardStop").hidden = false;
    $("#hardStop").innerHTML = `<strong>We stopped for your safety.</strong>${esc(run.hard_stop_message)}`;
    return;
  }
  if (!run.summary) return;
  const s = run.summary;
  $("#summaryWrap").hidden = false;
  const who = run.submitter.role === "caregiver" ? `caregiver (${run.submitter.relationship})` : "patient";
  $("#patientTitle").textContent = `Care summary · ${s.patient_name}`;
  $("#resultMeta").textContent = `For the ${who} · request: "${run.request}" · ${run.contract?.intent.replace(/_/g, " ")}`
    + (run.contract?.specialty ? ` / ${run.contract.specialty}` : "")
    + ` · reading grade ${s.reading_grade ?? "n/a"} · ${run.mode === "llm" ? "AMD model" : "rules mode"} · ${run.timings.total_s ?? "?"}s`;

  $("#sections").innerHTML = s.sections.map((sec) => {
    let body;
    if (sec.key === "medication_checklist") body = medTable(s, sec);
    else if (sec.key === "needs_clinician_review") body = `<ul class="items">${sec.items.map((c) => {
      const lvl = c.kind.split(":")[1];
      return `<li class="${lvl}"><span class="lvl">${lvl === "red" ? "Needs attention" : "Check"}</span>${esc(c.text)} ${cites(c.source_ids)}</li>`;
    }).join("") || "<li>Nothing flagged.</li>"}</ul>`;
    else body = `<ul class="items">${sec.items.map((c) =>
      `<li>${esc(c.text)} ${c.origin === "user_request" ? '<span class="userq">your request</span>' : cites(c.source_ids)}${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</li>`).join("")}</ul>`;
    return `<div class="card"><div class="sec-head"><h3>${esc(sec.title)}</h3><span class="conf ${sec.confidence}">${sec.confidence} confidence</span></div>${body}</div>`;
  }).join("") + (s.removed_claims.length ? `<p class="note">${s.removed_claims.length} statement(s) were removed because they could not be traced to the record.</p>` : "")
    + `<p class="note">${esc(s.disclaimer)}</p>`;

  $("#timeline").innerHTML = s.timeline.map((c) => `<li>${esc(c.text)} ${cites(c.source_ids)}</li>`).join("");
  $("#redCount").textContent = s.flags.filter((f) => f.level === "red").length;
  $("#amberCount").textContent = s.flags.filter((f) => f.level === "amber").length;

  $("#chatLog").innerHTML = run.chat.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join("");
  $("#chatLog").scrollTop = 1e6;
  const open = run.status === "awaiting_review";
  for (const el of ["#approveBtn", "#rejectBtn", "#improveForm button", "#improveInput"]) $(el).disabled = !open;
  const ex = $("#exportLink");
  ex.hidden = run.status !== "approved";
  ex.href = `/api/runs/${run.run_id}/export.txt`;
}

function medTable(s, sec) {
  const rows = s.medications.map((m) => `<tr>
      <td>${esc(m.name)} ${cites(m.source_ids)}</td>
      <td>${esc(m.directions || "Not recorded")}</td>
      <td>${esc(m.started || "")}</td>
      <td>${m.status === "confirmed" ? `<span class="pill ok">Checked</span><span class="note">${esc(m.drug_class)}</span>`
                                     : `<span class="pill no">Cannot confirm</span>`}</td></tr>`).join("");
  const inter = s.interactions.filter((i) => i.confirmed).map((i) =>
    `<li class="${i.severity === "major" ? "red" : "amber"}"><b>${esc(i.severity)}:</b> ${esc(i.drugs.join(" + "))}. ${esc(i.description)} <i>${esc(i.note)}</i> ${cites(i.source_ids)}</li>`).join("");
  const unchecked = s.interactions.filter((i) => !i.confirmed).length;
  return `<div class="tablewrap"><table class="meds"><thead><tr><th>Medicine</th><th>Directions</th><th>Started</th><th>Drug data check</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3 class="subhead">Possible interactions</h3><ul class="items">${inter || "<li>None found in the drug data source.</li>"}</ul>
    ${unchecked ? `<p class="note">${unchecked} pair(s) could not be checked: cannot confirm. Please ask your doctor or pharmacist.</p>` : ""}
    <h3 class="subhead">Allergies</h3><ul class="items">${s.allergies.map((c) => `<li>${esc(c.text)} ${cites(c.source_ids)}</li>`).join("") || "<li>No allergy information found.</li>"}</ul>`;
}

// ---------- source viewer ----------
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".cite");
  if (!b || !runId) return;
  const src = await api(`/api/runs/${runId}/source/${encodeURIComponent(b.dataset.src)}`);
  $("#srcTitle").textContent = `${src.doc.title || src.doc.filename}`;
  $("#srcMeta").textContent = `${src.doc.doc_id} · ${src.doc.filename} · ${src.doc.doc_date || "no date"} · page ${src.line.page}, line ${src.line.line}`;
  $("#srcLines").innerHTML = src.context.map((x) =>
    `<li class="${x.is_target ? "target" : ""}"><span class="lid">${esc(x.id)}</span>${esc(x.text)}</li>`).join("");
  $("#sourceDlg").showModal();
});

// ---------- review actions ----------
$("#improveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#improveInput").value.trim();
  if (!msg) return;
  $("#improveInput").value = "";
  render(await api(`/api/runs/${runId}/improve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg }) }));
});
$("#approveBtn").addEventListener("click", async () => render(await api(`/api/runs/${runId}/approve`, { method: "POST" })));
$("#rejectBtn").addEventListener("click", async () => {
  if (confirm("Reject this summary? It will not be marked final.")) render(await api(`/api/runs/${runId}/reject`, { method: "POST" }));
});

// ---------- telemetry ----------
async function telemetry() {
  try {
    const t = await api("/api/telemetry");
    const g = t.gpu;
    $("#gpu").innerHTML = g.connected
      ? `<div class="kv"><span>GPU utilization</span><b>${g.gpu_util_pct ?? "?"}%</b></div>
         <div class="kv"><span>VRAM</span><b>${g.vram_used_mb ?? "?"} / ${g.vram_total_mb ?? "?"} MB</b></div>`
      : `Not connected. ${esc(g.reason)}. No numbers are shown until a real AMD GPU is connected.`;
    const l = t.llm;
    $("#llmStats").innerHTML = t.mode === "llm"
      ? `<div class="kv"><span>Calls</span><b>${l.calls}</b></div><div class="kv"><span>Tokens/sec (last)</span><b>${l.last_tokens_per_s}</b></div>
         <div class="kv"><span>Avg latency</span><b>${l.avg_latency_s}s</b></div><div class="kv"><span>Failures</span><b>${l.failures}</b></div>`
      : "No model connected. Agents run on Python rules. Set LLM_BASE_URL and LLM_MODEL in .env when AMD access arrives.";
  } catch { /* server restarting */ }
}

init();

// Show unexpected errors instead of failing silently.
window.addEventListener("unhandledrejection", (e) => showError(`Something went wrong: ${e.reason?.message || e.reason}`));
window.addEventListener("error", (e) => showError(`Something went wrong: ${e.message}`));
