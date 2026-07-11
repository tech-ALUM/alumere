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
    if (!r.ok || !d.ok) throw new Error(d.error || "Invio non riuscito, riprova.");
    return d;
  }
  // "Cambia utente": reopen the login overlay in dismissable mode WITHOUT logging out.
  // The switch only takes effect once a new login completes (its cookie overwrites this
  // one); closing with the ✕ leaves the current session untouched.
  function switchUser() { showLoginOverlay(true); }

  // Small "👤 Name · Cambia" chip in the top bar's toolbar.
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
    sw.textContent = "Cambia"; sw.title = "Cambia utente";
    sw.addEventListener("click", switchUser);
    chip.append(who, sw);
  }

  const BRAND = `<div class="auth-brand"><span class="logo">∑</span><span>Alum<span class="thin">ère</span></span></div>`;
  const closeBtn = (dismissable) =>
    dismissable ? `<button type="button" class="auth-close" aria-label="Chiudi" title="Chiudi (resti connesso)">✕</button>` : "";

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

  // Login modal. `dismissable` adds a ✕ (used by "Cambia utente"); the first, forced
  // login (no session yet) is not dismissable.
  function showLoginOverlay(dismissable) {
    const ov = document.createElement("div");
    ov.className = "auth-overlay";
    ov.innerHTML = `
      <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        ${closeBtn(dismissable)}
        ${BRAND}
        <h2 id="authTitle">Accedi</h2>
        <p class="auth-sub">Inserisci la tua email aziendale: ti mandiamo un link per entrare. Nessuna password.</p>
        <form class="auth-form" novalidate>
          <label>Email <input name="email" type="email" autocomplete="email" inputmode="email" required placeholder="nome.cognome@…" /></label>
          <div class="auth-err" hidden></div>
          <button type="submit" class="btn primary auth-submit">Inviami il link</button>
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
      if (!email) { err.textContent = "Inserisci la tua email."; err.hidden = false; return; }
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
      <h2>Controlla la posta</h2>
      <p class="auth-sub">Ti abbiamo inviato un link di accesso a <strong class="auth-email"></strong>.
        Aprilo <strong>da questo dispositivo</strong> per entrare — scade tra pochi minuti.</p>
      <p class="auth-sub" style="opacity:.7">Puoi lasciare aperta questa pagina: si sblocca da sola appena accedi.</p>
      <button type="button" class="user-chip-switch auth-back">Usa un'altra email</button>`;
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
