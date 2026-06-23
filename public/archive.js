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
    setStatus("idle", " ");
  } catch (e) { setStatus("err", "Errore di rete"); }
}

function render(projects) {
  grid.innerHTML = "";
  emptyEl.classList.toggle("hidden", projects.length > 0);
  for (const p of projects) {
    const card = document.createElement("div");
    card.className = "proj-card";
    card.innerHTML = `
      <div class="proj-icon">∑</div>
      <div class="proj-name"></div>
      <div class="proj-meta"></div>
      <div class="proj-actions">
        <button class="mini open">Apri</button>
        <button class="mini danger del">Elimina</button>
      </div>`;
    card.querySelector(".proj-name").textContent = p.name || "Untitled";
    card.querySelector(".proj-meta").textContent = `${p.fileCount || 0} file · agg. ${fmtDate(p.updatedAt)}`;
    card.querySelector(".open").addEventListener("click", () => openProject(p.id));
    card.addEventListener("dblclick", () => openProject(p.id));
    card.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Eliminare "${p.name}"? L'operazione non è reversibile.`)) return;
      try { await fetch("/api/projects/" + encodeURIComponent(p.id), { method: "DELETE" }); load(); }
      catch { setStatus("err", "Eliminazione fallita"); }
    });
    grid.appendChild(card);
  }
}

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

load();
