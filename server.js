// Alumère — backend for the draft application.
//
// Responsibilities:
//   1. Serve the static front-end (public/): an archive page + the editor.
//   2. A filesystem-backed project store (shared library — no accounts yet).
//      Each project = a folder under PROJECTS_DIR:  <id>/meta.json + <id>/files/.
//   3. POST /api/compile : run a real LaTeX compile (latexmk) and return PDF+log.
//
// Persistence is deliberately simple (files on disk) so a trusted small group can
// self-host on one VPS. Mount a Docker volume at PROJECTS_DIR to keep projects.

import express from "express";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, cp } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Where persistent projects live. Mount a Docker volume here to keep them.
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(__dirname, "data", "projects");
const SEED_DIR = path.join(__dirname, "seed");

// ---------- identity / session (magic-link auth, domain-restricted) ----------
// You sign in with your company email: we mail a single-use link; opening it sets a
// signed httpOnly cookie that remembers you for a year. No passwords. The display name
// is derived from the address (mario.rossi@ → "Mario Rossi"); the cookie machinery
// (sign/verify below) is unchanged from the earlier name-only phase.
const COOKIE_NAME = "alm_session";
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;       // 1 year
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";    // set to 1 when served over HTTPS

// ---------- magic-link auth config ----------
// Only addresses on this domain may sign in (e.g. "dominio.com"). Empty = allow any (DEV ONLY).
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
// Absolute base for the links we email (e.g. https://docs.dominio.com). Empty = derive from request.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const LOGIN_TOKEN_TTL_MS = (Number(process.env.LOGIN_TOKEN_TTL_MIN) || 15) * 60 * 1000;
// SMTP (e.g. privateemail). If SMTP_HOST is empty we log the link instead of mailing it (dev).
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
if (!ALLOWED_EMAIL_DOMAIN) console.warn("[alumere][auth] ALLOWED_EMAIL_DOMAIN non impostato: qualsiasi dominio è ammesso (solo per dev).");

// Persistent secret used to sign session cookies. Prefer SESSION_SECRET in prod;
// otherwise keep one on disk inside PROJECTS_DIR (the persisted volume) so sessions
// survive restarts. It's a dotfile and is never treated as a project.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(PROJECTS_DIR, ".session-secret");
  try { if (existsSync(f)) return readFileSync(f, "utf8").trim(); } catch {}
  const s = crypto.randomBytes(32).toString("hex");
  try { mkdirSync(PROJECTS_DIR, { recursive: true }); writeFileSync(f, s, "utf8"); } catch {}
  return s;
}
const SESSION_SECRET = resolveSessionSecret();

// Projects can carry base64 images / zips, so allow a generous body.
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Identify the caller from the signed session cookie (req.user is null if not signed in).
app.use((req, _res, next) => { req.user = verifySession(parseCookies(req)[COOKIE_NAME]); next(); });

const ENGINE_FLAG = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
const COMPILE_TIMEOUT_MS = 60_000;

// ---------- helpers ----------
function safeRelPath(p) {
  const norm = path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, "");
  if (path.isAbsolute(norm) || norm.startsWith("..")) return null;
  return norm;
}
const TEXT_RE = /\.(tex|bib|cls|sty|txt|md|markdown|csv|tsv|json|ya?ml|cfg|bbl|aux|toc)$/i;
const isText = (name) => TEXT_RE.test(name);
const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const projectDir = (id) => path.join(PROJECTS_DIR, id);
const filesDir = (id) => path.join(projectDir(id), "files");
const uid = () => "n-" + crypto.randomBytes(5).toString("hex");

async function readMeta(id) {
  try { return JSON.parse(await readFile(path.join(projectDir(id), "meta.json"), "utf8")); }
  catch { return null; }
}
async function writeMeta(id, meta) {
  await writeFile(path.join(projectDir(id), "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

// ---------- session helpers ----------
const SYSTEM_USER = { id: "system", name: "Alumère (system)" };
const briefUser = (u) => (u ? { id: u.id, name: u.name } : null);

// Derive a display name from an email. "nome.cognome@" → "Nome Cognome"; a role address
// with no dot ("admin@") → "AdminAccount". A capital inside a segment marks a word break
// (maria.delCarmen@ → "Maria Del Carmen"), so we keep the local-part's ORIGINAL case here
// (the id, instead, is the lowercased full email — a stable identity across devices).
const capWord = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
function displayNameFromEmail(email) {
  const local = String(email).split("@")[0];
  if (local.includes(".")) {
    return local.split(".")
      .flatMap((seg) => seg.split(/(?<=[a-z])(?=[A-Z])/))
      .filter(Boolean).map(capWord).join(" ");
  }
  return capWord(local) + "Account";
}
// Validate an email and gate it to the allowed domain. Returns { id, name } or null.
function userFromEmail(raw) {
  const email = String(raw || "").trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const id = email.toLowerCase();
  if (ALLOWED_EMAIL_DOMAIN && !id.endsWith("@" + ALLOWED_EMAIL_DOMAIN)) return null;
  return { id, name: displayNameFromEmail(email) };
}

// Pending magic-link tokens: single-use, short-lived, in memory. Unused tokens expire;
// a restart just drops them (the user requests a new link) — no security impact.
const pendingLogins = new Map();                            // token -> { user, exp }
function prunePending() {
  const now = Date.now();
  for (const [t, v] of pendingLogins) if (v.exp <= now) pendingLogins.delete(t);
}
// Rate limiting so /api/auth/request can't be turned into a mail cannon. We throttle
// per-EMAIL (stops bombing one inbox) with a generous per-IP backstop — an office behind
// NAT shares one public IP, so the per-IP cap must be loose. Only valid requests count.
const emailHits = new Map(), ipHits = new Map();            // key -> { n, since }
function rateHit(map, key, max, windowMs) {
  const now = Date.now();
  const h = map.get(key);
  if (!h || now - h.since > windowMs) { map.set(key, { n: 1, since: now }); return true; }
  if (h.n >= max) return false;
  h.n++; return true;
}
// Mail transport: real SMTP if SMTP_HOST is set, else a dev fallback that logs the link.
// nodemailer is imported lazily & guarded, so the server boots even if it isn't installed.
let _transport;                                            // undefined = untried, null = unavailable
async function mailTransport() {
  if (_transport !== undefined) return _transport;
  if (!SMTP_HOST) return (_transport = null);
  try {
    const nodemailer = (await import("nodemailer")).default;
    _transport = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  } catch (e) {
    console.warn(`[alumere][auth] nodemailer non disponibile (${e.message}); uso il fallback console`);
    _transport = null;
  }
  return _transport;
}
async function sendLoginLink(email, link) {
  const minutes = Math.round(LOGIN_TOKEN_TTL_MS / 60000);
  const t = await mailTransport();
  if (!t) {                                                // dev: no SMTP → print the link to the log
    console.log(`[alumere][auth] (SMTP off) login link per ${email}:\n  ${link}`);
    return;
  }
  await t.sendMail({
    from: SMTP_FROM, to: email,
    subject: "Accesso ad Alumère",
    text:
      `Apri questo link per accedere ad Alumère (scade tra ${minutes} minuti).\n` +
      `Aprilo dal dispositivo su cui vuoi entrare:\n\n${link}\n\n` +
      `Se non hai richiesto tu l'accesso, ignora pure questa mail.`,
  });
}
function signSession(user) {
  const payload = Buffer.from(JSON.stringify(user)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
}
function parseCookies(req) {
  const out = {}; const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Gate for mutating endpoints: never write to a project without a known author.
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Devi identificarti per modificare.", needLogin: true });
  next();
}

// Build the editor's nested tree model from a project's files/ directory.
async function buildTree(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ id: uid(), type: "folder", name: e.name, open: true, children: await buildTree(full) });
    } else {
      const node = { id: uid(), type: "file", name: e.name };
      if (isText(e.name)) node.content = await readFile(full, "utf8");
      else { node.content = (await readFile(full)).toString("base64"); node.encoding = "base64"; }
      out.push(node);
    }
  }
  return out;
}

async function countFiles(dir) {
  let n = 0, entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

// Replace a project's files/ with the supplied flat list (handles renames/deletes).
async function writeFiles(id, files) {
  const root = filesDir(id);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const f of files || []) {
    const rel = safeRelPath(f.path || "");
    if (!rel) continue;
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    if (f.encoding === "base64") await writeFile(dest, Buffer.from(f.content || "", "base64"));
    else await writeFile(dest, f.content ?? "", "utf8");
  }
}

// Flat [{ path, content, encoding? }] walk of a project's files/ (text as utf8,
// binary as base64) — the inverse of writeFiles. Used to seed the collab Y.Doc.
async function readFilesFlat(dir, prefix = "") {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await readFilesFlat(full, rel));
    else if (isText(e.name)) out.push({ path: rel, content: await readFile(full, "utf8") });
    else out.push({ path: rel, content: (await readFile(full)).toString("base64"), encoding: "base64" });
  }
  return out;
}

// ---------- session endpoints ----------
app.get("/api/session", (req, res) => res.json({ ok: true, user: req.user || null }));

// Login, step 1: submit a company email → we mail a single-use magic link.
app.post("/api/auth/request", async (req, res) => {
  const user = userFromEmail((req.body || {}).email);
  if (!user) {
    const d = ALLOWED_EMAIL_DOMAIN ? `@${ALLOWED_EMAIL_DOMAIN}` : "aziendale";
    return res.status(403).json({ ok: false, error: `Serve una mail ${d} valida.` });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (!rateHit(emailHits, user.id, 5, 10 * 60 * 1000) || !rateHit(ipHits, ip, 60, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "Troppe richieste, riprova tra qualche minuto." });
  }
  prunePending();
  const token = crypto.randomBytes(32).toString("base64url");
  pendingLogins.set(token, { user, exp: Date.now() + LOGIN_TOKEN_TTL_MS });
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${base}/api/auth/verify?token=${token}`;
  try {
    await sendLoginLink(user.id, link);
  } catch (e) {
    pendingLogins.delete(token);
    console.error(`[alumere][auth] invio mail fallito: ${e.message}`);
    return res.status(502).json({ ok: false, error: "Invio della mail non riuscito, riprova." });
  }
  res.json({ ok: true, email: user.id });                  // generic — the client shows "controlla la posta"
});

// Login, step 2: the emailed link lands here → consume the token, set the session, enter.
app.get("/api/auth/verify", (req, res) => {
  prunePending();
  const token = String(req.query.token || "");
  const pend = token ? pendingLogins.get(token) : null;
  if (!pend || pend.exp <= Date.now()) {
    return res.status(400).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Link non valido</title>` +
      `<div style="font-family:system-ui;max-width:28rem;margin:4rem auto;text-align:center">` +
      `<h2>Link non valido o scaduto</h2><p>Richiedi un nuovo accesso.</p>` +
      `<p><a href="/">Torna ad Alumère</a></p></div>`);
  }
  pendingLogins.delete(token);                             // single-use
  res.cookie(COOKIE_NAME, signSession(pend.user), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_MS, secure: COOKIE_SECURE,
  });
  res.redirect("/");
});

app.post("/api/session/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// ---------- project endpoints ----------
app.get("/api/projects", requireUser, async (_req, res) => {
  try {
    await mkdir(PROJECTS_DIR, { recursive: true });
    const dirs = (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
    const list = [];
    for (const d of dirs) {
      const meta = await readMeta(d.name);
      if (meta) list.push({ ...meta, fileCount: await countFiles(filesDir(d.name)) });
    }
    list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    res.json({ ok: true, projects: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/projects/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  try {
    const root = await buildTree(filesDir(id));
    res.json({ ok: true, project: { id, name: meta.name, root } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put("/api/projects/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  const { files, name } = req.body || {};
  try {
    await writeFiles(id, files);
    meta.updatedAt = new Date().toISOString();
    meta.updatedBy = briefUser(req.user);
    if (name) meta.name = name;
    await writeMeta(id, meta);
    res.json({ ok: true, updatedAt: meta.updatedAt });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete("/api/projects/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try { await rm(projectDir(id), { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Upload a .zip (base64 in JSON) -> new project.
app.post("/api/projects/upload", requireUser, async (req, res) => {
  const { name, zip } = req.body || {};
  if (!zip) return res.status(400).json({ ok: false, error: "no zip data" });
  const id = crypto.randomUUID();
  try {
    const entries = new AdmZip(Buffer.from(zip, "base64")).getEntries();
    // Strip a single common top-level folder (typical of exported zips).
    const tops = new Set();
    for (const en of entries) {
      const p = en.entryName.replace(/\\/g, "/");
      if (!p || p.startsWith("__MACOSX")) continue;
      tops.add(p.split("/")[0]);
    }
    const strip = tops.size === 1 ? [...tops][0] + "/" : "";

    const root = filesDir(id);
    await mkdir(root, { recursive: true });
    let wrote = 0;
    for (const en of entries) {
      let p = en.entryName.replace(/\\/g, "/");
      if (en.isDirectory || p.startsWith("__MACOSX") || p.endsWith(".DS_Store")) continue;
      if (strip && p.startsWith(strip)) p = p.slice(strip.length);
      const rel = safeRelPath(p);
      if (!rel) continue;
      const dest = path.join(root, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, en.getData());
      wrote++;
    }
    if (!wrote) { await rm(projectDir(id), { recursive: true, force: true }); return res.status(400).json({ ok: false, error: "empty or invalid zip" }); }

    const now = new Date().toISOString();
    const meta = { id, name: (name || "Untitled project").replace(/\.zip$/i, "").slice(0, 120), createdAt: now, updatedAt: now, createdBy: briefUser(req.user), updatedBy: briefUser(req.user) };
    await writeMeta(id, meta);
    res.json({ ok: true, id, name: meta.name });
  } catch (e) {
    await rm(projectDir(id), { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- compile (compiles the files sent inline; stateless temp dir) ----------
function runLatexmk(cwd, mainFile, engineFlag) {
  return new Promise((resolve) => {
    const args = [engineFlag, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", mainFile];
    const child = spawn("latexmk", args, { cwd });
    let log = "";
    const onData = (d) => (log += d.toString());
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const killer = setTimeout(() => { log += "\n[alumere] Compilation timed out and was stopped.\n"; child.kill("SIGKILL"); }, COMPILE_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(killer); resolve({ code: -1, log: `[alumere] Failed to launch latexmk: ${err.message}\n` }); });
    child.on("close", (code) => { clearTimeout(killer); resolve({ code, log }); });
  });
}

app.post("/api/compile", requireUser, async (req, res) => {
  const { files, main = "main.tex", engine = "xelatex" } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ ok: false, log: "No files were sent to compile." });
  const engineFlag = ENGINE_FLAG[engine] || ENGINE_FLAG.xelatex;
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "alumere-"));
    for (const f of files) {
      const rel = safeRelPath(f.path || "");
      if (!rel) continue;
      const dest = path.join(dir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      if (f.encoding === "base64") await writeFile(dest, Buffer.from(f.content || "", "base64"));
      else await writeFile(dest, f.content ?? "", "utf8");
    }
    const mainRel = safeRelPath(main) || "main.tex";
    const { code, log } = await runLatexmk(dir, mainRel, engineFlag);
    const pdfPath = path.join(dir, mainRel.replace(/\.tex$/i, ".pdf"));
    if (existsSync(pdfPath)) {
      const pdf = await readFile(pdfPath);
      return res.json({ ok: true, log, pdf: pdf.toString("base64") });
    }
    return res.json({ ok: false, log: log || "No PDF was produced. Check the log for LaTeX errors.", code });
  } catch (err) {
    return res.status(500).json({ ok: false, log: `Server error: ${err.message}` });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, engines: Object.keys(ENGINE_FLAG) }));

// ---------- seed a sample project on first run ----------
async function seedSample() {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const dirs = (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
  if (dirs.length > 0 || !existsSync(SEED_DIR)) return;
  const id = crypto.randomUUID();
  await mkdir(filesDir(id), { recursive: true });
  await cp(SEED_DIR, filesDir(id), { recursive: true });
  const now = new Date().toISOString();
  await writeMeta(id, { id, name: "Sample paper", createdAt: now, updatedAt: now, createdBy: briefUser(SYSTEM_USER), updatedBy: briefUser(SYSTEM_USER) });
  console.log("[alumere] seeded sample project", id);
}

// ---------- real-time collaboration (M0 spike + M1 per-project docs) ----------
// A Hocuspocus CRDT server shares the SAME HTTP port: only WebSocket upgrades on
// COLLAB_PATH are routed to it — every normal HTTP request is untouched, so the
// compose file and the existing API don't change. It's loaded dynamically, so if
// the collab deps aren't installed the editor + compile app still boot (collab
// just stays off) instead of the whole process failing on a missing import.
//
// M1 — the room name IS the project id. A project's Y.Doc holds ydoc.getMap("files"):
// path -> Y.Text (text, live-editable) or { encoding:"base64", content } (binary,
// static). onLoadDocument seeds it from files/ on disk; onStoreDocument (debounced)
// materializes it back, so compile and the REST API keep working unchanged. Rooms
// with no matching project (e.g. the M0 spike "alumere-spike") have no meta, so they
// are skipped by both hooks and stay a pure in-memory relay. Socket auth is still
// deferred (same posture as the already-open GET reads) — that's a later gate.
const COLLAB_PATH = process.env.COLLAB_PATH || "/collab";
const COLLAB_FILES_KEY = "files";
const COLLAB_META_KEY = "meta";

async function attachCollab(httpServer) {
  let serverMod, WebSocketServer, Y;
  try {
    serverMod = await import("@hocuspocus/server");
    ({ WebSocketServer } = await import("ws"));
    Y = await import("yjs");
  } catch (e) {
    console.warn(`[alumere] real-time collab disabled (deps missing): ${e.message}`);
    return;
  }

  // First client on a project → fill the empty doc from files/ on disk. Non-project
  // rooms (no meta) are left untouched: the doc stays empty, a plain relay.
  async function onLoadDocument({ documentName, document }) {
    if (!validId(documentName)) return;
    if (!(await readMeta(documentName))) return;
    const filesMap = document.getMap(COLLAB_FILES_KEY);
    if (filesMap.size > 0) return;                          // already loaded/populated
    const files = await readFilesFlat(filesDir(documentName));
    document.transact(() => {
      for (const f of files) {
        if (f.encoding === "base64") {
          filesMap.set(f.path, { encoding: "base64", content: f.content });
        } else {
          const t = new Y.Text();
          filesMap.set(f.path, t);                          // integrate, then fill
          if (f.content) t.insert(0, f.content);
        }
      }
    });
    console.log(`[alumere] collab loaded "${documentName}" (${files.length} files)`);
  }

  // Debounced by Hocuspocus. The doc is the single source of truth, so we rewrite
  // the whole files/ set (this is what makes renames/deletes stick). Guard: refuse
  // to wipe a project down to zero files from an empty doc (protects against a seed
  // hiccup) — deleting the last file via collab just won't persist, which is safe.
  async function onStoreDocument({ documentName, document }) {
    if (!validId(documentName)) return;
    const meta = await readMeta(documentName);
    if (!meta) return;
    const filesMap = document.getMap(COLLAB_FILES_KEY);
    const files = [];
    for (const [p, v] of filesMap.entries()) {
      if (v instanceof Y.Text) files.push({ path: p, content: v.toString() });
      else if (v && v.encoding === "base64") files.push({ path: p, content: v.content, encoding: "base64" });
    }
    if (!files.length) { console.warn(`[alumere] collab store skipped for "${documentName}" (doc empty)`); return; }
    await writeFiles(documentName, files);
    meta.updatedAt = new Date().toISOString();
    const ub = document.getMap(COLLAB_META_KEY).get("updatedBy");
    if (ub && ub.id && ub.name) meta.updatedBy = { id: String(ub.id), name: String(ub.name) };
    await writeMeta(documentName, meta);
    console.log(`[alumere] collab stored "${documentName}" (${files.length} files)`);
  }

  const config = { debounce: 2000, maxDebounce: 10000, onLoadDocument, onStoreDocument };
  // v2 exports the `Hocuspocus` class and a pre-made `Server` instance; use whichever
  // is present. Either accepts config and exposes handleConnection(ws, request).
  const hocuspocus = serverMod.Hocuspocus
    ? new serverMod.Hocuspocus(config)
    : serverMod.Server.configure(config);

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, request) => hocuspocus.handleConnection(ws, request));
  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "/";
    try { pathname = new URL(request.url, "http://localhost").pathname; } catch {}
    if (pathname !== COLLAB_PATH) { socket.destroy(); return; }
    // Gate: only signed-in users may open a collab socket (same signed cookie as the REST API).
    const user = verifySession(parseCookies(request)[COOKIE_NAME]);
    if (!user) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  console.log(`[alumere] real-time collab ready →  ws ${COLLAB_PATH}  (per-project persistence on)`);
}

const httpServer = app.listen(PORT, async () => {
  await seedSample().catch((e) => console.warn("[alumere] seed failed:", e.message));
  console.log(`Alumère draft running →  http://localhost:${PORT}`);
});
attachCollab(httpServer);
