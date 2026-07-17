// Alumère — aspetto app (chiaro / scuro / auto) + menu impostazioni (⚙), CONDIVISO
// fra la home e l'editor. L'applicazione pre-paint del tema vive come piccolo script
// inline nell'<head> di ogni pagina (niente flash); qui si cablano i controlli a runtime:
// il <select id="appTheme"> e l'apri/chiudi del dropdown ⚙ (#settingsMenu). Così un
// controllo aggiunto a una pagina funziona anche sull'altra senza duplicare codice.
(function () {
  const KEY = "alumere.appTheme";
  function apply(v) {
    if (v === "dark" || v === "light") document.documentElement.dataset.appTheme = v;
    else delete document.documentElement.dataset.appTheme;   // "auto" → decide prefers-color-scheme
    try { localStorage.setItem(KEY, v); } catch {}
  }
  function saved() {
    let v = "auto";
    try { v = localStorage.getItem(KEY) || "auto"; } catch {}
    return ["auto", "light", "dark"].includes(v) ? v : "auto";
  }
  function wireSelect() {
    const sel = document.getElementById("appTheme");
    if (!sel) return;
    sel.value = saved();
    sel.addEventListener("change", () => apply(sel.value));
  }
  // ⚙ dropdown: toggle sul bottone, chiusura su click fuori o Esc. Autoconsistente, così
  // home ed editor si comportano allo stesso modo. (L'editor gestisce Esc anche per la
  // cronologia in app.js: qui chiudiamo solo il menu, e le due cose non sono mai aperte
  // insieme — l'overlay cronologia copre la ⚙.)
  function wireMenu() {
    const menu = document.getElementById("settingsMenu");
    if (!menu) return;
    const btn = document.getElementById("settingsBtn");
    const pop = menu.querySelector(".menu-pop");
    if (!btn || !pop) return;
    btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
    document.addEventListener("click", (e) => { if (!pop.hidden && !menu.contains(e.target)) pop.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) pop.hidden = true; });
  }
  function init() { wireSelect(); wireMenu(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.AlumereTheme = { apply, saved };
})();
