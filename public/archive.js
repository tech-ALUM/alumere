// Alumère — home (landing) page. Lists the shared project library as a table (title /
// owner / last-modified / actions), with a sidebar (views + shared tags) and a search.
// Create projects (blank / .zip), open, delete, download sources (.zip) or a compiled PDF,
// archive/restore, and tag them. Tags are SHARED: the whole library sees the same set.

const rowsEl = document.getElementById("rows");
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const footEl = document.getElementById("listFoot");
const statusEl = document.getElementById("archStatus");
const searchEl = document.getElementById("search");
const zipInput = document.getElementById("zipInput");
const sideAside = document.querySelector(".home-side");
const sideTagsEl = document.getElementById("sideTags");
const countAllEl = document.getElementById("countAll");
const countArchEl = document.getElementById("countArch");
const viewTitleEl = document.getElementById("viewTitle");

let PROJECTS = [];              // last loaded list, unfiltered
let TAGS = [];                  // tag registry [{id,name,color}]
let query = "";
let view = { kind: "all" };     // { kind:'all'|'archived'|'untagged' } | { kind:'tag', id }

// Client mirror of the server tag palette (for the swatches).
const TAG_COLORS = ["#7eb0d5", "#bd7ebe", "#8bd450", "#ffb55a", "#fd7f6f", "#e879b9", "#5ec8c0", "#9a8cff"];

function setStatus(kind, text) { statusEl.className = "status " + kind; statusEl.textContent = text; }
const openProject = (id) => { location.href = "editor.html?p=" + encodeURIComponent(id); };
function fmtAbs(s) { try { return new Date(s).toLocaleString(); } catch { return ""; } }
const enc = encodeURIComponent;
const safeFile = (s) => String(s || "project").replace(/[^\p{L}\p{N}._ -]/gu, "").trim() || "project";
const tagById = (id) => TAGS.find((t) => t.id === id);
const projTags = (p) => (p.tags || []).map(tagById).filter(Boolean);   // known tags only

// Uniform line icons (16px, currentColor) so the row actions line up in their button boxes.
const svgIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  download: svgIcon('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>'),
  archive: svgIcon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  restore: svgIcon('<polyline points="3 5 3 11 9 11"/><path d="M5.6 16A9 9 0 1 0 6 6.2L3 9"/>'),
  trash: svgIcon('<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
  tag: svgIcon('<path d="M20.6 13.4l-7.2 7.2a1.8 1.8 0 0 1-2.6 0l-7-7A1.8 1.8 0 0 1 3.3 12.3V5.3A1.8 1.8 0 0 1 5 3.5h7a1.8 1.8 0 0 1 1.3.5l7.3 7.3a1.8 1.8 0 0 1 0 2.1z"/><circle cx="7.8" cy="7.8" r="1.2"/>'),
  edit: svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
};

// Compact relative time in English ("3 months ago", "yesterday", "now"), Overleaf-style.
function relTime(s) {
  const t = new Date(s).getTime();
  if (!t) return "";
  const diff = Date.now() - t, min = 60e3, h = 60 * min, d = 24 * h;
  if (diff < min) return "now";
  if (diff < h) return `${Math.floor(diff / min)} min ago`;
  if (diff < d) return `${Math.floor(diff / h)} h ago`;
  if (diff < 30 * d) { const n = Math.floor(diff / d); return n <= 1 ? "yesterday" : `${n} days ago`; }
  if (diff < 365 * d) { const n = Math.floor(diff / (30 * d)); return n <= 1 ? "1 month ago" : `${n} months ago`; }
  const n = Math.floor(diff / (365 * d)); return n <= 1 ? "1 year ago" : `${n} years ago`;
}

async function load() {
  try {
    const [pj, tj] = await Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/tags").then((r) => r.json()),
    ]);
    PROJECTS = pj.projects || [];
    TAGS = tj.tags || [];
    render();
    setStatus("idle", "");
  } catch (e) { setStatus("err", "Network error"); }
}

// ---------- views / filtering ----------
function inView(p) {
  switch (view.kind) {
    case "archived": return !!p.archived;
    case "untagged": return !p.archived && projTags(p).length === 0;
    case "tag": return !p.archived && (p.tags || []).includes(view.id);
    default: return !p.archived;
  }
}
function currentList() {
  const q = query.trim().toLowerCase();
  let l = PROJECTS.filter(inView);
  if (q) l = l.filter((p) => (p.name || "").toLowerCase().includes(q));
  return l;
}
function titleFor() {
  switch (view.kind) {
    case "archived": return "Archived";
    case "untagged": return "No tag";
    case "tag": { const t = tagById(view.id); return t ? t.name : "Tag"; }
    default: return "All projects";
  }
}
function emptyMsg() {
  if (query.trim()) return `No projects for «${query.trim()}».`;
  switch (view.kind) {
    case "archived": return "No archived projects.";
    case "untagged": return "No untagged projects.";
    case "tag": return "No projects with this tag.";
    default: return "No projects.";
  }
}

// ---------- render ----------
function render() { renderSidebar(); renderMain(); }

function renderSidebar() {
  const nAll = PROJECTS.filter((p) => !p.archived).length;
  const nArch = PROJECTS.length - nAll;
  countAllEl.textContent = nAll ? String(nAll) : "";
  countArchEl.textContent = nArch ? String(nArch) : "";
  sideAside.querySelector('.side-item[data-view="all"]').classList.toggle("active", view.kind === "all");
  sideAside.querySelector('.side-item[data-view="archived"]').classList.toggle("active", view.kind === "archived");

  // Tags section: heading, then "New tag" at the TOP, then the tag list + "No tag".
  sideTagsEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "side-tags-head"; head.textContent = "Tags";
  sideTagsEl.appendChild(head);
  const add = document.createElement("button");
  add.className = "side-newtag"; add.dataset.act = "new-tag";
  add.innerHTML = `<span class="side-ic">＋</span> New tag`;
  sideTagsEl.appendChild(add);
  if (TAGS.length) {
    for (const t of TAGS) {
      const n = PROJECTS.filter((p) => !p.archived && (p.tags || []).includes(t.id)).length;
      const item = document.createElement("button");
      item.className = "side-item tag-item" + (view.kind === "tag" && view.id === t.id ? " active" : "");
      item.dataset.view = "tag"; item.dataset.tag = t.id;
      item.innerHTML = `<span class="tag-dot"></span><span class="ti-name"></span><span class="side-count">${n || ""}</span><span class="ti-del" data-act="del-tag" data-tag="${t.id}" title="Delete tag" aria-label="Delete tag">×</span>`;
      item.querySelector(".tag-dot").style.setProperty("--tc", t.color);
      item.querySelector(".ti-name").textContent = t.name;
      sideTagsEl.appendChild(item);
    }
    const nUn = PROJECTS.filter((p) => !p.archived && projTags(p).length === 0).length;
    const un = document.createElement("button");
    un.className = "side-item" + (view.kind === "untagged" ? " active" : "");
    un.dataset.view = "untagged";
    un.innerHTML = `<span class="side-ic">○</span><span class="ti-name">No tag</span><span class="side-count">${nUn || ""}</span>`;
    sideTagsEl.appendChild(un);
  }
}

function renderMain() {
  const list = currentList();
  const trulyEmpty = PROJECTS.length === 0;
  emptyEl.classList.toggle("hidden", !trulyEmpty);
  listEl.classList.toggle("hidden", trulyEmpty);
  viewTitleEl.textContent = titleFor();
  rowsEl.innerHTML = "";
  if (!trulyEmpty) {
    if (list.length === 0) {
      const no = document.createElement("div");
      no.className = "proj-none"; no.textContent = emptyMsg();
      rowsEl.appendChild(no);
    } else {
      for (const p of list) rowsEl.appendChild(rowFor(p));
    }
  }
  footEl.textContent = trulyEmpty ? "" : `${list.length} project${list.length === 1 ? "" : "s"}`;
}

function fillChips(container, p) {
  container.innerHTML = "";
  for (const t of projTags(p)) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.style.setProperty("--tc", t.color);
    chip.innerHTML = `<span class="tag-dot"></span><span class="tc-name"></span><button class="tag-x" aria-label="Remove tag" title="Remove tag">×</button>`;
    chip.querySelector(".tc-name").textContent = t.name;
    chip.querySelector(".tag-x").addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await setProjectTags(p, (p.tags || []).filter((x) => x !== t.id)); render(); }
      catch { setStatus("err", "Operation failed"); }
    });
    container.appendChild(chip);
  }
}

function rowFor(p) {
  const archived = !!p.archived;
  const row = document.createElement("div");
  row.className = "proj-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.dataset.id = p.id;
  row.innerHTML = `
    <div class="c-title">
      <span class="proj-row-icon">∑</span>
      <span class="proj-row-name"></span>
      <span class="tag-chips"></span>
      <button class="tag-add" aria-label="Add tag" title="Tag">${ICONS.tag}</button>
    </div>
    <div class="c-owner"></div>
    <div class="c-mod"><span class="mod-when"></span><span class="mod-by"></span></div>
    <div class="c-actions">
      <button class="row-act row-ren" data-tip="Rename" aria-label="Rename">${ICONS.edit}</button>
      <button class="row-act row-zip" data-tip="Download sources (.zip)" aria-label="Download .zip">${ICONS.download}</button>
      <button class="row-act row-pdf" data-tip="Download PDF" aria-label="Download PDF"><span class="pdf-badge">PDF</span></button>
      <button class="row-act row-arch" data-tip="${archived ? "Restore" : "Archive"}" aria-label="${archived ? "Restore" : "Archive"}">${archived ? ICONS.restore : ICONS.archive}</button>
      <button class="row-act row-del" data-tip="Delete" aria-label="Delete">${ICONS.trash}</button>
    </div>`;
  row.querySelector(".proj-row-name").textContent = p.name || "Untitled";
  row.querySelector(".c-owner").textContent = (p.createdBy && p.createdBy.name) || "—";
  const when = row.querySelector(".mod-when");
  when.textContent = relTime(p.updatedAt);
  when.title = fmtAbs(p.updatedAt);
  const by = (p.updatedBy && p.updatedBy.name) || "";
  row.querySelector(".mod-by").textContent = by ? ` · ${by}` : "";
  fillChips(row.querySelector(".tag-chips"), p);

  row.addEventListener("click", () => openProject(p.id));
  row.addEventListener("keydown", (e) => { if (e.key === "Enter") openProject(p.id); });
  const stop = (sel, fn) => { const el = row.querySelector(sel); el.addEventListener("click", (e) => { e.stopPropagation(); fn(el); }); };
  stop(".tag-add", (el) => openTagMenu(p, el));
  stop(".row-ren", () => renameProject(p));
  stop(".row-zip", () => downloadBlob(`/api/projects/${enc(p.id)}/download`, `${safeFile(p.name)}.zip`, "Preparing the zip…"));
  stop(".row-pdf", () => downloadBlob(`/api/projects/${enc(p.id)}/pdf`, `${safeFile(p.name)}.pdf`, "Compiling the PDF…"));
  stop(".row-arch", () => toggleArchive(p, !archived));
  stop(".row-del", () => removeProject(p));
  return row;
}
function refreshRowChips(p) {
  const row = rowsEl.querySelector(`.proj-row[data-id="${p.id}"]`);
  if (row) fillChips(row.querySelector(".tag-chips"), p);
}

// ---------- popovers (one at a time) ----------
let popoverClose = null;
function placePopover(pop, anchor) {
  pop.style.position = "fixed";
  pop.style.visibility = "hidden";
  const a = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = a.left, top = a.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  if (left < 8) left = 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, a.top - 6 - ph);
  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(top) + "px";
  pop.style.visibility = "";
}

// The 🏷 assign menu: toggle existing tags (stays open, live), or create-and-assign a new one.
function openTagMenu(p, anchor) {
  if (popoverClose) popoverClose();
  const pop = document.createElement("div");
  pop.className = "tag-pop assign";
  document.body.appendChild(pop);
  const close = () => {
    document.removeEventListener("mousedown", onOut, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", close, true);
    pop.remove();
    if (popoverClose === close) popoverClose = null;
  };
  const onOut = (e) => { if (!pop.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const build = () => {
    pop.innerHTML = "";
    if (!TAGS.length) {
      const em = document.createElement("div"); em.className = "tag-pop-empty"; em.textContent = "No tags yet.";
      pop.appendChild(em);
    }
    for (const t of TAGS) {
      const has = (p.tags || []).includes(t.id);
      const item = document.createElement("button");
      item.className = "tag-menu-item" + (has ? " on" : "");
      item.innerHTML = `<span class="tag-check">${has ? "✓" : ""}</span><span class="tag-dot"></span><span class="tm-name"></span>`;
      item.querySelector(".tag-dot").style.setProperty("--tc", t.color);
      item.querySelector(".tm-name").textContent = t.name;
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        const next = has ? (p.tags || []).filter((x) => x !== t.id) : [...(p.tags || []), t.id];
        try {
          await setProjectTags(p, next);
          renderSidebar();
          if (!inView(p)) { close(); renderMain(); }
          else { build(); refreshRowChips(p); placePopover(pop, anchor); }
        } catch { setStatus("err", "Operation failed"); }
      });
      pop.appendChild(item);
    }
    const sep = document.createElement("div"); sep.className = "tag-menu-sep"; pop.appendChild(sep);
    const add = document.createElement("button");
    add.className = "tag-menu-item new";
    add.innerHTML = `<span class="tag-check">＋</span><span class="tm-name">New tag…</span>`;
    add.addEventListener("click", async (e) => {
      e.stopPropagation();
      close();
      const t = await openCreateTag(anchor);
      if (t) { try { await setProjectTags(p, [...(p.tags || []), t.id]); } catch {} await load(); }
    });
    pop.appendChild(add);
  };
  build();
  placePopover(pop, anchor);
  popoverClose = close;
  setTimeout(() => {
    document.addEventListener("mousedown", onOut, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
  }, 0);
}

// Create-tag popover (name + colour swatches). Resolves with the created tag, or null.
function openCreateTag(anchor) {
  if (popoverClose) popoverClose();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "tag-pop create";
    pop.innerHTML = `
      <input class="tag-name-input" type="text" maxlength="40" placeholder="Tag name" autocomplete="off" spellcheck="false" />
      <div class="tag-swatches">${TAG_COLORS.map((c, i) => `<button type="button" class="tag-swatch${i === 0 ? " sel" : ""}" data-c="${c}" aria-label="Colour" style="--tc:${c}"></button>`).join("")}</div>
      <div class="tag-pop-err" hidden></div>
      <div class="tag-pop-actions"><button type="button" class="tag-cancel">Cancel</button><button type="button" class="tag-create">Create</button></div>`;
    document.body.appendChild(pop);
    placePopover(pop, anchor);
    let color = TAG_COLORS[0];
    const input = pop.querySelector(".tag-name-input");
    const errEl = pop.querySelector(".tag-pop-err");
    pop.querySelectorAll(".tag-swatch").forEach((s) => s.addEventListener("click", () => {
      color = s.dataset.c;
      pop.querySelectorAll(".tag-swatch").forEach((x) => x.classList.toggle("sel", x === s));
    }));
    const done = (val) => {
      document.removeEventListener("mousedown", onOut, true);
      document.removeEventListener("keydown", onKey, true);
      pop.remove();
      if (popoverClose === done) popoverClose = null;
      resolve(val);
    };
    const onOut = (e) => { if (!pop.contains(e.target)) done(null); };
    const submit = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const r = await createTag(name, color);
      if (r.ok) done(r.tag);
      else { errEl.textContent = r.error || "Error"; errEl.hidden = false; }
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    pop.querySelector(".tag-create").addEventListener("click", submit);
    pop.querySelector(".tag-cancel").addEventListener("click", () => done(null));
    popoverClose = done;
    setTimeout(() => { document.addEventListener("mousedown", onOut, true); input.focus(); }, 0);
    document.addEventListener("keydown", onKey, true);
  });
}

// ---------- tag API ----------
async function setProjectTags(p, ids) {
  const r = await fetch(`/api/projects/${enc(p.id)}/tags`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ids }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "fail");
  p.tags = d.tags;
  return d.tags;
}
async function createTag(name, color) {
  const r = await fetch("/api/tags", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, color }),
  });
  return r.json();
}
async function deleteTag(id) {
  const t = tagById(id);
  const n = PROJECTS.filter((p) => (p.tags || []).includes(id)).length;
  if (!confirm(`Delete the tag «${t ? t.name : ""}»?` + (n ? ` It will be removed from ${n} project${n === 1 ? "" : "s"}.` : ""))) return;
  try {
    await fetch("/api/tags/" + enc(id), { method: "DELETE" });
    if (view.kind === "tag" && view.id === id) view = { kind: "all" };
    await load();
  } catch { setStatus("err", "Tag delete failed"); }
}

// ---------- row actions ----------
async function downloadBlob(url, filename, busyMsg) {
  setStatus("busy", busyMsg);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = "Operation failed";
      try { msg = (await res.json()).error || msg; } catch {}
      setStatus("err", msg);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus("ok", "Done ✓");
  } catch { setStatus("err", "Download failed"); }
}

async function toggleArchive(p, archived) {
  setStatus("busy", archived ? "Archiving…" : "Restoring…");
  try {
    const res = await fetch(`/api/projects/${enc(p.id)}/archive`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
    });
    const data = await res.json();
    if (data.ok) { await load(); setStatus("ok", archived ? "Archived ✓" : "Restored ✓"); }
    else setStatus("err", data.error || "Operation failed");
  } catch { setStatus("err", "Operation failed"); }
}

async function removeProject(p) {
  if (!confirm(`Delete "${p.name}"? This can't be undone, for anyone.`)) return;
  try { await fetch(`/api/projects/${enc(p.id)}`, { method: "DELETE" }); load(); }
  catch { setStatus("err", "Delete failed"); }
}

async function renameProject(p) {
  const name = prompt("Rename project:", p.name || "");
  if (name === null) return;
  const next = name.trim();
  if (!next || next === p.name) return;
  setStatus("busy", "Renaming…");
  try {
    const res = await fetch(`/api/projects/${enc(p.id)}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }),
    });
    const data = await res.json();
    if (data.ok) { await load(); setStatus("ok", "Renamed ✓"); }
    else setStatus("err", data.error || "Rename failed");
  } catch { setStatus("err", "Rename failed"); }
}

// ---------- create / upload project ----------
async function createProject() {
  const name = prompt("New project name:", "");
  if (name === null) return;
  setStatus("busy", "Creating…");
  try {
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (data.ok) { setStatus("ok", "Created ✓"); openProject(data.id); }
    else setStatus("err", data.error || "Create failed");
  } catch { setStatus("err", "Create failed"); }
}

zipInput.addEventListener("change", async () => {
  const file = zipInput.files[0];
  if (!file) return;
  setStatus("busy", "Uploading…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    const zip = btoa(bin);
    const res = await fetch("/api/projects/upload", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, zip }),
    });
    const data = await res.json();
    if (data.ok) { setStatus("ok", "Uploaded ✓"); openProject(data.id); }
    else setStatus("err", data.error || "Upload failed");
  } catch (e) { setStatus("err", "Upload failed"); }
  finally { zipInput.value = ""; }
});

// ---------- "New project" dropdown ----------
(function wireNewProjMenu() {
  const menu = document.getElementById("newProjMenu");
  const btn = document.getElementById("newProjBtn");
  const pop = menu.querySelector(".menu-pop");
  const close = () => { pop.hidden = true; };
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => { if (!pop.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) close(); });
  document.getElementById("npEmpty").addEventListener("click", () => { close(); createProject(); });
  document.getElementById("npUpload").addEventListener("click", () => { close(); zipInput.click(); });
  // #npTemplate stays disabled until the template system lands.
})();

// ---------- sidebar (views + tags) + search ----------
sideAside.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    if (act.dataset.act === "new-tag") onNewTag(act);
    else if (act.dataset.act === "del-tag") deleteTag(act.dataset.tag);
    return;
  }
  const item = e.target.closest("[data-view]");
  if (!item) return;
  view = item.dataset.view === "tag" ? { kind: "tag", id: item.dataset.tag } : { kind: item.dataset.view };
  render();
});
async function onNewTag(anchor) { const t = await openCreateTag(anchor); if (t) await load(); }
searchEl.addEventListener("input", () => { query = searchEl.value; renderMain(); });

// Wait until the user is identified (auth.js) before loading the library.
(window.Alumere ? window.Alumere.ready : Promise.resolve()).then(load);
