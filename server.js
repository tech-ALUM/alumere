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
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, cp, rename } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// Behind a TLS-terminating reverse proxy (prod): trust the first hop so req.ip is the real
// client from X-Forwarded-For — the per-IP rate-limit backstop needs the true IP, not the
// proxy's. Opt-in via env (TRUST_PROXY=1) so direct/local runs are unaffected.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

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
if (!ALLOWED_EMAIL_DOMAIN) console.warn("[alumere][auth] ALLOWED_EMAIL_DOMAIN not set: any domain is allowed (dev only).");

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

// Pending magic-link tokens: single-use and short-lived. Kept on disk inside PROJECTS_DIR
// (the persisted volume) so a restart/redeploy doesn't silently invalidate the links already
// sitting in people's inboxes. Same trust model as .session-secret, which already lives there;
// entries are tiny, expire on their own, and are dropped the instant they're used. It's a
// dotfile, and projects are only ever read from directories, so it's never seen as a project.
const PENDING_FILE = path.join(PROJECTS_DIR, ".pending-logins.json");
const pendingLogins = new Map();                            // token -> { user, exp }
function persistPending() {
  try {
    mkdirSync(PROJECTS_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(pendingLogins)), "utf8");
  } catch (e) {
    console.warn(`[alumere][auth] pending tokens not persisted (${e.message}); kept in memory`);
  }
}
function prunePending() {
  const now = Date.now();
  let changed = false;
  for (const [t, v] of pendingLogins) if (v.exp <= now) { pendingLogins.delete(t); changed = true; }
  if (changed) persistPending();
}
try {                                                       // reload what's still valid after a restart
  for (const [t, v] of Object.entries(JSON.parse(readFileSync(PENDING_FILE, "utf8")))) {
    if (v && v.user && v.exp > Date.now()) pendingLogins.set(t, v);
  }
} catch {}
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
    console.warn(`[alumere][auth] nodemailer unavailable (${e.message}); using console fallback`);
    _transport = null;
  }
  return _transport;
}
// Shared by the login email and the two auth pages below: same face as the app (styles.css).
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const AUTH_FONT = "Inter,'Helvetica Neue',-apple-system,'Segoe UI',Arial,sans-serif";

async function sendLoginLink(email, link) {
  const minutes = Math.round(LOGIN_TOKEN_TTL_MS / 60000);
  const t = await mailTransport();
  if (!t) {                                                // dev: no SMTP → print the link to the log
    console.log(`[alumere][auth] (SMTP off) login link for ${email}:\n  ${link}`);
    return;
  }
  const safe = escapeHtml(link);
  await t.sendMail({
    from: SMTP_FROM, to: email,
    subject: "Sign in to Alumère",
    // Both parts on purpose. The link is ~90 chars, and plain-text mail gets wrapped around 76:
    // some clients then linkify only up to the wrap, so the token arrives TRUNCATED and the user
    // gets "link non valido". In the HTML part the URL lives in the href attribute, where no
    // amount of visual wrapping can break it; the angle brackets do the same job for the text
    // fallback (RFC 3986's delimiter convention), plus a copy-pasteable copy for the stubborn ones.
    text:
      `Open this link to sign in to Alumère (expires in ${minutes} minutes).\n` +
      `Open it on the device you want to sign in from:\n\n<${link}>\n\n` +
      `If you didn't request this, you can ignore this email.`,
    html:
      `<div style="font-family:${AUTH_FONT};font-size:15px;line-height:1.5;color:#243240">` +
      `<p>Open this link to sign in to Alumère (expires in ${minutes} minutes).<br>` +
      `Open it on the device you want to sign in from.</p>` +
      `<p><a href="${safe}" style="display:inline-block;padding:.6rem 1.4rem;background:#7eb0d5;` +
      `color:#103049;font-weight:600;text-decoration:none;border-radius:8px">Sign in to Alumère</a></p>` +
      `<p style="color:#6b7785;font-size:13px">If the button doesn't work, copy and paste this address:<br>` +
      `<span style="word-break:break-all">${safe}</span></p>` +
      `<p style="color:#6b7785;font-size:13px">If you didn't request this, you can ignore this email.</p>` +
      `</div>`,
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
  if (!req.user) return res.status(401).json({ ok: false, error: "You must sign in to make changes.", needLogin: true });
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

// ---------- history (M2): content-addressed snapshots per save ----------
// A project's live content is a Yjs doc materialized to files/ on each debounced store
// (see attachCollab). History rides that SAME hook: every store also records a VERSION —
// the whole file tree captured as content-addressed blobs (sha256), so re-saving an
// unchanged file costs nothing and a typical save adds just one small blob. Storage lives
// OUTSIDE files/ (writeFiles does rm -rf on files/), under history/:
//   history/objects/<sha>   raw file bytes, deduped by content hash
//   history/index.json      { versions: [ {id, at, by, label, kind, treeHash, files:[{path,sha,encoding?}]} ] }
// The timeline stays readable by COALESCING: a continuous editing burst by one person
// folds into a single evolving version (we amend the last one) until it settles
// (HISTORY_COALESCE_MS) or someone else edits — like Overleaf's automatic history. A
// restore or explicit checkpoint FORCES a fresh, non-amendable version (via a nonce the
// client bumps in the shared meta map), so the state you restore FROM is never eaten by an amend.
const HISTORY_COALESCE_MS = (Number(process.env.HISTORY_COALESCE_MIN) || 5) * 60 * 1000;
const HEX64_RE = /^[0-9a-f]{64}$/;
const historyDir = (id) => path.join(projectDir(id), "history");
const objectsDir = (id) => path.join(historyDir(id), "objects");
const objectPath = (id, sha) => path.join(objectsDir(id), sha);
const historyIndexPath = (id) => path.join(historyDir(id), "index.json");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const newVid = () => "v-" + crypto.randomBytes(6).toString("hex");

// Serialize read-modify-write of a project's history index: a store hook and a REST label
// edit could otherwise interleave. One promise chain per project id.
const historyLocks = new Map();
function withHistoryLock(id, fn) {
  const prev = historyLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);                    // run fn regardless of the prior outcome
  historyLocks.set(id, next.then(() => {}, () => {}));
  return next;
}

async function readHistoryIndex(id) {
  try { return JSON.parse(await readFile(historyIndexPath(id), "utf8")); }
  catch { return { versions: [] }; }
}
async function writeHistoryIndex(id, index) {
  await mkdir(historyDir(id), { recursive: true });
  const tmp = historyIndexPath(id) + ".tmp-" + crypto.randomBytes(4).toString("hex");
  await writeFile(tmp, JSON.stringify(index), "utf8");
  await rename(tmp, historyIndexPath(id));           // atomic swap: readers never see a half-written index
}

// Raw bytes of a flat file entry (text is utf8, binary is base64-decoded).
const bytesOf = (f) => f.encoding === "base64"
  ? Buffer.from(f.content || "", "base64")
  : Buffer.from(f.content ?? "", "utf8");

// Store a blob unless we already have it; return its sha. Atomic (temp + rename) so a crash
// mid-write can't leave a corrupt object sitting at the content-addressed name.
async function putBlob(id, buf) {
  const sha = sha256(buf);
  const dest = objectPath(id, sha);
  if (existsSync(dest)) return sha;
  await mkdir(objectsDir(id), { recursive: true });
  const tmp = dest + ".tmp-" + crypto.randomBytes(4).toString("hex");
  await writeFile(tmp, buf);
  try { await rename(tmp, dest); }
  catch (e) { if (!existsSync(dest)) throw e; await rm(tmp, { force: true }).catch(() => {}); }
  return sha;
}
async function getBlob(id, sha) {
  if (!HEX64_RE.test(sha || "")) return null;
  try { return await readFile(objectPath(id, sha)); } catch { return null; }
}

// Snapshot a flat file list into blobs → a path-sorted [{path, sha, encoding?}] tree.
async function treeFromFiles(id, files) {
  const tree = [];
  for (const f of files || []) {
    const rel = safeRelPath(f.path || "");
    if (!rel) continue;
    const sha = await putBlob(id, bytesOf(f));
    tree.push(f.encoding === "base64" ? { path: rel, sha, encoding: "base64" } : { path: rel, sha });
  }
  tree.sort((a, b) => a.path.localeCompare(b.path));
  return tree;
}
const treeHash = (tree) => sha256(Buffer.from(tree.map((f) => `${f.path}\0${f.sha}\0${f.encoding || ""}`).join("\n"), "utf8"));

// Delete blobs an amend just orphaned (now referenced by no surviving version).
async function pruneOrphans(id, index, candidateShas) {
  const kept = new Set();
  for (const v of index.versions) for (const f of v.files || []) kept.add(f.sha);
  for (const sha of new Set(candidateShas)) if (!kept.has(sha)) await rm(objectPath(id, sha), { force: true }).catch(() => {});
}

// Record one version from the current file tree. Coalesces same-author bursts by amending
// the last version; forceNew (restore / checkpoint / first-seed) always cuts a fresh,
// non-amendable one. Returns the version id when it actually recorded a change (new or
// amend), or null when nothing changed since the last version (so the caller can tell a
// substantive save from a content-less one).
async function recordVersion(id, files, by, { kind = "auto", label = null, forceNew = false } = {}) {
  return withHistoryLock(id, async () => {
    const tree = await treeFromFiles(id, files);
    if (!tree.length) return null;                   // never snapshot an empty tree
    const th = treeHash(tree);
    const index = await readHistoryIndex(id);
    const last = index.versions[index.versions.length - 1];
    if (last && last.treeHash === th && !forceNew) return null;   // genuinely unchanged → no version, and no "modified" bump upstream
    const now = new Date().toISOString();
    const amendable = !forceNew && kind === "auto" && last && last.kind === "auto" && !last.label
      && last.by && by && last.by.id === by.id
      && (Date.now() - Date.parse(last.at) < HISTORY_COALESCE_MS);
    if (amendable) {
      const prevShas = (last.files || []).map((f) => f.sha);
      last.at = now; last.treeHash = th; last.files = tree;
      await writeHistoryIndex(id, index);
      await pruneOrphans(id, index, prevShas);
      return last.id;
    }
    const v = { id: newVid(), at: now, by: by || null, label, kind, treeHash: th, files: tree };
    index.versions.push(v);
    await writeHistoryIndex(id, index);
    return v.id;
  });
}

// The first time a project is opened, capture its on-disk starting point as a baseline
// version (kind "initial" → never coalesced away by a same-author first edit).
async function ensureBaseline(id, files, by) {
  const index = await readHistoryIndex(id);
  if (index.versions.length) return;
  await recordVersion(id, files, by, { kind: "initial", forceNew: true });
}

// How many paths changed between a version and its predecessor (added / modified / removed).
function countChanged(v, prev) {
  const before = new Map((prev?.files || []).map((f) => [f.path, f.sha]));
  const after = new Map((v.files || []).map((f) => [f.path, f.sha]));
  let n = 0;
  for (const [p, s] of after) if (before.get(p) !== s) n++;
  for (const p of before.keys()) if (!after.has(p)) n++;
  return n;
}

// ---------- history retention + blob GC ----------
// Retention: old *auto* versions expire after HISTORY_RETENTION_DAYS (0 = keep forever).
// Milestones survive regardless of age — anything labeled or of a deliberate kind
// (initial / checkpoint / restore) — and so do the newest HISTORY_RETENTION_KEEP versions,
// so an untouched project never loses its whole recent timeline to the calendar.
// GC: a periodic sweep applies retention, then deletes every object no surviving version
// references (retention fallout, amend leftovers after a crash) plus stale temp files.
// It runs under the same per-project lock as recordVersion, so a store can't interleave:
// while we hold the lock, any blob on disk but absent from the index is genuinely garbage.
const HISTORY_RETENTION_DAYS = Math.max(0, Number(process.env.HISTORY_RETENTION_DAYS ?? 90) || 0);
const HISTORY_RETENTION_KEEP = Math.max(0, Number(process.env.HISTORY_RETENTION_KEEP ?? 10) || 0);
const HISTORY_GC_INTERVAL_MS = (Number(process.env.HISTORY_GC_INTERVAL_H) || 6) * 60 * 60 * 1000;

// Drop expired auto versions from the index (in place). Returns how many were removed.
function pruneExpiredVersions(index) {
  if (!HISTORY_RETENTION_DAYS) return 0;
  const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const total = index.versions.length;
  const kept = index.versions.filter((v, i) =>
    v.kind !== "auto" || v.label
    || total - i <= HISTORY_RETENTION_KEEP
    || !(Date.parse(v.at) < cutoff));                // NaN-safe: an unparsable date is kept
  const removed = total - kept.length;
  if (removed) index.versions = kept;
  return removed;
}

// One project's sweep: retention, then delete unreferenced objects and stray temp files.
async function gcProjectHistory(id) {
  return withHistoryLock(id, async () => {
    const index = await readHistoryIndex(id);
    const removed = pruneExpiredVersions(index);
    if (removed) await writeHistoryIndex(id, index);
    const referenced = new Set();
    for (const v of index.versions) for (const f of v.files || []) referenced.add(f.sha);
    let dropped = 0;
    let names = [];
    try { names = await readdir(objectsDir(id)); } catch { return { removed, dropped }; }
    for (const name of names) {
      if (HEX64_RE.test(name) ? referenced.has(name) : !name.includes(".tmp-")) continue;
      await rm(objectPath(id, name), { force: true }).catch(() => {});
      dropped++;
    }
    return { removed, dropped };
  });
}

async function historyGcSweep() {
  let dirs = [];
  try { dirs = (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()); }
  catch { return; }
  let versions = 0, blobs = 0;
  for (const d of dirs) {
    if (!validId(d.name)) continue;
    try {
      const r = await gcProjectHistory(d.name);
      versions += r.removed; blobs += r.dropped;
    } catch (e) { console.warn(`[alumere] history gc failed for "${d.name}": ${e.message}`); }
  }
  if (versions || blobs) console.log(`[alumere] history gc: pruned ${versions} versions, ${blobs} orphan blobs`);
}

// ---------- users roster (D2: populated at login) ----------
// PROJECTS_DIR/users.json ([{ id, name, lastLoginAt }]) — everyone who has ever signed in.
// It feeds the @mention autocomplete in comments (and is the natural base for per-person
// ACLs later). Upserted on each confirmed login, so it needs no migration or backfill.
const USERS_FILE = path.join(PROJECTS_DIR, "users.json");
let usersChain = Promise.resolve();                                 // serialize users.json read-modify-write
const withUsersLock = (fn) => { const r = usersChain.then(fn, fn); usersChain = r.catch(() => {}); return r; };
async function readUsers() {
  try { const j = JSON.parse(await readFile(USERS_FILE, "utf8")); return Array.isArray(j.users) ? j.users : []; }
  catch { return []; }
}
async function recordLogin(user) {
  await withUsersLock(async () => {
    const users = await readUsers();
    const u = users.find((x) => x.id === user.id);
    if (u) { u.name = user.name; u.lastLoginAt = new Date().toISOString(); }
    else users.push({ id: user.id, name: user.name, lastLoginAt: new Date().toISOString() });
    await mkdir(PROJECTS_DIR, { recursive: true });
    await writeFile(USERS_FILE, JSON.stringify({ users }, null, 2), "utf8");
  });
}

// ---------- session endpoints ----------
app.get("/api/session", (req, res) => res.json({ ok: true, user: req.user || null }));

// Login, step 1: submit a company email → we mail a single-use magic link.
app.post("/api/auth/request", async (req, res) => {
  const user = userFromEmail((req.body || {}).email);
  if (!user) {
    const d = ALLOWED_EMAIL_DOMAIN ? `@${ALLOWED_EMAIL_DOMAIN}` : "aziendale";
    return res.status(403).json({ ok: false, error: `Enter a valid ${d} email.` });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (!rateHit(emailHits, user.id, 5, 10 * 60 * 1000) || !rateHit(ipHits, ip, 60, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "Too many requests, try again in a few minutes." });
  }
  prunePending();
  const token = crypto.randomBytes(32).toString("base64url");
  pendingLogins.set(token, { user, exp: Date.now() + LOGIN_TOKEN_TTL_MS });
  persistPending();
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${base}/api/auth/verify?token=${token}`;
  try {
    await sendLoginLink(user.id, link);
  } catch (e) {
    pendingLogins.delete(token);
    persistPending();
    console.error(`[alumere][auth] invio mail fallito: ${e.message}`);
    return res.status(502).json({ ok: false, error: "Couldn't send the email, try again." });
  }
  res.json({ ok: true, email: user.id });                  // generic — the client shows "controlla la posta"
});

// Chrome shared by the two little auth pages below. These are served straight from here
// (no public/styles.css) so they keep working even if the static assets don't, hence the
// inline styles — the values mirror styles.css (--panel-2 / --panel / --ink / --muted /
// --accent) so the pages still look like Alumère. Background and color-scheme are declared
// explicitly on purpose: with no background a dark-mode browser darkens the default canvas
// and this dark-on-light text turns unreadable.
const authPage = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="light">` +
  `<meta name="robots" content="noindex">` +
  `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
  `background:#f5f7fa;color:#243240;font-family:${AUTH_FONT};line-height:1.5">` +
  `<main style="max-width:26rem;margin:1.5rem;padding:2rem 2.25rem;text-align:center;` +
  `background:#fff;border:1px solid #e4e8ee;border-radius:12px">${body}</main>`;
const invalidLinkPage = () => authPage("Invalid link",
  `<h2 style="margin:0 0 .5rem;font-size:1.3rem">Invalid or expired link</h2>` +
  `<p style="margin:0 0 1.25rem;color:#6b7785">Request a new sign-in link.</p>` +
  `<p style="margin:0"><a href="/" style="color:#5f9bc9">Back to Alumère</a></p>`);

// Login, step 2a: the emailed link lands HERE — and deliberately does NOT consume the token.
// Anything in the mail's path may fetch the URL before the human does (corporate link scanners,
// antivirus, proxies, link-preview bots); with a single-use token, a bot's GET burns it and the
// real person then hits "link non valido". That's exactly what office PCs were seeing. So the GET
// only renders a confirm page, and the token is spent by the POST below, behind a real click.
app.get("/api/auth/verify", (req, res) => {
  prunePending();
  const token = String(req.query.token || "");
  const pend = token ? pendingLogins.get(token) : null;
  if (!pend || pend.exp <= Date.now()) return res.status(400).type("html").send(invalidLinkPage());
  // Note: no JS auto-submit here on purpose — a scanner that executes scripts would burn the
  // token again, putting us right back where we started. It has to be a human click.
  return res.type("html").send(authPage("Confirm sign-in",
    `<h2 style="margin:0 0 .5rem;font-size:1.3rem">Sign in to Alumère</h2>` +
    `<p style="margin:0 0 1.5rem">You're about to sign in as <strong>${escapeHtml(pend.user.name)}</strong><br>` +
    `<span style="color:#6b7785;font-size:.9em">${escapeHtml(pend.user.id)}</span></p>` +
    `<form method="post" action="/api/auth/verify?token=${encodeURIComponent(token)}">` +
    `<button type="submit" style="font:inherit;font-weight:600;padding:.6rem 1.4rem;` +
    `background:#7eb0d5;color:#103049;border:1px solid #7eb0d5;border-radius:8px;cursor:pointer">` +
    `Confirm sign-in</button></form>`));
});

// Login, step 2b: the confirm button lands here → consume the token, set the session, enter.
// The token rides in the query string (the form carries no fields, and only express.json() is
// mounted); Caddy already redacts `token` from the access logs.
app.post("/api/auth/verify", (req, res) => {
  prunePending();
  const token = String(req.query.token || "");
  const pend = token ? pendingLogins.get(token) : null;
  if (!pend || pend.exp <= Date.now()) return res.status(400).type("html").send(invalidLinkPage());
  pendingLogins.delete(token);                             // single-use
  persistPending();
  recordLogin(pend.user).catch((e) => console.warn(`[alumere][auth] users.json update failed: ${e.message}`));
  res.cookie(COOKIE_NAME, signSession(pend.user), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_MS, secure: COOKIE_SECURE,
  });
  res.redirect("/");
});

app.post("/api/session/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// The roster for @mentions: everyone who has ever signed in (see recordLogin).
app.get("/api/users", requireUser, async (_req, res) => {
  try {
    const users = (await readUsers()).map((u) => ({ id: u.id, name: u.name }));
    users.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, users });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

// Rename a project (display name only). The id/folder stays immutable — only the
// label changes. Dedicated endpoint on purpose: PUT /api/projects/:id rewrites files/
// (rm -rf), so a name-only PUT would wipe the project. Doesn't bump updatedAt: renaming
// isn't a content change (same posture as archive/tags).
app.post("/api/projects/:id/rename", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  const name = String((req.body || {}).name || "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ ok: false, error: "empty name" });
  try {
    meta.name = name;
    await writeMeta(id, meta);
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete("/api/projects/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  try { await rm(projectDir(id), { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Create a blank project from a minimal template — the "start from zero" path
// (until now the only way in was uploading a .zip). The title carries the project
// name, escaped for LaTeX so a "&" or "%" in the name can't break the first compile.
const texEscape = (s) => String(s)
  .replace(/\\/g, "\\textbackslash{}")
  .replace(/([%&$#_{}])/g, "\\$1")
  .replace(/~/g, "\\textasciitilde{}")
  .replace(/\^/g, "\\textasciicircum{}");
app.post("/api/projects", requireUser, async (req, res) => {
  const name = String((req.body || {}).name || "").trim().slice(0, 120) || "New project";
  const id = crypto.randomUUID();
  try {
    const main = [
      "\\documentclass[11pt]{article}",
      "\\usepackage[utf8]{inputenc}",
      "\\usepackage[T1]{fontenc}",
      "\\usepackage{amsmath, amssymb}",
      "\\usepackage{graphicx}",
      "\\usepackage{hyperref}",
      "",
      `\\title{${texEscape(name)}}`,
      `\\author{${texEscape((req.user && req.user.name) || "")}}`,
      "\\date{\\today}",
      "",
      "\\begin{document}",
      "\\maketitle",
      "",
      "\\section{Introduction}",
      "Write here.",
      "",
      "\\end{document}",
      "",
    ].join("\n");
    await mkdir(filesDir(id), { recursive: true });
    await writeFile(path.join(filesDir(id), "main.tex"), main, "utf8");
    const now = new Date().toISOString();
    await writeMeta(id, { id, name, createdAt: now, updatedAt: now, createdBy: briefUser(req.user), updatedBy: briefUser(req.user) });
    res.json({ ok: true, id, name });
  } catch (e) {
    await rm(projectDir(id), { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ---------- download / export / archive ----------
// Download the project sources as a .zip (the files/ tree, as it sits on disk).
app.get("/api/projects/:id/download", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (!(await readMeta(id))) return res.status(404).json({ ok: false, error: "not found" });
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(filesDir(id));
    res.type("application/zip").send(zip.toBuffer());
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Compile the project from disk and stream the PDF. Note: files/ trails the live Yjs doc by
// the store debounce (a few seconds), so this is the last SAVED state — right for a library
// download, not the very last keystroke. The home has no editor context, so the main .tex is
// picked heuristically: main.tex → any file with \documentclass → shallowest .tex.
function pickMainTex(files) {
  const tex = files.filter((f) => /\.tex$/i.test(f.path) && f.encoding !== "base64");
  if (!tex.length) return null;
  const root = tex.find((f) => f.path.toLowerCase() === "main.tex");
  if (root) return root.path;
  const byDepth = (arr) => arr.slice().sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  const withClass = tex.filter((f) => /\\documentclass/.test(f.content || ""));
  return byDepth(withClass.length ? withClass : tex)[0].path;
}
app.get("/api/projects/:id/pdf", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (!(await readMeta(id))) return res.status(404).json({ ok: false, error: "not found" });
  let dir;
  try {
    const files = await readFilesFlat(filesDir(id));
    const mainRel = pickMainTex(files);
    if (!mainRel) return res.status(400).json({ ok: false, error: "No .tex file in the project." });
    dir = await mkdtemp(path.join(os.tmpdir(), "alumere-"));
    for (const f of files) {
      const rel = safeRelPath(f.path || "");
      if (!rel) continue;
      const dest = path.join(dir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      if (f.encoding === "base64") await writeFile(dest, Buffer.from(f.content || "", "base64"));
      else await writeFile(dest, f.content ?? "", "utf8");
    }
    const { code } = await runLatexmk(dir, mainRel, ENGINE_FLAG.xelatex);
    const pdfPath = path.join(dir, mainRel.replace(/\.tex$/i, ".pdf"));
    if (!existsSync(pdfPath)) return res.status(422).json({ ok: false, error: "Compilation failed — open the project in the editor for details.", code });
    res.type("application/pdf").send(await readFile(pdfPath));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// Archive / unarchive: a shared flag on meta (the whole library sees it). Doesn't touch
// updatedAt/By — archiving isn't a content edit. The list endpoint returns the flag; the
// client filters "Tutti i progetti" vs "Archiviati".
app.post("/api/projects/:id/archive", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  try {
    meta.archived = !!(req.body || {}).archived;
    await writeMeta(id, meta);
    res.json({ ok: true, archived: meta.archived });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- tags (shared, global) ----------
// A flat registry in PROJECTS_DIR/tags.json ([{ id, name, color }]); each project's meta
// carries tags:[id]. Tags are SHARED — the whole library sees the same set, no per-user
// state. Colours come from a fixed palette so the dots stay legible in light and dark.
const TAGS_FILE = path.join(PROJECTS_DIR, "tags.json");
const TAG_COLORS = ["#7eb0d5", "#bd7ebe", "#8bd450", "#ffb55a", "#fd7f6f", "#e879b9", "#5ec8c0", "#9a8cff"];
let tagsChain = Promise.resolve();                                  // serialize tags.json read-modify-write
const withTagsLock = (fn) => { const r = tagsChain.then(fn, fn); tagsChain = r.catch(() => {}); return r; };
async function readTags() {
  try { const j = JSON.parse(await readFile(TAGS_FILE, "utf8")); return Array.isArray(j.tags) ? j.tags : []; }
  catch { return []; }
}
async function writeTags(tags) {
  await mkdir(PROJECTS_DIR, { recursive: true });
  await writeFile(TAGS_FILE, JSON.stringify({ tags }, null, 2), "utf8");
}

app.get("/api/tags", requireUser, async (_req, res) => {
  try { res.json({ ok: true, tags: await readTags() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/tags", requireUser, async (req, res) => {
  const name = String((req.body || {}).name || "").trim().slice(0, 40);
  let color = String((req.body || {}).color || "");
  if (!name) return res.status(400).json({ ok: false, error: "Enter a tag name." });
  if (!TAG_COLORS.includes(color)) color = TAG_COLORS[0];
  try {
    const tag = await withTagsLock(async () => {
      const tags = await readTags();
      if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error("A tag with this name already exists.");
      const t = { id: crypto.randomUUID(), name, color };
      tags.push(t);
      await writeTags(tags);
      return t;
    });
    res.json({ ok: true, tag });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Delete a tag from the registry AND from every project that carries it (shared cleanup).
app.delete("/api/tags/:id", requireUser, async (req, res) => {
  const { id } = req.params;
  try {
    await withTagsLock(async () => writeTags((await readTags()).filter((t) => t.id !== id)));
    const dirs = (await readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
    for (const d of dirs) {
      if (!validId(d.name)) continue;
      const meta = await readMeta(d.name);
      if (meta && Array.isArray(meta.tags) && meta.tags.includes(id)) {
        meta.tags = meta.tags.filter((t) => t !== id);
        await writeMeta(d.name, meta);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Set a project's tags (whole array). Unknown ids are dropped. Not a content edit, so it
// leaves updatedAt/By alone (like archiving).
app.put("/api/projects/:id/tags", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  const wanted = Array.isArray((req.body || {}).tags) ? req.body.tags.map(String) : [];
  const known = new Set((await readTags()).map((t) => t.id));
  meta.tags = [...new Set(wanted.filter((t) => known.has(t)))];
  try { await writeMeta(id, meta); res.json({ ok: true, tags: meta.tags }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- history endpoints (M2) ----------
// Read-only browse of the timeline + per-file contents at a version, plus label edits.
// RESTORE is done CLIENT-side through the live Yjs doc (see app.js): the client pulls a
// version's tree from here and replaces the shared text in place, so every collaborator's
// editor follows — a server-side files/ write would just be overwritten by the live doc.

// Timeline, newest first. Lightweight: no file contents, just what the list needs to draw.
app.get("/api/projects/:id/history", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  if (!(await readMeta(id))) return res.status(404).json({ ok: false, error: "not found" });
  const index = await readHistoryIndex(id);
  const out = index.versions.map((v, i) => ({
    id: v.id, at: v.at, by: v.by || null, label: v.label || null, kind: v.kind || "auto",
    fileCount: (v.files || []).length, changed: countChanged(v, index.versions[i - 1]),
  }));
  out.reverse();
  res.json({ ok: true, versions: out });
});

// One version's metadata + its file list, each tagged by how it differs from the previous
// version (added / modified / removed / same) so the detail pane can show "what changed".
app.get("/api/projects/:id/history/:vid", requireUser, async (req, res) => {
  const { id, vid: versionId } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const index = await readHistoryIndex(id);
  const i = index.versions.findIndex((x) => x.id === versionId);
  if (i < 0) return res.status(404).json({ ok: false, error: "no such version" });
  const v = index.versions[i], prev = index.versions[i - 1];
  const before = new Map((prev?.files || []).map((f) => [f.path, f.sha]));
  const files = (v.files || []).map((f) => ({
    path: f.path, encoding: f.encoding || null,
    status: !before.has(f.path) ? "added" : (before.get(f.path) !== f.sha ? "modified" : "same"),
  }));
  for (const [p] of before) if (!(v.files || []).some((f) => f.path === p)) files.push({ path: p, encoding: null, status: "removed" });
  files.sort((a, b) => a.path.localeCompare(b.path));
  res.json({ ok: true, version: { id: v.id, at: v.at, by: v.by || null, label: v.label || null, kind: v.kind || "auto", files } });
});

// Content of one file AT a version (text as utf8, binary as base64). `path` must be one the
// version actually holds — we resolve it to a sha and read the blob, so no user-supplied
// path ever touches the filesystem. `prev=1` reads the same path in the PREVIOUS version
// (empty if it wasn't there yet) — the two sides a diff needs, from one endpoint.
app.get("/api/projects/:id/history/:vid/file", requireUser, async (req, res) => {
  const { id, vid: versionId } = req.params;
  const wanted = String(req.query.path || "");
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const index = await readHistoryIndex(id);
  const i = index.versions.findIndex((x) => x.id === versionId);
  if (i < 0) return res.status(404).json({ ok: false, error: "no such version" });
  const source = req.query.prev ? index.versions[i - 1] : index.versions[i];
  const f = source && (source.files || []).find((x) => x.path === wanted);
  if (!f) return res.json({ ok: true, path: wanted, encoding: null, content: "", missing: true });
  const buf = await getBlob(id, f.sha);
  if (!buf) return res.status(404).json({ ok: false, error: "blob missing" });
  if (f.encoding === "base64") res.json({ ok: true, path: f.path, encoding: "base64", content: buf.toString("base64") });
  else res.json({ ok: true, path: f.path, encoding: null, content: buf.toString("utf8") });
});

// The whole tree at a version, in the {path, content, encoding?} shape the client applies
// to the live doc on restore.
app.get("/api/projects/:id/history/:vid/tree", requireUser, async (req, res) => {
  const { id, vid: versionId } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const index = await readHistoryIndex(id);
  const v = index.versions.find((x) => x.id === versionId);
  if (!v) return res.status(404).json({ ok: false, error: "no such version" });
  const files = [];
  for (const f of v.files || []) {
    const buf = await getBlob(id, f.sha);
    if (!buf) continue;
    files.push(f.encoding === "base64" ? { path: f.path, content: buf.toString("base64"), encoding: "base64" } : { path: f.path, content: buf.toString("utf8") });
  }
  res.json({ ok: true, files });
});

// Name a version (a milestone). Labeled versions are never coalesced away.
app.post("/api/projects/:id/history/:vid/label", requireUser, async (req, res) => {
  const { id, vid: versionId } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const label = String((req.body || {}).label || "").trim().slice(0, 120) || null;
  const done = await withHistoryLock(id, async () => {
    const index = await readHistoryIndex(id);
    const v = index.versions.find((x) => x.id === versionId);
    if (!v) return false;
    v.label = label;
    await writeHistoryIndex(id, index);
    return true;
  });
  if (!done) return res.status(404).json({ ok: false, error: "no such version" });
  res.json({ ok: true, label });
});

// ---------- comment mentions → email ----------
// A comment's live sync rides the Yjs doc (see attachCollab); the ONE thing the client
// can't do itself is email the mentioned person, so this endpoint does exactly that and
// nothing else. Recipients must exist in users.json (you can only mention people who have
// actually signed in), so this can't be turned into an arbitrary-address mail cannon; a
// per-sender rate cap backstops the volume. SMTP off (dev) → the mail is logged instead.
app.post("/api/projects/:id/mentions", requireUser, async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ ok: false, error: "bad id" });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ ok: false, error: "not found" });
  if (!rateHit(emailHits, "mention:" + req.user.id, 30, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "Too many mentions, try again in a few minutes." });
  }
  const body = req.body || {};
  const text = String(body.text || "").trim().slice(0, 2000);
  const snippet = String(body.snippet || "").trim().slice(0, 300);
  const filePath = String(body.path || "").slice(0, 300);
  const roster = new Map((await readUsers()).map((u) => [u.id, u]));
  const wanted = Array.isArray(body.to) ? body.to.map((x) => String(x).toLowerCase()) : [];
  const to = [...new Set(wanted)].map((x) => roster.get(x)).filter(Boolean)
    .filter((u) => u.id !== req.user.id);                  // no self-notifications
  if (!to.length) return res.json({ ok: true, sent: 0 }); // nothing to do (or unknown ids: silently dropped)
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${base}/editor.html?p=${encodeURIComponent(id)}`;
  const t = await mailTransport();
  let sent = 0;
  for (const u of to) {
    if (!t) {                                              // dev: no SMTP → log instead of mailing
      console.log(`[alumere][mention] (SMTP off) would mail ${u.id}: ${req.user.name} mentioned them in "${meta.name}" (${filePath}): ${text}`);
      sent++; continue;
    }
    try {
      await t.sendMail({
        from: SMTP_FROM, to: u.id,
        subject: `${req.user.name} mentioned you in a comment — ${meta.name}`,
        text:
          `${req.user.name} mentioned you in a comment on "${meta.name}"` +
          (filePath ? ` (${filePath})` : "") + ".\n\n" +
          (snippet ? `On: "${snippet}"\n` : "") +
          `Comment: ${text}\n\n` +
          `Open the project: <${link}>\n`,
        html:
          `<div style="font-family:${AUTH_FONT};font-size:15px;line-height:1.5;color:#243240">` +
          `<p><b>${escapeHtml(req.user.name)}</b> mentioned you in a comment on ` +
          `<b>${escapeHtml(meta.name)}</b>${filePath ? ` <span style="color:#6b7785">(${escapeHtml(filePath)})</span>` : ""}.</p>` +
          (snippet ? `<blockquote style="margin:0 0 .75rem;padding:.5rem .75rem;border-left:3px solid #7eb0d5;color:#6b7785">${escapeHtml(snippet)}</blockquote>` : "") +
          `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>` +
          `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:.6rem 1.4rem;background:#7eb0d5;` +
          `color:#103049;font-weight:600;text-decoration:none;border-radius:8px">Open the project</a></p>` +
          `</div>`,
      });
      sent++;
    } catch (e) { console.warn(`[alumere][mention] mail to ${u.id} failed: ${e.message}`); }
  }
  res.json({ ok: true, sent });
});

// ---------- compile (compiles the files sent inline; stateless temp dir) ----------
function runLatexmk(cwd, mainFile, engineFlag) {
  return new Promise((resolve) => {
    const args = [engineFlag, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-synctex=1", "-no-shell-escape", mainFile];
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
      // SyncTeX map (editor ⇄ PDF positions), parsed client-side. Its Input records
      // point into the temp dir, so ship the dir too for path normalisation.
      const syncPath = path.join(dir, mainRel.replace(/\.tex$/i, ".synctex.gz"));
      const synctex = existsSync(syncPath) ? (await readFile(syncPath)).toString("base64") : null;
      return res.json({ ok: true, log, pdf: pdf.toString("base64"), synctex, synctexRoot: dir });
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
// Comments (giro 4) live in the SAME Yjs doc (map "comments": threadId -> plain thread
// object), so they sync live with zero extra plumbing. They persist next to meta.json —
// comments.json, OUTSIDE files/ (writeFiles rm -rf's files/, and a comment is not a
// source file: it must not enter compiles, zips or history versions).
const COLLAB_COMMENTS_KEY = "comments";
const commentsPath = (id) => path.join(projectDir(id), "comments.json");
async function readComments(id) {
  try { const j = JSON.parse(await readFile(commentsPath(id), "utf8")); return j && typeof j.threads === "object" ? j.threads : {}; }
  catch { return {}; }
}
// Chat (giro 5) rides the same doc as an Y.Array of plain message objects; persisted as
// chat.json next to comments.json (same reasoning: not a source file, stays out of
// compiles, zips and history).
const COLLAB_CHAT_KEY = "chat";
const chatPath = (id) => path.join(projectDir(id), "chat.json");
async function readChat(id) {
  try { const j = JSON.parse(await readFile(chatPath(id), "utf8")); return Array.isArray(j.messages) ? j.messages : []; }
  catch { return []; }
}
// Project dictionary (giro 6): the words added via the spellchecker's "Add to project
// dictionary" — an Y.Array of strings in the same doc, persisted as dictionary.json
// (same reasoning and same hooks as chat.json: not a source file).
const COLLAB_DICT_KEY = "dict";
const dictPath = (id) => path.join(projectDir(id), "dictionary.json");
async function readDict(id) {
  try { const j = JSON.parse(await readFile(dictPath(id), "utf8")); return Array.isArray(j.words) ? j.words : []; }
  catch { return []; }
}

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
    const meta = await readMeta(documentName);
    if (!meta) return;
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
    // Comments ride the same doc: seed the shared map from comments.json (once, with
    // the same "already populated" posture as files).
    const commentsMap = document.getMap(COLLAB_COMMENTS_KEY);
    if (commentsMap.size === 0) {
      const threads = await readComments(documentName);
      document.transact(() => { for (const [tid, th] of Object.entries(threads)) commentsMap.set(tid, th); });
    }
    // Chat too (same posture).
    const chatArr = document.getArray(COLLAB_CHAT_KEY);
    if (chatArr.length === 0) {
      const messages = await readChat(documentName);
      if (messages.length) document.transact(() => chatArr.push(messages));
    }
    // And the project dictionary (same posture).
    const dictArr = document.getArray(COLLAB_DICT_KEY);
    if (dictArr.length === 0) {
      const words = await readDict(documentName);
      if (words.length) document.transact(() => dictArr.push(words));
    }
    console.log(`[alumere] collab loaded "${documentName}" (${files.length} files)`);
    // History: capture the on-disk starting point the first time this project is opened.
    await ensureBaseline(documentName, files, meta.createdBy || SYSTEM_USER)
      .catch((e) => console.warn(`[alumere] history baseline failed for "${documentName}": ${e.message}`));
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
    // Persist comments alongside (same debounced boundary). Written only when they actually
    // changed, so ordinary text-editing stores don't rewrite the file every few seconds.
    try {
      const threads = {};
      for (const [tid, th] of document.getMap(COLLAB_COMMENTS_KEY).entries()) {
        if (th && typeof th === "object") threads[tid] = th;
      }
      const next = JSON.stringify({ threads }, null, 2);
      const cur = await readFile(commentsPath(documentName), "utf8").catch(() => null);
      if (cur !== next) await writeFile(commentsPath(documentName), next, "utf8");
    } catch (e) { console.warn(`[alumere] comments store failed for "${documentName}": ${e.message}`); }
    // Chat persists the same way: only when it actually changed, so it never touches
    // updatedAt/history on its own (a chat-only save is a "no change" store for files).
    try {
      const messages = document.getArray(COLLAB_CHAT_KEY).toArray().filter((m) => m && typeof m === "object");
      const next = JSON.stringify({ messages }, null, 2);
      const cur = await readFile(chatPath(documentName), "utf8").catch(() => null);
      if (cur !== next) await writeFile(chatPath(documentName), next, "utf8");
    } catch (e) { console.warn(`[alumere] chat store failed for "${documentName}": ${e.message}`); }
    // Project dictionary: same only-if-changed posture (a dictionary-only save must not
    // touch updatedAt or history either).
    try {
      const words = document.getArray(COLLAB_DICT_KEY).toArray().filter((w) => typeof w === "string");
      const next = JSON.stringify({ words }, null, 2);
      const cur = await readFile(dictPath(documentName), "utf8").catch(() => null);
      if (cur !== next) await writeFile(dictPath(documentName), next, "utf8");
    } catch (e) { console.warn(`[alumere] dictionary store failed for "${documentName}": ${e.message}`); }
    // History: this same debounced save is our version boundary. A restore or explicit
    // checkpoint bumps `historyBreak` in the shared meta map to force a fresh, non-amendable
    // version; we remember the last nonce we acted on in meta.json, so the flag needs no
    // clearing from the live doc (which would mean the server writing into the CRDT).
    // The break is { nonce, kind, label?, by? } — kind/label/by shape the forced version
    // (a checkpoint is authored by whoever cut it, not by the last editor). Bare-string
    // nonces from clients on older code still force a version, as before.
    const ub = document.getMap(COLLAB_META_KEY).get("updatedBy");
    const editor = ub && ub.id && ub.name ? { id: String(ub.id), name: String(ub.name) } : null;
    const brkRaw = document.getMap(COLLAB_META_KEY).get("historyBreak");
    const brk = brkRaw == null ? null
      : (typeof brkRaw === "object" ? brkRaw : { nonce: String(brkRaw) });
    const forceNew = !!brk && brk.nonce != null && brk.nonce !== meta.lastHistoryBreak;
    let vBy = editor || meta.updatedBy || meta.createdBy || SYSTEM_USER;
    const vOpts = { forceNew };
    if (forceNew) {
      vOpts.kind = brk.kind === "checkpoint" ? "checkpoint" : "restore";
      if (typeof brk.label === "string" && brk.label.trim()) vOpts.label = brk.label.trim().slice(0, 120);
      if (brk.by && brk.by.id && brk.by.name) vBy = { id: String(brk.by.id), name: String(brk.by.name) };
    }
    // Bump "ultima modifica" ONLY on a substantive change: recordVersion returns the version
    // id when it recorded something (new or amend) and null on a content-less save (reconnect,
    // reopen, redeploy re-materializes identical files). Otherwise the home would show activity
    // nobody performed, and drift ahead of the newest entry in the history timeline.
    const versionId = await recordVersion(documentName, files, vBy, vOpts)
      .catch((e) => { console.warn(`[alumere] history record failed for "${documentName}": ${e.message}`); return null; });
    let dirty = false;
    if (versionId) {
      meta.updatedAt = new Date().toISOString();
      if (editor) meta.updatedBy = editor;
      dirty = true;
    }
    if (forceNew) { meta.lastHistoryBreak = brk.nonce; dirty = true; }
    if (dirty) await writeMeta(documentName, meta);
    console.log(`[alumere] collab stored "${documentName}" (${files.length} files${versionId ? "" : ", no change"})`);
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
  // History housekeeping: one sweep shortly after boot (catches crash leftovers), then
  // periodic. unref() so neither timer keeps the process alive on shutdown.
  const gc = () => historyGcSweep().catch((e) => console.warn(`[alumere] history gc sweep failed: ${e.message}`));
  setTimeout(gc, 15_000).unref();
  setInterval(gc, HISTORY_GC_INTERVAL_MS).unref();
  console.log(`Alumère draft running →  http://localhost:${PORT}`);
});
attachCollab(httpServer);
