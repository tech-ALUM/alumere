# Alumère — draft application

A self-hosted, Overleaf-like LaTeX editor. Open the web app, create a document
from scratch in an editor that **suggests LaTeX commands as you type**, see the
**compiled PDF on the right**, and manage your **files and folders in a tree on
the left**. Documents are compiled with a **real LaTeX engine** (`latexmk` +
TeX Live) on the server.

This is a working **prototype / bozza**: a **shared project library** with
persistent server-side storage and a real LaTeX editor. Real-time collaboration
and per-user accounts are the documented next steps (see *Roadmap* below); this
draft lays the foundation they plug into.

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
├── docker-compose.prod.yml   # Public deploy: Caddy (auto-HTTPS) + app (see DEPLOY.md)
├── Caddyfile                 # Reverse-proxy config for the public deploy
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

Projects live **on the server**, in a simple filesystem store — a shared library,
so everyone using the instance sees the same projects (no accounts yet; intended
for a trusted group).

- **Archive (home page).** Lists every project as a card. **Carica .zip** uploads
  an existing LaTeX project (a common top-level folder inside the zip is stripped
  automatically). Open a card to edit it, or delete it. A **Sample paper** is
  seeded on first run so the library isn't empty.
- **Storage layout.** Each project is a folder under `PROJECTS_DIR`
  (default `data/projects`): `meta.json` (name + timestamps) and `files/` (the
  LaTeX tree). In Docker this is a named volume (`alumere-data`), so projects
  survive restarts and rebuilds.
- **Saving.** The editor saves to the server with the **Save** button, and also
  auto-saves on every **Recompile** (`Ctrl/Cmd+S`). Binary assets (images) are
  preserved but not editable in the text editor.

> **Concurrency caveat (draft).** Saving a project **replaces its whole file set**
> on the server (last-write-wins). If two people save the same project around the
> same time, the later save overwrites the earlier one — there is no merge or
> locking yet. Real-time collaboration (see *Roadmap*) is what addresses this.

### API (for reference)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Load a project's file tree |
| `POST` | `/api/projects/upload` | Create a project from an uploaded `.zip` |
| `PUT` | `/api/projects/:id` | Save a project's files |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/compile` | Compile the supplied files, return PDF + log |

---

## How it works (so anyone can pick it up)

1. The **whole project lives in the browser** as a file tree.
2. On **Recompile**, the front-end sends every file to `POST /api/compile`.
3. The server writes them to a temporary folder, runs
   `latexmk -interaction=nonstopmode -halt-on-error` (shell-escape disabled for
   safety), and returns the PDF (base64) plus the log.
4. The browser shows the PDF in the preview pane.

The **compile** endpoint is **stateless** — it stores nothing between compiles —
which keeps that path simple. Persistence is handled separately by the project
store (`/api/projects`, backed by `PROJECTS_DIR`).

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

This matches the architecture decision the team agreed:

1. **Real-time collaboration** — add **Yjs** (CRDT) with the **Hocuspocus**
   server and bind it to the CodeMirror editor, so multiple people edit the same
   file live, with cursors. This is the headline feature and the next big step —
   and it's what removes the last-write-wins limitation above. *An **M0 spike** is
   already wired up: the server relays a shared document over `ws /collab`, and
   `public/collab.html` (open it in two tabs) proves live sync + colored cursors
   labeled by the signed-in user. Binding this into the real per-file editor is the
   next milestone (M1).*
2. **Accounts & projects** — logins and a database (PostgreSQL) so projects
   persist and can be shared between members, with real access control instead of
   one shared library.
3. **Polish** — SyncTeX (click PDF ↔ jump to source), version history, image
   uploads, autosave, and a switch to PDF.js for richer preview control.

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
