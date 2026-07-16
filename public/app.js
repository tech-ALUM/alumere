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
let ydoc = null, provider = null, filesMap = null, metaMap = null;
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
const openPathEl = $("openPath"), presenceEl = $("presence");
const pdfFrame = $("pdf"), logEl = $("log"), previewEmpty = $("previewEmpty");
const engineSel = $("engine");

let currentPath = null;            // path of the open file (null = nothing open)
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
  const name = prompt("Nome nuovo file:", "untitled.tex");
  if (!name) return;
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  const path = targetDir ? `${targetDir}/${clean}` : clean;
  if (hasPath(path)) { alert("Esiste già un file con questo percorso."); return; }
  ydoc.transact(() => { filesMap.set(path, new Y.Text()); });
  pendingFolders.delete(targetDir);
  setUpdatedBy();
  openFile(path);
}
function newFolder() {
  const name = prompt("Nome nuova cartella:", "cartella");
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
  const nn = prompt("Rinomina in:", node.name);
  if (!nn) return;
  const clean = nn.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean === node.name) return;
  const parent = parentOf(node.path);
  const newPath = parent ? `${parent}/${clean}` : clean;

  if (isFolder) {
    const prefix = node.path + "/";
    const affected = fileEntries().filter(([p]) => p === node.path || p.startsWith(prefix));
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
    if (hasPath(newPath)) { alert("Percorso già esistente."); return; }
    const reopen = currentPath === node.path;
    if (reopen) currentPath = newPath;
    const v = filesMap.get(node.path);
    ydoc.transact(() => { moveEntry(node.path, newPath, v); });
    setUpdatedBy();
    if (reopen) openFile(newPath); else renderTree();
  }
}
function deleteNode(node) {
  if (!confirm(`Eliminare "${node.name}"?`)) return;
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
  renderTree();
  if (currentPath && !hasPath(currentPath)) {   // the open file went away (e.g. a peer deleted it)
    const first = fileEntries()[0];
    if (first) openFile(first[0]);
    else { currentPath = null; if (view) { view.destroy(); view = null; } openPathEl.textContent = ""; }
  }
}

// ---------- Editor (CodeMirror bound to the active file's Y.Text) ----------
function latexCompletions(context) {
  const env = context.matchBefore(/\\(begin|end)\{[a-zA-Z@*]*$/);
  if (env) {
    const from = env.from + env.text.indexOf("{") + 1;
    return { from, validFor: /^[a-zA-Z*]*$/, options: ENVIRONMENTS.map((e) => ({ label: e, type: "type" })) };
  }
  const cmd = context.matchBefore(/\\[a-zA-Z@]*$/);
  if (!cmd || (cmd.from === cmd.to && !context.explicit)) return null;
  const { snippetCompletion } = CM.autocomplete;
  const options = COMMANDS.map(([label, tmpl, detail]) => snippetCompletion(tmpl, { label, type: "function", detail }));
  for (const g of GREEK) options.push({ label: "\\" + g, type: "constant", detail: "Greek letter" });
  return { from: cmd.from, options, validFor: /^\\[a-zA-Z@]*$/ };
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
// (Re)build the editor bound to `path`. Recreating the view on each switch keeps the
// Yjs binding clean: the old yCollab is disposed before the new file's text loads, so
// a file's content can never leak into another file's Y.Text.
function openFile(path) {
  if (!hasPath(path)) return;
  const val = filesMap.get(path);
  currentPath = path;
  if (view) { view.destroy(); view = null; }
  const { EditorView, keymap } = CM.view;
  const { EditorState } = CM.state;
  let state;
  if (isBinaryVal(val)) {
    const msg = `% "${baseOf(path)}" è un asset binario (immagine/PDF).\n% È conservato nel progetto e usato in compilazione, ma non è modificabile qui.`;
    state = EditorState.create({ doc: msg, extensions: [...baseExtensions(), EditorView.editable.of(false), EditorState.readOnly.of(true)] });
  } else {
    const undoManager = new Y.UndoManager(val);
    state = EditorState.create({
      doc: val.toString(),
      extensions: [
        ...baseExtensions(),
        yCollab(val, provider.awareness, { undoManager }),
        keymap.of(yUndoManagerKeymap),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) noteLocalEdit();
        }),
      ],
    });
  }
  view = new EditorView({ state, parent: editorHost });
  openPathEl.textContent = path;
  try { provider.awareness.setLocalStateField("activeFile", path); } catch {}
  renderTree();
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
let pdfUrl = null, pdfBlob = null;
async function compile() {
  setStatus("busy", "Compiling…");
  const files = flattenForCompile();
  const payload = { files, main: detectMain(files), engine: engineSel.value };
  try {
    const res = await fetch("/api/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    renderLog(data.log);
    if (data.ok && data.pdf) {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      pdfBlob = b64ToBlob(data.pdf, "application/pdf");
      pdfUrl = URL.createObjectURL(pdfBlob);
      pdfFrame.src = pdfUrl;
      previewEmpty.classList.add("hidden");
      showTab("pdf");
      setStatus("ok", "Compiled ✓");
    } else { setStatus("err", "Errors"); showTab("log"); }
  } catch (e) {
    renderLog("Could not reach the compile server.\nIs it running?  →  " + e.message);
    setStatus("err", "Offline"); showTab("log");
  }
}

// ---------- Preview tabs ----------
function showTab(which) {
  const pdf = which === "pdf";
  pdfFrame.classList.toggle("hidden", !pdf);
  logEl.classList.toggle("hidden", pdf);
  if (pdf) previewEmpty.classList.toggle("hidden", !!pdfUrl);
  else previewEmpty.classList.add("hidden");
  $("tabPdf").classList.toggle("active", pdf);
  $("tabLog").classList.toggle("active", !pdf);
}

// ---------- Splitters ----------
let filesW = 248, editorFrac = 0.5;
const workspace = document.querySelector(".workspace");
function applyLayout() { workspace.style.gridTemplateColumns = `${filesW}px 6px ${editorFrac}fr 6px ${1 - editorFrac}fr`; }
function setupSplitters() {
  document.querySelectorAll(".splitter").forEach((sp, i) => {
    sp.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX, startFilesW = filesW, startFrac = editorFrac;
      const avail = () => workspace.clientWidth - filesW - 12;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (i === 0) filesW = Math.max(160, Math.min(520, startFilesW + dx));
        else { const startEditorPx = startFrac * avail(); editorFrac = Math.max(0.2, Math.min(0.8, (startEditorPx + dx) / avail())); }
        applyLayout();
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

function slug(s) { return (s || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "document"; }
function errorScreen(msg) {
  return `<div style="height:100%;display:grid;place-items:center;font-family:'Inter',sans-serif;color:#243240;text-align:center">
    <div><h2 style="margin:0 0 8px">${msg}</h2><p><a href="index.html">← Torna ai progetti</a></p></div></div>`;
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
  const label = user.name + (user.isMe ? " (tu)" : "");
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
  setConnState("connecting", "connessione…");
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
    const mainPath = detectMain(files);
    if (hasPath(mainPath)) openFile(mainPath);
    else if (files[0]) openFile(files[0].path);
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
  const name = (by && by.name) || "Sconosciuto";
  const { color } = colorFor((by && by.id) || name || "system");
  return { name, color };
}
const KIND_BADGE = { initial: "stato iniziale", checkpoint: "ripristino" };
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
    list.innerHTML = `<div class="hist-loading">Cronologia non disponibile.<br><span class="muted">${escapeHtml(e.message)}</span></div>`;
    return;
  }
  if (!histVersions.length) {
    list.innerHTML = `<div class="hist-loading">Ancora nessuna versione salvata.<br><span class="muted">Le versioni compaiono man mano che si scrive.</span></div>`;
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
    if (i === 0) { const tag = document.createElement("span"); tag.className = "hist-tag now"; tag.textContent = "attuale"; line1.appendChild(tag); }
    if (KIND_BADGE[v.kind]) { const tag = document.createElement("span"); tag.className = "hist-tag"; tag.textContent = KIND_BADGE[v.kind]; line1.appendChild(tag); }
    body.appendChild(line1);
    const line2 = document.createElement("div");
    line2.className = "hist-item-sub muted";
    line2.textContent = v.label ? v.label : `${who.name} · ${v.changed} ${v.changed === 1 ? "file" : "file"} modificat${v.changed === 1 ? "o" : "i"}`;
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
  detail.innerHTML = `<div class="hist-placeholder">Carico la versione…</div>`;
  let version;
  try { version = (await histJson(histApi(`/${id}`))).version; }
  catch (e) { detail.innerHTML = `<div class="hist-placeholder">Errore: ${escapeHtml(e.message)}</div>`; return; }
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
    <div class="hist-meta-sub muted">${version.label ? escapeHtml(version.label) : (KIND_BADGE[version.kind] || "salvataggio automatico")}</div>`;
  meta.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "hist-actions";
  const labelBtn = document.createElement("button");
  labelBtn.className = "btn small"; labelBtn.textContent = version.label ? "✎ Etichetta" : "＋ Etichetta";
  labelBtn.title = "Dai un nome a questa versione (milestone)";
  labelBtn.addEventListener("click", () => labelVersion(version));
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "btn primary small"; restoreBtn.textContent = "↩ Ripristina";
  restoreBtn.title = "Riporta il progetto a questa versione";
  restoreBtn.disabled = isNewest;                 // restoring the current state is a no-op
  if (isNewest) restoreBtn.title = "È già la versione attuale";
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
  bar.appendChild(mk("prev", "con la precedente"));
  bar.appendChild(mk("current", "con la copia attuale"));
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
  else diff.innerHTML = `<div class="hist-placeholder">Questa versione non contiene file.</div>`;
}

async function showDiff(version, file) {
  const diff = $("histDiff");
  if (!diff) return;
  diff.innerHTML = `<div class="hist-placeholder">Calcolo differenze…</div>`;
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
      diff.innerHTML = `<div class="hist-placeholder">📦 File binario — il confronto testuale non è disponibile.</div>`;
      return;
    }
    diff.innerHTML = renderDiff(before.content || "", after.content || "");
  } catch (e) {
    diff.innerHTML = `<div class="hist-placeholder">Errore nel diff: ${escapeHtml(e.message)}</div>`;
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
function renderDiff(beforeText, afterText) {
  if (beforeText === afterText) return `<div class="hist-placeholder">Nessuna differenza in questo file.</div>`;
  const ops = lineDiff(beforeText.split("\n"), afterText.split("\n"));
  // number lines and fold long unchanged runs
  let oldN = 0, newN = 0;
  const rows = ops.map((op) => {
    if (op.t === "ctx") { oldN++; newN++; return { t: "ctx", o: oldN, n: newN, s: op.s }; }
    if (op.t === "del") { oldN++; return { t: "del", o: oldN, n: null, s: op.s }; }
    newN++; return { t: "add", o: null, n: newN, s: op.s };
  });
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
  const html = out.map((r) => r.t === "fold"
    ? `<div class="dl fold">⋯ ${r.count} righe invariate ⋯</div>`
    : `<div class="dl ${r.t}"><span class="dln">${r.o ?? ""}</span><span class="dln">${r.n ?? ""}</span><span class="dls">${sign[r.t]}</span><span class="dlt">${escapeHtml(r.s) || "&nbsp;"}</span></div>`).join("");
  return `<div class="diff">${html}</div>`;
}

async function labelVersion(version) {
  const next = prompt("Nome della versione (vuoto per rimuovere l'etichetta):", version.label || "");
  if (next === null) return;                       // cancelled
  try {
    await histJson(histApi(`/${version.id}/label`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: next.trim() }),
    });
    await loadTimeline();                          // refresh list + detail
  } catch (e) { alert("Impossibile salvare l'etichetta: " + e.message); }
}

async function restoreVersion(version) {
  if (!booted || !filesMap) { alert("Attendi il caricamento del progetto prima di ripristinare."); return; }
  const when = fmtWhen(version.at);
  if (!confirm(`Ripristinare la versione del ${when}?\n\nIl contenuto attuale del progetto viene sostituito con quello di questa versione, per tutti. Lo stato attuale resta comunque nella cronologia: puoi tornare indietro in qualsiasi momento.`)) return;
  setStatus("busy", "Ripristino…");
  let tree;
  try { tree = (await histJson(histApi(`/${version.id}/tree`))).files || []; }
  catch (e) { setStatus("err", "Errore"); alert("Impossibile leggere la versione: " + e.message); return; }

  const target = new Map(tree.map((f) => [f.path, f]));
  // Bump the break nonce FIRST so the store triggered by this change is forced into a fresh,
  // non-amendable version — the state we're leaving is preserved as its own point in history.
  const nonce = "r-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  metaMap.set("historyBreak", nonce);
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
  setStatus("ok", "Ripristinato ✓");
  compile();                                       // reflect the restored content in the preview
}

// ---------- Load + wire up ----------
async function init() {
  // Don't touch anything until the user is identified (auth.js sets the session cookie).
  if (window.Alumere) { await window.Alumere.ready; if (window.Alumere.user) me = window.Alumere.user; }
  if (!PROJECT_ID) { location.replace("index.html"); return; }

  // Confirm the project exists (friendly error screen) before opening the socket.
  let meta;
  try { const d = await (await fetch(`/api/projects/${PROJECT_ID}`)).json(); if (!d.ok) throw 0; meta = d.project; }
  catch { document.body.innerHTML = errorScreen("Progetto non trovato o server irraggiungibile."); return; }
  $("projName").textContent = meta.name || "Project";
  document.title = (meta.name || "Project") + " — Alumère";
  initEditorTheme();

  if (!window.YCOLLAB) {
    setConnState("broken", "collab non disponibile");   // not "offline": nothing here will sync later
    editorHost.innerHTML = `<div style="padding:16px;font:13px/1.5 'Inter',sans-serif;color:#5a3a06;background:#fff3cd">Il bundle real-time (<code>window.YCOLLAB</code>) non è caricato. Ricostruisci <code>public/vendor/codemirror.js</code> con <code>npm run build:client</code> e ricarica.</div>`;
    return;
  }
  ({ Y, HocuspocusProvider, yCollab, yUndoManagerKeymap } = window.YCOLLAB);
  CM = await loadCodeMirror();

  // Shared doc for THIS project (room = project id), same port, path /collab.
  ydoc = new Y.Doc();
  filesMap = ydoc.getMap("files");
  metaMap = ydoc.getMap("meta");
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  provider = new HocuspocusProvider({ url: `${wsProto}://${location.host}/collab`, name: PROJECT_ID, document: ydoc });

  const { color, colorLight } = colorFor(me.id || me.name || "anon");
  // `id` is what lets peerList() collapse one person's several tabs into one avatar;
  // name/color are also read by yCollab to label the remote carets in the text.
  provider.awareness.setLocalStateField("user", { id: me.id, name: me.name, color, colorLight });

  filesMap.observe(onFilesChanged);
  noteNotSynced();
  // "connected" is the socket, not the doc — only `synced` means we actually have everyone's
  // work, so that's what flips us to online (see onSynced).
  provider.on("status", (e) => { if (e.status !== "connected") noteNotSynced(); });
  provider.on("disconnect", noteNotSynced);
  provider.on("synced", onSynced);
  provider.awareness.on("change", onAwarenessChange);

  // Toolbar + layout (independent of sync).
  renderTree(); applyLayout(); setupSplitters();
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
  $("history").addEventListener("click", openHistory);
  $("histClose").addEventListener("click", closeHistory);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("historyOverlay").hidden) { closeHistory(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); compile(); }
  });
}
init();
