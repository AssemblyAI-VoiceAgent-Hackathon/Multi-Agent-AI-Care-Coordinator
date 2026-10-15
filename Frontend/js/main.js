(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  window.CareUI = {
    toast(message, type = "info") {
      let region = $("#toastRegion");
      if (!region) {
        region = document.createElement("div");
        region.id = "toastRegion";
        region.className = "toast-region";
        region.setAttribute("aria-live", "polite");
        document.body.appendChild(region);
      }
      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      toast.textContent = message;
      region.appendChild(toast);
      window.setTimeout(() => toast.remove(), 3800);
    },
    escapeHTML(value) {
      return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }
  };

  const menuButton = $("[data-mobile-menu]");
  if (menuButton) {
    menuButton.addEventListener("click", () => {
      const nav = $("[data-nav]");
      if (nav) nav.classList.toggle("open");
    });
  }

  const sidebar = $("#patientSidebar") || $("#adminSidebar");
  $$("[data-open-sidebar]").forEach(button => button.addEventListener("click", () => sidebar?.classList.add("open")));
  $$("[data-close-sidebar]").forEach(button => button.addEventListener("click", () => sidebar?.classList.remove("open")));
  $$("[data-section]").forEach(link => link.addEventListener("click", () => {
    $$("[data-section]").forEach(item => item.classList.toggle("active", item === link));
    sidebar?.classList.remove("open");
  }));

  const profileButton = $("[data-profile-menu]");
  if (profileButton) profileButton.addEventListener("click", () => $("#profilePopover")?.classList.toggle("hidden"));
  $$("[data-logout]").forEach(button => button.addEventListener("click", () => {
    sessionStorage.removeItem("ccUser");
    window.location.href = "login.html";
  }));

  $$("[data-toggle-password]").forEach(button => button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  }));

  const storedUser = (() => {
    try { return JSON.parse(sessionStorage.getItem("ccUser") || "null"); }
    catch { return null; }
  })();
  if (storedUser) {
    const welcome = $("#welcomeName");
    const sidebarName = $("#sidebarUserName");
    const firstName = (storedUser.name || "Ayesha").trim().split(/\s+/)[0];
    if (welcome) welcome.textContent = firstName;
    if (sidebarName) sidebarName.textContent = storedUser.name || "Ayesha Khan";
  }

  const notificationButton = $("[data-notifications]");
  if (notificationButton) notificationButton.addEventListener("click", () => CareUI.toast("No new notifications in this demo."));
  const helpButton = $("#helpButton");
  if (helpButton) helpButton.addEventListener("click", () => CareUI.toast("Tip: upload a sample document and explore the summary review tools."));
})();