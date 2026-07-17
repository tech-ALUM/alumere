// Alumère — archive (landing) page. Lists projects from the server, uploads a
// .zip to create a new one, opens a project in the editor, or deletes it.

const grid = document.getElementById("grid");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("archStatus");
const zipInput = document.getElementById("zipInput");
const uploadBtn = document.getElementById("uploadBtn");

function setStatus(kind, text) { statusEl.className = "status " + kind; statusEl.textContent = text; }
function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch { return ""; } }
const openProject = (id) => { location.href = "editor.html?p=" + encodeURIComponent(id); };

async function load() {
  try {
    const data = await (await fetch("/api/projects")).json();
    render(data.projects || []);
    setStatus("idle", "");
  } catch (e) { setStatus("err", "Errore di rete"); }
}

function render(projects) {
  grid.innerHTML = "";
  emptyEl.classList.toggle("hidden", projects.length > 0);
  for (const p of projects) {
    // The whole card opens the project (click or Enter — it's focusable); deleting is a
    // small corner control that only shows on hover, so it can't be mistaken for "Apri".
    const card = document.createElement("div");
    card.className = "proj-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.innerHTML = `
      <button class="proj-del" title="Elimina progetto">🗑</button>
      <div class="proj-icon">∑</div>
      <div class="proj-name"></div>
      <div class="proj-meta"></div>`;
    card.querySelector(".proj-name").textContent = p.name || "Senza nome";
    const by = (p.updatedBy && p.updatedBy.name) || (p.createdBy && p.createdBy.name);
    card.querySelector(".proj-meta").textContent =
      `${p.fileCount || 0} file · agg. ${fmtDate(p.updatedAt)}` + (by ? ` · ${by}` : "");
    card.addEventListener("click", () => openProject(p.id));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") openProject(p.id); });
    card.querySelector(".proj-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Eliminare "${p.name}"? L'operazione non è reversibile, per nessuno.`)) return;
      try { await fetch("/api/projects/" + encodeURIComponent(p.id), { method: "DELETE" }); load(); }
      catch { setStatus("err", "Eliminazione fallita"); }
    });
    grid.appendChild(card);
  }
}

// Create a blank project server-side (minimal template), then jump straight into it.
async function createProject() {
  const name = prompt("Nome del nuovo progetto:", "");
  if (name === null) return;
  setStatus("busy", "Creo…");
  try {
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (data.ok) { setStatus("ok", "Creato ✓"); openProject(data.id); }
    else setStatus("err", data.error || "Creazione fallita");
  } catch { setStatus("err", "Creazione fallita"); }
}

document.getElementById("newProjBtn").addEventListener("click", createProject);
uploadBtn.addEventListener("click", () => zipInput.click());
zipInput.addEventListener("change", async () => {
  const file = zipInput.files[0];
  if (!file) return;
  setStatus("busy", "Carico…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    const zip = btoa(bin);
    const res = await fetch("/api/projects/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, zip }),
    });
    const data = await res.json();
    if (data.ok) { setStatus("ok", "Caricato ✓"); openProject(data.id); }
    else setStatus("err", data.error || "Upload fallito");
  } catch (e) { setStatus("err", "Upload fallito"); }
  finally { zipInput.value = ""; }
});

// Wait until the user is identified (auth.js) before loading the library.
(window.Alumere ? window.Alumere.ready : Promise.resolve()).then(load);
