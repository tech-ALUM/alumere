# Alumère — draft application

A self-hosted, Overleaf-like LaTeX editor. Open the web app, create a document
from scratch in an editor that **suggests LaTeX commands as you type**, see the
**compiled PDF on the right**, and manage your **files and folders in a tree on
the left**. Documents are compiled with a **real LaTeX engine** (`latexmk` +
TeX Live) on the server.

This is a working **draft / bozza**, but no longer a thin one: a **shared project
library** with persistent server-side storage, **real-time collaboration** (Yjs —
several people in the same file, live, with cursors and presence), **version
history** with diff and restore, and **passwordless magic-link sign-in** on every
read and write. What's still missing to call it a finished product is a real
database and per-project access control (see *Roadmap* below).

---

## What's in the box

```
alumDocs/
├── server.js                 # Express backend: project store API + POST /api/compile (latexmk)
├── seed/                     # Sample project, copied in on first run
│   ├── main.tex
│   ├── references.bib
│   └── sections/             # intro.tex, math.tex
├── build/
│   └── cm-entry.mjs          # CodeMirror bundle SOURCE (esbuild entry; see Notes)
├── public/
│   ├── index.html            # Archive: shared project library + .zip upload
│   ├── editor.html           # Editor: three-pane layout (tree · CodeMirror · PDF)
│   ├── archive.js            # Archive logic (list / upload / open / delete)
│   ├── app.js                # Editor logic: load + save project, autocomplete, compile
│   ├── styles.css            # Styling (pastel theme)
│   └── vendor/
│       └── codemirror.js     # Pre-built CodeMirror bundle (committed; runs offline)
├── data/                     # Persistent project store (created at runtime; Docker volume — git-ignored)
├── Dockerfile                # Node 22 + a TeX Live subset (zero local install needed)
├── docker-compose.yml        # Simple single-container run (localhost:3000)
├── docker-compose.dev.yml    # Development run: hot-reload via bind-mount + `node --watch`
├── docker-compose.prod.yml   # Public deploy A (standalone): Caddy (auto-HTTPS) + app (see DEPLOY.md)
├── docker-compose.alum.yml   # Public deploy B (ALUM): app only, behind an existing edge Caddy
├── Caddyfile                 # Reverse-proxy config for deploy A (self-contained Caddy)
├── Caddyfile.alum-edge       # Reference vhost for deploy B (existing edge Caddy on the VPS)
├── .env.example              # All deploy env vars (copy to .env on the server)
├── DEPLOY.md                 # Step-by-step production runbook
└── package.json
```

---

## Run it

### Option A — Docker (recommended; nothing to install but Docker)

This bundles a LaTeX distribution inside the container, so you don't install TeX
on your machine.

```bash
cd alumDocs
docker compose up --build
```

Then open **http://localhost:3000**.

> The first build downloads a TeX Live subset and takes a few minutes. After
> that it starts instantly.

### Option B — Local (you already have Node 18+ and a LaTeX distribution)

You need `latexmk` + a TeX distribution on your PATH (TeX Live on Linux,
MacTeX on macOS, MiKTeX on Windows).

```bash
cd alumDocs
npm install
npm start
```

Open **http://localhost:3000**.

> The Docker image is built on **Node 22**; for a local run, `package.json`
> requires **Node ≥ 18**.

---

## Develop it (hot-reload)

For day-to-day development use the dev compose file. It bind-mounts your local
code into the container and runs the server under `node --watch`, so edits are
picked up **without a rebuild**.

```bash
cd alumDocs
docker compose -f docker-compose.dev.yml up --build   # first time
docker compose -f docker-compose.dev.yml up           # subsequent runs
```

- **Files in `public/`** (`app.js`, `editor.html`, `styles.css`, …) are static —
  just **reload the browser**.
- **`server.js`** and other backend files trigger an **automatic server restart**
  (you'll see it in the logs).
- A rebuild (`--build`) is only needed when **`package.json`** (dependencies) or
  the **`Dockerfile`** changes.

> `node_modules` is kept inside the container via an anonymous volume, so the
> host's `node_modules` never shadows the Linux build. Projects persist in the
> same `alumere-data` volume as production, so you don't lose data switching
> between dev and prod.

---

## Using it

- **File tree (left).** Click a file to edit it. Hover a row for ✎ rename / 🗑
  delete. Use **＋ file** / **＋ folder** to add items (added inside the selected
  folder, or next to the selected file).
- **Editor (centre).** Type LaTeX. Start a command with a backslash —
  `\sec`, `\begin`, `\frac`, … — and an **autocomplete popup** appears, just
  like Overleaf. Press Enter to insert; snippet placeholders are Tab-navigable.
- **Preview (right).** Press **Recompile** (or `Ctrl/Cmd+S`) to build the PDF.
  Switch to the **Log** tab to see compiler output; errors are highlighted.
  **Download PDF** saves the result.
- **Engine selector.** Choose pdfLaTeX, XeLaTeX or LuaLaTeX. **The default engine
  is XeLaTeX** (good Unicode and system-font support out of the box).
- **Working together (topbar).** Avatars show who else is in the project, with
  colored cursors and selections in the editor and a live connection state. Text
  **saves itself continuously** — there is no Save button and nothing to press.
- **Review and Chat (left rail).** **Review** holds Word-style comments anchored
  to a selection, split into **Open** / **Resolved**, with threaded replies.
  **Chat** is a per-project conversation. Both take **@mentions**.
- **History.** Versions are snapshotted as people write: timeline with author,
  per-file diff, and restore. **📌 Checkpoint** pins a named version that later
  saves won't move.
- **Spell check.** Unknown words are underlined as you type; right-click for
  suggestions or **Add to project dictionary** — custom words are shared with
  everyone in the project, live.
- **SyncTeX, both ways.** Jump from the cursor to the matching place in the PDF,
  and double-click the PDF to jump back to the source.

The app ships with a small sample project (`main.tex`, `sections/`,
`references.bib`) so it compiles something the moment it loads.

---

## How packages are handled

The compile runs against the TeX distribution available to the server:

- **Docker image (default):** a curated TeX Live subset
  (`texlive-latex-recommended`, `-latex-extra`, `-fonts-recommended`,
  `-science`, plus XeTeX/LuaTeX). This covers the large majority of documents.
- **Need everything?** Replace those packages in the `Dockerfile` with
  `texlive-full` (much larger image, every CTAN package).
- **Leaner alternative — Tectonic.** Tectonic is a modern, self-contained engine
  that **downloads only the packages a document actually uses, on demand**, which
  keeps images tiny and removes package management almost entirely. It's a clean
  future swap behind the same `/api/compile` interface (note: it's XeLaTeX-based,
  so a few `pdflatex`-only documents may need tweaks).

---

## Projects & persistence

Projects live **on the server**, in a simple filesystem store — a shared library:
**everyone signed in sees every project**. Signing in is required for every read
and write (passwordless magic-link, restricted to your company email domain — see
*Notes* below), but there is **no per-project access control yet**, so the instance
is still meant for a trusted group.

- **Archive (home page).** Lists every project as a row; click one to edit it.
  **New project ▾** creates an empty one or **uploads an existing `.zip`** (a
  common top-level folder inside the zip is stripped automatically). Rows can be
  searched, tagged, **archived**, and moved to the **Trash** — removal is two-step,
  and only from the Trash view is a project destroyed for good. A **Sample paper**
  is seeded on first run so the library isn't empty.
- **Storage layout.** Each project is a folder under `PROJECTS_DIR`
  (default `data/projects`): `meta.json` (name + timestamps) and `files/` (the
  LaTeX tree). Alongside them sit things that are *about* the project but are not
  sources — `comments.json`, `chat.json`, `dictionary.json`, the Yjs state
  (`doc.ystate`) and the last successful build (`build.pdf` + `build.synctex.gz` +
  `build.json`), which is what the editor shows the moment you open a project.
  Keeping them out of `files/` is deliberate: they must never enter a compile, a
  zip or a history version. In Docker this is a named volume (`alumere-data`), so
  projects survive restarts and rebuilds.
- **Project names are unique.** Creating or renaming a project to a name already
  in use is refused (case-insensitive). A zip upload auto-suffixes instead —
  `Thesis (2)` — since the bytes are already on the server.
- **Saving.** There is nothing to save: every keystroke goes into the shared
  document, and the server persists it on a debounced hook. The topbar says
  *auto-save* instead of offering a button. `Ctrl/Cmd+S` is left bound to
  **Recompile**, since that's the only thing still worth asking for by hand.
  Binary assets (images) are preserved but not editable in the text editor.

> **How concurrent editing works.** Editing runs through **one Yjs document per
> project** (CRDT): two people in the same file merge character by character
> instead of overwriting each other, and the old last-write-wins behaviour is gone
> from the editor. The server keeps the live doc in `doc.ystate` and materializes
> `files/` from it on a debounced store hook, which is also what feeds compiles,
> zips and history versions.
>
> One sharp edge is left, and it lives in the API rather than the UI:
> `PUT /api/projects/:id` still **replaces a project's whole file set** (it does an
> `rm -rf` on `files/`). Nothing in the app calls it any more, but a script that
> does will clobber whatever people are typing. The endpoint deliberately deletes
> `doc.ystate` afterwards, so the next open re-seeds from disk instead of
> resurrecting the pre-overwrite content.

### API (for reference)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Load a project's file tree |
| `POST` | `/api/projects/upload` | Create a project from an uploaded `.zip` |
| `PUT` | `/api/projects/:id` | Replace a project's whole file set (see the caveat above) |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/compile` | Compile the supplied files, return PDF + log |

This is a subset — the server also exposes auth/session, history, tags,
archive/trash, mentions and last-build endpoints, plus the `ws /collab` socket.
`server.js` is the authoritative list.

---

## How it works (so anyone can pick it up)

1. The project lives in a **shared Yjs document**, one per project, kept on the
   server and replicated live into every open browser — that's what the file tree
   and the editor render.
2. On **Recompile**, the front-end sends every file from that document to
   `POST /api/compile`.
3. The server writes them to a temporary folder, runs
   `latexmk -interaction=nonstopmode -halt-on-error` (shell-escape disabled for
   safety), and returns the PDF (base64) plus the log.
4. The browser shows the PDF in the preview pane.

The compile itself is **throw-away**: a fresh temp folder per request, deleted
afterwards, with nothing carried from one compile to the next. What it does keep
is the **result** — on success it stores the PDF, the SyncTeX map and the log as
the project's *last build*, which is what you see the moment you open a project.
Persisting the **content** is a separate path again: the Yjs store hook, which
materializes `files/` under `PROJECTS_DIR`.

---

## Configuration

For a local/dev run the server needs almost nothing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `PROJECTS_DIR` | `data/projects` | Where projects are stored on disk (mounted as a volume in Docker) |

**Deploying it publicly** (magic-link auth, HTTPS, email) adds a handful more —
`ALLOWED_EMAIL_DOMAIN`, `PUBLIC_BASE_URL`, `COOKIE_SECURE`, `TRUST_PROXY`,
`SESSION_SECRET`, and the `SMTP_*` group. They're all documented in
[`.env.example`](.env.example), and [`DEPLOY.md`](DEPLOY.md) is a step-by-step
runbook (Caddy reverse proxy with automatic TLS + `docker-compose.prod.yml`).

---

## Roadmap (turning the draft into the full product)

This matches the architecture decision the team agreed. Items 1 and 3 are
**done**; item 2 is the one still open.

1. **Real-time collaboration** — ✅ **done (M1 + M2).** **Yjs** (CRDT) over
   **Hocuspocus**, bound to the CodeMirror editor: one shared document per project
   over `ws /collab`, live multi-file editing with colored cursors and presence
   avatars, persisted to `doc.ystate`. On top of it sits **version history** —
   content-addressed snapshots per save, with a timeline, per-file diff, labels,
   restore, retention and blob GC. (`public/collab.html`, the original **M0**
   two-tab spike, is still in the tree as a minimal reproduction of the transport.)
2. **Accounts & projects** — 🚧 **half done.** Sign-in exists and is enforced
   everywhere (passwordless magic-link, company-domain allowlist, users in
   `users.json`). What's missing is the rest of the item: a **database**
   (PostgreSQL) instead of the filesystem store, a **per-person allowlist**, and
   **per-project access control** so a project can be shared with some members
   rather than with everyone on the instance.
3. **Polish** — ✅ **done.** SyncTeX (click PDF ↔ jump to source), version
   history, image uploads (drag & drop onto the tree, or **Add files**), autosave
   (continuous, via the Yjs store hook), and PDF.js for the preview
   (`public/vendor/pdfjs`).

---

## Notes & limitations (it's a draft)

- The editor uses a **local CodeMirror bundle** (`public/vendor/codemirror.js`),
  so it works offline with no runtime CDN dependency. If that bundle is missing it
  falls back to the esm.sh CDN, and finally to a plain-text editor (shown with an
  on-screen notice). Serving from `http://localhost` is required — don't open the
  pages as `file://`. The bundle's **source** is `build/cm-entry.mjs` (which now also
  bundles the Yjs real-time pieces as `window.YCOLLAB`); rebuild it after editing with
  **`npm run build:client`** (driven by `build/build-client.mjs`, which aliases the
  Node-only `ws` package to the browser's native WebSocket).
- **Authentication is passwordless magic-link**, restricted to your company email
  domain — every read/write and the collaboration socket require a signed-in user.
  For a public deployment (HTTPS + SMTP) follow [`DEPLOY.md`](DEPLOY.md); the local
  runs above are fine for a trusted network.
- **One compile at a time per request**; fine for a few users.
