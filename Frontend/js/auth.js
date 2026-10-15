(() => {
  const $ = selector => document.querySelector(selector);
  const getUsers = () => {
    try { return JSON.parse(localStorage.getItem("ccDemoUsers") || "[]"); }
    catch { return []; }
  };
  const saveUsers = users => localStorage.setItem("ccDemoUsers", JSON.stringify(users));
  const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const setError = (id, message) => { const el = document.getElementById(id); if (el) el.textContent = message || ""; };
  const hashDemoPassword = async password => {
    // SHA-256 is only a demo safeguard; browser-side hashing is not secure authentication.
    if (window.crypto?.subtle && window.TextEncoder) {
      const bytes = new TextEncoder().encode(password);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    return `demo-${password.length}-${password.slice(0, 1)}-${password.slice(-1)}`;
  };

  const signupForm = $("#signupForm");
  if (signupForm) {
    const password = $("#signupPassword");
    password?.addEventListener("input", () => {
      const value = password.value;
      let score = 0;
      if (value.length >= 8) score++;
      if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
      if (/\d/.test(value)) score++;
      if (/[^A-Za-z0-9]/.test(value)) score++;
      const bar = $("#strengthBar");
      const label = $("#strengthText");
      const widths = ["0%", "25%", "50%", "75%", "100%"];
      if (bar) { bar.style.width = widths[score]; bar.style.background = score < 2 ? "#ff5277" : score < 3 ? "#ffbe45" : "#00d6a3"; }
      if (label) label.textContent = value ? ["Too weak", "Weak", "Fair", "Good", "Strong"][score] : "Use 8+ characters with a mix of letters and numbers.";
    });

    signupForm.addEventListener("submit", async event => {
      event.preventDefault();
      ["nameError", "signupEmailError", "signupPasswordError", "confirmPasswordError", "termsError"].forEach(id => setError(id, ""));
      const name = $("#fullName").value.trim();
      const email = $("#signupEmail").value.trim().toLowerCase();
      const pass = $("#signupPassword").value;
      const confirm = $("#confirmPassword").value;
      const type = $("#accountType").value;
      let valid = true;
      if (name.length < 2) { setError("nameError", "Please enter your name."); valid = false; }
      if (!validEmail(email)) { setError("signupEmailError", "Enter a valid email address."); valid = false; }
      if (pass.length < 8) { setError("signupPasswordError", "Use at least 8 characters."); valid = false; }
      if (pass !== confirm) { setError("confirmPasswordError", "Passwords do not match."); valid = false; }
      if (!$("#terms").checked) { setError("termsError", "Please accept the demo terms to continue."); valid = false; }
      const users = getUsers();
      if (users.some(user => user.email === email)) { setError("signupEmailError", "An account with this email already exists in this browser."); valid = false; }
      if (!valid) return;

      const submit = signupForm.querySelector('button[type="submit"]');
      submit.disabled = true; submit.textContent = "Creating demo account…";
      try {
        users.push({ name, email, passwordHash: await hashDemoPassword(pass), type });
        saveUsers(users);
        sessionStorage.setItem("ccUser", JSON.stringify({ name, email, type }));
        CareUI.toast("Demo account created. Opening your dashboard…", "success");
        window.setTimeout(() => { window.location.href = type === "admin" ? "admin-dashboard.html" : "patient-dashboard.html"; }, 650);
      } catch {
        CareUI.toast("Could not create the demo account. Please try again.", "error");
        submit.disabled = false; submit.innerHTML = 'Create account <span>→</span>';
      }
    });
  }

  const loginForm = $("#loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async event => {
      event.preventDefault();
      setError("loginEmailError", ""); setError("loginPasswordError", "");
      const email = $("#loginEmail").value.trim().toLowerCase();
      const password = $("#loginPassword").value;
      let valid = true;
      if (!validEmail(email)) { setError("loginEmailError", "Enter a valid email address."); valid = false; }
      if (!password) { setError("loginPasswordError", "Enter your password."); valid = false; }
      if (!valid) return;
      const submit = $("#loginSubmit");
      submit.disabled = true; submit.textContent = "Signing in…";
      const users = getUsers();
      const user = users.find(item => item.email === email);
      const passwordHash = await hashDemoPassword(password);
      const demoLogin = email === "demo@carecoordinator.test" && password.length >= 8;
      if ((user && user.passwordHash === passwordHash) || demoLogin) {
        const account = user || { name: "Ayesha Khan", email, type: "patient" };
        sessionStorage.setItem("ccUser", JSON.stringify({ name: account.name, email: account.email, type: account.type || "patient" }));
        CareUI.toast("Demo sign-in successful.", "success");
        window.setTimeout(() => { window.location.href = account.type === "admin" ? "admin-dashboard.html" : "patient-dashboard.html"; }, 450);
      } else {
        setError("loginPasswordError", "Account not found or password incorrect. Create an account or use the demo login.");
        submit.disabled = false; submit.innerHTML = 'Sign in <span>→</span>';
      }
    });
    $("#forgotPassword")?.addEventListener("click", () => CareUI.toast("Password reset requires a backend. For this demo, create a new demo account."));
    $("#googleDemo")?.addEventListener("click", () => CareUI.toast("Google sign-in is a visual demo. OAuth is not connected."));
  }
})();