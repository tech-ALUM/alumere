# alumDocs — Riepilogo avanzamenti e decisioni

> Diario di bordo del progetto: **leggi questo file a inizio sessione** per essere
> subito sul pezzo (stato attuale, scelte fatte e perché, prossimi passi). Le
> sezioni datate in alto sono le più recenti; sotto resta il contesto di design di
> base. (Ex `alumDocs_latexUpdates.md`.)

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
