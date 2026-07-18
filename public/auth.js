// Alumère — passwordless identity (magic link, domain-restricted).
// You sign in with your company email; we mail a single-use link that, when opened,
// sets a signed httpOnly cookie (remembered for a year on this device). The display
// name is derived server-side from the address (mario.rossi@ → "Mario Rossi"). No passwords.
// Exposes  window.Alumere = { user, ready, switchUser }.  Pages await `ready` before
// loading data, so the identity is known before any request (and `ready` stays pending
// while a forced login overlay is up, which keeps gated calls from firing unauthenticated).
(function () {
  let currentUser = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  async function fetchSession() {
    try { const d = await (await fetch("/api/session")).json(); return d.user || null; }
    catch { return null; }
  }
  // Ask the server to email a login link. Throws with the server's message on failure
  // (wrong domain → 403, too many requests → 429, …) so the overlay can show it.
  async function requestLink(email) {
    const r = await fetch("/api/auth/request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || "Couldn't send, please try again.");
    return d;
  }
  // "Switch user": reopen the login overlay in dismissable mode WITHOUT logging out.
  // The switch only takes effect once a new login completes (its cookie overwrites this
  // one); closing with the ✕ leaves the current session untouched.
  function switchUser() { showLoginOverlay(true); }

  // Small "👤 Name · Switch" chip in the top bar's toolbar.
  function renderChip() {
    const bar = document.querySelector(".topbar .toolbar");
    if (!bar || !currentUser) return;
    let chip = document.getElementById("userChip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "userChip"; chip.className = "user-chip";
      bar.insertBefore(chip, bar.firstChild);
    }
    chip.innerHTML = "";
    const who = document.createElement("span");
    who.className = "user-chip-name"; who.textContent = "👤 " + currentUser.name;
    const sw = document.createElement("button");
    sw.type = "button"; sw.className = "user-chip-switch";
    sw.textContent = "Switch"; sw.title = "Switch user";
    sw.addEventListener("click", switchUser);
    chip.append(who, sw);
  }

  const BRAND = `<div class="auth-brand"><span class="logo">∑</span><span>Alum<span class="thin">ère</span></span></div>`;
  const closeBtn = (dismissable) =>
    dismissable ? `<button type="button" class="auth-close" aria-label="Close" title="Close (you stay signed in)">✕</button>` : "";

  function destroyOverlay(ov) {
    if (ov._poll) clearInterval(ov._poll);
    if (ov._onKey) document.removeEventListener("keydown", ov._onKey);
    ov.remove();
  }
  // Wire the ✕ (present only when dismissable) + Esc to close, leaving the session as is.
  function wireClose(ov) {
    const x = ov.querySelector(".auth-close");
    if (!x) return;
    x.addEventListener("click", () => destroyOverlay(ov));
    if (ov._onKey) document.removeEventListener("keydown", ov._onKey);
    ov._onKey = (e) => { if (e.key === "Escape") destroyOverlay(ov); };
    document.addEventListener("keydown", ov._onKey);
  }

  // Login modal. `dismissable` adds a ✕ (used by "Switch user"); the first, forced
  // login (no session yet) is not dismissable.
  function showLoginOverlay(dismissable) {
    const ov = document.createElement("div");
    ov.className = "auth-overlay";
    ov.innerHTML = `
      <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        ${closeBtn(dismissable)}
        ${BRAND}
        <h2 id="authTitle">Sign in</h2>
        <p class="auth-sub">Enter your work email: we'll send you a link to sign in. No password.</p>
        <form class="auth-form" novalidate>
          <label>Email <input name="email" type="email" autocomplete="email" inputmode="email" required placeholder="name.surname@…" /></label>
          <div class="auth-err" hidden></div>
          <button type="submit" class="btn primary auth-submit">Send me the link</button>
        </form>
      </div>`;
    document.body.appendChild(ov);
    wireClose(ov);
    const form = ov.querySelector("form");
    const err = ov.querySelector(".auth-err");
    const input = form.querySelector('[name="email"]');
    const btn = ov.querySelector(".auth-submit");
    setTimeout(() => input.focus(), 30);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const email = input.value.trim();
      if (!email) { err.textContent = "Enter your email."; err.hidden = false; return; }
      btn.disabled = true;
      try { await requestLink(email); showSentState(ov, email, dismissable); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
  }

  // "Check your inbox" state: wait for the link to be opened on this device. We poll the
  // session until it becomes the JUST-REQUESTED user (not merely "any session" — during a
  // switch the previous session is still active), then reload.
  function showSentState(ov, email, dismissable) {
    const expectId = email.toLowerCase();
    const card = ov.querySelector(".auth-card");
    card.innerHTML = `
      ${closeBtn(dismissable)}
      ${BRAND}
      <h2>Check your inbox</h2>
      <p class="auth-sub">We've sent a sign-in link to <strong class="auth-email"></strong>.
        Open it <strong>on this device</strong> to sign in — it expires in a few minutes.</p>
      <p class="auth-sub" style="opacity:.7">You can leave this page open: it unlocks itself as soon as you sign in.</p>
      <button type="button" class="user-chip-switch auth-back">Use a different email</button>`;
    card.querySelector(".auth-email").textContent = email;   // textContent → no HTML injection
    wireClose(ov);
    card.querySelector(".auth-back").addEventListener("click", () => {
      destroyOverlay(ov);
      showLoginOverlay(dismissable);
    });
    ov._poll = setInterval(async () => {
      const u = await fetchSession();
      if (u && u.id === expectId) { clearInterval(ov._poll); location.reload(); }
    }, 3000);
  }

  (async function init() {
    currentUser = await fetchSession();
    if (!currentUser) { showLoginOverlay(false); return; }   // `ready` stays pending until login + reload
    renderChip();
    resolveReady(currentUser);
  })();

  window.Alumere = { get user() { return currentUser; }, ready, switchUser };
})();
