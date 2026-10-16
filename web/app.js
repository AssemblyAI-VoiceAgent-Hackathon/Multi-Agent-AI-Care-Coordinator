// CareCoordinator patient dashboard (Mariam's layout) wired to the real multi-agent pipeline. Vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// Mariam's 5-step tracker, driven by the real agent states.
const STEPS = [
  ["▤", "1. Upload", []], ["⚙", "2. Processing", ["safety", "main", "intake", "classifier"]],
  ["⌘", "3. AI Analysis", ["summarizer", "medication", "compiler"]], ["♙", "4. Review", null], ["✓", "5. Final", null],
];
let runId = null, es = null, current = null, agentState = {}, events = [];

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.detail ? (typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)) : r.statusText);
  return body;
}
function toast(msg, type = "") {
  const t = $("#appToast");
  t.textContent = msg; t.className = `app-toast ${type}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}
function showError(msg) { const e = $("#formError"); e.textContent = msg; e.classList.remove("hidden"); toast(msg, "error"); }
function openDialog(title, html) { $("#dialogTitle").textContent = title; $("#dialogContent").innerHTML = html; $("#detailDialog").showModal(); }
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());

// ---------- navigation (Mariam's views) ----------
function showView(name, updateHash = true) {
  if (!$(`#${name}.dashboard-view`)) name = "home";
  $$(".dashboard-view").forEach((v) => { const on = v.id === name; v.hidden = !on; v.classList.toggle("active", on); });
  $$(".nav-link").forEach((a) => {
    const on = a.dataset.view === name;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#pageTitle").textContent = $(`#${name}`).dataset.title;
  if (updateHash) history.replaceState(null, "", `#${name}${runId ? `&run=${runId}` : ""}`);
  $("#sidebar").classList.remove("open"); $("#mobileMenu").setAttribute("aria-expanded", "false");
  $("#profileMenu").classList.add("hidden");
  window.scrollTo({ top: 0 });
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-view]");
  if (!a) return;
  e.preventDefault(); showView(a.dataset.view);
});
$("#mobileMenu").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#mobileMenu").setAttribute("aria-expanded", String(open));
});
$("#profileButton").addEventListener("click", () => {
  const hidden = $("#profileMenu").classList.toggle("hidden");
  $("#profileButton").setAttribute("aria-expanded", String(!hidden));
});
$("#notificationButton").addEventListener("click", () => {
  const hidden = $("#notificationPanel").classList.toggle("hidden");
  $("#notificationButton").setAttribute("aria-expanded", String(!hidden));
});
$("#helpButton").addEventListener("click", () => openDialog("What is real in this prototype?", `<ul>
  <li><b>Working now:</b> reading uploaded PDFs, the 6 agents, emergency hard stop, source links for every statement, verification with 2 retries, flags for the clinician, approve / improve / reject, the PDF report.</li>
  <li id="helpModel">${esc($("#modeBadge").dataset.note || "")}</li>
  <li><b>GPU numbers</b> are shown only when a real AMD GPU is connected (System monitoring page). They are never simulated.</li>
  <li><b>Medicine checks</b> use a small demo drug list, not a licensed clinical database. Anything not on it says "cannot confirm".</li>
  <li><b>All records are synthetic</b> (made with Synthea). No real patient data.</li>
  <li><b>How to use:</b> Upload Documents → Prepare my summary → read My Summary → ask for changes → Approve → download the PDF.</li></ul>`));

// ---------- setup ----------
async function init() {
  renderWorkflow(); renderEmpty();
  const cfg = await api("/api/config");
  const b = $("#modeBadge");
  if (cfg.mode === "llm") {
    b.innerHTML = `<span class="online-dot"></span>AMD model · ${esc(cfg.llm.model)}`;
    b.dataset.note = `AI model: ${cfg.llm.model}, served on AMD GPUs. The Compiler still checks every statement against the documents.`;
    $("#sidebarMode").textContent = "AMD model connected";
  } else {
    b.innerHTML = `<span class="online-dot amber"></span>Rules mode`;
    b.dataset.note = "Not connected yet: the AI model on the AMD GPU. Until it is, the agents run on fixed Python rules.";
    $("#sidebarMode").textContent = "Rules mode (AMD model not connected)"; $("#modeDot").classList.add("amber");
  }
  $("#clfNote").textContent = cfg.safety_classifier.configured ? "keyword list plus a safety model" : "keyword list; it can miss unusual wording";
  const pts = await api("/api/patients");
  $("#patientPicks").innerHTML = pts.map((p) => `
    <button type="button" class="file-item patient-pick" data-pid="${esc(p.id)}">
      <span class="avatar small">${esc(initials(p.label))}</span>
      <span class="file-meta"><b>${esc(p.label)}</b><small>${p.documents} synthetic documents · click to use</small></span>
      <span class="status-badge pick-badge">Select</span>
    </button>`).join("") || `<div class="empty-state">No sample patients found.</div>`;
  const [hv] = location.hash.slice(1).split("&");
  const m = location.hash.match(/run=([a-f0-9]+)/) || [null, store.get("carecoord.run")];
  showView(hv || "home", false);
  if (m[1]) startRun(m[1], false);
}
const initials = (s) => String(s).split(/[\s(]+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

$$('input[name="role"]').forEach((r) => r.addEventListener("change", () => {
  $("#caregiverFields").classList.toggle("hidden", $('input[name="role"]:checked').value !== "caregiver");
}));
$("#examples").addEventListener("click", (e) => { if (e.target.matches(".chip")) $('textarea[name="request"]').value = e.target.textContent; });

// ---------- documents: upload or sample patient ----------
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
  $("#selectedCount").textContent = `${chosen.length} file${chosen.length === 1 ? "" : "s"}`;
  $("#fileList").innerHTML = chosen.map((f, i) => `
    <div class="file-item"><span class="file-type-icon">▤</span>
      <span class="file-meta"><b>${esc(f.name)}</b><small>${(f.size / 1024).toFixed(0)} KB · ready</small></span>
      <button type="button" class="file-remove" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></div>`).join("")
    || `<div class="empty-state">Your selected documents will appear here.</div>`;
  if (chosen.length) pickPatient("");
}
function pickPatient(id) {
  $("#patientId").value = id;
  $$(".patient-pick").forEach((b) => {
    const on = b.dataset.pid === id;
    b.classList.toggle("selected", on);
    b.querySelector(".pick-badge").textContent = on ? "✓ Selected" : "Select";
    b.querySelector(".pick-badge").className = `status-badge pick-badge ${on ? "success" : ""}`;
  });
}
$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("#browseFiles").addEventListener("click", (e) => { e.stopPropagation(); $("#fileInput").click(); });
$("#fileList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  chosen.splice(+b.dataset.rm, 1); renderFiles();
});
$("#patientPicks").addEventListener("click", (e) => {
  const b = e.target.closest(".patient-pick"); if (!b) return;
  const id = $("#patientId").value === b.dataset.pid ? "" : b.dataset.pid;
  if (id) { chosen = []; renderFiles(); }
  pickPatient(id);
});
const dz = $("#dropZone");
dz.addEventListener("click", () => $("#fileInput").click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#fileInput").click(); } });
["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
$("#documentSearch").addEventListener("input", () => current && renderDocs(current));

$("#runForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#formError").classList.add("hidden");
  const fd = new FormData(e.target);
  if (chosen.length) { fd.delete("patient_id"); chosen.forEach((f) => fd.append("files", f)); }
  else if (!fd.get("patient_id")) { showError("Please upload at least one document, or pick a sample patient."); return; }
  $("#startBtn").disabled = true; $("#startBtn").textContent = "Reading documents…";
  try {
    const { run_id } = await api("/api/runs", { method: "POST", body: fd });
    startRun(run_id, true);
  } catch (ex) { showError(ex.message); }
  finally { $("#startBtn").disabled = false; $("#startBtn").textContent = "Prepare my summary →"; }
});

// ---------- run lifecycle ----------
function startRun(id, fresh) {
  runId = id; current = null; agentState = {}; events = [];
  store.set("carecoord.run", id);
  for (const a of ["#adminLink", "#adminLink2"]) $(a).href = `/admin#run=${id}`;
  $("#hardStop").classList.add("hidden"); $("#working").classList.remove("hidden");
  renderEvents(); renderWorkflow();
  if (fresh) { showView("home"); toast("The agents are reading your documents…"); }
  else history.replaceState(null, "", `#${$(".dashboard-view.active").id}&run=${id}`);
  if (es) es.close();
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (m) => {
    const p = JSON.parse(m.data);
    events.unshift(p.event); renderEvents();
    agentState = p.agents || {}; renderWorkflow();
  };
  // Poll until the run leaves "running", so the result shows even if the event stream is delayed or buffered.
  const poll = async () => {
    if (runId !== id) return;
    let run;
    try { run = await api(`/api/runs/${id}`); }
    catch {  // the server restarted and forgot this run
      runId = null; store.set("carecoord.run", ""); $("#working").classList.add("hidden");
      if (es) es.close();
      renderEmpty(); renderWorkflow(); history.replaceState(null, "", `#${$(".dashboard-view.active").id}`);
      return;
    }
    if (run.status === "running") setTimeout(poll, 800);
    else {
      $("#working").classList.add("hidden"); agentState = run.agents || {}; render(run);
      if (fresh && run.status === "awaiting_review") { showView("summary"); toast("Your summary is ready to review.", "success"); }
    }
  };
  poll();
}

// ---------- rendering ----------
function stepState(agents, i) {
  const status = current?.status;
  if (i === 0) return runId ? "complete" : "";
  if (agents === null) {
    if (i === 3) return status === "awaiting_review" ? "current" : ["approved", "rejected"].includes(status) ? "complete" : "";
    return status === "approved" ? "complete" : "";
  }
  const st = agents.map((k) => agentState[k] || "idle");
  if (st.some((s) => s === "stopped" || s === "error")) return "stopped";
  if (st.some((s) => s === "active" || s === "retrying")) return "current";
  if (st.every((s) => s === "finished") || (status && status !== "running")) return "complete";
  return "";
}
function renderWorkflow() {
  const label = { complete: "✓ Completed", current: "● In progress", stopped: "■ Stopped", "": "○ Pending" };
  $("#workflow").innerHTML = STEPS.map(([ico, name, agents], i) => {
    const st = stepState(agents, i);
    const lbl = i === 3 && st === "current" ? "● Your turn" : label[st];
    return `${i ? '<div class="workflow-connector"></div>' : ""}<div class="workflow-step ${st}"><span class="workflow-icon">${ico}</span><div><strong>${name}</strong><small>${lbl}</small></div></div>`;
  }).join("");
  const map = { running: ["In progress", "info"], awaiting_review: ["Ready for your review", "info"], approved: ["Approved", "success"],
    rejected: ["Rejected", "error"], hard_stop: ["Stopped for safety", "error"], error: ["Error", "error"] };
  const [txt, cls] = map[current?.status] || (runId ? ["In progress", "info"] : ["Waiting", ""]);
  $("#workflowStatus").textContent = txt; $("#workflowStatus").className = `status-badge ${cls}`;
  $("#workflowSub").textContent = current?.request ? `“${current.request}”` : runId ? "The agents are working" : "No request yet";
}

function activityHTML(list) {
  return list.map((ev) => `<div class="activity-entry t-${esc(ev.type)}"><span class="activity-dot"></span>
    <div><strong>${esc(ev.agent)} · ${esc(ev.type.replace(/_/g, " "))}</strong><small>${esc(ev.message)}</small></div>
    <time>${esc(ev.ts.slice(11, 19))}</time></div>`).join("");
}
function renderEvents() {
  $("#homeRecentActivity").innerHTML = activityHTML(events.slice(0, 5)) || `<div class="empty-state">No activity recorded yet.</div>`;
  $("#historyList").innerHTML = activityHTML(events) || `<div class="empty-state">No activity recorded yet.</div>`;
  $("#historyCount").textContent = `${events.length} events`;
}

function cites(ids) {
  return (ids || []).map((id) => `<button class="cite" data-src="${esc(id)}" title="Show source">${esc(id.replace(/:p\d+:/, " "))}</button>`).join("");
}
const userTag = (c) => (c.origin === "user_request" ? '<span class="userq">your request</span>' : cites(c.source_ids));

function renderEmpty() {
  const none = (msg) => `<div class="empty-state">${msg}</div>`;
  $("#summaryContent").innerHTML = none("No summary yet. Go to Upload Documents and prepare your summary.");
  $("#medicationList").innerHTML = none("No medicines yet.");
  $("#interactionList").innerHTML = none("Nothing checked yet."); $("#allergyList").innerHTML = none("Nothing checked yet.");
  $("#questionList").innerHTML = none("Your questions will appear here.");
  $("#redList").innerHTML = $("#amberList").innerHTML = none("Nothing flagged.");
  $("#chatLog").innerHTML = `<div class="msg system">The conversation starts once your summary is ready.</div>`;
  for (const el of ["#approveBtn", "#rejectBtn", "#improveForm button", "#improveInput", "#questionForm button", "#viewSources", "#copySummary"]) $(el).disabled = true;
}

function renderDocs(run) {
  const q = $("#documentSearch").value.toLowerCase().trim();
  const docs = run.documents.filter((d) => `${d.doc_id} ${d.title} ${d.filename} ${d.doc_date}`.toLowerCase().includes(q));
  $("#recentDocuments").innerHTML = docs.map((d) => `
    <div class="recent-document${d.readable ? "" : " bad"}"><span class="file-type-icon doc-id">${esc(d.doc_id)}</span>
      <span class="file-meta"><b>${esc(d.title || d.filename)}</b><small>${esc(d.doc_date || "no date")} · ${esc(d.filename)}${d.readable ? "" : " · unreadable"}</small></span></div>`).join("")
    || `<div class="empty-state">${run.documents.length ? "No documents match your search." : "No documents read yet."}</div>`;
}

function render(run) {
  current = run;
  renderDocs(run); renderWorkflow();
  $("#homeDocumentCount").textContent = run.documents.length;
  const who = run.submitter.role === "caregiver" ? `Caregiver (${run.submitter.relationship})` : "Patient";
  $("#profileRole").textContent = run.submitter.name ? `${who} · ${run.submitter.name}` : who;

  if (run.status === "hard_stop") {
    $("#hardStop").classList.remove("hidden");
    $("#hardStop").innerHTML = `<span class="notice-icon">⚠</span><div><strong>We stopped for your safety.</strong><p>${esc(run.hard_stop_message)}</p></div>`;
    renderEmpty(); showView("home");
    $("#homeSummaryStatus").textContent = "Stopped"; $("#homeSummarySub").textContent = "Emergency words in the request";
    return;
  }
  if (!run.summary) return;
  const s = run.summary;
  const sec = Object.fromEntries(s.sections.map((x) => [x.key, x]));
  const first = s.patient_name.split(" ")[0];

  // profile + home
  $("#profileName").textContent = s.patient_name; $("#profileInitials").textContent = initials(s.patient_name);
  $("#welcomeTitle").innerHTML = `Hello, ${esc(run.submitter.role === "caregiver" ? (run.submitter.name || "there") : first)} <span class="wave">👋</span>`;
  $("#welcomeSub").textContent = run.submitter.role === "caregiver"
    ? `Here is ${s.patient_name}'s health information, simplified.` : "Your health information, simplified.";
  const statusText = { awaiting_review: "Draft", approved: "Approved", rejected: "Rejected" }[run.status] || run.status;
  $("#homeSummaryStatus").textContent = statusText;
  $("#homeSummarySub").textContent = run.status === "awaiting_review" ? "Requires your review" : run.status === "approved" ? "PDF report ready" : "";

  // summary
  const sum = sec.plain_language_summary;
  $("#summaryTitle").textContent = run.submitter.role === "caregiver" ? `${s.patient_name}'s Medical Summary` : "My Medical Summary";
  $("#summaryMeta").textContent = `${s.patient_name} · ${run.contract?.intent.replace(/_/g, " ") ?? ""}${run.contract?.specialty ? ` / ${run.contract.specialty}` : ""} · ${run.mode === "llm" ? "AMD model" : "rules mode"} · ${run.timings.total_s ?? "?"}s`;
  const badge = { awaiting_review: ["● Draft", "warning"], approved: ["✓ Approved", "success"], rejected: ["Rejected", "error"] }[run.status] || [run.status, ""];
  $("#summaryStatus").textContent = badge[0]; $("#summaryStatus").className = `status-badge ${badge[1]}`;
  $("#summaryConf").textContent = sum ? `${sum.confidence} confidence` : ""; $("#summaryConf").className = `conf ${sum?.confidence ?? ""}`;
  const used = [...new Set(s.sections.flatMap((x) => x.items.flatMap((c) => (c.source_ids || []).map((i) => i.split(":")[0]))))].sort();
  $("#summaryContent").innerHTML = `<ul>${(sum?.items || []).map((c) => `<li>${esc(c.text)} ${userTag(c)}${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</li>`).join("")}</ul>
    <div class="source-note">▤ Sources: ${used.map((id) => esc(`${id} ${run.documents.find((d) => d.doc_id === id)?.title || ""}`)).join(" · ") || "none"}</div>`;
  const verified = s.sections.reduce((n, x) => n + x.items.length, 0);
  $("#reviewSources").textContent = `${verified} statements checked against the records${s.removed_claims.length ? `; ${s.removed_claims.length} removed because they could not be traced` : ""}.`;
  const unconfirmed = s.medications.filter((m) => m.status !== "confirmed").length;
  $("#reviewUncertain").textContent = unconfirmed ? `${unconfirmed} medicine(s) could not be confirmed in the drug data.` : "Every medicine was found in the drug data.";
  $("#reviewGrade").textContent = `Reading grade ${s.reading_grade ?? "n/a"}. ${s.disclaimer}`;
  $("#timeline").innerHTML = s.timeline.map((c) => `<li>${esc(c.text)} ${cites(c.source_ids)}</li>`).join("") || `<li class="muted">No dated events.</li>`;

  // review actions + PDF (unchanged endpoints)
  const open = run.status === "awaiting_review", approved = run.status === "approved";
  for (const el of ["#approveBtn", "#rejectBtn", "#improveForm button", "#improveInput", "#questionForm button"]) $(el).disabled = !open;
  $("#viewSources").disabled = $("#copySummary").disabled = false;
  $("#approveBtn").classList.toggle("hidden", !open); $("#rejectBtn").classList.toggle("hidden", !open);
  $("#pdfLink").href = `/api/runs/${run.run_id}/report.pdf`; $("#exportLink").href = `/api/runs/${run.run_id}/export.txt`;
  $("#pdfLink").classList.toggle("hidden", !approved); $("#exportLink").classList.toggle("hidden", !approved);
  $("#fullReport").classList.toggle("hidden", approved);
  $("#fullReport").textContent = run.status === "rejected" ? "Rejected: start a new request" : "Approve to unlock the PDF report";
  $("#summaryNote").textContent = approved ? "Approved. Download the PDF report to print or share with your care team."
    : run.status === "rejected" ? "This summary was rejected and is not final." : "Nothing is final until you approve it. Approving unlocks the PDF report.";
  $("#chatLog").innerHTML = run.chat.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join("");
  $("#chatLog").scrollTop = 1e6;

  // medicines
  const reviewed = new Set(JSON.parse(store.get(`carecoord.meds.${run.run_id}`) || "[]"));
  $("#medicationList").innerHTML = s.medications.map((m, i) => `
    <div class="checklist-item">
      <label><input type="checkbox" class="medication-check" data-i="${i}" ${reviewed.has(i) ? "checked" : ""}>
        <span><strong>${esc(m.name)}</strong>
          <small>${esc(m.directions || "Directions not recorded")}${m.started ? ` · started ${esc(m.started)}` : ""}${m.drug_class ? ` · ${esc(m.drug_class)}` : ""} ${cites(m.source_ids)}</small></span></label>
      ${m.status === "confirmed" ? `<span class="status-badge success">Checked in drug data</span>` : `<span class="status-badge warning">Cannot confirm</span>`}
    </div>`).join("") || `<div class="empty-state">No medicines found in the records.</div>`;
  updateMedProgress();
  const inter = s.interactions.filter((i) => i.confirmed);
  const unchecked = s.interactions.length - inter.length;
  $("#interactionList").innerHTML = (inter.map((i) => `
    <div class="flag-item ${i.severity === "major" ? "red" : "amber"}"><span class="lvl">${esc(i.severity)}</span>
      <b>${esc(i.drugs.join(" + "))}.</b> ${esc(i.description)} <i>${esc(i.note)}</i> ${cites(i.source_ids)}</div>`).join("")
    || `<div class="empty-state">None found in the drug data source.</div>`)
    + (unchecked ? `<p class="small-note">${unchecked} pair(s) could not be checked: cannot confirm. Please ask your doctor or pharmacist.</p>` : "");
  $("#allergyList").innerHTML = s.allergies.map((c) => `<div class="question-item"><p>${esc(c.text)} ${cites(c.source_ids)}</p></div>`).join("")
    || `<div class="empty-state">No allergy information found.</div>`;
  $("#navMedCount").textContent = s.medications.length || "";

  // questions
  const qs = sec.questions_for_doctor?.items || [];
  const asked = new Set(JSON.parse(store.get(`carecoord.q.${run.run_id}`) || "[]"));
  $("#questionList").innerHTML = qs.map((c, i) => `
    <div class="question-item"><input type="checkbox" class="asked-check" data-i="${i}" aria-label="Asked" ${asked.has(i) ? "checked" : ""}>
      <p>${esc(c.text)} ${userTag(c)}</p></div>`).join("") || `<div class="empty-state">No questions yet.</div>`;
  $("#questionCount").textContent = `${qs.length} questions`;
  $("#homeQuestionCount").textContent = qs.length;
  $("#navQuestionCount").textContent = qs.length || "";

  // clinician
  const cr = sec.needs_clinician_review?.items || [];
  const lvl = (c) => c.kind.split(":")[1];
  const flagList = (items, l) => items.map((c) => `<div class="flag-item ${l}">${esc(c.text)} ${cites(c.source_ids)}</div>`).join("") || `<div class="empty-state">Nothing flagged.</div>`;
  const reds = cr.filter((c) => lvl(c) === "red"), ambers = cr.filter((c) => lvl(c) === "amber");
  $("#redList").innerHTML = flagList(reds, "red"); $("#amberList").innerHTML = flagList(ambers, "amber");
  const red = s.flags.filter((f) => f.level === "red").length, amber = s.flags.filter((f) => f.level === "amber").length;
  $("#redCount").textContent = $("#redBadge").textContent = red; $("#amberCount").textContent = $("#amberBadge").textContent = amber;
  $("#clinDocCount").textContent = run.documents.length; $("#clinMedCount").textContent = `${s.medications.length}`;
  $("#clinicianSub").textContent = `${s.patient_name} · ${who} request: “${run.request}”`;
  $("#navFlagCount").textContent = red || "";

  // notifications (real, from this run)
  const notes = [];
  if (red) notes.push(`<p data-view="clinician" class="notif-link">⚑ ${red} item(s) need a clinician's attention.</p>`);
  if (unconfirmed) notes.push(`<p data-view="medications" class="notif-link">✚ ${unconfirmed} medicine(s) cannot be confirmed.</p>`);
  if (open) notes.push(`<p data-view="summary" class="notif-link">▧ Your summary is ready for review.</p>`);
  if (approved) notes.push(`<p data-view="summary" class="notif-link">⇩ Your PDF report is ready.</p>`);
  $("#notificationList").innerHTML = notes.join("") || "<p>Nothing new.</p>";
  $("#notifDot").classList.toggle("hidden", !notes.length);
}

function updateMedProgress() {
  const boxes = $$(".medication-check"), done = [...boxes].filter((b) => b.checked).length;
  $("#medicationProgress").textContent = `${done} of ${boxes.length} reviewed`;
  $("#medicationCheckCount").textContent = `${done}/${boxes.length}`;
}
$("#medicationList").addEventListener("change", () => {
  updateMedProgress();
  store.set(`carecoord.meds.${runId}`, JSON.stringify([...$$(".medication-check")].filter((b) => b.checked).map((b) => +b.dataset.i)));
});
$("#questionList").addEventListener("change", () => {
  store.set(`carecoord.q.${runId}`, JSON.stringify([...$$(".asked-check")].filter((b) => b.checked).map((b) => +b.dataset.i)));
});

// ---------- source viewer ----------
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".cite");
  if (!b || !runId) return;
  const src = await api(`/api/runs/${runId}/source/${encodeURIComponent(b.dataset.src)}`);
  openDialog(src.doc.title || src.doc.filename, `<p class="muted">${esc(src.doc.doc_id)} · ${esc(src.doc.filename)} · ${esc(src.doc.doc_date || "no date")} · page ${src.line.page}, line ${src.line.line}</p>
    <ol class="srclines">${src.context.map((x) => `<li class="${x.is_target ? "target" : ""}"><span class="lid">${esc(x.id)}</span>${esc(x.text)}</li>`).join("")}</ol>`);
});
$("#viewSources").addEventListener("click", () => current && openDialog("Source documents", `<ul>${current.documents.map((d) =>
  `<li><b>${esc(d.doc_id)}</b> · ${esc(d.title || d.filename)} · ${esc(d.doc_date || "no date")}${d.readable ? "" : " · <b>unreadable</b>"}</li>`).join("")}</ul>`));
$("#copySummary").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#summaryContent").innerText); toast("Summary copied.", "success"); }
  catch { toast("Copy is not allowed in this browser.", "warning"); }
});

// ---------- review actions (same endpoints as before) ----------
async function improve(msg) {
  const run = await api(`/api/runs/${runId}/improve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg }) });
  render(run);
  return run;
}
$("#improveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#improveInput").value.trim();
  if (!msg) return;
  $("#improveInput").value = "";
  await improve(msg); toast("Summary updated and re-checked.", "success");
});
$("#questionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = $("#questionInput").value.trim().replace(/^(about|regarding)\s+/i, "");
  if (!topic) return;
  $("#questionInput").value = "";
  const run = await improve(`Add a question about ${topic}`);
  const reply = [...run.chat].reverse().find((m) => m.role === "assistant");
  const box = $("#questionAnswer");
  box.textContent = reply?.text || "Done."; box.classList.remove("hidden");
});
$("#approveBtn").addEventListener("click", async () => { render(await api(`/api/runs/${runId}/approve`, { method: "POST" })); toast("Approved. Your PDF report is ready.", "success"); });
$("#rejectBtn").addEventListener("click", async () => {
  if (confirm("Reject this summary? It will not be marked final.")) render(await api(`/api/runs/${runId}/reject`, { method: "POST" }));
});

init();

// Show unexpected errors instead of failing silently.
window.addEventListener("unhandledrejection", (e) => showError(`Something went wrong: ${e.reason?.message || e.reason}`));
