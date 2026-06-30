// Alumère — lightweight identity (phase 1: name only, no password yet).
// You type your name once; a signed httpOnly cookie remembers you for a year, so
// it's not asked again on this device. The server attributes project changes to you.
// Exposes  window.Alumere = { user, ready, switchUser }.  Pages await `ready`
// before loading data, so the identity is known before any save.
(function () {
  let currentUser = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  async function fetchSession() {
    try { const d = await (await fetch("/api/session")).json(); return d.user || null; }
    catch { return null; }
  }
  async function postSession(firstName, lastName) {
    const r = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || "Errore di accesso");
    return d.user;
  }
  async function switchUser() {
    try { await fetch("/api/session/logout", { method: "POST" }); } catch {}
    location.reload();
  }

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

  // Blocking modal asking for first + last name. Resolves with the created user.
  function showOverlay() {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "auth-overlay";
      ov.innerHTML = `
        <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
          <div class="auth-brand"><span class="logo">∑</span><span>Alum<span class="thin">ère</span></span></div>
          <h2 id="authTitle">Chi sei?</h2>
          <p class="auth-sub">Inserisci nome e cognome: le modifiche ai progetti (creazione, salvataggi…) verranno registrate a tuo nome. Te lo chiediamo una volta sola su questo dispositivo.</p>
          <form class="auth-form" novalidate>
            <label>Nome <input name="firstName" autocomplete="given-name" required /></label>
            <label>Cognome <input name="lastName" autocomplete="family-name" required /></label>
            <div class="auth-err" hidden></div>
            <button type="submit" class="btn primary auth-submit">Entra</button>
          </form>
        </div>`;
      document.body.appendChild(ov);
      const form = ov.querySelector("form");
      const err = ov.querySelector(".auth-err");
      const fn = form.querySelector('[name="firstName"]');
      const ln = form.querySelector('[name="lastName"]');
      const btn = ov.querySelector(".auth-submit");
      setTimeout(() => fn.focus(), 30);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.hidden = true;
        if (!fn.value.trim() || !ln.value.trim()) {
          err.textContent = "Inserisci nome e cognome."; err.hidden = false; return;
        }
        btn.disabled = true;
        try {
          const user = await postSession(fn.value, ln.value);
          ov.remove();
          resolve(user);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
      });
    });
  }

  (async function init() {
    currentUser = await fetchSession();
    if (!currentUser) currentUser = await showOverlay();
    renderChip();
    resolveReady(currentUser);
  })();

  window.Alumere = { get user() { return currentUser; }, ready, switchUser };
})();
