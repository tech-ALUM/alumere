# alumDocs — Riepilogo avanzamenti e decisioni

> Diario di bordo del progetto: **leggi questo file a inizio sessione** per essere
> subito sul pezzo (stato attuale, scelte fatte e perché, prossimi passi). Le
> sezioni datate in alto sono le più recenti; sotto resta il contesto di design di
> base. (Ex `alumDocs_latexUpdates.md`.)

---

## 2026-07-12 (sera) — Deploy reale su VPS ALUM: fatto, integrato col Caddy edge ✅

App **live su `https://docs.alum-lab.com`**, dietro il Caddy edge già presente sul VPS. Deploy con Claude Code sul server (utente `albertoboffi`), dir `/opt/alum/alumere` (convenzione `/opt/alum/<servizio>`).

**⚠️ Correzione all'handoff precedente**
L'handoff proponeva `app` su `127.0.0.1:3000:3000` + `reverse_proxy localhost:3000`. Sbagliato per QUESTO server: il Caddy del VPS è un **container** sulla rete `alum_web`, non un servizio host → da dentro il container `localhost:3000` è il Caddy stesso, non l'app. Integrazione corretta (uniforme con duit/maluS): app agganciata alla rete esterna condivisa **`alum_web`** con alias, Caddy che la raggiunge **per nome** con `reverse_proxy alumere:3000`. Nessun porto pubblicato sull'host.

**Cosa c'è ora**
- **`docker-compose.alum.yml`** (nuovo, versionato): solo servizio `app`, `expose: 3000` (niente porte host), `env_file: .env`, volume `alumere-data`, healthcheck via `node fetch /api/health`, su rete `alum_web` (external) con alias `alumere`. Nessun Caddy interno (quello di `prod` confliggerebbe su 80/443).
- **Caddyfile edge** (`/opt/alum/caddy/Caddyfile`): nuovo vhost `docs.alum-lab.com` → `reverse_proxy alumere:3000`, `encode zstd gzip`, TLS automatico, WebSocket `/collab` passthrough. Aggiunta **redazione del `token` in query nei log** (il magic-link è `/api/auth/verify?token=…`), sul modello dei vhost `brain`. Reload con force-recreate (Caddyfile è bind-mount a file singolo).
- **`.env` sul server** (mai committato): config decisa + segreti `SESSION_SECRET` (openssl) e `SMTP_PASS` (casella `tech@alum-lab.com`).

**Email / DNS**
- Record A `docs.alum-lab.com → 84.247.128.81` creato. DKIM e DMARC su `alum-lab.com` a posto.
- **SPF da verificare/sistemare** su Namecheap: `v=spf1 include:spf.privateemail.com ~all` (un solo record SPF per dominio; se ne esiste già uno, fondere). Non blocca l'avvio, incide solo sulla deliverability dei magic-link.

**Follow-up (non bloccanti)**
- `package-lock.json` disallineato (`nodemailer` assente dal lock) → rigenerare + passare a `npm ci`.
- Backup: i progetti vivono nel volume Docker **`alumere-data`** → includerlo nei backup.
- Valutare versionare/backuppare `/opt/alum/caddy/` (config edge di 5 servizi, oggi solo sul VPS).

---

## 2026-07-12 (pomeriggio) — Handoff deploy all'informatico + scoperta: Caddy già sul VPS ⚠️

Preparazione al deploy reale: raccolti i valori d'ambiente e **verificato il server target dall'esterno**.
Il deploy lo esegue **l'informatico** (ha chiesto di provarci lui). Codice già su `origin/main` (`5d00510`).

**Target reale**
- VPS `84.247.128.81` (Ubuntu, Docker + Compose pronti, porta SSH 22 aperta).
- Dominio app: **`docs.alum-lab.com`** (sotto-dominio di `alum-lab.com`, già di proprietà). Record DNS
  **A → 84.247.128.81 ancora da creare** (al momento del check non risolveva).

**⚠️ Scoperta che cambia la procedura di `DEPLOY.md`**
- Test dall'esterno: **sul VPS gira GIÀ un Caddy** (`:80` → `308` redirect a https con header `Server: Caddy`;
  `:443` apre ma dà TLS *internal error* su SNI sconosciuto → Caddy con HTTPS automatico su vhost nominati,
  verosimilmente serve già altri siti).
- ⇒ **NON** lanciare lo stack intero `docker-compose.prod.yml`: il suo Caddy interno confliggerebbe sulle
  porte 80/443 con quello esistente e non partirebbe.
- **Via corretta = integrare col Caddy esistente**: avviare **solo** il servizio `app` pubblicato su
  `127.0.0.1:3000` (aggiungere `ports: ["127.0.0.1:3000:3000"]` al servizio `app` e non avviare il servizio
  `caddy`), poi nel Caddyfile esistente aggiungere:
  ```
  docs.alum-lab.com {
      reverse_proxy localhost:3000
  }
  ```
  Caddy fa da sé TLS + passthrough WebSocket di `/collab`. Da chiarire com'è gestito il Caddy esistente
  (servizio systemd sull'host vs. container Docker).

**Valori `.env` decisi** (config, non segreti): `PUBLIC_DOMAIN=docs.alum-lab.com`,
`PUBLIC_BASE_URL=https://docs.alum-lab.com`, `ALLOWED_EMAIL_DOMAIN=alum-lab.com`, `COOKIE_SECURE=1`,
`TRUST_PROXY=1`, `LOGIN_TOKEN_TTL_MIN=15`; SMTP **privateemail** (`SMTP_HOST=mail.privateemail.com`,
`SMTP_PORT=465`, `SMTP_USER`/`SMTP_FROM=tech@alum-lab.com`).
**Segreti (MAI committati)**: `SESSION_SECRET` (generare con `openssl rand -hex 32`) e `SMTP_PASS` (password
della casella `tech@alum-lab.com`) → si scrivono **solo** nel `.env` sul server.

**Prossimo**: creare il record DNS; l'informatico integra col Caddy esistente + `.env` sul server + avvio del
solo `app`; poi test end-to-end (magic-link → mail → editor real-time in due schede).

---

## 2026-07-12 — Deploy pubblico (M-sec Step 4): artefatti + verifica ✅

Preparato tutto il necessario per aprire l'app su internet dietro HTTPS con l'auth magic-link. Al deploy
manca solo **fornire dominio + DNS** e **credenziali SMTP reali**: codice e config sono pronti e **verificati**.

**Cosa c'è ora**
- **`docker-compose.prod.yml`**: stack di produzione = **Caddy** (TLS automatico Let's Encrypt) davanti all'**app**,
  che **non** pubblica porte sull'host (solo `expose`, raggiungibile da Caddy come `app:3000`). Config operativa via
  `env_file: .env`; volumi persistenti per dati (`alumere-data`) e certificati (`caddy_data`/`caddy_config`);
  healthcheck dell'app con `node -e fetch(...)` (niente curl nell'immagine slim).
- **`Caddyfile`**: `reverse_proxy app:3000`, dominio da `{$PUBLIC_DOMAIN}`; gli upgrade WebSocket di `/collab`
  passano trasparenti.
- **`.env.example`**: tutte le env documentate (dominio, gate, cookie, SMTP) → `cp .env.example .env` sul server.
- **`.dockerignore`** (prima **assente**): impedisce che `.env`/segreti finiscano nei layer dell'immagine e che un
  `node_modules`/`data` locale la sporchi.
- **`DEPLOY.md`**: runbook passo-passo (DNS → `.env` → avvio → verifica → SMTP/SPF-DKIM → backup volume → troubleshooting).
- **`server.js`**: +3 righe `trust proxy` **opt-in** (`TRUST_PROXY=1`) → dietro Caddy `req.ip` è l'IP reale del client
  (rate-limit per-IP di nuovo corretto). Inerte senza la env: dev/run diretto invariati.
- **`README`**: sezione Configuration aggiornata + rimosso il caveat "no auth / non esporre" ormai falso.

**Scelte (e perché)**
- **Caddy**: TLS automatico, config minimale, WS passthrough senza settaggi. App non esposta → solo Caddy pubblica 80/443.
- **`COOKIE_SECURE=1` da env** (non da `req.protocol`): il cookie è `Secure` anche se l'app dietro il proxy vede HTTP;
  idem `PUBLIC_BASE_URL` esplicito per i link → non dipende dal protocollo visto dall'app.
- **Lockfile**: `nodemailer` è in `package.json` ma **manca dal `package-lock.json`**; il Dockerfile usa `npm install`
  (non `npm ci`) quindi l'immagine lo prende comunque. Rigenerare il lock + passare a `npm ci` è hardening segnato come
  follow-up (task in background) — non blocca.

**Verificato (Docker in locale, tutto ISOLATO dal container di prod)**
- **Statico**: sintassi `server.js`; `docker compose config` (exit 0); `caddy validate` → "Valid configuration";
  `npm install --omit=dev` installa davvero `nodemailer` (v6.10.1) nonostante il lock disallineato (host non toccato).
- **Runtime end-to-end attraverso Caddy — 11/11**: health pubblica; gate 401 senza cookie / 200 con; gate dominio
  (`@gmail.com` → 403); magic-link emesso col `PUBLIC_BASE_URL`; verify → 302 + cookie **Secure + HttpOnly** su HTTPS;
  **WebSocket `/collab` attraverso il proxy** aperto col cookie, respinto senza.
- **Percorso SMTP reale (MailHog)**: `POST /api/auth/request` → mail **realmente inviata** via `nodemailer` e catturata:
  destinatario `laura.bianchi@example.com`, mittente `noreply@example.com`, oggetto "Accesso ad Alumère", link presente.
  Resta server-side solo la deliverability vera (SPF/DKIM/spam).

**Prossimo → deploy vero**: su un VPS → `cp .env.example .env` coi valori reali (dominio, `ALLOWED_EMAIL_DOMAIN`, SMTP),
record DNS A → server, `docker compose -f docker-compose.prod.yml up -d --build`. Poi eventuali: allowlist per-persona
(oltre al dominio), ACL per-progetto, persistenza dei token pending (ora in memoria).

---

## 2026-07-11 — Sicurezza: login magic-link, dominio-ristretto (M-sec step 1–3) ✅

In vista dell'apertura su internet (la collaborazione real-time richiede **un solo server**
raggiungibile da tutti → i buchi di sicurezza vanno chiusi prima). Sostituita l'"identità"
(solo nome) con **autenticazione vera passwordless**: login via **magic link** su email del
**dominio aziendale**. Fatto e verificato (Step 1–3), ora **mergiato in `main`** e pushato
(`fedffed`, fast-forward su `c071e15`); manca solo lo Step 4 (SMTP reale + HTTPS), che è
deploy/config, non codice.

**Cosa c'è ora**
- **Login (server, `server.js`)**: `POST /api/auth/request {email}` valida formato + **gate dominio**
  (`ALLOWED_EMAIL_DOMAIN`), crea un **token monouso** a scadenza e manda il link
  `…/api/auth/verify?token=…`; `GET /api/auth/verify` consuma il token e setta il cookie di sessione
  firmato (**riuso `signSession`**, macchina cookie invariata). Rimosso il vecchio `POST /api/session`.
- **Nome derivato dall'email**: `mario.rossi@`→"Mario Rossi"; **camelCase = confine di parola**
  (`maria.delCarmen@`→"Maria Del Carmen"); senza punto → account funzionale (`admin@`→"AdminAccount").
  **Id utente = email lowercased** (identità stabile); il nome usa il case originale.
- **Gate propagato** (`requireUser`): `GET /api/projects`, `GET /api/projects/:id`, `POST /api/compile`
  e il **websocket `/collab`** (autenticato leggendo lo stesso cookie nell'`upgrade`). Restano
  pubblici solo il flusso di login e `/api/health`.
- **Rate-limit**: per-email (5/10min, blocca il mail-bombing di una casella) + **backstop per-IP
  generoso** (60/10min) — così il **NAT dell'ufficio** (un solo IP condiviso) non si autoblocca.
- **Client (`public/auth.js`)**: overlay email → "controlla la posta" (poll finché la sessione diventa
  il **nuovo** utente → reload). **"Cambia utente" annullabile**: apre l'overlay con una **X** (alto a
  dx) + Esc **senza sloggare** — il cambio avviene solo completando un nuovo accesso.
- **`nodemailer`** importato in modo **guardato** (dynamic import): senza SMTP l'app non crasha e il
  link viene **stampato nel log** (fallback dev).

**Scelte (e perché)**
- **Magic link invece di password**: l'attribuzione (spina dorsale dell'app + history futura) diventa
  affidabile (casella reale al dominio), niente password da custodire/resettare, **nessun DB utenti**
  per la v1 (l'allowlist È il dominio). Era anche la direzione già prevista nei commenti del codice.
- **Gate del ws nell'`upgrade`** (parse cookie + `verifySession`), non un `onAuthenticate` di Hocuspocus:
  riusa la roba REST; socket non autenticati → 401 + destroy.
- **Import mailer guardato**: coerente con come sono trattate le dep collab (l'app parte comunque).

**Config (env)**: `ALLOWED_EMAIL_DOMAIN` (vuoto = qualsiasi, **solo dev**), `PUBLIC_BASE_URL`,
`LOGIN_TOKEN_TTL_MIN` (default 15), `SMTP_HOST/PORT/USER/PASS/FROM`, `COOKIE_SECURE=1` (dietro HTTPS).

**Verificato** (in isolamento su :3100, senza toccare i dati né il container :3000):
- **Headless**: flusso auth **23/23** (gate dominio, derivazione nome incl. `delCarmen`, token monouso,
  rate-limit per-email, NAT-friendly) + **gate 10/10** (senza cookie → 401 su letture/compile/ws; con
  cookie → 200 e handshake ws 101; login+health pubblici).
- **Browser**: login end-to-end (email → link dal log → dentro come "Laura Bianchi"), gmail rifiutata in
  UI, "cambia utente" + X che chiude mantenendo la sessione.

**Prossimo → Step 4 (deploy pubblico)**
- **SMTP reale**: `privateemail` da una casella esistente (buona deliverability) — indirizzo/credenziali
  da fornire al deploy.
- **HTTPS obbligatorio**: reverse proxy (es. Caddy, TLS automatico), `COOKIE_SECURE=1`, `PUBLIC_BASE_URL`
  = URL pubblico, `ALLOWED_EMAIL_DOMAIN` = dominio vero.
- Poi eventuali: allowlist per-persona (oltre al dominio), ACL per-progetto, persistenza dei token
  pending (ora in memoria).

---

## 2026-07-05 — M1 Step 1 (pipe collaborativo + persistenza): implementato ✅

Primo step di M1: l'**editor vero** è ora collaborativo e i contenuti girano su Yjs,
con **persistenza server-side** nei `files/`. Sparisce il PUT last-write-wins. Strategia
concordata: fare prima il **pipe server (verificabile headless)**, poi il polish (Step 2).

**Cosa c'è ora**
- **Fonte di verità = un `Y.Doc` per progetto** (stanza = id progetto). `ydoc.getMap("files")`
  mappa `path → Y.Text` (testo, editabile dal vivo) oppure `{ encoding:"base64", content }`
  (binari, statici: round-trippati da persistenza e compile ma non collaborativi).
- **Server (`server.js`, `attachCollab`)**: `onLoadDocument` semina il doc dai `files/` su disco
  (nuovo helper `readFilesFlat`, inverso di `writeFiles`); `onStoreDocument` (debounce 2s)
  materializza il doc nei `files/` e aggiorna `meta.json` (`updatedAt` + `updatedBy` letto da una
  meta-map Yjs che il client setta sugli edit locali). Le stanze senza progetto (lo spike
  `alumere-spike`) non hanno `meta` → saltate da entrambi gli hook, restano relay in memoria.
- **Client (`public/app.js`, riscritto attorno a Yjs)**: l'editor si lega al `Y.Text` del file
  attivo via `yCollab` (ricreo la `EditorView` al cambio file → binding pulito, nessun hazard di
  compartment); albero = **proiezione dei path** della mappa (folder derivate dai segmenti);
  create/rename/delete mutano la mappa → **live per tutti**; compile legge il contenuto corrente da
  Yjs (stateless, invariato). Nuovo indicatore `#collabState` (connessione + n° presenti in
  `editor.html`). Rimossi PUT/dirty locali.

**Scelte (e perché)**
- **Zero nuove dipendenze, zero rebuild di bundle/immagine**: `window.YCOLLAB` (dal bundle M0) espone
  già `Y`/`HocuspocusProvider`/`yCollab`/`yUndoManagerKeymap`; il server usa deps già presenti. In dev
  basta il riavvio di `node --watch` (server) + reload del browser (client statici).
- **Niente `history()` nativa di CodeMirror** nel ramo collaborativo: l'undo è lo Yjs `UndoManager`
  (via `yUndoManagerKeymap`), altrimenti confligge col CRDT. File binari aperti read-only.
- **Guardia anti-wipe**: `onStoreDocument` non azzera i `files/` partendo da un doc vuoto (protegge da
  un seed fallito) — cancellare *l'ultimo* file via collab semplicemente non persiste (edge case accettato).
- **Folder**: derivate dai path (le folder vuote già oggi non sopravvivevano a un salvataggio); una
  "＋ folder" crea una cartella **locale** finché non contiene un file (condivisione folder vuote → Step 2).
- **Sicurezza invariata**: nessuna auth sul socket `/collab` (coerente con le letture già aperte) → gate dopo.

**Verificato in questa sessione (in isolamento, senza toccare il container di produzione su :3000)**
- Server fresco su :3100 + `PROJECTS_DIR` temporaneo. **Test headless a 2 client** (`@hocuspocus/provider`,
  stessi pacchetti del browser): seed dai `files/` (anche annidati), sync live di un file, create e
  rename propagati → **PASS** (8/8).
- **Persistenza su disco**: edit/create/rename materializzati nei `files/`, `meta.updatedAt` aggiornato;
  la stanza `alumere-spike` **non** crea cartelle (resta relay) → **PASS**.
- **Browser** (preview dockerizzato): pagina carica **senza errori in console**, albero renderizzato da
  Yjs (folder `sections/` annidata), editor legato al `Y.Text` con highlight, presenze `● N online`.
  *(Il compile logga `latexmk ENOENT` solo perché il container di verifica è un `node` minimale senza
  TeX; nell'immagine reale il PDF esce come prima — il codice di compile non è stato toccato.)*

**Come vederlo girare**: il container `alumere` attualmente su :3000 ha il codice **vecchio** (la prod
compose fa `COPY` a build-time). Per M1: fermarlo e usare la **dev compose** (bind-mount + `node --watch`,
nessun rebuild necessario perché le dipendenze non cambiano) — poi aprire un progetto in **due schede**.

**Prossimo passo → M1 Step 2**
- Presenze ricche (chip con nomi/colori + "chi sta su quale file"), robustezza operazioni cartella e
  condivisione folder vuote, riconnessione, pulizia UX (Save button, `#dirtyDot`). Poi M2 (history) e auth sul ws.

---

## 2026-07-05 — M0 real-time (Yjs + Hocuspocus): implementato ✅

Implementato e verificato lo **spike M0** di collaborazione real-time. È uno
*spike standalone*: **non tocca l'editor vero** (quello è M1), serve a validare la
pipe end-to-end (deps + bundle + websocket + Docker) col minor rischio possibile.

**Cosa c'è ora**
- Pagina spike `public/collab.html` (+ `public/collab.js`): un CodeMirror minimale
  legato a un `Y.Text` condiviso; stanza unica in memoria; cursori/presenze
  colorati col nome dell'utente loggato (riusa l'identità di `auth.js`). Nessun
  salvataggio.
- Server (`server.js`, funzione `attachCollab`): `Hocuspocus` agganciato allo
  **stesso** `http.Server` di Express; solo gli upgrade WebSocket su **`/collab`**
  vengono instradati al CRDT, tutto il resto resta HTTP normale.
- Bundle client (`build/cm-entry.mjs`): `yjs` + `@hocuspocus/provider` +
  `y-codemirror.next` esposti su `window.YCOLLAB`, **nello stesso bundle** di
  `window.CM6`.

**Scelte fatte (e perché)**
- **WS sullo stesso porto 3000, path `/collab`** → nessuna modifica ai
  `docker-compose*.yml`. (Risposta alla "domanda 1" di questo doc.)
- **Dipendenze aggiunte** (risposta "domanda 2"): server → `@hocuspocus/server`,
  `ws`, `yjs`, `y-protocols`; bundle client (dev) → `@hocuspocus/provider`,
  `y-codemirror.next`, `esbuild`, `@codemirror/*`.
- **Hocuspocus pinnato alla 2.15.2, non la 4.x.** La v4 è passata a `crossws` con
  `handleConnection(Request web-standard)`: integrazione più involuta e non
  collaudabile a mano qui. La 2.x usa il pattern robusto `ws` `noServer` +
  `handleConnection(ws, req)`. Il salto alla v4 è rimandabile.
- **Yjs nello stesso bundle di CM6.** `y-codemirror.next` deve condividere la
  *stessa* istanza `@codemirror/state` dell'editor, altrimenti le facet di
  CodeMirror vedono due copie e il binding si rompe.
- **Alias `ws` → WebSocket nativa in fase di build.** `@hocuspocus/provider`
  dipende da `ws` (Node) e non ha campo `browser`; in browser deve usare la
  WebSocket globale. `build/build-client.mjs` aliasa `ws` a uno stub
  (`build/ws-browser-stub.mjs`) così esbuild non trascina i built-in Node.
- **Import server dinamico e guardato.** Se le dep collab mancano, l'app parte
  comunque (editor + compile) e la collab resta spenta, invece di non avviarsi.
- **Sicurezza invariata (fase 1).** Nessuna auth sul socket `/collab` ancora:
  coerente con "la sicurezza può aspettare"; va aggiunta dopo M1 (vedi sotto).

**Build (Node non è sull'host)**
- Il bundle client si ricostruisce con `npm run build:client` (via
  `build/build-client.mjs`). Non essendoci Node sull'host, in pratica gira dentro
  un container Node usa-e-getta; l'immagine app si ricostruisce con
  `docker compose up --build`. `README.md` e `.gitignore` aggiornati di conseguenza.

**Verificato in questa sessione**
- Bundle buildato pulito (~506 KB) e servito con `window.YCOLLAB`.
- `ws /collab` → **101 Switching Protocols**; path non-collab → connessione chiusa.
- **Sync CRDT bidirezionale + presenze** provate con un test headless a due client
  (stessi pacchetti del browser): `PASS`.
- Conferma visiva dei **due cursori separati** in browser (Safari).

**Prossimo passo → M1**
- Legare Yjs all'**editor vero, per-file** (un `Y.Doc` per progetto, mappa
  path→testo): qui sparisce il last-write-wins.
- Persistenza: materializzare i `Y.Doc` nei `files/` (con debounce) così compile
  ed endpoint attuali continuano a funzionare senza cambiare nulla.
- Poi: auth sul websocket `/collab`, asset binari, riconnessione.

---

## (contesto precedente) Dove vengono registrati file e modifiche, oggi

I file stanno sul server, in `data/projects/<id>/files/`, dentro il volume Docker `alumere-data` (persistono ai riavvii). Ogni progetto ha anche un `meta.json`.

L'attribuzione sta nel `meta.json`: `createdBy` (chi ha creato → di fatto l'owner) e `updatedBy` + `updatedAt` (chi ha salvato per ultimo e quando).

⚠️ Quello che **non c'è ancora** è la parte "history" di Overleaf: niente versioni passate, niente diff. Il salvataggio (PUT) riscrive interamente la cartella `files/`, quindi le versioni precedenti non vengono conservate. Oggi vedi chi ha creato/modificato per ultimo, ma non cosa è cambiato nel tempo. Va costruita.

## Come funziona davvero Overleaf

Overleaf **non** usa un repo git per progetto per la sua cronologia (precisazione rispetto a quanto detto inizialmente).

- L'editing in tempo reale è basato su **OT (Operational Transformation)**: ogni modifica è un'"operazione" (inserisci/cancella a livello di caratteri). È questo che permette a più persone di scrivere insieme nello stesso istante.
- La cronologia è costruita da un servizio dedicato (storicamente `track-changes`, oggi `project-history`) che conserva quel flusso di operazioni più degli snapshot, salvando i contenuti come blob indirizzati per contenuto in un proprio datastore. Da lì nascono la timeline, i diff fine-grained e il "chi ha cambiato cosa".
- **Git in Overleaf** esiste solo come integrazione esterna (il *git bridge*: cloni/pushi il progetto via git), che è una cosa diversa da come la history è memorizzata internamente.

Quindi è un sistema **OT + servizio-di-storia su misura**, non `.git` per progetto. È anche piuttosto pesante: strettamente legato al motore di collaborazione real-time.

## Perché era stata proposta la via git

Non perché sia "come fa Overleaf", ma perché è il modo più semplice e robusto per ottenere lo stesso risultato visibile (timeline + autore + diff + ripristino) alla nostra scala, senza costruire un intero motore OT. E combacia con come l'app salva oggi: un PUT = l'intero progetto → un commit = un salvataggio. La granularità è "per salvataggio" (più grossa del carattere-per-carattere di Overleaf), che è esattamente ciò che ha senso col modello attuale.

## Il collegamento col futuro

La history "vera" stile Overleaf è accoppiata alla collaborazione in tempo reale — già prevista in roadmap con **Yjs + Hocuspocus**. Yjs è un CRDT: il suo log di update permette di ricostruire qualunque stato passato, quindi con il real-time la cronologia fine-grained potrà nascere da lì.

In sintesi:

- **Adesso**, per avere subito la UX history+diff: git per progetto (o snapshot) è la scelta giusta-dimensionata.
- **Più avanti**, con Yjs, la cronologia diventa naturale e granulare come quella di Overleaf, senza git.

## Sicurezza / controllo di accesso

L'auth attuale è solo "fase 1": gate sulle scritture + attribuzione. Ma:

- **le letture sono aperte**: `GET /api/projects` e `GET /api/projects/:id` non chiedono identità → chiunque raggiunga il server vede e scarica tutti i progetti senza digitare un nome (l'overlay blocca solo la UI lato client, non l'API);
- anche `/api/compile` è aperto (qualcuno potrebbe far girare `latexmk` a vuoto).

Finché si è in pochi su localhost/rete privata, è accettabile. Nel momento in cui si apre agli altri / su internet, questo è il buco da chiudere prima di costruirci sopra la collaborazione.

**Decisione presa:** non ci sono ancora progetti reali caricati (si vuole avere tutto pronto e sicuro prima di lavorare con dati sensibili), quindi la sicurezza può aspettare.

## Push del lavoro di stamattina

- Repo trunk-based (tutto su `main`), remote = `Paul-Gnata/alumDocs` via HTTPS.
- Solo le modifiche dell'auth (6 file modificati + `public/auth.js` nuovo), niente file spuri.
- Commit creato: `c82cfbb`
- Push: `ee9abc2..c82cfbb main -> main` ✅ Il lavoro di stamattina (identità + attribuzione) è ora tracciato sul remote.

## Collaborazione real-time — Architettura proposta (Yjs + Hocuspocus)

- **Server**: integrare Hocuspocus (server CRDT su websocket) sullo stesso porto di Express (upgrade ws su `/collab`) → niente modifiche al compose. Persistenza: a ogni sync (con debounce) materializzare i file in `files/`, così compilazione ed endpoint attuali continuano a funzionare senza cambiare nulla; al primo caricamento il `Y.Doc` si inizializza dai `files/` esistenti.
- **Client**: estendere il bundle esbuild (`build/cm-entry.mjs`) con `yjs` + `y-codemirror.next` + `@hocuspocus/provider`; legare il file attivo al `Y.Text` di CodeMirror; cursori e presenze colorati col nome (vantaggio di aver fatto prima l'identità).
- **Attrito da sapere**: si aggiungono dipendenze vere, serve un rebuild dell'immagine (`--build`) e un rebuild del bundle del client. Node non è sull'host, quindi il bundle va ricostruito dentro il container.

### Piano a tappe

- **M0 — Fondamenta (spike)**: un documento condiviso che si sincronizza dal vivo tra due schede, con presenze/cursori. Prova la pipe end-to-end (deps + bundle + ws + Docker). Piccola, elimina i rischi grossi. → ✅ **fatto il 2026-07-05 (vedi sezione in cima).**
- **M1 — Integrazione progetto**: un `Y.Doc` per progetto (mappa path → testo), editor legato al file attivo, persistenza che alimenta `files/`, albero multi-file live. Qui sparisce il last-write-wins.
- **M2 — History "vera"**: snapshot Yjs → pannello cronologia (timeline + autore + diff + ripristino), stile Overleaf, costruito sul log Yjs.
- **Dopo**: asset binari (restano non-collaborativi), riconnessione, e auth sul ws quando si farà il gate.

### Da confermare prima di partire

1. WS sullo stesso porto (3000, niente cambi al compose) — ok? (alternativa: porto dedicato)
2. Via libera ad aggiungere le dipendenze + un rebuild dell'immagine (la M0 tocca `package.json` e il bundle).

> ✅ **Entrambe risolte nella sessione del 2026-07-05** (vedi sezione in cima): WS su `/collab`, stesso porto 3000, nessuna modifica al compose; dipendenze aggiunte + bundle e immagine ricostruiti.
