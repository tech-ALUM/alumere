// Alumère — editor page (M1: real-time collaborative editing).
// Loads ONE project (by ?p=<id>). The project's files live in a SHARED Yjs document
// (room = project id): ydoc.getMap("files") maps  path -> Y.Text  (text, live-edited
// with remote cursors) or  { encoding:"base64", content }  (binary, static). The
// server seeds that map from files/ on disk and persists it back (debounced), so
// compile and the REST API keep working unchanged. The old per-save PUT
// (last-write-wins) is gone: edits sync live and persist through the CRDT.
// Three panes: file tree · CodeMirror editor · PDF preview.

const CM_BASE = "https://esm.sh";
let CM = null;

const PROJECT_ID = new URLSearchParams(location.search).get("p");

async function loadCodeMirror() {
  if (window.CM6) return window.CM6;            // local vendored bundle (preferred)
  // Fallback: fetch from a CDN (needs network; only if the local bundle is absent).
  const [view, state, commands, language, legacy, autocomplete, search, hl] = await Promise.all([
    import(`${CM_BASE}/@codemirror/view@6`),
    import(`${CM_BASE}/@codemirror/state@6`),
    import(`${CM_BASE}/@codemirror/commands@6`),
    import(`${CM_BASE}/@codemirror/language@6`),
    import(`${CM_BASE}/@codemirror/legacy-modes@6/mode/stex`),
    import(`${CM_BASE}/@codemirror/autocomplete@6`),
    import(`${CM_BASE}/@codemirror/search@6`),
    import(`${CM_BASE}/@lezer/highlight@1`),
  ]);
  return { view, state, commands, language, legacy, autocomplete, search, tags: hl.tags };
}

// ---------- LaTeX autocomplete data ----------
const ENVIRONMENTS = [
  "equation", "equation*", "align", "align*", "gather", "itemize", "enumerate",
  "description", "figure", "table", "tabular", "center", "abstract", "quote",
  "verbatim", "theorem", "lemma", "proof", "matrix", "bmatrix", "pmatrix",
  "cases", "frame", "minipage", "array",
];
const COMMANDS = [
  ["\\section", "\\section{${title}}", "Section heading"],
  ["\\subsection", "\\subsection{${title}}", "Subsection"],
  ["\\subsubsection", "\\subsubsection{${title}}", "Subsubsection"],
  ["\\paragraph", "\\paragraph{${title}}", "Paragraph heading"],
  ["\\textbf", "\\textbf{${text}}", "Bold text"],
  ["\\textit", "\\textit{${text}}", "Italic text"],
  ["\\emph", "\\emph{${text}}", "Emphasis"],
  ["\\texttt", "\\texttt{${text}}", "Monospace"],
  ["\\underline", "\\underline{${text}}", "Underline"],
  ["\\begin", "\\begin{${env}}\n\t${}\n\\end{${env}}", "Environment block"],
  ["\\item", "\\item ${}", "List item"],
  ["\\usepackage", "\\usepackage{${package}}", "Load a package"],
  ["\\documentclass", "\\documentclass[${11pt}]{${article}}", "Document class"],
  ["\\includegraphics", "\\includegraphics[width=${0.8}\\linewidth]{${file}}", "Insert an image"],
  ["\\caption", "\\caption{${caption}}", "Caption"],
  ["\\label", "\\label{${key}}", "Label for cross-reference"],
  ["\\ref", "\\ref{${key}}", "Reference a label"],
  ["\\eqref", "\\eqref{${key}}", "Reference an equation"],
  ["\\cite", "\\cite{${key}}", "Citation"],
  ["\\footnote", "\\footnote{${text}}", "Footnote"],
  ["\\href", "\\href{${url}}{${text}}", "Hyperlink"],
  ["\\frac", "\\frac{${num}}{${den}}", "Fraction"],
  ["\\sqrt", "\\sqrt{${x}}", "Square root"],
  ["\\sum", "\\sum_{${i=1}}^{${n}} ${}", "Summation"],
  ["\\int", "\\int_{${a}}^{${b}} ${} \\, d${x}", "Integral"],
  ["\\newcommand", "\\newcommand{\\${name}}{${definition}}", "Define a macro"],
  ["\\title", "\\title{${title}}", "Document title"],
  ["\\author", "\\author{${author}}", "Author"],
  ["\\date", "\\date{${\\today}}", "Date"],
  ["\\maketitle", "\\maketitle", "Render the title block"],
  ["\\tableofcontents", "\\tableofcontents", "Table of contents"],
  ["\\begin{equation}", "\\begin{equation}\n\t${}\n\\end{equation}", "Numbered equation"],
  ["\\begin{align}", "\\begin{align}\n\t${}\n\\end{align}", "Aligned equations"],
  ["\\begin{itemize}", "\\begin{itemize}\n\t\\item ${}\n\\end{itemize}", "Bulleted list"],
  ["\\begin{enumerate}", "\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}", "Numbered list"],
  ["\\begin{figure}", "\\begin{figure}[${h}]\n\t\\centering\n\t\\includegraphics[width=${0.8}\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${key}}\n\\end{figure}", "Figure"],
];
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "Delta", "Gamma", "Sigma", "Omega"];

// ---------- Collaboration state (Yjs + Hocuspocus) ----------
let ydoc = null, provider = null, filesMap = null, metaMap = null, commentsMap = null;
let Y = null, HocuspocusProvider = null, yCollab = null, yUndoManagerKeymap = null;
let me = { id: "anon", name: "Anonimo" };
let booted = false;   // becomes true after the first successful sync (bootstrap once)

// Deterministic per-user cursor color (same person → same color). From the M0 spike.
function colorFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { color: `hsl(${hue} 65% 45%)`, colorLight: `hsl(${hue} 65% 45% / 0.25)` };
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const treeEl = $("tree"), editorHost = $("editor"), statusEl = $("status"), collabEl = $("collabState");
const tabbarListEl = $("tabbarList"), editorEmptyEl = $("editorEmpty"), presenceEl = $("presence");
const logEl = $("log"), logWrap = $("logWrap"), issuesEl = $("issues"), previewEmpty = $("previewEmpty");
const pdfScroll = $("pdfScroll"), pdfSizer = $("pdfSizer"), pagesEl = $("pdfPages");
const previewBody = document.querySelector(".preview-body");
const engineSel = $("engine");

let currentPath = null;            // path of the open file (null = nothing open)
let openTabs = [];                 // client-only: paths open as tabs, left→right order
let view = null;                   // the live CodeMirror EditorView
let targetDir = "";                // folder new files/folders go into (from last click)
const collapsed = new Set();       // folder paths the user has collapsed (local-only UI)
const pendingFolders = new Set();  // empty folders created locally (not shared until they hold a file)

// ---------- Editor colour palettes ----------
// Add a palette here AND a matching  body[data-editor-theme="<id>"]  block in styles.css.
const PALETTES = [
  { id: "light",     label: "Pastel Light" },
  { id: "dark",      label: "Slate Dark" },
  { id: "solarized", label: "Solarized" },
  { id: "nord",      label: "Nord" },
];
const THEME_KEY = "alumere.editorTheme";
function applyEditorTheme(id) {
  document.body.dataset.editorTheme = id;
  try { localStorage.setItem(THEME_KEY, id); } catch {}
}
function initEditorTheme() {
  const sel = $("editorTheme");
  if (sel) {
    sel.innerHTML = "";
    for (const p of PALETTES) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.label; sel.appendChild(o);
    }
  }
  let saved = "light";
  try { saved = localStorage.getItem(THEME_KEY) || "light"; } catch {}
  if (!PALETTES.some((p) => p.id === saved)) saved = "light";
  if (sel) { sel.value = saved; sel.addEventListener("change", () => applyEditorTheme(sel.value)); }
  applyEditorTheme(saved);
}

// App theme (chiaro/scuro/auto) e menu ⚙ sono gestiti da theme.js, condiviso con la home.

// ---------- File model over the shared Y.Map ----------
function isBinaryVal(v) { return !(v instanceof Y.Text); }
function fileEntries() { return filesMap ? [...filesMap.entries()] : []; }   // snapshot: safe to mutate while iterating
function hasPath(p) { return !!filesMap && filesMap.has(p); }
function parentOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function baseOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }

// The list compile / detect-main work on: same {path, content, encoding?} shape as before.
function flattenForCompile() {
  const out = [];
  for (const [p, v] of fileEntries()) {
    if (isBinaryVal(v)) out.push({ path: p, content: v.content ?? "", encoding: "base64" });
    else out.push({ path: p, content: v.toString() });
  }
  return out;
}
function detectMain(files) {
  const named = files.find((f) => /(^|\/)main\.tex$/i.test(f.path));
  if (named) return named.path;
  const withClass = files.find((f) => /\.tex$/i.test(f.path) && /\\documentclass/.test(f.content || ""));
  if (withClass) return withClass.path;
  const anyTex = files.find((f) => /\.tex$/i.test(f.path));
  return anyTex ? anyTex.path : (files[0] ? files[0].path : "main.tex");
}

// Record "who edited last" in a shared meta map; the server reads it on persist so
// attribution survives even though the save happens server-side, not via an HTTP call.
function setUpdatedBy() {
  if (!metaMap || !me) return;
  try { metaMap.set("updatedBy", { id: me.id, name: me.name }); } catch {}
}
let lastEditStamp = 0;
function noteLocalEdit() {
  const now = Date.now();
  if (now - lastEditStamp > 2000) { lastEditStamp = now; setUpdatedBy(); }   // throttle CRDT meta churn
}

// ---------- Tree (derived from the set of paths; folders are implicit) ----------
function buildTreeModel() {
  const rootChildren = [];
  const folderIndex = new Map();          // path -> folder node
  function ensureFolder(path) {
    if (folderIndex.has(path)) return folderIndex.get(path);
    const node = { type: "folder", name: baseOf(path), path, children: [] };
    folderIndex.set(path, node);
    const parent = parentOf(path);
    (parent ? ensureFolder(parent).children : rootChildren).push(node);
    return node;
  }
  function addFile(path) {
    const parent = parentOf(path);
    (parent ? ensureFolder(parent).children : rootChildren).push({ type: "file", name: baseOf(path), path });
  }
  for (const [p] of fileEntries()) addFile(p);
  for (const p of pendingFolders) ensureFolder(p);     // local empty folders
  const sort = (list) => list.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === "folder" ? -1 : 1));
  sort(rootChildren);
  for (const f of folderIndex.values()) sort(f.children);
  return rootChildren;
}

function iconFor(node, open) {
  if (node.type === "folder") return open ? "📂" : "📁";
  const n = node.name;
  if (/\.tex$/i.test(n)) return "📄";
  if (/\.bib$/i.test(n)) return "📚";
  if (/\.(png|jpe?g|pdf|gif|svg|eps)$/i.test(n)) return "🖼";
  return "📃";
}

// Where everyone else is right now, recomputed per render (see peerList / onAwarenessChange).
let peersByFile = new Map();      // path -> peers sitting in that file
function renderTree() {
  if (!treeEl) return;
  peersByFile = new Map();
  for (const p of peerList()) {
    if (p.isMe) continue;                     // my own row already reads as `.active`
    for (const f of p.activeFiles) {
      if (!peersByFile.has(f)) peersByFile.set(f, []);
      peersByFile.get(f).push(p);
    }
  }
  treeEl.innerHTML = "";
  treeEl.appendChild(buildList(buildTreeModel()));
}
function buildList(list) {
  const ul = document.createElement("ul");
  for (const node of list) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    const openFolder = node.type === "folder" && !collapsed.has(node.path);
    row.className = "row" + (node.type === "file" && node.path === currentPath ? " active" : "");
    const tw = document.createElement("span");
    tw.className = "twisty";
    tw.textContent = node.type === "folder" ? (openFolder ? "▾" : "▸") : "";
    const ic = document.createElement("span");
    ic.className = "rowicon"; ic.textContent = iconFor(node, openFolder);
    const nm = document.createElement("span");
    nm.className = "rowname"; nm.textContent = node.name;
    const actions = document.createElement("span");
    actions.className = "rowactions";
    const renameBtn = document.createElement("button"); renameBtn.textContent = "✎"; renameBtn.title = "Rename";
    const delBtn = document.createElement("button"); delBtn.textContent = "🗑"; delBtn.title = "Delete";
    actions.append(renameBtn, delBtn);
    row.append(tw, ic, nm);
    const here = node.type === "file" ? peersByFile.get(node.path) : null;
    if (here) {
      const marks = document.createElement("span");
      marks.className = "rowpeers";
      for (const p of here.slice(0, 3)) marks.appendChild(avatarEl(p, { small: true }));
      row.appendChild(marks);
    }
    row.appendChild(actions);
    li.appendChild(row);
    row.addEventListener("click", (e) => {
      if (e.target === renameBtn || e.target === delBtn) return;
      if (node.type === "folder") {
        if (collapsed.has(node.path)) collapsed.delete(node.path); else collapsed.add(node.path);
        targetDir = node.path; renderTree();
      } else { targetDir = parentOf(node.path); openFile(node.path); }
    });
    renameBtn.addEventListener("click", (e) => { e.stopPropagation(); renameNode(node); });
    delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteNode(node); });
    if (node.type === "folder" && openFolder) li.appendChild(buildList(node.children));
    ul.appendChild(li);
  }
  return ul;
}

// Structure ops mutate the shared map, so they propagate live to every peer.
function newFile() {
  const name = prompt("New file name:", "untitled.tex");
  if (!name) return;
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  const path = targetDir ? `${targetDir}/${clean}` : clean;
  if (hasPath(path)) { alert("A file with this path already exists."); return; }
  ydoc.transact(() => { filesMap.set(path, new Y.Text()); });
  pendingFolders.delete(targetDir);
  setUpdatedBy();
  openFile(path);
}
function newFolder() {
  const name = prompt("New folder name:", "folder");
  if (!name) return;
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  const path = targetDir ? `${targetDir}/${clean}` : clean;
  pendingFolders.add(path); collapsed.delete(path); targetDir = path;
  renderTree();
}
// Move an entry to a new path (Y.Text content is copied into a fresh Y.Text — rename
// is coarse-grained, so per-char history for that file is not carried over).
function moveEntry(oldPath, newPath, v) {
  if (isBinaryVal(v)) { filesMap.set(newPath, { encoding: "base64", content: v.content }); }
  else { const t = new Y.Text(); filesMap.set(newPath, t); const s = v.toString(); if (s) t.insert(0, s); }
  filesMap.delete(oldPath);
}
function renameNode(node) {
  const isFolder = node.type === "folder";
  const nn = prompt("Rename to:", node.name);
  if (!nn) return;
  const clean = nn.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean === node.name) return;
  const parent = parentOf(node.path);
  const newPath = parent ? `${parent}/${clean}` : clean;

  if (isFolder) {
    const prefix = node.path + "/";
    const affected = fileEntries().filter(([p]) => p === node.path || p.startsWith(prefix));
    // Keep open tabs pointing at the moved files (same order) so the prune in onFilesChanged spares them.
    openTabs = openTabs.map((p) => (p === node.path || p.startsWith(prefix)) ? newPath + p.slice(node.path.length) : p);
    let reopen = null;
    if (currentPath && (currentPath === node.path || currentPath.startsWith(prefix))) {
      reopen = newPath + currentPath.slice(node.path.length);
      currentPath = reopen;                 // set before the mutation so observe sees it present
    }
    ydoc.transact(() => { for (const [p, v] of affected) moveEntry(p, newPath + p.slice(node.path.length), v); });
    if (pendingFolders.delete(node.path)) pendingFolders.add(newPath);
    if (collapsed.delete(node.path)) collapsed.add(newPath);
    setUpdatedBy();
    if (reopen) openFile(reopen); else renderTree();
  } else {
    if (hasPath(newPath)) { alert("Path already exists."); return; }
    const ti = openTabs.indexOf(node.path);
    if (ti >= 0) openTabs[ti] = newPath;      // keep the tab in place through the rename
    const reopen = currentPath === node.path;
    if (reopen) currentPath = newPath;
    const v = filesMap.get(node.path);
    ydoc.transact(() => { moveEntry(node.path, newPath, v); });
    setUpdatedBy();
    if (reopen) openFile(newPath); else renderTree();
  }
}
function deleteNode(node) {
  if (!confirm(`Delete "${node.name}"?`)) return;
  if (node.type === "folder") {
    const prefix = node.path + "/";
    const affected = fileEntries().filter(([p]) => p === node.path || p.startsWith(prefix));
    ydoc.transact(() => { for (const [p] of affected) filesMap.delete(p); });
    for (const p of [...pendingFolders]) if (p === node.path || p.startsWith(prefix)) pendingFolders.delete(p);
    collapsed.delete(node.path);
  } else {
    ydoc.transact(() => { filesMap.delete(node.path); });
  }
  setUpdatedBy();
  renderTree();   // covers the pending-folder case (no map change → no observe callback)
}

// Fires on every change to the file set — local or remote — so the tree stays live.
function onFilesChanged() {
  const had = openTabs.length;
  openTabs = openTabs.filter(hasPath);          // drop tabs whose file vanished (local or remote)
  renderTree();
  if (currentPath && !hasPath(currentPath)) {   // the open file went away (e.g. a peer deleted it)
    const next = openTabs[0] || (fileEntries()[0] && fileEntries()[0][0]) || null;
    if (next) { openFile(next); return; }       // openFile re-renders tabs + persists
    currentPath = null;
    if (view) { view.destroy(); view = null; }
    closeCommentOverlays();
    closeSpellMenu();
    try { provider.awareness.setLocalStateField("activeFile", null); } catch {}
  }
  renderTabs();
  if (openTabs.length !== had) saveTabs();
}

// ---------- Editor (CodeMirror bound to the active file's Y.Text) ----------
// Prefix-only matching (filter: false disables CM6's fuzzy filter, which would
// surface "\subsection" for "\be"). No validFor: the source re-runs per keystroke
// so the manual filter stays fresh — the lists are tiny, it costs nothing.
function latexCompletions(context) {
  const env = context.matchBefore(/\\(begin|end)\{[a-zA-Z@*]*$/);
  if (env) {
    const from = env.from + env.text.indexOf("{") + 1;
    const typed = env.text.slice(env.text.indexOf("{") + 1).toLowerCase();
    const options = ENVIRONMENTS.filter((e) => e.toLowerCase().startsWith(typed))
      .map((e) => ({ label: e, type: "type" }));
    if (!options.length) return null;
    return { from, options, filter: false };
  }
  const cmd = context.matchBefore(/\\[a-zA-Z@]*$/);
  if (!cmd || (cmd.from === cmd.to && !context.explicit)) return null;
  const { snippetCompletion } = CM.autocomplete;
  const typed = cmd.text.toLowerCase();
  const options = [];
  for (const [label, tmpl, detail] of COMMANDS)
    if (label.toLowerCase().startsWith(typed)) options.push(snippetCompletion(tmpl, { label, type: "function", detail }));
  for (const g of GREEK) {
    const label = "\\" + g;
    if (label.toLowerCase().startsWith(typed)) options.push({ label, type: "constant", detail: "Greek letter" });
  }
  if (!options.length) return null;
  options.sort((a, b) => a.label.localeCompare(b.label));
  return { from: cmd.from, options, filter: false };
}
// Shared editor extensions (no native history — the Yjs UndoManager owns undo for
// collaborative text; binary files open read-only, where undo is moot anyway).
function baseExtensions() {
  const { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap } = CM.view;
  const { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } = CM.language;
  const { stex } = CM.legacy;
  const { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } = CM.autocomplete;
  const { defaultKeymap, indentWithTab } = CM.commands;
  const { highlightSelectionMatches, searchKeymap } = CM.search;
  let latexExt = [];
  try {
    const t = CM.tags, HS = CM.language.HighlightStyle;
    const latexHighlight = HS.define([
      { tag: t.tagName, color: "var(--ed-tok-command)", fontWeight: "600" },     // \commands -> green
      { tag: t.keyword, color: "var(--ed-tok-command)", fontWeight: "600" },
      { tag: t.controlKeyword, color: "var(--ed-tok-command)", fontWeight: "600" },
      { tag: t.comment, color: "var(--ed-tok-comment)", fontStyle: "italic" },
      { tag: t.string, color: "var(--ed-tok-string)" },
      { tag: t.number, color: "var(--ed-tok-number)" },
      { tag: t.atom, color: "var(--ed-tok-math)" },                            // math
      { tag: [t.bracket, t.brace], color: "var(--ed-tok-bracket)" },
      { tag: t.meta, color: "var(--ed-tok-meta)" },
    ]);
    latexExt = [syntaxHighlighting(latexHighlight)];
  } catch (e) { console.warn("custom LaTeX highlight unavailable:", e); }
  return [
    lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
    bracketMatching(), closeBrackets(), indentOnInput(), highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ...latexExt,
    StreamLanguage.define(stex), EditorView.lineWrapping,
    autocompletion({ override: [latexCompletions], activateOnTyping: true, defaultKeymap: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...completionKeymap, ...searchKeymap, indentWithTab]),
  ];
}
// ---------- Multi-file tabs (client-only view state) ----------
// Opening a file (tree click, goto-issue, restore) adds a tab; peers don't see my tabs.
// The set + active file are persisted per project so a reload restores the workspace.
const TABS_KEY = () => `alumere.tabs:${PROJECT_ID}`;
function saveTabs() {
  try { localStorage.setItem(TABS_KEY(), JSON.stringify({ open: openTabs, active: currentPath })); } catch {}
}
function loadSavedTabs() {
  try {
    const s = JSON.parse(localStorage.getItem(TABS_KEY()) || "null");
    if (s && Array.isArray(s.open)) return { open: s.open, active: s.active || null };
  } catch {}
  return null;
}
// Reflect currentPath === null (no tabs) by swapping the editor host for the empty note.
function updateEditorEmpty() {
  const empty = !currentPath;
  editorHost.hidden = empty;
  if (editorEmptyEl) editorEmptyEl.hidden = !empty;
}
function renderTabs() {
  tabbarListEl.innerHTML = "";
  const bases = openTabs.map(baseOf);
  for (const path of openTabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (path === currentPath ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.title = path;
    const name = document.createElement("span");
    name.className = "tab-name";
    // Disambiguate same-named files (e.g. two "intro.tex") by prefixing their folder.
    const base = baseOf(path), par = parentOf(path);
    name.textContent = (par && bases.filter((b) => b === base).length > 1) ? `${baseOf(par)}/${base}` : base;
    const close = document.createElement("button");
    close.type = "button"; close.className = "tab-close"; close.title = "Close"; close.textContent = "✕";
    tab.append(name, close);
    tab.addEventListener("click", (e) => { if (e.target !== close && path !== currentPath) openFile(path); });
    tab.addEventListener("mousedown", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(path); } }); // middle-click closes
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(path); });
    tabbarListEl.appendChild(tab);
  }
  updateEditorEmpty();
  const active = tabbarListEl.querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function closeTab(path) {
  const i = openTabs.indexOf(path);
  if (i < 0) return;
  openTabs.splice(i, 1);
  if (currentPath === path) {
    const next = openTabs[i] || openTabs[i - 1] || null;   // prefer the right neighbour, else the left
    if (next) { openFile(next); return; }                  // openFile re-renders tabs + persists
    currentPath = null;
    if (view) { view.destroy(); view = null; }
    closeCommentOverlays();
    closeSpellMenu();
    try { provider.awareness.setLocalStateField("activeFile", null); } catch {}
    renderTree();
  }
  renderTabs();
  saveTabs();
}

// (Re)build the editor bound to `path`. Recreating the view on each switch keeps the
// Yjs binding clean: the old yCollab is disposed before the new file's text loads, so
// a file's content can never leak into another file's Y.Text.
function openFile(path) {
  if (!hasPath(path)) return;
  revealEditor();                    // opening a file while the editor pane is collapsed
  const val = filesMap.get(path);
  currentPath = path;
  if (!openTabs.includes(path)) openTabs.push(path);
  updateEditorEmpty();               // un-hide the host before CM measures it
  if (view) { view.destroy(); view = null; }
  closeCommentOverlays();            // overlays are anchored to the old view's coordinates
  closeSpellMenu();                  // ditto for the spell menu
  const { EditorView, keymap } = CM.view;
  const { EditorState } = CM.state;
  let state;
  if (isBinaryVal(val)) {
    const msg = `% "${baseOf(path)}" is a binary asset (image/PDF).\n% It's kept in the project and used at compile time, but can't be edited here.`;
    state = EditorState.create({ doc: msg, extensions: [...baseExtensions(), EditorView.editable.of(false), EditorState.readOnly.of(true)] });
  } else {
    const undoManager = new Y.UndoManager(val);
    state = EditorState.create({
      doc: val.toString(),
      extensions: [
        ...baseExtensions(),
        yCollab(val, provider.awareness, { undoManager }),
        keymap.of(yUndoManagerKeymap),
        ...commentExtensions(),
        ...spellExtensions(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) noteLocalEdit();
        }),
      ],
    });
  }
  view = new EditorView({ state, parent: editorHost });
  refreshCommentDecos();             // paint this file's comment highlights (no-op on binary)
  scheduleSpellcheck(300);           // first spell pass for the freshly opened file
  view.scrollDOM.addEventListener("scroll", repositionOverlays, { passive: true });
  try { provider.awareness.setLocalStateField("activeFile", path); } catch {}
  renderTree();
  renderTabs();
  saveTabs();
  view.focus();
}

// ---------- Compile (stateless: send the current Yjs content to /api/compile) ----------
function setStatus(kind, text) { statusEl.className = "status " + kind; statusEl.textContent = text; }
function b64ToBlob(b64, type) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
function renderLog(text) {
  logEl.innerHTML = "";
  for (const line of (text || "").split("\n")) {
    const span = document.createElement("span");
    if (/error|undefined|!|fatal/i.test(line)) span.className = "errline";
    span.textContent = line + "\n";
    logEl.appendChild(span);
  }
}
// ---------- LaTeX log → readable problem list ----------
// latexmk runs with -file-line-error, so real errors arrive as "./file.tex:27: message".
// Errors without a location ("! LaTeX Error: …") try to pick a line from the "l.27" context
// that follows. Warnings ("LaTeX Warning: …") carry no file, so they render without a jump
// (guessing the file and landing the cursor in the wrong one would be worse than no link).
function parseLatexLog(log) {
  const issues = [], seen = new Set(), lines = (log || "").split("\n");
  const push = (kind, file, line, msg) => {
    msg = msg.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!msg) return;
    const key = `${kind}|${file}|${line}|${msg}`;
    if (seen.has(key) || issues.length >= 50) return;
    seen.add(key);
    issues.push({ kind, file, line, msg });
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m = ln.match(/^(?:\.\/)?([^:\s]+\.(?:tex|sty|cls|bib|bbl)):(\d+):\s*(.*)$/);
    if (m) {
      let msg = m[3];
      // "Undefined control sequence." tells you nothing without the "l.27 \foo" context
      // that follows a few lines below — append the offending snippet when we find it.
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const lm = lines[j].match(/^l\.\d+\s+(.*)$/);
        if (lm && lm[1].trim()) { msg += ` → ${lm[1].trim()}`; break; }
        if (/^(?:\.\/)?[^:\s]+:(\d+):/.test(lines[j])) break;
      }
      push("error", m[1].replace(/^\.\//, ""), Number(m[2]), msg);
      continue;
    }
    m = ln.match(/^!\s*(.+)$/);
    if (m) {
      let line = null;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)/);
        if (lm) { line = Number(lm[1]); break; }
      }
      push("error", null, line, m[1]);
      continue;
    }
    m = ln.match(/^(?:LaTeX|Package|Class)(?:\s+\S+)?\s+Warning:\s*(.*)$/);
    if (m) {
      let msg = m[1];
      // warnings wrap onto continuation lines that start with matching indentation
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^\s{4,}\S/.test(lines[j])) { msg += " " + lines[j].trim(); i = j; }
        else break;
      }
      const lm = msg.match(/on input line (\d+)/);
      push("warning", null, lm ? Number(lm[1]) : null, msg);
    }
  }
  return issues;
}

// Move the editor to file:line (used by the problem rows). openFile is synchronous, so the
// fresh view is ready to receive the selection right after the switch.
function gotoIssue(file, line) {
  revealEditor();                    // the jump target must be visible (openFile also does this)
  if (file && hasPath(file) && currentPath !== file) openFile(file);
  if (!view || !line || (file && !hasPath(file))) return;
  const doc = view.state.doc;
  const pos = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function renderIssues(issues) {
  issuesEl.innerHTML = "";
  issuesEl.classList.toggle("hidden", !issues.length);
  const tab = $("tabLog");
  tab.textContent = "Log";
  const nErr = issues.filter((x) => x.kind === "error").length;
  if (nErr) {
    const b = document.createElement("span");
    b.className = "tab-badge"; b.textContent = nErr;
    tab.appendChild(b);
  }
  for (const it of issues) {
    const canJump = !!(it.line && (!it.file || hasPath(it.file)));
    const row = document.createElement(canJump ? "button" : "div");
    row.className = `issue ${it.kind}` + (canJump ? " link" : "");
    if (canJump) row.type = "button";
    const badge = document.createElement("span");
    badge.className = "issue-badge";
    badge.textContent = it.kind === "error" ? "error" : "warning";
    const msg = document.createElement("span");
    msg.className = "issue-msg"; msg.textContent = it.msg;
    row.append(badge, msg);
    if (it.file || it.line) {
      const loc = document.createElement("span");
      loc.className = "issue-loc";
      loc.textContent = (it.file || "") + (it.line ? `:${it.line}` : "");
      row.appendChild(loc);
    }
    if (canJump) row.addEventListener("click", () => gotoIssue(it.file, it.line));
    issuesEl.appendChild(row);
  }
}

let pdfBlob = null;
async function compile() {
  setStatus("busy", "Compiling…");
  const files = flattenForCompile();
  const payload = { files, main: detectMain(files), engine: engineSel.value };
  try {
    const res = await fetch("/api/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    renderLog(data.log);
    const issues = parseLatexLog(data.log);
    renderIssues(issues);
    if (data.ok && data.pdf) {
      pdfBlob = b64ToBlob(data.pdf, "application/pdf");
      previewEmpty.classList.add("hidden");
      showTab("pdf");                                  // reveal the pane before we measure it
      try { await loadPdf(data.pdf); }                 // base64 → PDF.js canvases
      catch (err) { console.warn("PDF render failed:", err); }
      await loadSyncTex(data.synctex, data.synctexRoot);   // editor ⇄ PDF map for this build
      showTab("pdf");                                  // pdfDoc is set now → the zoom bar shows
      setStatus("ok", "Compiled ✓");
    } else {
      const nErr = issues.filter((x) => x.kind === "error").length;
      setStatus("err", nErr ? `${nErr} error${nErr === 1 ? "" : "s"}` : "Errors");
      showTab("log");
    }
  } catch (e) {
    renderLog("The compile server isn't responding.\n→ " + e.message);
    renderIssues([]);
    setStatus("err", "Offline"); showTab("log");
  }
}

// ---------- Preview tabs ----------
function showTab(which) {
  const pdf = which === "pdf";
  pdfScroll.classList.toggle("hidden", !pdf);
  logWrap.classList.toggle("hidden", pdf);
  if (pdf) previewEmpty.classList.toggle("hidden", !!pdfDoc);
  else previewEmpty.classList.add("hidden");
  $("tabPdf").classList.toggle("active", pdf);
  $("tabLog").classList.toggle("active", !pdf);
  $("pdfZoomBar").classList.toggle("hidden", !pdf || !pdfDoc);
  // The divider arrow needs a PDF + its synctex map, but not the PDF tab in front:
  // jumping from the Log view is fine (flashPdfSpot switches to the PDF itself).
  $("syncForward").classList.toggle("hidden", !pdfDoc || !syncTex);
}

// ---------- PDF preview (PDF.js): crisp canvas render + smooth continuous zoom ----------
// The native <iframe> viewer couldn't do smooth, continuous, pane-scoped zoom, so we render
// the PDF ourselves onto <canvas>. 100% = fit-to-width of the preview pane; `zoom` is a
// continuous multiplier over that. Pinch / ⌘(Ctrl)+wheel over the preview zooms around the
// cursor; the canvases re-render crisply (at devicePixelRatio) once the gesture settles,
// with a CSS transform on the pages layer giving instant feedback in between.
let pdfjsLib = null, pdfDoc = null, pdfPageList = [];
let fitScale = 1;            // PDF.js scale at which page 1 fills the pane width (= 100%)
let zoom = 1;               // user multiplier over fit-width (continuous)
let renderedZoom = 1;        // the zoom the current canvases were rasterised at
let naturalW = 0, naturalH = 0;   // untransformed size of the pages layer, in px
let renderTimer = null, rendering = false, pendingRender = false;
const ZOOM_MIN = 0.1, ZOOM_MAX = 5;

async function ensurePdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
  return pdfjsLib;
}

async function loadPdf(base64) {
  await ensurePdfjs();
  const bin = atob(base64), data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  if (pdfDoc) { try { pdfDoc.destroy(); } catch {} }
  pdfDoc = doc;
  pdfPageList = [];
  for (let i = 1; i <= doc.numPages; i++) pdfPageList.push(await doc.getPage(i));
  computeFitScale();
  await renderPdf();
}

function computeFitScale() {
  if (!pdfPageList.length) return;
  const vp = pdfPageList[0].getViewport({ scale: 1 });
  const w = previewBody.clientWidth;
  // 0 = the pane isn't laid out (e.g. the tab is hidden while a compile lands): keep the
  // previous fit rather than clamping to a tiny page; the ResizeObserver in setupZoom
  // re-fits as soon as the pane has a real width again.
  if (!w) return;
  const avail = Math.max(120, w - 32);           // minus .pdf-pages padding
  fitScale = avail / vp.width;
}

// Rasterise every page at the current zoom. Crisp: the backing store is devicePixelRatio,
// capped so a big zoom can't allocate an enormous canvas. A token guards against an older
// (slower) render finishing after a newer one.
// Rasterise every page at the current zoom. SERIALISED: two concurrent render()s on the same
// PDF.js page proxy conflict and leave a canvas stuck, so we never overlap — if a request
// arrives mid-render, we loop once more at the end with whatever `zoom` is by then (so the
// latest zoom always wins). Crisp: backing store at devicePixelRatio, capped so a big zoom
// can't allocate an enormous canvas.
async function renderPdf() {
  if (!pdfPageList.length) return;
  if (rendering) { pendingRender = true; return; }
  rendering = true;
  try {
    do {
      pendingRender = false;
      const dpr = window.devicePixelRatio || 1;
      const scale = fitScale * zoom;
      const canvases = [];
      for (const page of pdfPageList) {
        const vp = page.getViewport({ scale });
        const backing = Math.min(dpr, 3200 / vp.width);        // cap canvas pixels
        const canvas = document.createElement("canvas");
        canvas.style.width = Math.round(vp.width) + "px";
        canvas.style.height = Math.round(vp.height) + "px";
        canvas.width = Math.max(1, Math.round(vp.width * backing));
        canvas.height = Math.max(1, Math.round(vp.height * backing));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: scale * backing }) }).promise;
        canvases.push(canvas);
      }
      pagesEl.style.transform = "";
      pagesEl.replaceChildren(...canvases);
      renderedZoom = zoom;
      naturalW = pagesEl.offsetWidth;
      naturalH = pagesEl.offsetHeight;
      pdfSizer.style.width = naturalW + "px";
      pdfSizer.style.height = naturalH + "px";
      updateZoomLabel();
    } while (pendingRender);                                   // a newer zoom came in mid-render
  } finally {
    rendering = false;
  }
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; renderPdf(); }, 120);
}

// Instant, cheap feedback during a gesture: CSS-scale the already-rendered canvases by the
// ratio to their rasterised zoom, and size the sizer to match so the scrollbars stay honest.
function applyTransform() {
  const k = renderedZoom ? zoom / renderedZoom : 1;
  pagesEl.style.transform = Math.abs(k - 1) < 1e-4 ? "" : `scale(${k})`;
  pdfSizer.style.width = (naturalW * k) + "px";
  pdfSizer.style.height = (naturalH * k) + "px";
  updateZoomLabel();
}

function updateZoomLabel() {
  const lbl = $("pdfZoomLabel");
  if (lbl) lbl.textContent = Math.round(zoom * 100) + "%";
}

// Change zoom keeping the content point under (clientX,clientY) fixed. Live bounding rects
// keep it correct regardless of the auto-margin centring.
function zoomAround(target, clientX, clientY) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, target));
  if (Math.abs(next - zoom) < 1e-4) return;
  const before = pagesEl.getBoundingClientRect();
  const kOld = renderedZoom ? zoom / renderedZoom : 1;
  const cx = (clientX - before.left) / kOld;                   // the point, in natural px
  const cy = (clientY - before.top) / kOld;
  zoom = next;
  applyTransform();
  const kNew = renderedZoom ? zoom / renderedZoom : 1;
  const after = pagesEl.getBoundingClientRect();
  pdfScroll.scrollLeft += after.left - (clientX - cx * kNew);
  pdfScroll.scrollTop += after.top - (clientY - cy * kNew);
  scheduleRender();
}
function zoomToCenter(target) {
  const r = pdfScroll.getBoundingClientRect();
  zoomAround(target, r.left + r.width / 2, r.top + r.height / 2);
}

function setupZoom() {
  if (!$("pdfZoomBar")) return;
  $("zoomOut").addEventListener("click", () => zoomToCenter(zoom - 0.1));
  $("zoomIn").addEventListener("click", () => zoomToCenter(zoom + 0.1));
  // Back to fit-width. Same path as the buttons/pinch: instant transform feedback now, crisp
  // re-render on settle — going straight to renderPdf() here could be superseded by an
  // in-flight render and silently no-op.
  $("zoomReset").addEventListener("click", () => { zoom = 1; applyTransform(); scheduleRender(); });
  // Pinch (a Mac trackpad reports it as wheel+ctrlKey) or ⌘/Ctrl+wheel → smooth zoom around
  // the cursor. A plain wheel is left alone so it scrolls the pages.
  pdfScroll.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !pdfDoc) return;
    e.preventDefault();
    zoomAround(zoom * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
  }, { passive: false });
  // Keep "100% = fit width" as the pane is resized (splitter drag / window resize).
  if (window.ResizeObserver) {
    let rt = null;
    new ResizeObserver(() => {
      if (!pdfDoc) return;
      if (rt) clearTimeout(rt);
      rt = setTimeout(() => { computeFitScale(); renderPdf(); }, 150);
    }).observe(previewBody);
  }
}

// ---------- SyncTeX (editor ⇄ PDF) ----------
// The compile ships back main.synctex.gz; we gunzip it right in the browser
// (DecompressionStream — no library) and index the records both ways: (file,line) →
// PDF spots for the forward search, per-page boxes/points → (file,line) for the
// inverse double-click. Client-only and stateless: each compile replaces the data.
let syncTex = null;
const SP_PER_BP = 65781.76;   // scaled points per PDF point (65536 sp/pt × 72.27/72 pt/bp)

async function gunzipToText(b64) {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const stream = new Blob([arr]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function loadSyncTex(b64, root) {
  syncTex = null;
  if (!b64 || typeof DecompressionStream === "undefined") return;
  try { syncTex = parseSyncTex(await gunzipToText(b64), root || ""); }
  catch (err) { console.warn("SyncTeX unavailable:", err); }
}

// The subset of the synctex format we need. Records live after "Content:", grouped in
// {page … } blocks: hboxes "(tag,line:x,y:w,h,d" carry extents (containment for the
// inverse search), records x/k/g/$/v carry bare positions. Coordinates are scaled
// points, y growing downward at the BASELINE — same orientation as our canvas — but
// but the page origin varies by engine: pdflatex/lualatex bake the (1in,1in) TeX
// origin into the coordinates and write "X/Y Offset:0", xelatex writes origin-relative
// coordinates and puts the 1in into the Offset headers. So: page = raw + header offset,
// nothing hardcoded. (Field-tested both ways — a fixed +72 double-counts on xelatex,
// no offset lands every jump one block off, e.g. abstract → author line.)
function parseSyncTex(text, root) {
  const pathOf = new Map(), tagOf = new Map(), pages = new Map(), byLoc = new Map();
  let unit = 1, page = 0, inContent = false, offX = 0, offY = 0;
  const norm = (p) => {           // "/tmp/alumere-x/./sections/intro.tex" → "sections/intro.tex"
    let s = p.trim();
    if (root && s.startsWith(root)) s = s.slice(root.length);
    return s.replace(/^\/+/, "").replace(/^(\.\/)+/, "");
  };
  const pageOf = (n) => { let pg = pages.get(n); if (!pg) { pg = { boxes: [], points: [] }; pages.set(n, pg); } return pg; };
  const addLoc = (tag, line, rec) => {
    const key = tag + ":" + line;
    let a = byLoc.get(key); if (!a) { a = []; byLoc.set(key, a); }
    a.push(rec);
  };
  for (const ln of text.split("\n")) {
    if (!inContent) {
      if (ln.startsWith("Input:")) {
        const m = ln.match(/^Input:(\d+):(.*)$/);
        if (m) { const p = norm(m[2]); pathOf.set(+m[1], p); if (!tagOf.has(p)) tagOf.set(p, +m[1]); }
      } else if (ln.startsWith("Unit:")) unit = Number(ln.slice(5)) || 1;
      else if (ln.startsWith("X Offset:")) offX = (Number(ln.slice(9)) || 0) / SP_PER_BP;
      else if (ln.startsWith("Y Offset:")) offY = (Number(ln.slice(9)) || 0) / SP_PER_BP;
      else if (ln.startsWith("Content:")) inContent = true;
      continue;
    }
    const c = ln[0];
    if (c === "{") { page = parseInt(ln.slice(1), 10) || 0; continue; }
    if (c === "}") { page = 0; continue; }
    if (!page) continue;
    const bp = unit / SP_PER_BP;
    if (c === "(" || c === "h") {                       // hbox, open or void
      const m = ln.match(/^.(\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/);
      if (!m) continue;
      const box = { tag: +m[1], line: +m[2], x: +m[3] * bp + offX, y: +m[4] * bp + offY, w: +m[5] * bp, h: +m[6] * bp, d: +m[7] * bp };
      pageOf(page).boxes.push(box);
      addLoc(box.tag, box.line, { page, x: box.x, y: box.y, h: box.h, d: box.d });
    } else if (c === "x" || c === "k" || c === "g" || c === "$" || c === "v") {
      const m = ln.match(/^.(\d+),(\d+):(-?\d+),(-?\d+)/);
      if (!m) continue;
      const pt = { tag: +m[1], line: +m[2], x: +m[3] * bp + offX, y: +m[4] * bp + offY };
      pageOf(page).points.push(pt);
      addLoc(pt.tag, pt.line, { page, x: pt.x, y: pt.y, h: 0, d: 0 });
    }
  }
  const linesByTag = new Map();   // per file: the source lines that produced output, sorted
  for (const key of byLoc.keys()) {
    const [tag, line] = key.split(":").map(Number);
    if (!linesByTag.has(tag)) linesByTag.set(tag, []);
    linesByTag.get(tag).push(line);
  }
  for (const a of linesByTag.values()) a.sort((x, y) => x - y);
  return { pathOf, tagOf, pages, byLoc, linesByTag };
}

// Forward search: cursor line → the first spot in the PDF that line produced. A line
// that left no record (comment, blank, preamble) falls to the nearest following one —
// "show me where I am" should never just do nothing mid-document.
function syncForward() {
  if (!syncTex || !view || !currentPath) return;
  const tag = syncTex.tagOf.get(currentPath);
  if (tag == null) return;                             // file wasn't part of the last compile
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const lines = syncTex.linesByTag.get(tag) || [];
  let target = null;
  for (const l of lines) if (l >= line) { target = l; break; }
  if (target == null) target = lines[lines.length - 1];
  if (target == null) return;
  // Among the line's records trust the POINTS and take their median: points track the
  // line's own output position, while boxes attributed to a line often belong to the
  // PREVIOUS visual line (a box closes where the next source line starts) and a stray
  // end-of-line point sits on the previous line too — the median shrugs both off.
  const recs = syncTex.byLoc.get(tag + ":" + target);
  const pts = recs.filter((r) => !(r.h > 0));
  let best = null;
  if (pts.length) {
    pts.sort((a, b) => (a.page - b.page) || (a.y - b.y));
    best = pts[Math.floor(pts.length / 2)];
  } else {
    for (const r of recs) {
      if (!best || r.page < best.page || (r.page === best.page && r.y < best.y)) best = r;
    }
  }
  flashPdfSpot(best);
}

// Highlight a horizontal band at the spot and scroll it into view. The band lives
// INSIDE .pdf-pages (position:absolute), so the pinch transform scales it along with
// the pages, and a zoom re-render (replaceChildren) simply clears it.
function flashPdfSpot(r) {
  const canvas = pagesEl.querySelectorAll("canvas")[r.page - 1];
  const pdfPage = pdfPageList[r.page - 1];
  if (!canvas || !pdfPage) return;
  showTab("pdf");                                      // measuring needs the pane visible
  const vp = pdfPage.getViewport({ scale: 1 });
  const k = canvas.offsetHeight / vp.height;           // PDF pt → layout px at the current zoom
  // Band extents: snug to the actual line box under the spot when there is one (the
  // box's own line attribution doesn't matter here — only its geometry), else a
  // text-line-ish default around the baseline.
  let top = r.y - (r.h || 9), bottom = r.y + (r.d || 4);
  const pg = syncTex && syncTex.pages.get(r.page);
  if (pg) {
    let bb = null, bestArea = Infinity;
    for (const b of pg.boxes) {
      if (!(b.h > 0) || b.h + b.d > 40) continue;      // line-sized boxes only
      const x0 = Math.min(b.x, b.x + b.w), x1 = Math.max(b.x, b.x + b.w);
      if (r.x < x0 || r.x > x1 || r.y < b.y - b.h || r.y > b.y + b.d) continue;
      const area = (x1 - x0) * (b.h + b.d);
      if (area < bestArea) { bestArea = area; bb = b; }
    }
    if (bb) { top = bb.y - bb.h - 1; bottom = bb.y + bb.d + 1; }
  }
  const flash = document.createElement("div");
  flash.className = "sync-flash";
  flash.style.left = canvas.offsetLeft + "px";
  flash.style.width = canvas.offsetWidth + "px";
  flash.style.top = canvas.offsetTop + top * k + "px";
  flash.style.height = Math.max(6, (bottom - top) * k) + "px";
  for (const el of pagesEl.querySelectorAll(".sync-flash")) el.remove();
  pagesEl.appendChild(flash);
  const fr = flash.getBoundingClientRect(), sr = pdfScroll.getBoundingClientRect();
  pdfScroll.scrollTop += fr.top + fr.height / 2 - (sr.top + sr.height * 0.35);
  setTimeout(() => flash.remove(), 1900);
}

// Inverse search: the nearest POINT record wins. Points (kern/glue/current) are laid
// down as the source line advances, so their line attribution tracks the visual line
// closely; the enclosing hboxes instead carry the line where the paragraph ENDED —
// picking those made every jump land one source line late (field-tested by Tommy).
// Vertical distance weighs more (the target is a line of text); x still matters,
// Overleaf-style: clicking the end of a wrapped line resolves to the source line that
// continues there. `valid` filters out records from files we can't jump to (.aux/.toc,
// classes), so their points don't steal the click from the real text next to them.
function syncInverse(page, x, y, valid) {
  const pg = syncTex.pages.get(page);
  if (!pg) return null;
  let best = null, bestD = Infinity;
  for (const p of pg.points) {
    if (valid && !valid(p.tag)) continue;
    const d = (p.x - x) ** 2 + 9 * (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = { tag: p.tag, line: p.line }; }
  }
  if (best) return best;
  // Degenerate synctex with no usable points: smallest containing hbox as a fallback.
  let bestArea = Infinity;
  for (const b of pg.boxes) {
    if (valid && !valid(b.tag)) continue;
    const x0 = Math.min(b.x, b.x + b.w), x1 = Math.max(b.x, b.x + b.w);
    const y0 = b.y - b.h, y1 = b.y + b.d;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) { bestArea = area; best = { tag: b.tag, line: b.line }; }
    }
  }
  return best;
}

function onPdfDblClick(e) {
  if (!syncTex || e.target.tagName !== "CANVAS") return;
  const page = [...pagesEl.querySelectorAll("canvas")].indexOf(e.target) + 1;
  const pdfPage = pdfPageList[page - 1];
  if (!page || !pdfPage) return;
  const rect = e.target.getBoundingClientRect();
  const vp = pdfPage.getViewport({ scale: 1 });
  const inProject = (tag) => { const f = syncTex.pathOf.get(tag); return !!f && hasPath(f); };
  const hit = syncInverse(page,
    (e.clientX - rect.left) / rect.width * vp.width,
    (e.clientY - rect.top) / rect.height * vp.height, inProject);
  if (!hit) return;
  gotoIssue(syncTex.pathOf.get(hit.tag), hit.line);
}

// ---------- Comments (giro 4): Word-style anchored threads + @mentions ----------
// A thread lives in the shared Y.Map("comments") as a PLAIN object — replacing the whole
// value on change is coarse, but it syncs live to every peer with zero new plumbing and
// survives on disk as comments.json (see server hooks). Anchoring is D1: best-effort
// { from, to, snippet } — Yjs relative positions don't survive the doc being rebuilt from
// disk, so instead the client that EDITS keeps anchors fresh (debounced write-back of the
// positions CodeMirror has already mapped), and on open the snippet re-locates the range
// if offsets went stale. A comment whose text was deleted simply loses its highlight
// (the thread itself survives; the review panel of giro 5 will list those too).
// Thread: { id, path, anchor:{from,to,snippet}, resolved, createdAt,
//           messages:[{ id, by:{id,name}, at, text, mentions:[emailId] }] }
let roster = [];                         // [{id,name}] — everyone who has ever signed in (D2)
let rosterById = new Map();
let commentField = null, setCommentsEffect = null;   // CM6 pieces, built once CM is loaded
let commentDom = null;                   // { fab, pop } floating elements (lazy singleton)
let overlayState = null;                 // { kind:"composer"|"threads", pos, sel?, ids? }
let commentWriteTimer = null;

const newCommentId = () => "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function commentsSupported() { return !!(CM && CM.state && CM.state.StateField && CM.view.Decoration); }

// Build the CM6 StateField once: decorations live-map through every edit (local AND
// remote — yCollab feeds remote changes through the same transaction pipeline), and a
// setCommentsEffect rebuilds them from the stored anchors.
function ensureCommentField() {
  if (commentField || !commentsSupported()) return;
  const { StateField, StateEffect } = CM.state;
  const { EditorView, Decoration } = CM.view;
  setCommentsEffect = StateEffect.define();
  const build = (ranges) => Decoration.set(
    ranges.filter((r) => r.from < r.to)
      .map((r) => Decoration.mark({ class: "cm-comment-hl", threadId: r.id }).range(r.from, r.to)),
    true);
  commentField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setCommentsEffect)) deco = build(e.value);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// Anchor → concrete range in the CURRENT text. Exact offsets first; if the text moved
// underneath (edits from a session that didn't write back), find the snippet again,
// preferring the occurrence closest to where the comment used to sit.
function resolveAnchor(text, a) {
  if (!a || typeof a.from !== "number" || typeof a.to !== "number") return null;
  const snip = a.snippet || "";
  if (!snip) return null;
  if (text.slice(a.from, a.to) === snip) return { from: a.from, to: a.to };
  let best = -1, bestD = Infinity;
  for (let i = text.indexOf(snip); i >= 0; i = text.indexOf(snip, i + 1)) {
    const d = Math.abs(i - a.from);
    if (d < bestD) { best = i; bestD = d; }
    if (i > a.from && d > bestD) break;              // occurrences only get farther from here
  }
  return best < 0 ? null : { from: best, to: best + snip.length };
}

function buildCommentRanges() {
  if (!view || !currentPath || !commentsMap) return [];
  const text = view.state.doc.toString();
  const out = [];
  for (const [tid, th] of commentsMap.entries()) {
    if (!th || th.path !== currentPath || th.resolved) continue;
    const r = resolveAnchor(text, th.anchor);
    if (r) out.push({ id: tid, from: r.from, to: r.to });
  }
  return out;
}

function refreshCommentDecos() {
  if (!view || !commentField) return;
  if (view.state.field(commentField, false) === undefined) return;   // binary/read-only view
  view.dispatch({ effects: setCommentsEffect.of(buildCommentRanges()) });
}

// Threads whose live-mapped range currently touches `pos` (click target).
function threadIdsAtPos(pos) {
  const ids = [];
  const f = view && commentField && view.state.field(commentField, false);
  if (!f) return ids;
  f.between(pos, pos, (from, to, val) => { if (val.spec.threadId) ids.push(val.spec.threadId); });
  return ids;
}

// D1 write-back: after MY edits settle, store the positions CodeMirror mapped for me.
// Only the editing client does this (remote peers just re-map locally), and only when
// something actually moved — so no ping-pong between idle viewers.
function scheduleCommentWriteBack() {
  clearTimeout(commentWriteTimer);
  commentWriteTimer = setTimeout(writeBackCommentAnchors, 2000);
}
function writeBackCommentAnchors() {
  if (!view || !currentPath || !commentsMap || !commentField) return;
  const f = view.state.field(commentField, false);
  if (!f) return;
  const live = new Map();
  f.between(0, view.state.doc.length, (from, to, val) => { if (val.spec.threadId) live.set(val.spec.threadId, { from, to }); });
  const updates = [];
  for (const [tid, r] of live) {
    const th = commentsMap.get(tid);
    if (!th || th.path !== currentPath || r.from >= r.to) continue;   // collapsed → keep the old anchor (orphan)
    const snippet = view.state.sliceDoc(r.from, r.to);
    const a = th.anchor || {};
    if (a.from === r.from && a.to === r.to && a.snippet === snippet) continue;
    updates.push([tid, { ...th, anchor: { from: r.from, to: r.to, snippet } }]);
  }
  if (updates.length) ydoc.transact(() => { for (const [tid, th] of updates) commentsMap.set(tid, th); });
}

// ---- floating UI: fab (add-comment button), composer, thread popover ----
function ensureCommentDom() {
  if (commentDom) return commentDom;
  const fab = document.createElement("button");
  fab.type = "button"; fab.className = "comment-fab"; fab.hidden = true;
  fab.title = "Comment on the selection";
  fab.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 10a2 2 0 0 1-2 2H6l-3.5 3V4a2 2 0 0 1 2-2H12a2 2 0 0 1 2 2z"/></svg>`;
  fab.addEventListener("mousedown", (e) => e.preventDefault());      // keep the editor selection
  fab.addEventListener("click", openComposer);
  const pop = document.createElement("div");
  pop.className = "comment-pop"; pop.hidden = true;
  document.body.append(fab, pop);
  // Click-away closes (the pop and the fab are outside the editor DOM).
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== fab) closeCommentOverlays();
  });
  commentDom = { fab, pop };
  return commentDom;
}

function placeOverlay(el, pos) {
  if (!view) return;
  const c = view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.length)));
  const host = editorHost.getBoundingClientRect();
  if (!c || c.bottom < host.top || c.top > host.bottom) { el.style.visibility = "hidden"; return; }
  el.style.visibility = "visible";
  const w = el.offsetWidth || 320, h = el.offsetHeight || 0;
  const left = Math.max(host.left + 8, Math.min(c.left, host.right - w - 8));
  let top = c.bottom + 8;
  if (top + h > innerHeight - 8) top = Math.max(8, c.top - h - 8);
  el.style.left = left + "px"; el.style.top = top + "px";
}

function updateCommentFab() {
  const dom = ensureCommentDom();
  if (!view || !currentPath || !commentField || view.state.field(commentField, false) === undefined
      || (overlayState && overlayState.kind === "composer")) { dom.fab.hidden = true; return; }
  const sel = view.state.selection.main;
  // No selection, or the editor lost focus (clicked into another pane): the affordance
  // would just linger over the text — Tommy's complaint from the field test.
  if (sel.empty || !view.hasFocus) { dom.fab.hidden = true; return; }
  const c = view.coordsAtPos(sel.head);
  const host = editorHost.getBoundingClientRect();
  if (!c || c.bottom < host.top || c.top > host.bottom) { dom.fab.hidden = true; return; }
  dom.fab.hidden = false;
  dom.fab.style.left = Math.min(c.right + 8, host.right - 36) + "px";
  dom.fab.style.top = (c.top - 4) + "px";
}

function repositionOverlays() {
  if (overlayState && commentDom && !commentDom.pop.hidden) placeOverlay(commentDom.pop, overlayState.pos);
  updateCommentFab();
}

function closeCommentOverlays() {
  if (commentDom) { commentDom.pop.hidden = true; commentDom.pop.innerHTML = ""; }
  overlayState = null;
  updateCommentFab();
}

// ---- @mention autocomplete over a textarea. Returns { wrap, textarea, mentions() }:
// typing "@" filters the roster in a dropdown; picking inserts "@Name" and records the id.
// On submit, only ids whose "@Name" still appears in the text count as mentions.
function mentionArea(placeholder) {
  const wrap = document.createElement("div");
  wrap.className = "mention-wrap";
  const ta = document.createElement("textarea");
  ta.className = "comment-input"; ta.rows = 2; ta.placeholder = placeholder;
  ta.maxLength = 2000;
  const menu = document.createElement("div");
  menu.className = "mention-menu"; menu.hidden = true;
  wrap.append(ta, menu);
  const picked = new Map();                    // name → id
  let items = [], sel = 0;
  const close = () => { menu.hidden = true; items = []; };
  const query = () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/@([\p{L}\p{N}._-]*)$/u);
    return m ? { text: m[1], start: upto.length - m[0].length } : null;
  };
  const renderMenu = (q) => {
    const needle = q.text.toLowerCase();
    items = roster.filter((u) => u.id !== me.id
      && (u.name.toLowerCase().includes(needle) || u.id.includes(needle))).slice(0, 6);
    if (!items.length) { close(); return; }
    sel = Math.min(sel, items.length - 1);
    menu.innerHTML = "";
    items.forEach((u, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mention-item" + (i === sel ? " sel" : "");
      b.innerHTML = `<b>${escapeHtml(u.name)}</b> <span class="muted">${escapeHtml(u.id)}</span>`;
      b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i, q); });
      menu.appendChild(b);
    });
    menu.hidden = false;
  };
  const pick = (i, q) => {
    const u = items[i]; if (!u) return;
    picked.set(u.name, u.id);
    const before = ta.value.slice(0, q.start), after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${u.name} ${after}`;
    const caret = before.length + u.name.length + 2;
    ta.setSelectionRange(caret, caret);
    ta.focus(); close();
  };
  ta.addEventListener("input", () => { const q = query(); if (q) { sel = 0; renderMenu(q); } else close(); });
  ta.addEventListener("blur", () => setTimeout(close, 150));
  ta.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    const q = query(); if (!q) { close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % items.length; renderMenu(q); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel + items.length - 1) % items.length; renderMenu(q); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(sel, q); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  const mentions = () =>
    [...picked.entries()].filter(([name]) => ta.value.includes("@" + name)).map(([, id]) => id);
  return { wrap, textarea: ta, mentions };
}

async function notifyMentions(ids, text, snippet, path = currentPath) {
  if (!ids.length) return;
  try {
    await fetch(`/api/projects/${PROJECT_ID}/mentions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: ids, text, snippet, path }),
    });
  } catch { /* the comment itself is already saved — the email is best-effort */ }
}

// ---- composer: comment the current selection ----
function openComposer() {
  if (!view || !currentPath) return;
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const dom = ensureCommentDom();
  overlayState = {
    kind: "composer", pos: sel.to,
    sel: { from: sel.from, to: sel.to, snippet: view.state.sliceDoc(sel.from, sel.to) },
  };
  dom.pop.innerHTML = "";
  const quote = document.createElement("div");
  quote.className = "comment-quote";
  quote.textContent = overlayState.sel.snippet.length > 120
    ? overlayState.sel.snippet.slice(0, 120) + "…" : overlayState.sel.snippet;
  const area = mentionArea("Comment… (@ to mention someone)");
  const row = document.createElement("div");
  row.className = "comment-btnrow";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "btn small"; cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeCommentOverlays);
  const send = document.createElement("button");
  send.type = "button"; send.className = "btn primary small"; send.textContent = "Comment";
  send.addEventListener("click", () => submitComposer(area));
  area.textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitComposer(area); }
  });
  row.append(cancel, send);
  dom.pop.append(quote, area.wrap, row);
  dom.pop.hidden = false;
  updateCommentFab();                       // the fab hides while the composer is open
  placeOverlay(dom.pop, overlayState.pos);
  area.textarea.focus();
}

function submitComposer(area) {
  const text = area.textarea.value.trim();
  if (!text || !overlayState || overlayState.kind !== "composer") return;
  const { sel } = overlayState;
  const mentions = area.mentions();
  const th = {
    id: newCommentId(), path: currentPath,
    anchor: { from: sel.from, to: sel.to, snippet: sel.snippet },
    resolved: false, createdAt: new Date().toISOString(),
    messages: [{ id: newCommentId(), by: { id: me.id, name: me.name }, at: new Date().toISOString(), text, mentions }],
  };
  commentsMap.set(th.id, th);
  notifyMentions(mentions, text, sel.snippet);
  closeCommentOverlays();
  refreshCommentDecos();
  // Word-style: commenting consumes the selection — collapse it and hand focus back,
  // so the 💬 button doesn't pop right back up over the freshly commented text.
  if (view) {
    view.dispatch({ selection: { anchor: Math.min(sel.to, view.state.doc.length) } });
    view.focus();
  }
}

// ---- thread popover: read, reply, resolve, delete ----
function msgHtml(m) {
  let html = escapeHtml(m.text);
  for (const mid of m.mentions || []) {
    const u = rosterById.get(mid);
    if (!u) continue;
    html = html.split(escapeHtml("@" + u.name)).join(`<span class="mention">${escapeHtml("@" + u.name)}</span>`);
  }
  return html;
}

function openThreads(ids, pos) {
  const dom = ensureCommentDom();
  overlayState = { kind: "threads", pos, ids };
  renderThreadPopover();
  // If every thread was dead (resolved/deleted since the ids were captured — e.g. from a
  // stale rAF), the render above already closed the popover: don't re-show an empty shell.
  if (!overlayState) return;
  dom.pop.hidden = false;
  placeOverlay(dom.pop, pos);
}

function renderThreadPopover() {
  if (!overlayState || overlayState.kind !== "threads" || !commentDom) return;
  const pop = commentDom.pop;
  const threads = overlayState.ids.map((id) => commentsMap.get(id)).filter((t) => t && !t.resolved);
  if (!threads.length) { closeCommentOverlays(); return; }
  pop.innerHTML = "";
  for (const th of threads) {
    const box = document.createElement("div");
    box.className = "comment-thread";
    const head = document.createElement("div");
    head.className = "comment-thread-head";
    const resolve = document.createElement("button");
    resolve.type = "button"; resolve.className = "mini"; resolve.textContent = "✓ Resolve";
    resolve.title = "Mark this comment as resolved (hides the highlight)";
    resolve.addEventListener("click", () => {
      commentsMap.set(th.id, { ...commentsMap.get(th.id), resolved: true, resolvedBy: { id: me.id, name: me.name }, resolvedAt: new Date().toISOString() });
      refreshCommentDecos(); renderThreadPopover();
    });
    const del = document.createElement("button");
    del.type = "button"; del.className = "mini"; del.textContent = "🗑";
    del.title = "Delete the whole comment thread";
    del.addEventListener("click", () => {
      if (!confirm("Delete this comment thread?")) return;
      commentsMap.delete(th.id);
      refreshCommentDecos(); renderThreadPopover();
    });
    head.append(resolve, del);
    box.appendChild(head);
    for (const m of th.messages || []) {
      const row = document.createElement("div");
      row.className = "comment-msg";
      const who = authorUser(m.by);
      row.appendChild(avatarEl(who, { small: true }));
      const body = document.createElement("div");
      body.className = "comment-msg-body";
      body.innerHTML = `<div class="comment-msg-head"><b>${escapeHtml(who.name)}</b> <span class="muted">${escapeHtml(fmtWhen(m.at))}</span></div>
        <div class="comment-msg-text">${msgHtml(m)}</div>`;
      row.appendChild(body);
      box.appendChild(row);
    }
    const area = mentionArea("Reply… (@ to mention someone)");
    area.textarea.rows = 1;
    const reply = document.createElement("button");
    reply.type = "button"; reply.className = "btn small comment-replybtn"; reply.textContent = "Reply";
    const doReply = () => {
      const text = area.textarea.value.trim();
      if (!text) return;
      const cur = commentsMap.get(th.id);
      if (!cur) return;
      const mentions = area.mentions();
      commentsMap.set(th.id, {
        ...cur,
        messages: [...(cur.messages || []), { id: newCommentId(), by: { id: me.id, name: me.name }, at: new Date().toISOString(), text, mentions }],
      });
      notifyMentions(mentions, text, (cur.anchor && cur.anchor.snippet) || "");
      renderThreadPopover();
    };
    reply.addEventListener("click", doReply);
    area.textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doReply(); }
    });
    const replyRow = document.createElement("div");
    replyRow.className = "comment-replyrow";
    replyRow.append(area.wrap, reply);
    box.appendChild(replyRow);
    pop.appendChild(box);
  }
  placeOverlay(pop, overlayState.pos);
}

// Comments changed (mine or a peer's): refresh the highlights, any open popover, and
// the review panel + rail badge (giro 5).
function onCommentsChanged() {
  if (!booted) return;
  refreshCommentDecos();
  if (overlayState && overlayState.kind === "threads") renderThreadPopover();
  renderReviewPanel();
  updateRailBadges();
}

// The editor extensions for a text file: highlight field + click-to-open + fab tracking.
function commentExtensions() {
  ensureCommentField();
  if (!commentField) return [];
  const { EditorView } = CM.view;
  const { Transaction } = CM.state;
  return [
    commentField,
    EditorView.domEventHandlers({
      click: (e, v) => {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const ids = threadIdsAtPos(pos);
        if (ids.length) openThreads(ids, pos);
        else if (overlayState && overlayState.kind === "threads") closeCommentOverlays();
        return false;                       // never swallow the click: the cursor still moves
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        if (overlayState) {
          overlayState.pos = u.changes.mapPos(overlayState.pos);
          if (overlayState.sel) {
            overlayState.sel.from = u.changes.mapPos(overlayState.sel.from);
            overlayState.sel.to = u.changes.mapPos(overlayState.sel.to, 1);
          }
        }
        if (Transaction && u.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined)) {
          scheduleCommentWriteBack();
        }
      }
      if (u.selectionSet || u.docChanged || u.focusChanged) updateCommentFab();
      if (u.docChanged || u.geometryChanged) repositionOverlays();
    }),
  ];
}

// ---------- Spellcheck (giro 6): IT+EN dictionaries · red dots · right-click fixes ----------
// The hunspell heavy lifting (parse + lookup + suggest) lives in spell-worker.js, off the
// UI thread. Here: tokenize the open file, skip everything that isn't prose (commands,
// code-like arguments, math, comments), underline unknown words via a CM6 decoration
// field (it live-maps through edits, exactly like the comment highlights), and serve a
// right-click menu with suggestions + "Add to project dictionary". The custom words are
// an Y.Array("dict") in the shared doc — live for every peer, persisted as dictionary.json.
let spellWorker = null, spellBroken = false;
const spellCache = new Map();        // token → true (known) / false (unknown); spans files
const spellPending = new Map();      // check-request id → the words it asked about
const suggestCallbacks = new Map();  // suggest-request id → callback
let dictArr = null;                  // Y.Array("dict") — the project's custom dictionary
let projectDict = new Set();         // lowercased mirror of dictArr for O(1) lookups
let spellField = null, setSpellEffect = null;
let spellTimer = null, spellSeq = 0;
let spellMenuEl = null;              // right-click popover (lazy singleton)

function spellSupported() { return commentsSupported() && typeof Worker !== "undefined"; }

function ensureSpellWorker() {
  if (spellWorker || spellBroken || !spellSupported()) return spellWorker;
  try { spellWorker = new Worker("spell-worker.js"); }
  catch (e) { console.warn("[alumere] spellcheck off:", e); spellBroken = true; return null; }
  // Dictionaries missing/broken → spellcheck goes silently dark, the editor lives on
  // (same posture as comments without the bundle).
  spellWorker.onerror = (e) => {
    console.warn("[alumere] spellcheck worker failed — spellcheck disabled:", (e && e.message) || e);
    spellBroken = true;
    try { spellWorker.terminate(); } catch {}
    spellWorker = null;
  };
  spellWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "dead") {              // dictionaries failed to load inside the worker
      console.warn("[alumere] spellcheck disabled:", m.error);
      spellBroken = true;
      try { spellWorker.terminate(); } catch {}
      spellWorker = null;
      return;
    }
    if (m.type === "checked") {
      const asked = spellPending.get(m.id);
      spellPending.delete(m.id);
      if (!asked) return;
      const bad = new Set(m.unknown || []);
      for (const w of asked) spellCache.set(w, !bad.has(w));
      if (bad.size) runSpellcheck();          // fresh positions — the doc may have moved meanwhile
    } else if (m.type === "suggested") {
      const cb = suggestCallbacks.get(m.id);
      suggestCallbacks.delete(m.id);
      if (cb) cb(m.suggestions || []);
    }
  };
  return spellWorker;
}

function ensureSpellField() {
  if (spellField || !spellSupported()) return;
  const { StateField, StateEffect } = CM.state;
  const { EditorView, Decoration } = CM.view;
  setSpellEffect = StateEffect.define();
  const build = (ranges) => Decoration.set(
    ranges.filter((r) => r.from < r.to)
      .map((r) => Decoration.mark({ class: "cm-spell-err", spell: true }).range(r.from, r.to)),
    true);
  spellField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setSpellEffect)) deco = build(e.value);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// Stretches of the source that are NOT prose and must never be spellchecked:
// comments, math, \commands, and the {arguments} of code-like commands (labels,
// cite keys, paths, package names — plus \href's URL).
const SPELL_ARG_CMDS = /\\(begin|end|usepackage|documentclass|label|ref|eqref|pageref|autoref|nameref|cite[a-zA-Z]*|input|include|includeonly|includegraphics|bibliography|bibliographystyle|url|href|hypersetup|verb)\s*(\[[^\]\n]*\])?\s*\{[^}\n]*\}/g;
function spellExcludedRanges(text) {
  const out = [];
  for (const m of text.matchAll(/(^|[^\\])%[^\n]*/g)) out.push([m.index + m[1].length, m.index + m[0].length]);
  for (const m of text.matchAll(/\$\$[\s\S]{0,2000}?\$\$|\$[^$\n]{0,500}\$|\\\[[\s\S]{0,2000}?\\\]|\\\([\s\S]{0,500}?\\\)/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(SPELL_ARG_CMDS)) out.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/\\[a-zA-Z@]+\*?/g)) out.push([m.index, m.index + m[0].length]);
  return out.sort((a, b) => a[0] - b[0]);
}

function runSpellcheck() {
  if (!view || !currentPath || !spellField) return;
  if (view.state.field(spellField, false) === undefined) return;    // binary/read-only view
  const text = view.state.doc.toString();
  if (text.length > 500000) { view.dispatch({ effects: setSpellEffect.of([]) }); return; }  // pathological file
  const excl = spellExcludedRanges(text);
  const selHead = view.hasFocus ? view.state.selection.main.head : -1;
  const bad = [], ask = new Set();
  let ei = 0;
  for (const m of text.matchAll(/[\p{L}][\p{L}'’]*/gu)) {
    const from = m.index, to = from + m[0].length, word = m[0];
    if (word.length < 2) continue;
    while (ei < excl.length && excl[ei][1] <= from) ei++;
    // Skip anything overlapping an excluded stretch. `ei` only moves forward: both the
    // tokens and the ranges are in document order.
    let inMask = false;
    for (let j = ei; j < excl.length && excl[j][0] < to; j++) if (excl[j][1] > from) { inMask = true; break; }
    if (inMask) continue;
    if (from <= selHead && selHead <= to) continue;                 // the word being typed right now
    if (projectDict.has(word.replace(/’/g, "'").toLowerCase())) continue;
    const known = spellCache.get(word);
    if (known === false) bad.push({ from, to });
    else if (known === undefined) ask.add(word);
  }
  view.dispatch({ effects: setSpellEffect.of(bad) });
  const w = ask.size ? ensureSpellWorker() : null;
  if (w) {
    const id = ++spellSeq, words = [...ask];
    spellPending.set(id, words);
    w.postMessage({ type: "check", id, words });
  }
}
function scheduleSpellcheck(delay = 500) {
  if (!spellSupported()) return;
  clearTimeout(spellTimer);
  spellTimer = setTimeout(runSpellcheck, delay);
}

// ---- right-click menu: suggestions + add-to-dictionary ----
function ensureSpellMenu() {
  if (spellMenuEl) return spellMenuEl;
  spellMenuEl = document.createElement("div");
  spellMenuEl.className = "spell-menu";
  spellMenuEl.hidden = true;
  document.body.appendChild(spellMenuEl);
  document.addEventListener("mousedown", (e) => {
    if (!spellMenuEl.hidden && !spellMenuEl.contains(e.target)) closeSpellMenu();
  });
  return spellMenuEl;
}
function closeSpellMenu() {
  if (spellMenuEl) { spellMenuEl.hidden = true; spellMenuEl.innerHTML = ""; }
}

function spellRangeAt(pos) {
  const f = view && spellField && view.state.field(spellField, false);
  if (!f) return null;
  let hit = null;
  f.between(pos, pos, (from, to) => { hit = { from, to, word: view.state.sliceDoc(from, to) }; return false; });
  return hit;
}

function applySpellFix(hit, replacement) {
  if (!view) return;
  // A live collab doc can move under an open menu: replace only if the word is still there.
  if (view.state.sliceDoc(hit.from, hit.to) !== hit.word) return;
  view.dispatch({
    changes: { from: hit.from, to: hit.to, insert: replacement },
    selection: { anchor: hit.from + replacement.length },
    userEvent: "input.spell",
  });
  view.focus();
}

function addToProjectDict(word) {
  if (!dictArr) return;
  const w = String(word).replace(/’/g, "'").trim();
  if (!w || projectDict.has(w.toLowerCase())) return;
  dictArr.push([w]);          // the observer repaints every peer (and the server persists)
}
function onDictChanged() {
  projectDict = new Set(dictArr.toArray()
    .filter((x) => typeof x === "string")
    .map((s) => s.replace(/’/g, "'").toLowerCase()));
  scheduleSpellcheck(0);
}

function openSpellMenu(hit, x, y) {
  const el = ensureSpellMenu();
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "spell-menu-word";
  head.textContent = hit.word;
  const list = document.createElement("div");
  const wait = document.createElement("div");
  wait.className = "spell-menu-empty";
  wait.textContent = "Looking for suggestions…";
  list.appendChild(wait);
  const sep = document.createElement("div");
  sep.className = "spell-menu-sep";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "spell-menu-item spell-menu-add";
  add.textContent = `Add “${hit.word}” to the project dictionary`;
  add.addEventListener("click", () => { addToProjectDict(hit.word); closeSpellMenu(); });
  el.append(head, list, sep, add);
  el.hidden = false;
  const place = () => {
    el.style.left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y + 4, innerHeight - el.offsetHeight - 8)) + "px";
  };
  place();
  requestSuggestions(hit.word, (suggestions) => {
    if (el.hidden || !el.contains(list)) return;        // closed (or reopened elsewhere) meanwhile
    list.innerHTML = "";
    // Mirror the word's capitalisation: "Wehn" should propose "When", not "when".
    const cased = suggestions.map((s) => (/^\p{Lu}/u.test(hit.word) && /^\p{Ll}/u.test(s)) ? s[0].toUpperCase() + s.slice(1) : s);
    if (!cased.length) {
      const none = document.createElement("div");
      none.className = "spell-menu-empty";
      none.textContent = "No suggestions";
      list.appendChild(none);
    }
    for (const s of cased) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "spell-menu-item spell-menu-sugg";
      b.textContent = s;
      b.addEventListener("click", () => { applySpellFix(hit, s); closeSpellMenu(); });
      list.appendChild(b);
    }
    place();
  });
}
function requestSuggestions(word, cb) {
  const w = ensureSpellWorker();
  if (!w) { cb([]); return; }
  const id = ++spellSeq;
  suggestCallbacks.set(id, cb);
  w.postMessage({ type: "suggest", id, word });
}

// The editor extensions for a text file: underline field + context menu + re-check triggers.
function spellExtensions() {
  ensureSpellField();
  if (!spellField) return [];
  const { EditorView } = CM.view;
  return [
    spellField,
    EditorView.domEventHandlers({
      contextmenu: (e, v) => {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const hit = spellRangeAt(pos);
        if (!hit) return false;                          // not on a flagged word → native menu
        e.preventDefault();
        openSpellMenu(hit, e.clientX, e.clientY);
        return true;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) { closeSpellMenu(); scheduleSpellcheck(600); }
      else if (u.selectionSet) scheduleSpellcheck(400);  // re-check the word the cursor just left
    }),
  ];
}

// ---------- Side panels (giro 5): icon rail — Files · Review · Chat ----------
// One panel occupies the left column at a time (the hidden ones leave the grid, see CSS).
// Review lists EVERY thread of the project — open, resolved, orphaned — with jump/reply/
// resolve/delete; Chat is a plain group chat over Y.Array("chat"), persisted server-side
// as chat.json with the same hooks as comments.
let sidePanel = "files";
let reviewFilter = "open";               // which tab of the review panel is showing
let chatArr = null, chatUnread = 0;      // unread only counts while the chat panel is closed

function setSidePanel(name) {
  sidePanel = name;
  $("filesPane").hidden = name !== "files";
  $("reviewPane").hidden = name !== "review";
  $("chatPane").hidden = name !== "chat";
  $("railFiles").classList.toggle("active", name === "files");
  $("railReview").classList.toggle("active", name === "review");
  $("railChat").classList.toggle("active", name === "chat");
  if (name === "review") renderReviewPanel();
  if (name === "chat") {
    chatUnread = 0; updateRailBadges();
    renderChat(); scrollChatBottom(true);
    $("chatInput").focus();
  }
}

function updateRailBadges() {
  const open = commentsMap ? [...commentsMap.values()].filter((t) => t && !t.resolved).length : 0;
  const rb = $("reviewBadge");
  rb.hidden = !open; rb.textContent = open > 99 ? "99+" : String(open);
  const cb = $("chatBadge");
  cb.hidden = !chatUnread; cb.textContent = chatUnread > 99 ? "99+" : String(chatUnread);
}

// The text a thread's anchor lives in — read from the SHARED files map, so it works for
// files that aren't open in the editor. null = the file is gone (or turned binary).
function fileTextOf(path) {
  const v = filesMap && filesMap.get(path);
  return v instanceof Y.Text ? v.toString() : null;
}
function threadState(th) {
  const text = fileTextOf(th.path);
  if (text == null) return { orphan: true, reason: "file deleted" };
  return resolveAnchor(text, th.anchor) ? { orphan: false } : { orphan: true, reason: "text deleted" };
}

// Jump from a review card to the thread's place in the source (cross-file, like gotoIssue).
function gotoThread(th) {
  if (!hasPath(th.path)) return;
  revealEditor();
  if (currentPath !== th.path) openFile(th.path);
  if (!view) return;
  const r = resolveAnchor(view.state.doc.toString(), th.anchor);
  const pos = Math.min(r ? r.from : (th.anchor && th.anchor.from) || 0, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  // Open the in-text popover once the scroll has landed (placing it needs fresh coords).
  // Re-check inside the callback: frames can arrive late (background tab) and the thread
  // may have been resolved or deleted in the meantime.
  if (r && !th.resolved) requestAnimationFrame(() => {
    const cur = commentsMap.get(th.id);
    if (cur && !cur.resolved) openThreads([th.id], r.from);
  });
}

function renderReviewPanel() {
  if ($("reviewPane").hidden || !commentsMap) return;
  $("revTabOpen").classList.toggle("active", reviewFilter === "open");
  $("revTabResolved").classList.toggle("active", reviewFilter === "resolved");
  const listEl = $("reviewList");
  listEl.innerHTML = "";
  const want = [...commentsMap.entries()]
    .map(([id, th]) => ({ ...th, id }))
    .filter((t) => t && t.messages && (reviewFilter === "open" ? !t.resolved : !!t.resolved));
  // Document order: by file, then by position in the file.
  want.sort((a, b) => (a.path || "").localeCompare(b.path || "")
    || (((a.anchor && a.anchor.from) || 0) - ((b.anchor && b.anchor.from) || 0)));
  if (!want.length) {
    const d = document.createElement("div");
    d.className = "review-empty";
    d.textContent = reviewFilter === "open"
      ? "No open comments. Select some text in the editor and press 💬 to start a thread."
      : "No resolved comments yet.";
    listEl.appendChild(d);
    return;
  }
  for (const th of want) listEl.appendChild(reviewCard(th));
}

function reviewCard(th) {
  const st = threadState(th);
  const card = document.createElement("div");
  card.className = "review-card" + (th.resolved ? " resolved" : "");
  const top = document.createElement("div");
  top.className = "review-card-top";
  const p = document.createElement("span");
  p.className = "review-path"; p.textContent = th.path; p.title = th.path;
  top.appendChild(p);
  if (st.orphan) {
    const f = document.createElement("span");
    f.className = "review-flag"; f.textContent = st.reason;
    f.title = "The commented text is no longer there — the thread is kept here in Review.";
    top.appendChild(f);
  }
  card.appendChild(top);
  const quote = document.createElement("div");
  quote.className = "comment-quote";
  const snip = (th.anchor && th.anchor.snippet) || "";
  quote.textContent = snip.length > 120 ? snip.slice(0, 120) + "…" : (snip || "(no text)");
  if (hasPath(th.path)) {
    quote.title = "Jump to this point in the file";
    quote.addEventListener("click", () => gotoThread(th));
  }
  card.appendChild(quote);
  for (const m of th.messages || []) {
    const row = document.createElement("div");
    row.className = "comment-msg";
    const who = authorUser(m.by);
    row.appendChild(avatarEl(who, { small: true }));
    const body = document.createElement("div");
    body.className = "comment-msg-body";
    body.innerHTML = `<div class="comment-msg-head"><b>${escapeHtml(who.name)}</b> <span class="muted">${escapeHtml(fmtWhen(m.at))}</span></div>
      <div class="comment-msg-text">${msgHtml(m)}</div>`;
    row.appendChild(body);
    card.appendChild(row);
  }
  if (th.resolved && th.resolvedBy) {
    const d = document.createElement("div");
    d.className = "muted"; d.style.fontSize = "11px";
    d.textContent = `✓ Resolved by ${th.resolvedBy.name}${th.resolvedAt ? " · " + fmtWhen(th.resolvedAt) : ""}`;
    card.appendChild(d);
  }
  if (!th.resolved) {
    const area = mentionArea("Reply… (@ to mention someone)");
    area.textarea.rows = 1;
    const reply = document.createElement("button");
    reply.type = "button"; reply.className = "btn small comment-replybtn"; reply.textContent = "Reply";
    const doReply = () => {
      const text = area.textarea.value.trim();
      const cur = commentsMap.get(th.id);
      if (!text || !cur) return;
      const mentions = area.mentions();
      commentsMap.set(th.id, {
        ...cur,
        messages: [...(cur.messages || []), { id: newCommentId(), by: { id: me.id, name: me.name }, at: new Date().toISOString(), text, mentions }],
      });                                  // the map observer re-renders the panel
      notifyMentions(mentions, text, (cur.anchor && cur.anchor.snippet) || "", cur.path);
    };
    reply.addEventListener("click", doReply);
    area.textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doReply(); }
    });
    const rr = document.createElement("div");
    rr.className = "comment-replyrow";
    rr.append(area.wrap, reply);
    card.appendChild(rr);
  }
  const actions = document.createElement("div");
  actions.className = "review-actions";
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "mini";
  toggle.textContent = th.resolved ? "↺ Reopen" : "✓ Resolve";
  toggle.title = th.resolved
    ? "Reopen this thread (the highlight comes back if its text still exists)"
    : "Mark this comment as resolved (hides the highlight)";
  toggle.addEventListener("click", () => {
    const cur = commentsMap.get(th.id);
    if (!cur) return;
    let next;
    if (th.resolved) {                     // Yjs rejects `undefined` values — drop the keys
      next = { ...cur, resolved: false };
      delete next.resolvedBy; delete next.resolvedAt;
    } else {
      next = { ...cur, resolved: true, resolvedBy: { id: me.id, name: me.name }, resolvedAt: new Date().toISOString() };
    }
    commentsMap.set(th.id, next);
    refreshCommentDecos();
  });
  const del = document.createElement("button");
  del.type = "button"; del.className = "mini"; del.textContent = "🗑";
  del.title = "Delete the whole comment thread";
  del.addEventListener("click", () => {
    if (!confirm("Delete this comment thread?")) return;
    commentsMap.delete(th.id);
    refreshCommentDecos();
  });
  actions.append(toggle, del);
  card.appendChild(actions);
  return card;
}

// ---------- Chat (giro 5) ----------
function chatMessages() { return chatArr ? chatArr.toArray().filter((m) => m && m.text && m.by) : []; }

function sendChat() {
  const ta = $("chatInput");
  const text = ta.value.trim();
  if (!text || !chatArr) return;
  chatArr.push([{ id: newCommentId(), by: { id: me.id, name: me.name }, at: new Date().toISOString(), text }]);
  ta.value = "";
  autoGrowChatInput();
  scrollChatBottom(true);                  // the array observer already re-rendered the list
  ta.focus();
}

function onChatChanged(e) {
  if (!booted) return;
  if (sidePanel === "chat") { renderChat(); scrollChatBottom(); }
  else {
    let n = 0;
    for (const d of e.changes.delta) if (d.insert) for (const m of d.insert) if (m && m.by && m.by.id !== me.id) n++;
    if (n) { chatUnread += n; updateRailBadges(); }
  }
}

function renderChat() {
  const list = $("chatList");
  const msgs = chatMessages();
  $("chatEmpty").hidden = msgs.length > 0;
  list.innerHTML = "";
  let prev = null;
  for (const m of msgs) {
    // Consecutive messages from the same person within 3′ stack under one header.
    const compact = !!prev && prev.by.id === m.by.id && (Date.parse(m.at) - Date.parse(prev.at) < 3 * 60e3);
    const row = document.createElement("div");
    row.className = "chat-msg" + (compact ? " compact" : "");
    const body = document.createElement("div");
    body.className = "chat-msg-body";
    if (compact) {
      const g = document.createElement("span"); g.className = "chat-gutter";
      row.appendChild(g);
    } else {
      const who = authorUser(m.by);
      row.appendChild(avatarEl({ ...who, isMe: m.by.id === me.id }, { small: true }));
      body.innerHTML = `<div class="chat-msg-head"><b>${escapeHtml(who.name)}</b> <span class="muted">${escapeHtml(fmtWhen(m.at))}</span></div>`;
    }
    const t = document.createElement("div");
    t.className = "chat-msg-text"; t.textContent = m.text;
    body.appendChild(t);
    row.appendChild(body);
    list.appendChild(row);
    prev = m;
  }
}

// Pin to the bottom on send/open; on incoming messages only if the reader was already
// near the bottom (don't yank someone who scrolled up to read history).
function scrollChatBottom(force = false) {
  const sc = $("chatScroll");
  if (force || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80) sc.scrollTop = sc.scrollHeight;
}
function autoGrowChatInput() {
  const ta = $("chatInput");
  ta.style.height = "auto";
  ta.style.height = Math.min(110, ta.scrollHeight) + "px";
}

// ---------- Splitters ----------
let filesW = 248, editorFrac = 0.5;
let collapsedPane = null;   // null | "editor" | "preview" — mid-bar chevrons (Overleaf-style)
const workspace = document.querySelector(".workspace");
function applyLayout() {
  // A collapsed pane keeps its grid track (display:none would shift the columns after it)
  // but the track goes to 0 and the pane turns invisible via CSS (data-collapsed below).
  const ed = collapsedPane === "editor" ? "0px" : collapsedPane === "preview" ? "1fr" : `${editorFrac}fr`;
  const pv = collapsedPane === "preview" ? "0px" : collapsedPane === "editor" ? "1fr" : `${1 - editorFrac}fr`;
  workspace.style.gridTemplateColumns = `46px ${filesW}px 6px ${ed} 6px ${pv}`;
  if (collapsedPane) workspace.dataset.collapsed = collapsedPane;
  else delete workspace.dataset.collapsed;
  // Only the restoring chevron survives a collapse: › always moves the divider right,
  // ‹ always moves it left, so their meaning never flips — just their titles.
  const right = $("collapsePdf"), left = $("collapseEditor");
  if (right && left) {
    right.hidden = collapsedPane === "preview";
    left.hidden = collapsedPane === "editor";
    right.title = collapsedPane === "editor" ? "Show the editor again" : "Hide the PDF — editor only";
    left.title = collapsedPane === "preview" ? "Show the PDF again" : "Hide the editor — PDF only";
  }
}
function setCollapsed(which) {
  collapsedPane = which;
  if (which === "editor") closeCommentOverlays();   // fixed-position popovers would linger over the PDF
  applyLayout();
  if (view) view.requestMeasure();                  // re-measure after the width jump (PDF re-fits via its ResizeObserver)
}
// Anything that lands the user in the source (tree click, error row, review card, inverse
// search) must bring a collapsed editor back, or the jump would be invisible.
function revealEditor() { if (collapsedPane === "editor") setCollapsed(null); }
function setupSplitters() {
  document.querySelectorAll(".splitter").forEach((sp, i) => {
    sp.addEventListener("mousedown", (e) => {
      if (i === 1 && collapsedPane) return;          // a collapsed divider is parked, not draggable
      e.preventDefault();
      const startX = e.clientX, startFilesW = filesW, startFrac = editorFrac;
      const avail = () => workspace.clientWidth - filesW - 12;
      // body.dragging freezes the cursor to col-resize, kills text selection, and disables
      // pointer-events on the preview so it can't capture the mouse mid-drag (see styles.css).
      document.body.classList.add("dragging");
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (i === 0) filesW = Math.max(160, Math.min(520, startFilesW + dx));
        else { const startEditorPx = startFrac * avail(); editorFrac = Math.max(0.2, Math.min(0.8, (startEditorPx + dx) / avail())); }
        applyLayout();
      };
      const up = () => {
        document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

function slug(s) { return (s || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "document"; }
function errorScreen(msg) {
  return `<div style="height:100%;display:grid;place-items:center;font-family:'Inter',sans-serif;color:#243240;text-align:center">
    <div><h2 style="margin:0 0 8px">${msg}</h2><p><a href="index.html">← Back to projects</a></p></div></div>`;
}

// ---------- Real-time connection status + presence ----------
// Peers publish { user:{id,name,color}, activeFile } into awareness (see init + openFile);
// this is the read side. yCollab already draws named cursors INSIDE the open file, so what
// these avatars add is everything you can't see from there: who else is on the project at
// all, and which file each of them is sitting in.
const MAX_AVATARS = 4;             // the toolbar is a single row — past this we collapse into "+N"

// "Tommaso Panseri" → "TP". Display names arrive derived from the email, so mirror the word
// rules the server used to build them (displayNameFromEmail): a capital mid-word is a break
// ("AdminAccount" → "AA"), and 3+ words take first+last ("Maria Del Carmen" → "MC").
function initialsOf(name) {
  const words = String(name || "")
    .split(/[\s._-]+/)
    .flatMap((w) => w.split(/(?<=[a-z])(?=[A-Z])/))
    .filter((w) => /^\p{L}/u.test(w));
  if (!words.length) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

// The avatar, built in ONE place: initials today, profile photo the day there is one. When
// `avatarUrl` starts being published in awareness, the <img> branch lights up everywhere
// (toolbar + tree) and nothing else has to change.
function avatarEl(user, { small = false } = {}) {
  const el = document.createElement("span");
  el.className = "avatar" + (small ? " avatar-sm" : "") + (user.isMe ? " is-me" : "");
  el.style.setProperty("--avatar-color", user.color || "var(--accent)");
  const label = user.name + (user.isMe ? " (you)" : "");
  el.dataset.name = label;
  el.setAttribute("aria-label", label);
  if (small) el.title = label;     // tree rows sit in a scroller: a CSS tip would be clipped
  if (user.avatarUrl) {
    const img = document.createElement("img");
    img.src = user.avatarUrl; img.alt = "";
    el.appendChild(img);
  } else {
    el.textContent = initialsOf(user.name);
  }
  return el;
}

// Everyone in this project's room: me first, then by name — a stable order, so the strip
// doesn't reshuffle itself while people move around.
// Keyed by PERSON, not by socket: awareness holds one entry per tab, so someone with the
// project open twice (laptop + desktop, or just a stray tab) would otherwise show up as two
// identical avatars. The question this strip answers is "who is here", so tabs collapse.
function peerList() {
  if (!provider) return [];
  const myClientId = provider.awareness.clientID;
  const byPerson = new Map();
  for (const [clientId, st] of provider.awareness.getStates()) {
    const u = st && st.user;
    if (!u || !u.name) continue;             // a peer mid-handshake has no user field yet
    const isMe = clientId === myClientId;
    const key = u.id || `client:${clientId}`;   // pre-id clients (or none) stay per-socket
    const prev = byPerson.get(key);
    if (prev) {
      prev.isMe = prev.isMe || isMe;         // any tab of mine makes the person "me"
      if (st.activeFile) prev.activeFiles.add(st.activeFile);
      continue;
    }
    // activeFiles is a set, not one path: two tabs can sit in two different files, and
    // "Paolo has intro.tex and math.tex open" is the honest answer — picking one would
    // just be arbitrary.
    byPerson.set(key, {
      key, name: u.name, color: u.color, avatarUrl: u.avatarUrl || null,
      activeFiles: new Set(st.activeFile ? [st.activeFile] : []), isMe,
    });
  }
  const out = [...byPerson.values()];
  out.sort((a, b) => (a.isMe !== b.isMe ? (a.isMe ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

// awareness fires on every remote CURSOR move — i.e. on every keystroke of every peer. Redrawing
// the strip and the whole tree at that rate would be wasteful and would drop hover states from
// under the mouse, so redraw only when the part we actually display has changed.
let presenceSig = "";
function onAwarenessChange() {
  if (!booted) return;
  const peers = peerList();
  const sig = peers.map((p) =>
    `${p.key}:${p.name}:${p.color}:${p.avatarUrl}:${[...p.activeFiles].sort().join(",")}`).join("|");
  if (sig === presenceSig) return;
  presenceSig = sig;
  renderPresence(peers);
  renderTree();                              // file rows carry "who's in here" markers
}
function renderPresence(peers = peerList()) {
  if (!presenceEl) return;
  presenceEl.innerHTML = "";
  const shown = peers.slice(0, MAX_AVATARS);
  shown.forEach((p, i) => {
    const el = avatarEl(p);
    el.style.zIndex = String(MAX_AVATARS + 1 - i);   // the overlapping stack reads left-over-right
    presenceEl.appendChild(el);
  });
  const extra = peers.slice(MAX_AVATARS);
  if (extra.length) {
    const more = document.createElement("span");
    more.className = "avatar avatar-more";
    more.textContent = "+" + extra.length;
    more.dataset.name = extra.map((p) => p.name).join(", ");   // the hidden ones are still nameable
    more.setAttribute("aria-label", more.dataset.name);
    presenceEl.appendChild(more);
  }
}

// One owner for "how connected am I", so the toolbar chip, the offline banner and the
// auto-save hint can never contradict each other (CSS keys off body[data-conn]).
function setConnState(state, text) {   // "online" | "connecting" | "offline" | "broken"
  document.body.dataset.conn = state;
  if (!collabEl) return;
  collabEl.textContent = text;
  collabEl.className = "status " + (state === "online" ? "ok" : state === "connecting" ? "busy" : "err");
}

// Hocuspocus retries on its own and reports "connecting" the whole time it does — it never
// sits in a "disconnected" state to read. So losing the socket must be measured in TIME, not
// taken from an event: a blip (or a server restart) recovers in a second and deserves no
// alarm, while a real outage has to be said out loud. Escalate only if we're still not synced
// after the grace period; once loud, stay loud until an actual sync, or the banner would
// flap in and out on every retry.
const OFFLINE_GRACE_MS = 5000;
let offlineTimer = null;
function noteNotSynced() {
  if (document.body.dataset.conn === "offline") return;      // already loud
  setConnState("connecting", "connecting…");
  if (!offlineTimer) offlineTimer = setTimeout(() => {
    offlineTimer = null;
    setConnState("offline", "○ offline");
  }, OFFLINE_GRACE_MS);
}

// Runs on every successful (re)sync; bootstraps the UI once the seeded files arrive.
function onSynced() {
  if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
  setConnState("online", "● online");
  presenceSig = "";              // a reconnect may have emptied/changed the room → force one redraw
  if (!booted) {
    booted = true;
    renderTree();
    const files = flattenForCompile();
    const saved = loadSavedTabs();
    let opened = false;
    if (saved && saved.open.length) {
      openTabs = saved.open.filter(hasPath);                 // restore only files that still exist
      const active = (saved.active && hasPath(saved.active)) ? saved.active : (openTabs[0] || null);
      if (active) { openFile(active); opened = true; }       // active is already in openTabs → order kept
    }
    if (!opened) {
      const mainPath = detectMain(files);
      if (hasPath(mainPath)) openFile(mainPath);
      else if (files[0]) openFile(files[0].path);
      else renderTabs();                                     // empty project → show the empty state
    }
    // Giro 5: the seeded comments/chat arrived before `booted`, so their observers were
    // silent — paint the initial state once. History is never "unread": the badge starts
    // counting from messages that arrive live.
    updateRailBadges();
    renderChat();
    compile();
  }
  onAwarenessChange();           // booted by now, so this actually paints the strip + markers
}

// ---------- History (M2): timeline · diff · restore ----------
// The server records a version on each debounced save (content-addressed snapshots); this
// is the read/act side. Restore goes THROUGH the live Yjs doc — we pull a version's tree and
// replace the shared text in place — so every collaborator's editor follows and the change
// persists via the normal store path (a server-side files/ write would just be overwritten).
let histVersions = [];        // timeline (newest first), as returned by the API
let histSelId = null;         // selected version id
let histSelPath = null;       // selected file path within that version
let histCompare = "prev";     // "prev" (what this version changed) | "current" (vs the working copy)

const histApi = (suffix) => `/api/projects/${PROJECT_ID}/history${suffix}`;
async function histJson(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
function fmtWhen(iso) {
  try { return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
// History authors carry only {id,name}; derive the SAME cursor color the person has live,
// so a face in the timeline matches their caret/avatar in the editor.
function authorUser(by) {
  const name = (by && by.name) || "Unknown";
  const { color } = colorFor((by && by.id) || name || "system");
  return { name, color };
}
const KIND_BADGE = { initial: "initial state", restore: "restore", checkpoint: "checkpoint" };
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function openHistory() {
  const ov = $("historyOverlay");
  ov.hidden = false; ov.setAttribute("aria-hidden", "false");
  const pn = $("projName"); if ($("histProj")) $("histProj").textContent = pn ? pn.textContent : "";
  loadTimeline();
}
function closeHistory() {
  const ov = $("historyOverlay");
  ov.hidden = true; ov.setAttribute("aria-hidden", "true");
}

async function loadTimeline() {
  const list = $("histList");
  list.innerHTML = `<div class="hist-loading">Carico la cronologia…</div>`;
  try {
    const d = await histJson(histApi(""));
    histVersions = d.versions || [];
  } catch (e) {
    list.innerHTML = `<div class="hist-loading">History unavailable.<br><span class="muted">${escapeHtml(e.message)}</span></div>`;
    return;
  }
  if (!histVersions.length) {
    list.innerHTML = `<div class="hist-loading">No versions saved yet.<br><span class="muted">Versions appear as you write.</span></div>`;
    return;
  }
  list.innerHTML = "";
  histVersions.forEach((v, i) => {
    const item = document.createElement("button");
    item.className = "hist-item" + (v.id === histSelId ? " sel" : "");
    item.type = "button";
    const who = authorUser(v.by);
    item.appendChild(avatarEl(who, { small: true }));
    const body = document.createElement("div");
    body.className = "hist-item-body";
    const line1 = document.createElement("div");
    line1.className = "hist-item-line";
    const when = document.createElement("span");
    when.className = "hist-when"; when.textContent = fmtWhen(v.at);
    line1.appendChild(when);
    if (i === 0) { const tag = document.createElement("span"); tag.className = "hist-tag now"; tag.textContent = "current"; line1.appendChild(tag); }
    if (KIND_BADGE[v.kind]) { const tag = document.createElement("span"); tag.className = "hist-tag"; tag.textContent = KIND_BADGE[v.kind]; line1.appendChild(tag); }
    body.appendChild(line1);
    const line2 = document.createElement("div");
    line2.className = "hist-item-sub muted";
    line2.textContent = v.label ? v.label : `${who.name} · ${v.changed} file${v.changed === 1 ? "" : "s"} changed`;
    body.appendChild(line2);
    item.appendChild(body);
    item.addEventListener("click", () => selectVersion(v.id));
    list.appendChild(item);
  });
  // Keep a selection alive across reloads; default to the newest.
  const stillThere = histVersions.some((v) => v.id === histSelId);
  selectVersion(stillThere ? histSelId : histVersions[0].id);
}

async function selectVersion(id) {
  histSelId = id;
  for (const el of $("histList").querySelectorAll(".hist-item")) el.classList.remove("sel");
  const idx = histVersions.findIndex((v) => v.id === id);
  const items = $("histList").querySelectorAll(".hist-item");
  if (items[idx]) items[idx].classList.add("sel");
  const detail = $("histDetail");
  detail.innerHTML = `<div class="hist-placeholder">Loading version…</div>`;
  let version;
  try { version = (await histJson(histApi(`/${id}`))).version; }
  catch (e) { detail.innerHTML = `<div class="hist-placeholder">Error: ${escapeHtml(e.message)}</div>`; return; }
  renderDetail(version, idx);
}

function renderDetail(version, idx) {
  const detail = $("histDetail");
  const who = authorUser(version.by);
  const isNewest = idx === 0;
  detail.innerHTML = "";

  // Meta bar: who / when / label + actions.
  const meta = document.createElement("div");
  meta.className = "hist-meta";
  const av = avatarEl(who);
  meta.appendChild(av);
  const info = document.createElement("div");
  info.className = "hist-meta-info";
  info.innerHTML = `<div class="hist-meta-top"><b>${escapeHtml(who.name)}</b> <span class="muted">· ${escapeHtml(fmtWhen(version.at))}</span></div>
    <div class="hist-meta-sub muted">${version.label ? escapeHtml(version.label) : (KIND_BADGE[version.kind] || "auto-save")}</div>`;
  meta.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "hist-actions";
  const labelBtn = document.createElement("button");
  labelBtn.className = "btn small"; labelBtn.textContent = version.label ? "✎ Label" : "＋ Label";
  labelBtn.title = "Name this version (milestone)";
  labelBtn.addEventListener("click", () => labelVersion(version));
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "btn primary small"; restoreBtn.textContent = "↩ Restore";
  restoreBtn.title = "Restore the project to this version";
  restoreBtn.disabled = isNewest;                 // restoring the current state is a no-op
  if (isNewest) restoreBtn.title = "This is already the current version";
  restoreBtn.addEventListener("click", () => restoreVersion(version));
  actions.append(labelBtn, restoreBtn);
  meta.appendChild(actions);
  detail.appendChild(meta);

  // Compare toggle.
  const bar = document.createElement("div");
  bar.className = "hist-compare";
  bar.innerHTML = `<span class="muted">Confronta:</span>`;
  const mk = (mode, text) => {
    const b = document.createElement("button");
    b.className = "hist-seg" + (histCompare === mode ? " on" : "");
    b.textContent = text; b.type = "button";
    b.addEventListener("click", () => { if (histCompare !== mode) { histCompare = mode; renderDetail(version, idx); } });
    return b;
  };
  bar.appendChild(mk("prev", "vs previous"));
  bar.appendChild(mk("current", "vs current copy"));
  detail.appendChild(bar);

  // Body: file list + diff.
  const body = document.createElement("div");
  body.className = "hist-detail-body";
  const files = document.createElement("ul");
  files.className = "hist-files";
  const changed = version.files.filter((f) => f.status !== "same");
  const shown = changed.length ? changed : version.files;   // if nothing changed (baseline), list all
  for (const f of shown) {
    const li = document.createElement("li");
    li.className = "hist-file" + (f.path === histSelPath ? " sel" : "");
    li.innerHTML = `<span class="hist-file-badge ${f.status}">${{ added: "+", modified: "~", removed: "−", same: "=" }[f.status] || "="}</span><span class="hist-file-name">${escapeHtml(f.path)}</span>`;
    li.addEventListener("click", () => { histSelPath = f.path; renderDetail(version, idx); });
    files.appendChild(li);
  }
  body.appendChild(files);
  const diff = document.createElement("div");
  diff.className = "hist-diff"; diff.id = "histDiff";
  body.appendChild(diff);
  detail.appendChild(body);

  // Pick a file to show: keep the current one if it's in the list, else the first changed.
  const pick = shown.find((f) => f.path === histSelPath) || shown[0];
  if (pick) { histSelPath = pick.path; for (const li of files.children) li.classList.toggle("sel", li.querySelector(".hist-file-name").textContent === pick.path); showDiff(version, pick); }
  else diff.innerHTML = `<div class="hist-placeholder">This version has no files.</div>`;
}

async function showDiff(version, file) {
  const diff = $("histDiff");
  if (!diff) return;
  diff.innerHTML = `<div class="hist-placeholder">Computing differences…</div>`;
  try {
    let before, after;
    if (histCompare === "current") {
      // Working copy → THIS version. The selected version is the "after" side in BOTH
      // modes, so the signs keep one meaning: green = a line this version has, red = a
      // line it lacks. Looking at an old version, text added since then reads as "−"
      // (and the diff previews exactly what Ripristina would apply to today's copy).
      before = currentContentOf(file.path);
      after = await fileAt(version.id, file.path, false);
    } else {
      // previous version → this version
      before = await fileAt(version.id, file.path, true);
      after = await fileAt(version.id, file.path, false);
    }
    if (before.encoding === "base64" || after.encoding === "base64") {
      diff.innerHTML = `<div class="hist-placeholder">📦 Binary file — text comparison isn't available.</div>`;
      return;
    }
    diff.innerHTML = renderDiff(before.content || "", after.content || "");
  } catch (e) {
    diff.innerHTML = `<div class="hist-placeholder">Diff error: ${escapeHtml(e.message)}</div>`;
  }
}

async function fileAt(versionId, path, prev) {
  const q = new URLSearchParams({ path });
  if (prev) q.set("prev", "1");
  return histJson(histApi(`/${versionId}/file?${q.toString()}`));
}
function currentContentOf(path) {
  const v = filesMap && filesMap.get(path);
  if (v instanceof Y.Text) return { encoding: null, content: v.toString(), missing: false };
  if (v && v.encoding === "base64") return { encoding: "base64", content: v.content, missing: false };
  return { encoding: null, content: "", missing: true };
}

// ---- line diff (LCS with common prefix/suffix trim + a fallback for pathological sizes) ----
function lcsCore(a, b) {
  const n = a.length, m = b.length;
  if (!n) return b.map((s) => ({ t: "add", s }));
  if (!m) return a.map((s) => ({ t: "del", s }));
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "ctx", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", s: a[i] }); i++; }
    else { ops.push({ t: "add", s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "del", s: a[i++] });
  while (j < m) ops.push({ t: "add", s: b[j++] });
  return ops;
}
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  const aMid = a.slice(s, n - e), bMid = b.slice(s, m - e);
  const ops = [];
  for (let k = 0; k < s; k++) ops.push({ t: "ctx", s: a[k] });
  if (aMid.length * bMid.length > 4_000_000) {           // too big for the O(nm) table — block-replace the middle
    for (const x of aMid) ops.push({ t: "del", s: x });
    for (const x of bMid) ops.push({ t: "add", s: x });
  } else ops.push(...lcsCore(aMid, bMid));
  for (let k = n - e; k < n; k++) ops.push({ t: "ctx", s: a[k] });
  return ops;
}
// ---- intra-line highlight: inside a balanced del/add block, mark WHAT changed in each
// line pair (word-level LCS), so a one-word edit doesn't read as a whole different line ----
const diffTokens = (s) => s.match(/[\p{L}\p{N}_]+|\s+|./gu) || [];
function intralineSegs(aLine, bLine) {
  const ops = lineDiff(diffTokens(aLine), diffTokens(bLine));
  let common = 0;
  for (const op of ops) if (op.t === "ctx") common += op.s.length;
  // Lines that share too little read better as plain del+add: highlighting nearly
  // everything says less than highlighting nothing.
  if (common / Math.max(aLine.length, bLine.length) < 0.3) return null;
  const segs = { del: [], add: [] };
  const push = (side, changed, text) => {
    const last = segs[side][segs[side].length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs[side].push({ changed, text });
  };
  for (const op of ops) {
    if (op.t === "ctx") { push("del", false, op.s); push("add", false, op.s); }
    else push(op.t, true, op.s);
  }
  return segs;
}
// Pair the − and + lines of each changed block in order (1st del ↔ 1st add, …) up to the
// shorter side — the extra lines of an unbalanced block are plain additions/removals. A
// mispaired couple (say a new line slipped in between) is harmless: intralineSegs refuses
// pairs that share too little, and the pair just renders un-highlighted.
function markIntraline(rows) {
  for (let i = 0; i < rows.length;) {
    if (rows[i].t === "ctx") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].t !== "ctx") j++;
    const dels = [], adds = [];
    for (let k = i; k < j; k++) (rows[k].t === "del" ? dels : adds).push(rows[k]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const segs = intralineSegs(dels[k].s, adds[k].s);
      if (segs) { dels[k].hl = segs.del; adds[k].hl = segs.add; }
    }
    i = j;
  }
}
function renderDiff(beforeText, afterText) {
  if (beforeText === afterText) return `<div class="hist-placeholder">No differences in this file.</div>`;
  const ops = lineDiff(beforeText.split("\n"), afterText.split("\n"));
  // number lines and fold long unchanged runs
  let oldN = 0, newN = 0;
  const rows = ops.map((op) => {
    if (op.t === "ctx") { oldN++; newN++; return { t: "ctx", o: oldN, n: newN, s: op.s }; }
    if (op.t === "del") { oldN++; return { t: "del", o: oldN, n: null, s: op.s }; }
    newN++; return { t: "add", o: null, n: newN, s: op.s };
  });
  markIntraline(rows);
  const KEEP = 3, MINFOLD = 8, out = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== "ctx") { out.push(rows[i++]); continue; }
    let j = i; while (j < rows.length && rows[j].t === "ctx") j++;
    const run = rows.slice(i, j), first = i === 0, last = j === rows.length;
    if (run.length > MINFOLD) {
      if (!first) out.push(...run.slice(0, KEEP));
      const hidden = run.length - (first ? 0 : KEEP) - (last ? 0 : KEEP);
      if (hidden > 0) out.push({ t: "fold", count: hidden });
      if (!last) out.push(...run.slice(run.length - KEEP));
    } else out.push(...run);
    i = j;
  }
  const sign = { ctx: " ", add: "+", del: "−" };
  const lineHtml = (r) => r.hl
    ? r.hl.map((sg) => sg.changed ? `<span class="dlh">${escapeHtml(sg.text)}</span>` : escapeHtml(sg.text)).join("")
    : (escapeHtml(r.s) || "&nbsp;");
  const html = out.map((r) => r.t === "fold"
    ? `<div class="dl fold">⋯ ${r.count} righe invariate ⋯</div>`
    : `<div class="dl ${r.t}"><span class="dln">${r.o ?? ""}</span><span class="dln">${r.n ?? ""}</span><span class="dls">${sign[r.t]}</span><span class="dlt">${lineHtml(r)}</span></div>`).join("");
  return `<div class="diff">${html}</div>`;
}

async function labelVersion(version) {
  const next = prompt("Version name (empty to remove the label):", version.label || "");
  if (next === null) return;                       // cancelled
  try {
    await histJson(histApi(`/${version.id}/label`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: next.trim() }),
    });
    await loadTimeline();                          // refresh list + detail
  } catch (e) { alert("Couldn't save the label: " + e.message); }
}

async function restoreVersion(version) {
  if (!booted || !filesMap) { alert("Wait for the project to load before restoring."); return; }
  const when = fmtWhen(version.at);
  if (!confirm(`Restore the version from ${when}?\n\nThe project's current content is replaced with this version's, for everyone. The current state stays in the history: you can go back at any time.`)) return;
  setStatus("busy", "Restoring…");
  let tree;
  try { tree = (await histJson(histApi(`/${version.id}/tree`))).files || []; }
  catch (e) { setStatus("err", "Error"); alert("Couldn't read the version: " + e.message); return; }

  const target = new Map(tree.map((f) => [f.path, f]));
  // Bump the break nonce FIRST so the store triggered by this change is forced into a fresh,
  // non-amendable version — the state we're leaving is preserved as its own point in history.
  metaMap.set("historyBreak", { nonce: newBreakNonce(), kind: "restore" });
  ydoc.transact(() => {
    for (const [p, f] of target) {
      const existing = filesMap.get(p);
      if (f.encoding === "base64") {
        filesMap.set(p, { encoding: "base64", content: f.content });
      } else if (existing instanceof Y.Text) {
        const cur = existing.toString();
        if (cur !== (f.content || "")) { existing.delete(0, existing.length); if (f.content) existing.insert(0, f.content); }
      } else {
        const t = new Y.Text(); filesMap.set(p, t); if (f.content) t.insert(0, f.content);
      }
    }
    for (const [p] of fileEntries()) if (!target.has(p)) filesMap.delete(p);   // drop files not in the target
  });
  setUpdatedBy();
  // Rebind the open editor to the (possibly replaced) text; structural changes already
  // re-render the tree via the filesMap observer.
  const keep = currentPath && hasPath(currentPath) ? currentPath : null;
  if (keep) openFile(keep);
  closeHistory();
  setStatus("ok", "Restored ✓");
  compile();                                       // reflect the restored content in the preview
}

const newBreakNonce = () => Date.now() + "-" + Math.random().toString(36).slice(2, 8);

// Manual checkpoint: cut a named, non-amendable version of the CURRENT doc state, now.
// Same mechanism as restore — bump the break nonce in the shared meta map — but carrying
// kind/label/author, so the server cuts it as a "checkpoint" by whoever clicked (the doc
// content may be untouched, so the last EDITOR would be the wrong author). The version
// itself is made by the debounced server store (~2s), hence the short poll to show it.
async function checkpointNow() {
  if (!booted || !filesMap) { alert("Wait for the project to load before creating a checkpoint."); return; }
  const label = prompt("Checkpoint name (optional):", "");
  if (label === null) return;                      // cancelled
  const btn = $("histCheckpoint");
  const prevNewest = histVersions[0] ? histVersions[0].id : null;
  metaMap.set("historyBreak", {
    nonce: newBreakNonce(), kind: "checkpoint",
    label: label.trim() || null, by: { id: me.id, name: me.name },
  });
  btn.disabled = true; btn.textContent = "📌 Creo il checkpoint…";
  try {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      let newest;
      try { newest = ((await histJson(histApi(""))).versions || [])[0]; } catch { continue; }
      if (newest && newest.kind === "checkpoint" && newest.id !== prevNewest) {
        histSelId = newest.id;
        if (!$("historyOverlay").hidden) await loadTimeline();
        return;
      }
    }
    // Offline or slow store: the nonce is already in the doc, so the checkpoint will be
    // cut at the next successful save — nothing is lost, it just isn't visible yet.
    alert("The checkpoint hasn't appeared yet: it'll be created on the next save (e.g. when you come back online).");
  } finally {
    btn.disabled = false; btn.textContent = "📌 Checkpoint";
  }
}

// ---------- Project name (rename) ----------
// The name is authoritative in meta.json (via POST …/rename) and mirrored into the shared
// meta map so a rename shows up live for everyone who has the project open right now.
function setProjName(name) {
  const el = $("projName");
  if (el) el.textContent = name;
  document.title = (name || "Project") + " — Alumère";
}
function closeProjMenu() {
  const menu = $("projMenu"), pop = menu && menu.querySelector(".menu-pop");
  if (pop) pop.hidden = true;
}
async function commitProjRename(next) {
  const prev = ($("projName").textContent || "").trim();
  if (!next || next === prev) return;
  setProjName(next);                                   // optimistic
  try {
    const r = await fetch(`/api/projects/${PROJECT_ID}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    setProjName(d.name);
    try { metaMap.set("name", d.name); } catch {}      // live-mirror to peers
  } catch (e) {
    setProjName(prev);                                 // revert on failure
    alert("Couldn't rename the project: " + e.message);
  }
}
// Click "Rename" → the name becomes an inline input (Enter/blur = save, Esc = cancel).
let projRenaming = false;
function startProjRename() {
  if (projRenaming) return;
  projRenaming = true;
  closeProjMenu();
  const menu = $("projMenu"), btn = $("projNameBtn");
  const cur = ($("projName").textContent || "").trim();
  const input = document.createElement("input");
  input.className = "projname-input";
  input.value = cur; input.maxLength = 120; input.setAttribute("aria-label", "Project name");
  btn.hidden = true;
  menu.insertBefore(input, menu.firstChild);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;                     // Enter removes the input → blur; guard the double
    const next = input.value.trim().slice(0, 120);
    input.remove(); btn.hidden = false; projRenaming = false;
    if (commit) commitProjRename(next);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}
function setupProjMenu() {
  const menu = $("projMenu"); if (!menu) return;
  const btn = $("projNameBtn"), pop = menu.querySelector(".menu-pop"), ren = $("projRename");
  if (!btn || !pop) return;
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => { if (!pop.hidden && !menu.contains(e.target)) pop.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) pop.hidden = true; });
  if (ren) ren.addEventListener("click", (e) => { e.stopPropagation(); startProjRename(); });
}
// A peer renamed the project (mirrored into the shared meta map) → follow it live.
function onMetaChanged(e) {
  if (e.keysChanged && e.keysChanged.has("name")) {
    const n = metaMap.get("name");
    if (typeof n === "string" && n && n !== ($("projName").textContent || "").trim()) setProjName(n);
  }
}

// ---------- Load + wire up ----------
async function init() {
  // Don't touch anything until the user is identified (auth.js sets the session cookie).
  if (window.Alumere) { await window.Alumere.ready; if (window.Alumere.user) me = window.Alumere.user; }
  if (!PROJECT_ID) { location.replace("index.html"); return; }

  // Confirm the project exists (friendly error screen) before opening the socket.
  let meta;
  try { const d = await (await fetch(`/api/projects/${PROJECT_ID}`)).json(); if (!d.ok) throw 0; meta = d.project; }
  catch { document.body.innerHTML = errorScreen("Project not found or server unreachable."); return; }
  setProjName(meta.name || "Project");
  initEditorTheme();

  if (!window.YCOLLAB) {
    setConnState("broken", "collab unavailable");   // not "offline": nothing here will sync later
    editorHost.innerHTML = `<div style="padding:16px;font:13px/1.5 'Inter',sans-serif;color:#5a3a06;background:#fff3cd">The real-time bundle (<code>window.YCOLLAB</code>) isn't loaded. Rebuild <code>public/vendor/codemirror.js</code> with <code>npm run build:client</code> and reload.</div>`;
    return;
  }
  ({ Y, HocuspocusProvider, yCollab, yUndoManagerKeymap } = window.YCOLLAB);
  CM = await loadCodeMirror();

  // Shared doc for THIS project (room = project id), same port, path /collab.
  ydoc = new Y.Doc();
  filesMap = ydoc.getMap("files");
  metaMap = ydoc.getMap("meta");
  commentsMap = ydoc.getMap("comments");
  chatArr = ydoc.getArray("chat");
  dictArr = ydoc.getArray("dict");     // project dictionary (giro 6): custom spellcheck words
  // The @mention roster (D2): everyone who has ever signed in. Best-effort — comments
  // work without it, you just don't get autocomplete.
  fetch("/api/users").then((r) => r.json()).then((d) => {
    if (d && d.ok) { roster = d.users || []; rosterById = new Map(roster.map((u) => [u.id, u])); }
  }).catch(() => {});
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  provider = new HocuspocusProvider({ url: `${wsProto}://${location.host}/collab`, name: PROJECT_ID, document: ydoc });

  const { color, colorLight } = colorFor(me.id || me.name || "anon");
  // `id` is what lets peerList() collapse one person's several tabs into one avatar;
  // name/color are also read by yCollab to label the remote carets in the text.
  provider.awareness.setLocalStateField("user", { id: me.id, name: me.name, color, colorLight });

  filesMap.observe(onFilesChanged);
  metaMap.observe(onMetaChanged);
  commentsMap.observe(onCommentsChanged);
  chatArr.observe(onChatChanged);
  dictArr.observe(onDictChanged);
  ensureSpellWorker();               // prewarm: the dictionaries take a moment to parse
  noteNotSynced();
  // "connected" is the socket, not the doc — only `synced` means we actually have everyone's
  // work, so that's what flips us to online (see onSynced).
  provider.on("status", (e) => { if (e.status !== "connected") noteNotSynced(); });
  provider.on("disconnect", noteNotSynced);
  provider.on("synced", onSynced);
  provider.awareness.on("change", onAwarenessChange);

  // Toolbar + layout (independent of sync).
  renderTree(); applyLayout(); setupSplitters(); setupProjMenu();
  $("recompile").addEventListener("click", compile);
  $("newFile").addEventListener("click", newFile);
  $("newFolder").addEventListener("click", newFolder);
  $("download").addEventListener("click", () => {
    if (!pdfBlob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(pdfBlob); a.download = slug(meta.name) + ".pdf"; a.click();
  });
  $("tabPdf").addEventListener("click", () => showTab("pdf"));
  $("tabLog").addEventListener("click", () => showTab("log"));
  // Side panels (giro 5): the icon rail swaps what the left column shows.
  $("railFiles").addEventListener("click", () => setSidePanel("files"));
  $("railReview").addEventListener("click", () => setSidePanel("review"));
  $("railChat").addEventListener("click", () => setSidePanel("chat"));
  $("revTabOpen").addEventListener("click", () => { reviewFilter = "open"; renderReviewPanel(); });
  $("revTabResolved").addEventListener("click", () => { reviewFilter = "resolved"; renderReviewPanel(); });
  $("chatSend").addEventListener("click", sendChat);
  $("chatInput").addEventListener("input", autoGrowChatInput);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("history").addEventListener("click", openHistory);
  $("histClose").addEventListener("click", closeHistory);
  $("histCheckpoint").addEventListener("click", checkpointNow);
  // The ⚙ menu (toggle / outside-click / Esc-to-close) is wired by theme.js. Here we only
  // keep Esc-closes-history and the Cmd/Ctrl+S compile shortcut.
  setupZoom();
  $("syncForward").addEventListener("click", syncForward);
  // The arrow lives on the splitter: don't let pressing it start a pane drag.
  $("syncForward").addEventListener("mousedown", (e) => e.stopPropagation());
  // Pane collapse chevrons (same divider): › = divider right, ‹ = divider left.
  $("collapsePdf").addEventListener("click", () => setCollapsed(collapsedPane === "editor" ? null : "preview"));
  $("collapseEditor").addEventListener("click", () => setCollapsed(collapsedPane === "preview" ? null : "editor"));
  document.querySelectorAll(".collapse-btn").forEach((b) => b.addEventListener("mousedown", (e) => e.stopPropagation()));
  pagesEl.addEventListener("dblclick", onPdfDblClick);   // inverse search: PDF → source
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && spellMenuEl && !spellMenuEl.hidden) { closeSpellMenu(); return; }
    if (e.key === "Escape" && commentDom && !commentDom.pop.hidden) { closeCommentOverlays(); return; }
    if (e.key === "Escape" && !$("historyOverlay").hidden) { closeHistory(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); compile(); }
  });
}
init();
