"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    [...root.querySelectorAll(selector)];

  const maxBytes = 20 * 1024 * 1024;
  const allowed = new Set(["pdf", "jpg", "jpeg", "png", "txt"]);

  const selectedFiles = new Map();
  const questions = [];
  const activity = [];

  let questionId = 0;
  let toastTimer = null;

  // --------------------------------------------------
  // SHARED UTILITIES
  // --------------------------------------------------

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function toast(message, type = "success") {
    const element = $("#appToast");
    if (!element) return;

    element.textContent = message;
    element.className = `app-toast ${type}`;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      element.classList.add("hidden");
    }, 3200);
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) {
      return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTime(date = new Date()) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function extOf(name) {
    return name.includes(".")
      ? name.split(".").pop().toLowerCase()
      : "";
  }

  // --------------------------------------------------
  // ACTIVITY HISTORY
  // --------------------------------------------------

  function recordActivity(title, details = "") {
    activity.unshift({
      title,
      details,
      time: formatTime()
    });

    if (activity.length > 50) {
      activity.pop();
    }

    renderActivity();
  }

  function renderActivity() {
    const historyHTML = activity.length
      ? activity.map(item => `
          <div class="activity-entry">
            <span class="activity-dot"></span>
            <div>
              <strong>${escapeHTML(item.title)}</strong>
              <small>${escapeHTML(item.details)}</small>
            </div>
            <time>${escapeHTML(item.time)}</time>
          </div>
        `).join("")
      : '<div class="empty-state">No activity recorded yet.</div>';

    const historyList = $("#historyList");
    const homeActivity = $("#homeRecentActivity");

    if (historyList) {
      historyList.innerHTML = historyHTML;
    }

    if (homeActivity) {
      homeActivity.innerHTML = activity.length
        ? historyHTML.slice(0) &&
          activity.slice(0, 4).map(item => `
            <div class="activity-entry">
              <span class="activity-dot"></span>
              <div>
                <strong>${escapeHTML(item.title)}</strong>
                <small>${escapeHTML(item.details)}</small>
              </div>
              <time>${escapeHTML(item.time)}</time>
            </div>
          `).join("")
        : '<div class="empty-state">No activity recorded yet.</div>';
    }
  }

  // --------------------------------------------------
  // SEPARATE DASHBOARD SCREENS
  // --------------------------------------------------

  const views = $$(".dashboard-view");
  const navLinks = $$(".sidebar-nav [data-view]");

  const pageNames = {
    home: "Home",
    documents: "Upload Documents",
    summary: "My Summary",
    medications: "Medication & Allergy",
    questions: "Doctor Questions",
    history: "History"
  };

  function showView(viewId) {
    const target = document.getElementById(viewId);

    if (
      !target ||
      !target.classList.contains("dashboard-view")
    ) {
      viewId = "home";
    }

    views.forEach(view => {
      const isActive = view.id === viewId;

      view.hidden = !isActive;
      view.classList.toggle("active", isActive);
    });

    navLinks.forEach(link => {
      const isActive = link.dataset.view === viewId;

      link.classList.toggle("active", isActive);

      if (isActive) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

    const title = $("#pageTitle");

    if (title) {
      title.textContent = pageNames[viewId] || "Home";
    }

    // Close open menus after navigating.
    $("#profileMenu")?.classList.add("hidden");
    $("#notificationPanel")?.classList.add("hidden");

    $("#profileButton")?.setAttribute("aria-expanded", "false");
    $("#notificationButton")?.setAttribute("aria-expanded", "false");

    // Close the mobile sidebar after selecting a screen.
    $("#sidebar")?.classList.remove("open");
    $("#mobileMenu")?.setAttribute("aria-expanded", "false");

    // Preserve the selected screen in the URL.
    if (location.hash !== `#${viewId}`) {
      history.replaceState(null, "", `#${viewId}`);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Both sidebar links and buttons on the Home screen work.
  $$("[data-view]").forEach(element => {
    element.addEventListener("click", event => {
      event.preventDefault();
      showView(element.dataset.view);
    });
  });

  // Restore the selected screen on page load.
  const requestedView = location.hash.slice(1);

  showView(
    views.some(view => view.id === requestedView)
      ? requestedView
      : "home"
  );

  // Support browser back/forward navigation.
  window.addEventListener("popstate", () => {
    const id = location.hash.slice(1);
    showView(id || "home");
  });

  // --------------------------------------------------
  // MOBILE SIDEBAR
  // --------------------------------------------------

  const sidebar = $("#sidebar");
  const mobileMenu = $("#mobileMenu");

  mobileMenu?.addEventListener("click", () => {
    const isOpen = sidebar.classList.toggle("open");

    mobileMenu.setAttribute("aria-expanded", String(isOpen));
    mobileMenu.setAttribute(
      "aria-label",
      isOpen ? "Close navigation" : "Open navigation"
    );
  });

  document.addEventListener("click", event => {
    if (
      window.innerWidth <= 950 &&
      sidebar?.classList.contains("open") &&
      !sidebar.contains(event.target) &&
      !mobileMenu?.contains(event.target)
    ) {
      sidebar.classList.remove("open");
      mobileMenu?.setAttribute("aria-expanded", "false");
    }
  });

  // --------------------------------------------------
  // PROFILE MENU AND NOTIFICATIONS
  // --------------------------------------------------

  $("#profileButton")?.addEventListener("click", () => {
    const menu = $("#profileMenu");
    const opening = menu.classList.contains("hidden");

    menu.classList.toggle("hidden", !opening);

    $("#profileButton").setAttribute(
      "aria-expanded",
      String(opening)
    );

    $("#notificationPanel")?.classList.add("hidden");
  });

  $("#notificationButton")?.addEventListener("click", () => {
    const panel = $("#notificationPanel");
    const opening = panel.classList.contains("hidden");

    panel.classList.toggle("hidden", !opening);

    $("#notificationButton").setAttribute(
      "aria-expanded",
      String(opening)
    );

    $("#profileMenu")?.classList.add("hidden");
  });

  $("#profileInfo")?.addEventListener("click", () => {
    showDialog(
      "Demo account",
      "<p><strong>Name:</strong> Ayesha Khan</p>" +
      "<p><strong>Account type:</strong> Patient / Caregiver</p>" +
      "<p>This is fictional profile information for the frontend demo.</p>"
    );
  });

  $("#helpButton")?.addEventListener("click", () => {
    showDialog(
      "CareCoordinator help",
      "<p><strong>Upload Documents:</strong> Select supported files.</p>" +
      "<p><strong>My Summary:</strong> Review the fictional summary.</p>" +
      "<p><strong>Medication & Allergy:</strong> Review the sample checklist.</p>" +
      "<p><strong>Doctor Questions:</strong> Prepare discussion topics.</p>" +
      "<p>All medical content on this page is demonstration data. " +
      "This website is not a medical service.</p>"
    );
  });

  // --------------------------------------------------
  // FILE UPLOAD DEMONSTRATION
  // --------------------------------------------------

  const fileInput = $("#fileInput");
  const dropZone = $("#dropZone");
  const fileList = $("#fileList");
  const uploadButton = $("#simulateUpload");
  const recentDocuments = $("#recentDocuments");

  function renderFiles() {
    const files = [...selectedFiles.values()];

    const count = $("#selectedCount");
    if (count) {
      count.textContent =
        `${files.length} file${files.length === 1 ? "" : "s"}`;
    }

    const homeCount = $("#homeDocumentCount");
    if (homeCount) {
      homeCount.textContent = files.length;
    }

    if (!files.length) {
      fileList.innerHTML =
        '<div class="empty-state">Your selected documents will appear here.</div>';
    } else {
      fileList.innerHTML = files.map(file => `
        <div class="file-item" data-file-id="${escapeHTML(file.id)}">
          <span class="file-type-icon">▤</span>

          <div class="file-meta">
            <b>${escapeHTML(file.name)}</b>
            <small>
              ${formatSize(file.size)} · ${escapeHTML(file.status)}
            </small>
            <div class="file-progress">
              <span style="width:${file.progress}%"></span>
            </div>
          </div>

          <button type="button"
                  class="file-remove"
                  data-remove-file="${escapeHTML(file.id)}"
                  aria-label="Remove ${escapeHTML(file.name)}"
                  ${file.status === "Uploading demo" ? "disabled" : ""}>
            ×
          </button>
        </div>
      `).join("");
    }

    const pending = files.some(file => file.status === "Selected");

    uploadButton.disabled = !pending;

    $$("[data-remove-file]").forEach(button => {
      button.addEventListener("click", () => {
        selectedFiles.delete(button.dataset.removeFile);
        renderFiles();
        recordActivity("Document removed", "Removed a selected demo file.");
      });
    });

    renderRecent();
  }

  function renderRecent() {
    const query = ($("#documentSearch")?.value || "")
      .trim()
      .toLowerCase();

    const files = [...selectedFiles.values()].filter(file =>
      file.name.toLowerCase().includes(query)
    );

    if (!files.length) {
      recentDocuments.innerHTML = `
        <div class="empty-state">
          ${query ? "No matching documents." : "No documents selected yet."}
        </div>
      `;
      return;
    }

    recentDocuments.innerHTML = files.map(file => `
      <div class="recent-document">
        <span class="file-type-icon">▤</span>
        <div class="file-meta">
          <b>${escapeHTML(file.name)}</b>
          <small>
            ${formatSize(file.size)} · ${escapeHTML(file.status)}
          </small>
        </div>
      </div>
    `).join("");
  }

  function addFiles(fileCollection) {
    [...fileCollection].forEach(file => {
      const ext = extOf(file.name);

      if (!allowed.has(ext)) {
        toast(`${file.name}: file type not supported.`, "error");
        return;
      }

      if (file.size > maxBytes) {
        toast(`${file.name}: exceeds the 20 MB limit.`, "error");
        return;
      }

      if (file.size === 0) {
        toast(`${file.name}: file is empty.`, "error");
        return;
      }

      // Avoid duplicate selections of the same file.
      const duplicate = [...selectedFiles.values()].some(existing =>
        existing.name === file.name &&
        existing.size === file.size &&
        existing.lastModified === file.lastModified
      );

      if (duplicate) {
        toast(`${file.name}: already selected.`, "warning");
        return;
      }

      const id = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      selectedFiles.set(id, {
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        status: "Selected",
        progress: 0
      });

      recordActivity("Document selected", file.name);
    });

    renderFiles();
  }

  $("#browseFiles")?.addEventListener("click", event => {
    event.stopPropagation();
    fileInput?.click();
  });

  dropZone?.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    fileInput?.click();
  });

  dropZone?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput?.click();
    }
  });

  fileInput?.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(type => {
    dropZone?.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach(type => {
    dropZone?.addEventListener(type, event => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone?.addEventListener("drop", event => {
    if (event.dataTransfer?.files) {
      addFiles(event.dataTransfer.files);
    }
  });

  $("#documentSearch")?.addEventListener("input", renderRecent);

  uploadButton?.addEventListener("click", () => {
    const pending = [...selectedFiles.values()].filter(
      file => file.status === "Selected"
    );

    if (!pending.length) return;

    pending.forEach(file => {
      file.status = "Uploading demo";
      file.progress = 0;
    });

    uploadButton.disabled = true;
    renderFiles();

    recordActivity(
      "Demo upload started",
      `${pending.length} file(s) selected for simulated processing.`
    );

    // This is only a browser animation. No file is sent to a server.
    let progress = 0;

    const interval = window.setInterval(() => {
      progress = Math.min(100, progress + 20);

      pending.forEach(file => {
        if (selectedFiles.has(file.id)) {
          file.progress = progress;
        }
      });

      if (progress >= 100) {
        window.clearInterval(interval);

        pending.forEach(file => {
          if (selectedFiles.has(file.id)) {
            file.status = "Demo upload complete";
            file.progress = 100;
          }
        });

        renderFiles();

        recordActivity(
          "Demo upload complete",
          `${pending.length} file(s) processed in the frontend only.`
        );

        toast(
          `${pending.length} file(s) processed in the demo. No server upload occurred.`,
          "success"
        );
      } else {
        renderFiles();
      }
    }, 300);
  });

  // --------------------------------------------------
  // REUSABLE DIALOG
  // --------------------------------------------------

  const dialog = $("#detailDialog");

  function showDialog(title, content) {
    $("#dialogTitle").textContent = title;
    $("#dialogContent").innerHTML = content;

    if (dialog?.showModal) {
      dialog.showModal();
    } else {
      toast(title);
    }
  }

  $("#closeDialog")?.addEventListener("click", () => {
    dialog?.close();
  });

  dialog?.addEventListener("click", event => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  // --------------------------------------------------
  // MEDICAL SUMMARY
  // --------------------------------------------------

  $("#viewSources")?.addEventListener("click", () => {
    showDialog(
      "Summary sources",
      "<p>These are illustrative source labels, not real uploaded records.</p>" +
      "<ul>" +
      "<li>Demo Lab Report.pdf — sample laboratory result</li>" +
      "<li>Demo Prescription.txt — sample medication list</li>" +
      "<li>Demo Discharge Note.pdf — sample follow-up note</li>" +
      "</ul>" +
      "<p>In a real system, every generated statement should link to " +
      "the exact page or passage in its source document.</p>"
    );
  });

  $("#editSummary")?.addEventListener("click", () => {
    const content = $("#summaryContent");
    if (!content) return;

    const current = content.innerText;

    const textarea = document.createElement("textarea");
    textarea.className = "form-control";
    textarea.value = current;
    textarea.rows = 10;
    textarea.setAttribute("aria-label", "Edit demonstration summary");

    const save = document.createElement("button");
    save.className = "btn btn-primary";
    save.type = "button";
    save.textContent = "Save edited demo summary";

    content.replaceChildren(textarea, save);

    save.addEventListener("click", () => {
      const safeText = escapeHTML(textarea.value)
        .replace(/\n/g, "<br>");

      content.innerHTML = `
        <div>${safeText}</div>
        <div class="source-note">▤ Demo sources — review before use</div>
      `;

      recordActivity("Summary edited", "Saved a local demo summary edit.");
      toast("Demo summary edits saved in this page.", "success");
    });

    textarea.focus();
  });

  $("#copySummary")?.addEventListener("click", async () => {
    const text = $("#summaryContent")?.innerText || "";

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }

      await navigator.clipboard.writeText(text);
      toast("Summary copied.", "success");
    } catch {
      showDialog(
        "Copy summary",
        `<p>Clipboard access is unavailable.</p>
         <textarea class="form-control" rows="9"
         readonly>${escapeHTML(text)}</textarea>
         <p>Select the text above and copy it manually.</p>`
      );
    }
  });

  $("#approveSummary")?.addEventListener("click", () => {
    if (!window.confirm(
      "Mark this fictional sample summary as reviewed? This does not represent clinical approval."
    )) {
      return;
    }

    const status = $("#summaryStatus");

    status.textContent = "✓ Demo reviewed";
    status.className = "status-badge success";

    recordActivity(
      "Summary marked reviewed",
      "Demo status only; no clinical approval occurred."
    );

    toast("Marked as reviewed in this demo only.", "success");
  });

  $("#fullReport")?.addEventListener("click", () => {
    showDialog(
      "Full demo report",
      "<p><strong>Document overview</strong></p>" +
      "<ul>" +
      "<li>Three fictional source categories are shown for illustration.</li>" +
      "<li>One sample detail is flagged for clinician review.</li>" +
      "<li>No real health documents have been analyzed.</li>" +
      "</ul>" +
      "<p><strong>Next step:</strong> verify every finding against " +
      "original records with a qualified clinician.</p>"
    );
  });

  $("#medicationDetails")?.addEventListener("click", () => {
    showDialog(
      "Medication & allergy checklist",
      "<p>This is a fictional checklist for interface testing.</p>" +
      "<ul>" +
      "<li>Medication list: confirm current medicines and doses.</li>" +
      "<li>Allergies: confirm the substance and reaction with a clinician.</li>" +
      "<li>Interactions: do not rely on this demo to assess medication safety.</li>" +
      "</ul>"
    );
  });

  // --------------------------------------------------
  // MEDICATION CHECKLIST
  // --------------------------------------------------

  const medicationChecks = $$(".medication-check");

  function updateMedicationCount() {
    const completed = medicationChecks.filter(input => input.checked).length;

    const progress = $("#medicationProgress");
    const homeCount = $("#medicationCheckCount");

    if (progress) {
      progress.textContent = `${completed} of ${medicationChecks.length} reviewed`;
    }

    if (homeCount) {
      homeCount.textContent = `${completed}/${medicationChecks.length}`;
    }
  }

  medicationChecks.forEach(input => {
    input.addEventListener("change", () => {
      updateMedicationCount();

      recordActivity(
        "Checklist updated",
        `${input.checked ? "Reviewed" : "Unmarked"} a demo checklist item.`
      );
    });
  });

  // --------------------------------------------------
  // DOCTOR QUESTIONS
  // --------------------------------------------------

  const questionForm = $("#questionForm");
  const questionInput = $("#questionInput");
  const questionList = $("#questionList");

  function renderQuestions() {
    const count = $("#questionCount");
    const homeCount = $("#homeQuestionCount");

    if (count) {
      count.textContent =
        `${questions.length} question${questions.length === 1 ? "" : "s"}`;
    }

    if (homeCount) {
      homeCount.textContent = questions.length;
    }

    if (!questions.length) {
      questionList.innerHTML =
        '<div class="empty-state">Your questions will appear here.</div>';
      return;
    }

    questionList.innerHTML = questions.map(question => `
      <div class="question-item">
        <p>${escapeHTML(question.text)}</p>
        <button type="button"
                class="remove-question"
                data-remove-question="${question.id}"
                aria-label="Remove question">×</button>
      </div>
    `).join("");

    $$("[data-remove-question]", questionList).forEach(button => {
      button.addEventListener("click", () => {
        const id = Number(button.dataset.removeQuestion);
        const index = questions.findIndex(item => item.id === id);

        if (index !== -1) {
          questions.splice(index, 1);
          renderQuestions();
          recordActivity("Question removed", "Removed a demo question.");
          toast("Question removed.", "success");
        }
      });
    });
  }

  questionForm?.addEventListener("submit", event => {
    event.preventDefault();

    const text = questionInput.value.trim();

    if (!text) {
      toast("Type a question first.", "error");
      questionInput.focus();
      return;
    }

    questions.push({
      id: ++questionId,
      text
    });

    questionInput.value = "";

    renderQuestions();

    $("#questionAnswer").classList.add("hidden");

    recordActivity("Question added", text);
    toast("Question added to your demo list.", "success");
  });

  // --------------------------------------------------
  // CLEAR HISTORY
  // --------------------------------------------------

  $("#clearHistory")?.addEventListener("click", () => {
    if (!activity.length) {
      toast("There is no history to clear.", "warning");
      return;
    }

    if (!window.confirm("Clear the activity history for this page session?")) {
      return;
    }

    activity.length = 0;
    renderActivity();
    toast("Demo activity history cleared.", "success");
  });

  // --------------------------------------------------
  // INITIALIZE
  // --------------------------------------------------

  renderFiles();
  renderQuestions();
  renderActivity();
  updateMedicationCount();

  recordActivity(
    "Dashboard opened",
    "CareCoordinator frontend demonstration started."
  );

})();
