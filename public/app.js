// Alumère — editor page. Loads ONE project (by ?p=<id>) from the server,
// lets you edit / save / compile it. Three panes: file tree · CodeMirror editor
// with LaTeX autocomplete · PDF preview.

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

// ---------- Project state (loaded from the server) ----------
let project = { id: PROJECT_ID, name: "", root: [] };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const treeEl = $("tree"), editorHost = $("editor"), statusEl = $("status");
const openPathEl = $("openPath"), dirtyDot = $("dirtyDot");
const pdfFrame = $("pdf"), logEl = $("log"), previewEmpty = $("previewEmpty");
const engineSel = $("engine");

let currentFileId = null;
let editorApi = null;
let pdfUrl = null, pdfBlob = null;

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

// ---------- Tree helpers ----------
function findById(id, list = project.root) {
  for (const n of list) {
    if (n.id === id) return { node: n, list };
    if (n.children) { const hit = findById(id, n.children); if (hit) return hit; }
  }
  return null;
}
function pathOf(id) {
  function rec(list, prefix) {
    for (const n of list) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.id === id) return p;
      if (n.children) { const r = rec(n.children, p); if (r) return r; }
    }
    return null;
  }
  return rec(project.root, "");
}
function flattenFiles() {
  const out = [];
  (function rec(list, prefix) {
    for (const n of list) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.type === "file") {
        out.push(n.encoding === "base64"
          ? { path: p, content: n.content ?? "", encoding: "base64" }
          : { path: p, content: n.content ?? "" });
      } else if (n.children) rec(n.children, p);
    }
  })(project.root, "");
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
function findFileIdByPath(targetPath) {
  let found = null;
  (function rec(list, prefix) {
    for (const n of list) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.type === "file" && p === targetPath) found = n.id;
      else if (n.children) rec(n.children, p);
    }
  })(project.root, "");
  return found;
}
const uid = () => "n-" + Math.random().toString(36).slice(2, 9);

// ---------- Tree rendering ----------
function iconFor(node) {
  if (node.type === "folder") return node.open ? "📂" : "📁";
  if (/\.tex$/i.test(node.name)) return "📄";
  if (/\.bib$/i.test(node.name)) return "📚";
  if (/\.(png|jpe?g|pdf|gif|svg|eps)$/i.test(node.name)) return "🖼";
  return "📃";
}
function isBinary(node) { return node.encoding === "base64"; }

function renderTree() { treeEl.innerHTML = ""; treeEl.appendChild(buildList(project.root)); }
function buildList(list) {
  const ul = document.createElement("ul");
  for (const node of list) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row" + (node.id === currentFileId ? " active" : "");
    const tw = document.createElement("span");
    tw.className = "twisty";
    tw.textContent = node.type === "folder" ? (node.open ? "▾" : "▸") : "";
    const ic = document.createElement("span");
    ic.className = "rowicon"; ic.textContent = iconFor(node);
    const nm = document.createElement("span");
    nm.className = "rowname"; nm.textContent = node.name;
    const actions = document.createElement("span");
    actions.className = "rowactions";
    const renameBtn = document.createElement("button"); renameBtn.textContent = "✎"; renameBtn.title = "Rename";
    const delBtn = document.createElement("button"); delBtn.textContent = "🗑"; delBtn.title = "Delete";
    actions.append(renameBtn, delBtn);
    row.append(tw, ic, nm, actions);
    li.appendChild(row);
    row.addEventListener("click", (e) => {
      if (e.target === renameBtn || e.target === delBtn) return;
      if (node.type === "folder") { node.open = !node.open; renderTree(); }
      else openFile(node.id);
    });
    renameBtn.addEventListener("click", (e) => { e.stopPropagation(); renameNode(node.id); });
    delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteNode(node.id); });
    if (node.children && node.open) li.appendChild(buildList(node.children));
    ul.appendChild(li);
  }
  return ul;
}

function targetList() {
  const hit = findById(currentFileId);
  if (!hit) return project.root;
  if (hit.node.type === "folder") { hit.node.open = true; return hit.node.children; }
  return hit.list;
}
function newFile() {
  const name = prompt("New file name:", "untitled.tex");
  if (!name) return;
  const node = { id: uid(), type: "file", name, content: "" };
  targetList().push(node);
  renderTree(); openFile(node.id); markDirty();
}
function newFolder() {
  const name = prompt("New folder name:", "folder");
  if (!name) return;
  targetList().push({ id: uid(), type: "folder", name, open: true, children: [] });
  renderTree(); markDirty();
}
function renameNode(id) {
  const hit = findById(id); if (!hit) return;
  const name = prompt("Rename to:", hit.node.name);
  if (!name) return;
  hit.node.name = name;
  if (id === currentFileId) openPathEl.textContent = pathOf(id);
  renderTree(); markDirty();
}
function deleteNode(id) {
  const hit = findById(id); if (!hit) return;
  if (!confirm(`Delete "${hit.node.name}"?`)) return;
  hit.list.splice(hit.list.indexOf(hit.node), 1);
  if (id === currentFileId) {
    const first = flattenFiles()[0];
    currentFileId = first ? findFileIdByPath(first.path) : null;
    if (currentFileId) openFile(currentFileId, true);
    else editorApi.setValue("");
  }
  renderTree(); markDirty();
}

// ---------- Open / save files ----------
function saveCurrentToModel() {
  if (!currentFileId || !editorApi) return;
  const hit = findById(currentFileId);
  if (hit && hit.node.type === "file" && !isBinary(hit.node)) hit.node.content = editorApi.getValue();
}
function openFile(id, skipSave) {
  if (!skipSave) saveCurrentToModel();
  const hit = findById(id);
  if (!hit || hit.node.type !== "file") return;
  currentFileId = id;
  if (isBinary(hit.node)) {
    editorApi.setValue(`% "${hit.node.name}" is a binary asset (image/PDF).\n% It is kept in the project and used at compile time, but is not editable here.`);
  } else {
    editorApi.setValue(hit.node.content ?? "");
  }
  openPathEl.textContent = pathOf(id);
  renderTree();
}

// ---------- Dirty state + persistence ----------
let dirty = false;
function markDirty() { dirty = true; dirtyDot.textContent = "● unsaved"; }
function markClean() { dirty = false; dirtyDot.textContent = ""; }

async function persist() {
  saveCurrentToModel();
  const res = await fetch(`/api/projects/${PROJECT_ID}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: flattenFiles() }),
  });
  if (!res.ok) throw new Error("save failed");
  markClean();
}
async function saveProject() {
  const btn = $("save");
  try { btn.disabled = true; await persist(); setStatus("ok", "Saved ✓"); }
  catch { setStatus("err", "Save failed"); }
  finally { btn.disabled = false; }
}

// ---------- Editor (CodeMirror, textarea fallback) ----------
async function initEditor() {
  try { CM = await loadCodeMirror(); buildCodeMirror(); }
  catch (err) { console.warn("CodeMirror failed to load, using a plain editor.", err); buildTextareaFallback(); }
}
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
function buildCodeMirror() {
  const { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap } = CM.view;
  const { EditorState } = CM.state;
  const { history, historyKeymap, defaultKeymap, indentWithTab } = CM.commands;
  const { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } = CM.language;
  const { stex } = CM.legacy;
  const { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } = CM.autocomplete;
  const { highlightSelectionMatches, searchKeymap } = CM.search;
  let latexExt = [];
  try {
    const t = CM.tags, HS = CM.language.HighlightStyle;
    const latexHighlight = HS.define([
      { tag: t.tagName, color: "var(--ed-tok-command)", fontWeight: "600" },     // \\commands -> green
      { tag: t.keyword, color: "var(--ed-tok-command)", fontWeight: "600" },
      { tag: t.controlKeyword, color: "var(--ed-tok-command)", fontWeight: "600" },
      { tag: t.comment, color: "var(--ed-tok-comment)", fontStyle: "italic" },
      { tag: t.string, color: "var(--ed-tok-string)" },
      { tag: t.number, color: "var(--ed-tok-number)" },
      { tag: t.atom, color: "var(--ed-tok-math)" },                           // math
      { tag: [t.bracket, t.brace], color: "var(--ed-tok-bracket)" },
      { tag: t.meta, color: "var(--ed-tok-meta)" },
    ]);
    latexExt = [syntaxHighlighting(latexHighlight)];
  } catch (e) { console.warn("custom LaTeX highlight unavailable:", e); }
  const extensions = [
    lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
    history(), bracketMatching(), closeBrackets(), indentOnInput(), highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ...latexExt,
    StreamLanguage.define(stex), EditorView.lineWrapping,
    autocompletion({ override: [latexCompletions], activateOnTyping: true, defaultKeymap: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => { if (u.docChanged) { markDirty(); saveCurrentToModel(); } }),
  ];
  const startNode = findById(currentFileId)?.node;
  const startDoc = startNode && !isBinary(startNode) ? (startNode.content ?? "") : "";
  const view = new EditorView({ state: EditorState.create({ doc: startDoc, extensions }), parent: editorHost });
  editorApi = {
    getValue: () => view.state.doc.toString(),
    setValue: (s) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } }),
    focus: () => view.focus(),
  };
  openPathEl.textContent = pathOf(currentFileId) || "";
}
function buildTextareaFallback() {
  const note = document.createElement("div");
  note.textContent = "\u26a0 Editor library could not load — plain text mode (no highlighting or autocomplete). Check the network and reload.";
  note.style.cssText = "background:#fff3cd;color:#5a3a06;font:12px 'Inter',sans-serif;padding:6px 10px;border-bottom:1px solid #f0dca0;";
  editorHost.appendChild(note);
  const ta = document.createElement("textarea");
  ta.style.cssText = "width:100%;height:calc(100% - 31px);border:0;padding:12px;font-family:monospace;font-size:13.5px;resize:none;outline:none;";
  const startNode = findById(currentFileId)?.node;
  ta.value = startNode && !isBinary(startNode) ? (startNode.content ?? "") : "";
  ta.addEventListener("input", () => { markDirty(); saveCurrentToModel(); });
  editorHost.appendChild(ta);
  editorApi = { getValue: () => ta.value, setValue: (s) => { ta.value = s; }, focus: () => ta.focus() };
}

// ---------- Compile ----------
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
async function compile() {
  saveCurrentToModel();
  setStatus("busy", "Compiling…");
  try { await persist(); } catch { /* keep compiling even if save fails */ }
  const files = flattenFiles();
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

// ---------- Load + wire up ----------
async function loadProject() {
  if (!PROJECT_ID) { location.replace("index.html"); return false; }
  let data;
  try { data = await (await fetch(`/api/projects/${PROJECT_ID}`)).json(); }
  catch { document.body.innerHTML = errorScreen("Could not reach the server."); return false; }
  if (!data.ok) { document.body.innerHTML = errorScreen("Project not found."); return false; }
  project = data.project;
  return true;
}
function errorScreen(msg) {
  return `<div style="height:100%;display:grid;place-items:center;font-family:'Inter',sans-serif;color:#243240;text-align:center">
    <div><h2 style="margin:0 0 8px">${msg}</h2><p><a href="index.html">← Back to projects</a></p></div></div>`;
}

async function init() {
  // Don't load/edit/save until the user is identified (auth.js sets the session cookie).
  if (window.Alumere) await window.Alumere.ready;
  const ok = await loadProject();
  if (!ok) return;
  $("projName").textContent = project.name || "Project";
  document.title = (project.name || "Project") + " — Alumère";
  initEditorTheme();
  const files = flattenFiles();
  currentFileId = findFileIdByPath(detectMain(files)) || (files[0] ? findFileIdByPath(files[0].path) : null);
  renderTree(); applyLayout(); setupSplitters();
  $("recompile").addEventListener("click", compile);
  $("save").addEventListener("click", saveProject);
  $("newFile").addEventListener("click", newFile);
  $("newFolder").addEventListener("click", newFolder);
  $("download").addEventListener("click", () => {
    if (!pdfBlob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(pdfBlob); a.download = slug(project.name) + ".pdf"; a.click();
  });
  $("tabPdf").addEventListener("click", () => showTab("pdf"));
  $("tabLog").addEventListener("click", () => showTab("log"));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); compile(); }
  });
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  await initEditor();
  if (currentFileId) openFile(currentFileId, true);
  compile();
}
init();
