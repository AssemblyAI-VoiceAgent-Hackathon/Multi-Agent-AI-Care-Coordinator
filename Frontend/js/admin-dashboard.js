"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // --------------------------------------------------
  // UTILITIES
  // --------------------------------------------------

  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);

  let toastTimer;
  let refreshTimer = null;
  let paused = false;

  function toast(message, type = "success") {
    const el = $("#appToast");
    if (!el) return;

    el.textContent = message;
    el.className = `app-toast ${type}`;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function setBar(selector, percentage) {
    const element = $(selector);
    if (element) {
      element.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
    }
  }

  // --------------------------------------------------
  // SCREEN NAVIGATION
  // --------------------------------------------------

  const views = $$(".dashboard-view");
  const navLinks = $$(".sidebar-nav [data-view]");

  const titles = {
    overview: "System Overview",
    agents: "Agent Activity",
    documents: "Document Monitoring",
    verification: "Verification Results",
    hardware: "Hardware & Performance",
    logs: "Logs & Errors",
    settings: "Monitoring Settings"
  };

  function showView(id) {
    if (!views.some(view => view.id === id)) id = "overview";

    views.forEach(view => {
      const active = view.id === id;
      view.hidden = !active;
      view.classList.toggle("active", active);
    });

    navLinks.forEach(link => {
      const active = link.dataset.view === id;
      link.classList.toggle("active", active);

      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    setText("#pageTitle", titles[id]);

    $("#adminSidebar")?.classList.remove("open");
    $("#mobileMenu")?.setAttribute("aria-expanded", "false");

    if (location.hash !== `#${id}`) {
      history.replaceState(null, "", `#${id}`);
    }

    if (id === "hardware") {
      requestAnimationFrame(drawGpuChart);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $$("[data-view]").forEach(element => {
    element.addEventListener("click", event => {
      event.preventDefault();
      showView(element.dataset.view);
    });
  });

  window.addEventListener("popstate", () => {
    showView(location.hash.slice(1) || "overview");
  });

  const initialView = location.hash.slice(1);
  showView(views.some(view => view.id === initialView)
    ? initialView
    : "overview");

  // --------------------------------------------------
  // MOBILE SIDEBAR
  // --------------------------------------------------

  $("#mobileMenu")?.addEventListener("click", () => {
    const sidebar = $("#adminSidebar");
    const open = sidebar.classList.toggle("open");

    $("#mobileMenu").setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", event => {
    const sidebar = $("#adminSidebar");

    if (
      window.innerWidth <= 950 &&
      sidebar?.classList.contains("open") &&
      !sidebar.contains(event.target) &&
      !$("#mobileMenu")?.contains(event.target)
    ) {
      sidebar.classList.remove("open");
      $("#mobileMenu")?.setAttribute("aria-expanded", "false");
    }
  });

  // --------------------------------------------------
  // AGENT DEMO DATA
  // --------------------------------------------------

  const agents = [
    {
      name: "Main Agent",
      status: "Working",
      task: "Planning tasks",
      time: "14:32"
    },
    {
      name: "Intake Agent",
      status: "Completed",
      task: "Selected 3 relevant files",
      time: "14:31"
    },
    {
      name: "Document Classifier",
      status: "Completed",
      task: "Organized 5 sample documents",
      time: "14:31"
    },
    {
      name: "Record Summarizer",
      status: "Working",
      task: "Extracting demonstration facts",
      time: "14:32"
    },
    {
      name: "Medication Checker",
      status: "Idle",
      task: "Waiting for demo input",
      time: "14:30"
    },
    {
      name: "Manager/Compiler",
      status: "Retrying",
      task: "Checking sample claims",
      time: "14:32"
    }
  ];

  function statusClass(status) {
    return {
      Working: "info",
      Completed: "success",
      Idle: "muted",
      Retrying: "warning",
      Paused: "muted"
    }[status] || "muted";
  }

  function renderAgentRows(target, list) {
    const body = $(target);
    if (!body) return;

    if (!list.length) {
      body.innerHTML = `
        <tr><td colspan="4" class="empty-cell">No matching agents.</td></tr>
      `;
      return;
    }

    body.innerHTML = list.map(agent => `
      <tr>
        <td><strong>${escapeHTML(agent.name)}</strong></td>
        <td>
          <span class="status-badge ${statusClass(agent.status)}">
            ${escapeHTML(agent.status)}
          </span>
        </td>
        <td>${escapeHTML(agent.task)}</td>
        <td>${escapeHTML(agent.time)}</td>
      </tr>
    `).join("");
  }

  function renderOverviewAgents() {
    const container = $("#overviewAgentList");
    if (!container) return;

    container.innerHTML = agents.slice(0, 5).map(agent => `
      <div class="agent-mini-row">
        <span class="agent-dot ${statusClass(agent.status)}"></span>
        <strong>${escapeHTML(agent.name)}</strong>
        <span class="status-badge ${statusClass(agent.status)}">
          ${escapeHTML(paused ? "Paused" : agent.status)}
        </span>
        <small>${escapeHTML(agent.task)}</small>
      </div>
    `).join("");
  }

  function filterAgents() {
    const query = ($("#agentSearch")?.value || "").toLowerCase().trim();
    const status = $("#agentStatusFilter")?.value || "all";

    const filtered = agents.filter(agent => {
      const matchesText =
        `${agent.name} ${agent.task} ${agent.status}`.toLowerCase().includes(query);

      const matchesStatus = status === "all" || agent.status === status;
      return matchesText && matchesStatus;
    });

    renderAgentRows("#agentTableBody", filtered);
  }

  $("#agentSearch")?.addEventListener("input", filterAgents);
  $("#agentStatusFilter")?.addEventListener("change", filterAgents);

  $("#toggleMonitoring")?.addEventListener("click", () => {
    paused = !paused;

    $("#toggleMonitoring").textContent =
      paused ? "Resume monitoring" : "Pause monitoring";

    setText("#systemStatus", paused ? "Ⅱ Paused" : "● Running");

    const status = $("#systemStatus");
    status.className = `status-badge ${paused ? "warning" : "success"}`;

    setText(
      "#settingsMonitoringStatus",
      paused
        ? "Monitoring paused. Automatic metric changes are stopped."
        : "Monitoring resumed."
    );

    setText("#settingsStatusBadge", paused ? "Paused" : "Active");
    $("#settingsStatusBadge").className =
      `status-badge ${paused ? "warning" : "success"}`;

    if (paused) {
      stopRefresh();
    } else {
      startRefresh();
    }

    renderAgentRows(
      "#agentTableBody",
      agents.map(agent => ({
        ...agent,
        status: paused ? "Paused" : agent.status
      }))
    );

    renderOverviewAgents();
    toast(paused ? "Demo monitoring paused." : "Demo monitoring resumed.");
  });

  // --------------------------------------------------
  // DOCUMENT MONITORING
  // --------------------------------------------------

  const documents = [
    {
      id: "DOC-001",
      name: "Demo Lab Report.pdf",
      type: "PDF",
      status: "Processed",
      updated: "14:32"
    },
    {
      id: "DOC-002",
      name: "Demo Prescription.txt",
      type: "TXT",
      status: "Processed",
      updated: "14:31"
    },
    {
      id: "DOC-003",
      name: "Demo Discharge Note.pdf",
      type: "PDF",
      status: "In review",
      updated: "14:30"
    },
    {
      id: "DOC-004",
      name: "Sample Imaging Report.jpg",
      type: "JPG",
      status: "Flagged",
      updated: "14:29"
    },
    {
      id: "DOC-005",
      name: "Demo Clinical Notes.txt",
      type: "TXT",
      status: "Processed",
      updated: "14:28"
    },
    {
      id: "DOC-006",
      name: "Sample Follow-up.pdf",
      type: "PDF",
      status: "In review",
      updated: "14:27"
    },
    {
      id: "DOC-007",
      name: "Demo History.pdf",
      type: "PDF",
      status: "Processed",
      updated: "14:26"
    },
    {
      id: "DOC-008",
      name: "Sample Referral.txt",
      type: "TXT",
      status: "Processed",
      updated: "14:25"
    },
    {
      id: "DOC-009",
      name: "Demo Visit Summary.pdf",
      type: "PDF",
      status: "Processed",
      updated: "14:24"
    },
    {
      id: "DOC-010",
      name: "Sample Care Plan.txt",
      type: "TXT",
      status: "Processed",
      updated: "14:23"
    },
    {
      id: "DOC-011",
      name: "Demo Test Results.pdf",
      type: "PDF",
      status: "Processed",
      updated: "14:22"
    },
    {
      id: "DOC-012",
      name: "Sample Instructions.pdf",
      type: "PDF",
      status: "Processed",
      updated: "14:21"
    }
  ];

  function renderDocuments() {
    const query = ($("#documentSearch")?.value || "").toLowerCase().trim();
    const status = $("#documentStatusFilter")?.value || "all";

    const filtered = documents.filter(doc => {
      const text = `${doc.id} ${doc.name} ${doc.type} ${doc.status}`.toLowerCase();
      return text.includes(query) && (status === "all" || doc.status === status);
    });

    const body = $("#documentTableBody");

    body.innerHTML = filtered.length
      ? filtered.map(doc => `
          <tr>
            <td>${escapeHTML(doc.id)}</td>
            <td>${escapeHTML(doc.name)}</td>
            <td>${escapeHTML(doc.type)}</td>
            <td>
              <span class="status-badge ${
                doc.status === "Processed" ? "success" :
                doc.status === "Flagged" ? "danger" : "warning"
              }">${escapeHTML(doc.status)}</span>
            </td>
            <td>${escapeHTML(doc.updated)}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="5" class="empty-cell">No matching documents.</td></tr>';

    setText("#documentTotal", documents.length);
    setText("#documentProcessed", documents.filter(d => d.status === "Processed").length);
    setText("#documentReview", documents.filter(d => d.status === "In review").length);
    setText("#documentFlagged", documents.filter(d => d.status === "Flagged").length);
  }

  $("#documentSearch")?.addEventListener("input", renderDocuments);
  $("#documentStatusFilter")?.addEventListener("change", renderDocuments);

  // --------------------------------------------------
  // VERIFICATION DEMO DATA
  // --------------------------------------------------

  const verification = [
    { id: "VR-001", claim: "Sample claim A", result: "Verified", confidence: "High" },
    { id: "VR-002", claim: "Sample claim B", result: "Verified", confidence: "High" },
    { id: "VR-003", claim: "Sample claim C", result: "Verified", confidence: "Medium" },
    { id: "VR-004", claim: "Sample claim D", result: "Flagged", confidence: "Low" },
    { id: "VR-005", claim: "Sample claim E", result: "Rejected", confidence: "Low" },
    { id: "VR-006", claim: "Sample claim F", result: "Verified", confidence: "High" }
  ];

  function renderVerification() {
    const counts = {
      Verified: 23,
      Flagged: 2,
      Rejected: 1
    };

    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const verifiedPercent = Math.round(counts.Verified / total * 100);

    const flaggedPercent = counts.Flagged / total * 100;
    const rejectedPercent = counts.Rejected / total * 100;

    const gradient =
      `conic-gradient(#00d6a3 0% ${verifiedPercent}%, ` +
      `#ffbe45 ${verifiedPercent}% ${verifiedPercent + flaggedPercent}%, ` +
      `#ff5277 ${verifiedPercent + flaggedPercent}% 100%)`;

    ["#overviewDonut", "#verificationDonut"].forEach(selector => {
      const chart = $(selector);
      if (chart) chart.style.background = gradient;
    });

    setText("#overviewVerifiedPercent", `${verifiedPercent}%`);
    setText("#verifiedPercent", `${verifiedPercent}%`);

    const legendHTML = `
      <div class="legend-row">
        <span><span class="legend-dot green-dot"></span>Verified</span>
        <strong>${counts.Verified}</strong>
      </div>
      <div class="legend-row">
        <span><span class="legend-dot yellow-dot"></span>Flagged</span>
        <strong>${counts.Flagged}</strong>
      </div>
      <div class="legend-row">
        <span><span class="legend-dot red-dot"></span>Rejected</span>
        <strong>${counts.Rejected}</strong>
      </div>
    `;

    $("#overviewVerificationLegend").innerHTML = legendHTML;
    $("#verificationLegend").innerHTML = legendHTML;

    const confidence = [
      ["High", 78],
      ["Medium", 16],
      ["Low", 6]
    ];

    confidence.forEach(([level, percent]) => {
      setText(`#confidence${level}Label`, `${percent}%`);
      setBar(`#confidence${level}Bar`, percent);
    });

    $("#verificationTableBody").innerHTML = verification.map(item => `
      <tr>
        <td>${escapeHTML(item.id)}</td>
        <td>${escapeHTML(item.claim)}</td>
        <td><span class="status-badge ${
          item.result === "Verified" ? "success" :
          item.result === "Flagged" ? "warning" : "danger"
        }">${escapeHTML(item.result)}</span></td>
        <td>${escapeHTML(item.confidence)}</td>
      </tr>
    `).join("");
  }

  // --------------------------------------------------
  // METRICS AND HARDWARE
  // --------------------------------------------------

  let metrics = {
    gpu: 68,
    memory: 42,
    response: 1.8,
    tokens: 48
  };

  const gpuHistory = [48, 52, 50, 57, 54, 60, 58, 55, 63, 59, 68, 62, 65, 58, 68];

  function renderMetrics() {
    const gpu = metrics.gpu;
    const memory = metrics.memory;
    const response = metrics.response;
    const tokens = metrics.tokens;

    setText("#overviewGpu", `${gpu}%`);
    setBar("#overviewGpuBar", gpu);

    setText("#overviewMemory", `${memory} GB / 192 GB`);
    setBar("#overviewMemoryBar", memory / 192 * 100);

    setText("#overviewResponse", `${response.toFixed(1)} s`);
    setBar("#overviewResponseBar", Math.min(100, response / 5 * 100));

    setText("#overviewTokens", `${tokens} tok/s`);
    setBar("#overviewTokensBar", tokens / 80 * 100);

    setText("#hardwareGpu", `${gpu}%`);
    setBar("#hardwareGpuBar", gpu);

    setText("#hardwareMemory", `${memory} GB / 192 GB`);
    setBar("#hardwareMemoryBar", memory / 192 * 100);

    setText("#hardwareResponse", `${response.toFixed(1)} s`);
    setText("#hardwareTokens", `${tokens} tok/s`);

    setText("#chartLatest", `Latest: ${gpu}%`);

    if (gpuHistory[gpuHistory.length - 1] !== gpu) {
      gpuHistory.push(gpu);
      if (gpuHistory.length > 30) gpuHistory.shift();
    }

    if ($("#hardware")?.classList.contains("active")) {
      drawGpuChart();
    }
  }

  function refreshMetrics() {
    if (paused) {
      toast("Monitoring is paused. Resume to update metrics.", "warning");
      return;
    }

    metrics.gpu = randomBetween(45, 88);
    metrics.memory = randomBetween(35, 90);
    metrics.response = randomBetween(9, 32) / 10;
    metrics.tokens = randomBetween(35, 65);

    agents.forEach(agent => {
      agent.time = timeNow().slice(0, 5);
    });

    renderMetrics();
    filterAgents();
    renderOverviewAgents();

    addLog(
      "INFO",
      "Demo metrics refreshed",
      "Generated new simulated performance values."
    );

    renderLogs();
    toast("Simulated metrics refreshed.", "success");
  }

  $("#refreshMetrics")?.addEventListener("click", refreshMetrics);

  // --------------------------------------------------
  // CANVAS LINE CHART
  // --------------------------------------------------

  function drawGpuChart() {
    const canvas = $("#gpuChart");
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = 260 * ratio;

    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);

    const width = rect.width;
    const height = 260;
    const left = 42;
    const right = width - 12;
    const top = 16;
    const bottom = height - 32;

    ctx.clearRect(0, 0, width, height);

    ctx.font = "11px Arial";
    ctx.fillStyle = "#9bb2d0";
    ctx.strokeStyle = "rgba(100,150,200,0.15)";
    ctx.lineWidth = 1;

    [0, 25, 50, 75, 100].forEach(value => {
      const y = bottom - (value / 100) * (bottom - top);

      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();

      ctx.fillText(`${value}%`, 4, y + 4);
    });

    const points = gpuHistory.map((value, index) => ({
      x: left + index / Math.max(1, gpuHistory.length - 1) * (right - left),
      y: bottom - value / 100 * (bottom - top)
    }));

    if (!points.length) return;

    // Fill beneath the line.
    ctx.beginPath();
    ctx.moveTo(points[0].x, bottom);

    points.forEach(point => ctx.lineTo(point.x, point.y));

    ctx.lineTo(points[points.length - 1].x, bottom);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(0,217,255,0.25)");
    gradient.addColorStop(1, "rgba(0,123,255,0.01)");

    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw the neon-blue line.
    ctx.beginPath();

    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });

    ctx.strokeStyle = "#00d9ff";
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "rgba(0,217,255,0.5)";
    ctx.stroke();
    ctx.shadowBlur = 0;

    const last = points[points.length - 1];

    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#00d9ff";
    ctx.fill();
  }

  window.addEventListener("resize", drawGpuChart);

  $("#timeRange")?.addEventListener("change", event => {
    const range = Number(event.target.value);

    setText(
      "#chartSubtitle",
      `Simulated samples from the last ${range === 60 ? "hour" : `${range} minutes`}`
    );

    toast("Chart time range updated for the demo.");
  });

  // --------------------------------------------------
  // RECENT LOGS
  // --------------------------------------------------

  let logs = [
    {
      time: "14:32:10",
      level: "WARN",
      event: "Claim flagged",
      details: "Sample claim requires source verification."
    },
    {
      time: "14:31:45",
      level: "INFO",
      event: "Retry completed",
      details: "Simulated summarizer retry finished."
    },
    {
      time: "14:30:20",
      level: "INFO",
      event: "Processing complete",
      details: "Sample document classification finished."
    },
    {
      time: "14:29:12",
      level: "ERROR",
      event: "Demo validation error",
      details: "Fictional record missing a sample source reference."
    },
    {
      time: "14:28:05",
      level: "INFO",
      event: "Agent initialized",
      details: "Simulated medication checker is idle."
    }
  ];

  function addLog(level, event, details) {
    logs.unshift({
      time: timeNow(),
      level,
      event,
      details
    });

    if (logs.length > 100) logs.pop();
  }

  function renderLogs() {
    const query = ($("#logSearch")?.value || "").toLowerCase().trim();
    const level = $("#logLevelFilter")?.value || "all";

    const filtered = logs.filter(log => {
      const searchable = `${log.time} ${log.level} ${log.event} ${log.details}`.toLowerCase();

      return searchable.includes(query) &&
        (level === "all" || log.level === level);
    });

    const rows = filtered.map(log => `
      <tr>
        <td>${escapeHTML(log.time)}</td>
        <td>
          <span class="status-badge ${
            log.level === "ERROR" ? "danger" :
            log.level === "WARN" ? "warning" : "info"
          }">${escapeHTML(log.level)}</span>
        </td>
        <td>${escapeHTML(log.event)}</td>
        <td>${escapeHTML(log.details)}</td>
      </tr>
    `).join("");

    $("#logTableBody").innerHTML = rows;
    $("#logEmptyState").classList.toggle("hidden", filtered.length > 0);

    const recent = $("#overviewRecentLogs");
    if (recent) {
      recent.innerHTML = logs.slice(0, 4).map(log => `
        <div class="log-mini-row">
          <span class="status-badge ${
            log.level === "ERROR" ? "danger" :
            log.level === "WARN" ? "warning" : "info"
          }">${escapeHTML(log.level)}</span>
          <div>
            <strong>${escapeHTML(log.event)}</strong>
            <small>${escapeHTML(log.details)}</small>
          </div>
          <time>${escapeHTML(log.time)}</time>
        </div>
      `).join("") || '<div class="empty-state">No demo logs.</div>';
    }
  }

  $("#logSearch")?.addEventListener("input", renderLogs);
  $("#logLevelFilter")?.addEventListener("change", renderLogs);

  $("#clearLogs")?.addEventListener("click", () => {
    if (!logs.length) {
      toast("There are no demo logs to clear.", "warning");
      return;
    }

    if (!window.confirm("Clear all simulated logs?")) return;

    logs = [];
    renderLogs();

    toast("Demo logs cleared.", "success");
  });

  // --------------------------------------------------
  // SETTINGS AND AUTOMATIC REFRESH
  // --------------------------------------------------

  const defaultSettings = {
    autoRefresh: true,
    refreshInterval: 5,
    includeWarnings: true
  };

  let settings = { ...defaultSettings };

  function stopRefresh() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startRefresh() {
    stopRefresh();

    if (paused || !settings.autoRefresh) return;

    refreshTimer = setInterval(() => {
      if (paused) return;

      metrics.gpu = randomBetween(45, 88);
      metrics.memory = randomBetween(35, 90);
      metrics.response = randomBetween(9, 32) / 10;
      metrics.tokens = randomBetween(35, 65);

      agents.forEach(agent => {
        agent.time = timeNow().slice(0, 5);
      });

      renderMetrics();
      filterAgents();
      renderOverviewAgents();

      if (settings.includeWarnings && Math.random() < 0.2) {
        addLog(
          "WARN",
          "Simulated performance notice",
          "Generated automatically by the frontend demo."
        );
        renderLogs();
      }
    }, settings.refreshInterval * 1000);
  }

  function loadSettingsIntoForm() {
    $("#autoRefresh").checked = settings.autoRefresh;
    $("#refreshInterval").value = String(settings.refreshInterval);
    $("#includeWarnings").checked = settings.includeWarnings;

    setText(
      "#settingsMonitoringStatus",
      paused
        ? "Monitoring paused."
        : settings.autoRefresh
          ? "Automatic updates enabled."
          : "Automatic updates disabled."
    );

    setText(
      "#settingsStatusBadge",
      paused ? "Paused" : settings.autoRefresh ? "Active" : "Manual"
    );
  }

  $("#saveSettings")?.addEventListener("click", () => {
    settings = {
      autoRefresh: $("#autoRefresh").checked,
      refreshInterval: Number($("#refreshInterval").value),
      includeWarnings: $("#includeWarnings").checked
    };

    startRefresh();
    loadSettingsIntoForm();

    toast("Demo monitoring settings saved.", "success");
  });

  $("#resetSettings")?.addEventListener("click", () => {
    settings = { ...defaultSettings };

    loadSettingsIntoForm();
    startRefresh();

    toast("Settings restored to defaults.", "success");
  });

  // --------------------------------------------------
  // INITIALIZE THE DASHBOARD
  // --------------------------------------------------

  renderMetrics();
  renderAgentRows("#agentTableBody", agents);
  renderOverviewAgents();
  renderDocuments();
  renderVerification();
  renderLogs();
  loadSettingsIntoForm();
  startRefresh();

  // Draw the chart after the page has completed layout.
  requestAnimationFrame(drawGpuChart);

})();