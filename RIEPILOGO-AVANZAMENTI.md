# alumDocs — Riepilogo avanzamenti e decisioni

> Diario di bordo del progetto: **leggi questo file a inizio sessione** per essere
> subito sul pezzo (stato attuale, scelte fatte e perché, prossimi passi). Le
> sezioni datate in alto sono le più recenti; sotto resta il contesto di design di
> base. (Ex `alumDocs_latexUpdates.md`.)

---

## 2026-07-20 — Giro 6: collasso pannelli + spell-check IT/EN + popup autocomplete leggibile ✅ (in attesa del check di Tommy)

Tre richieste di Tommy (con screenshot): **① frecce per chiudere editor o PDF** sul divisorio
(alla Overleaf), **② spell-check** con sottolineatura a puntini rossi, suggerimenti al tasto
destro, dizionari **italiano + inglese** e parole custom **per progetto**, **③ il popup
dell'autocomplete LaTeX illeggibile** in tema scuro. Niente rebuild del bundle CM6 (le
decorazioni erano già esportate dal giro 4); tocca i 3 file client + `server.js` (persistenza
dizionario) + nuovi asset vendorizzati.

**① Collasso pannelli** (`editor.html`/`app.js`/`styles.css`)
- Due chevron a metà del divisorio editor/PDF: **›** = divisorio a destra (chiudi il PDF, o
  riporta l'editor), **‹** = divisorio a sinistra (chiudi l'editor, o riporta il PDF). Il verso
  non cambia mai significato; da collassato resta solo il chevron che ripristina.
- Il pannello collassato **resta nel grid** con colonna `0px` (un `display:none` farebbe slittare
  le colonne dopo di lui) e sparisce con `visibility:hidden` (a 0px i suoi bordi si vedrebbero
  ancora). Divisorio parcheggiato = niente drag né hover; freccia SyncTeX nascosta.
- **Tutto ciò che porta al sorgente riapre l'editor collassato** (`revealEditor` in `openFile`,
  `gotoIssue`, `gotoThread`): click sull'albero, riga d'errore, card di review, inverse search.
  Il PDF si ri-adatta da solo (ResizeObserver già in essere; il fix `clientWidth=0` del giro 3
  copre il caso "compile col PDF chiuso").

**② Spell-check** — la scelta grossa: **due motori diversi, uno per lingua**, in un **Web Worker**
(`public/spell-worker.js`) così parsing e lookup non toccano mai il thread dell'editor.
- **Inglese**: Typo.js (hunspell in JS, BSD, vendorizzato in `public/vendor/typo/`) su
  `en_US.aff/.dic` LibreOffice — 123k forme ≈ 30MB di hash, ok, e il suo `suggest()` è buono.
- **Italiano**: Typo.js **esplode** — l'espansione completa di it_IT è ~3.1M forme e coi prefissi
  di elisione (`l'`, `dell'`, …) in cross-product coi suffissi verbali **sfonda il limite delle
  Map di V8** (~16.7M) dopo 23s. Soluzione in due mosse: (a) i 142 prefissi con apostrofo sono
  **strippati dall'.aff** (one-off, finiscono in `elisions.json`) e ri-applicati a runtime
  (`prefisso' + parola nota` — stesso insieme accettato, frazione della memoria); (b) le 3.1M
  forme rimanenti vivono in un **filtro di Bloom precalcolato** (`it-words.bloom`, 9MB, K=17,
  falsi-accetti ~1e-5 — dimensionato per il suggest, che sonda ~1k candidati a parola) generato
  da `build/build-spell-bloom.mjs` (rigenerarlo: `docker exec alumere-dev node
  /app/build/build-spell-bloom.mjs`). In alternativa sarebbero stati **~400MB di RAM** nel worker
  (misurati). ⚠ Bug trovato costruendolo: `fnv(...) | 1` reinterpreta l'hash come int32
  **negativo** → metà dei probe finiva su indici negativi che la Uint8Array **ingoia in
  silenzio** (parole "aggiunte" ma mai ritrovate) — servì il `>>> 0`.
- **Cosa si controlla**: tokenizzazione full-doc (fino a 500KB) con **maschere** per ciò che non è
  prosa — commenti, `$…$`/`\[…\]`, `\comandi`, e gli argomenti "codice" (`\ref`, `\cite`,
  `\usepackage`, `\includegraphics`, `\href`, ecc.). La parola sotto il cursore non viene
  flaggata mentre la scrivi. Cache dei verdetti condivisa tra file; ricontrollo debounced su
  edit (anche remoti) e cambio selezione.
- **Sottolineatura**: `Decoration.mark` in uno StateField (si rimappa da sé ad ogni edit, come le
  evidenzie dei commenti) + puntini rossi CSS (`text-decoration: dotted #e5484d`).
- **Tasto destro su una parola flaggata** → menu con suggerimenti (delle due lingue
  interfogliati) + **"Add … to the project dictionary"**; su parola non flaggata resta il menu
  nativo. Ranking "fix più plausibile prima": trasposizione (wehn→when) e solo-accenti
  (perche→perché) > coppia REP (qesto→questo — aggiunte a mano q→qu e gli accenti: l'.aff ne ha
  solo 4) > sostituzione > cancellazione/inserzione; il suggerimento rispetta la maiuscola
  (Wehn→When). Il primo giro aveva il fix giusto sepolto o assente (cap troppo aggressivo sui
  candidati): ora si generano tutti i ~1k candidati d1 (un probe Bloom l'uno) e si ranka dopo.
- **Dizionario di progetto**: `Y.Array("dict")` nello stesso doc Yjs → sync live a tutti i peer,
  persistito come **`dictionary.json`** accanto a `chat.json` con gli stessi hook (seed in load,
  riscrittura solo-se-cambiato → non tocca `updatedAt`). "Add to dictionary" toglie la
  sottolineatura **ovunque, per tutti**. Worker rotto/asset mancanti → spellcheck spento in
  silenzio, l'editor vive (posture dei commenti senza bundle).
- **Licenze**: en_US = SCOWL (permissive), **it_IT = GPL-3** (file di dati LibreOffice; README
  in `public/vendor/typo/`), Typo.js = BSD modificata. Da tenere presente se un domani si
  ridistribuisce il codice.

**③ Popup autocomplete**: la causa era **tema app scuro + popup CM6 col fondo chiaro di
default** → testo `--muted` chiaro su fondo quasi bianco. Ora il tooltip segue la **palette
dell'editor** (`--ed-bg/--ed-fg`, bordo in color-mix), dettagli in corsivo leggibili, match
evidenziato in `--ed-cursor`, riga selezionata accento con testo `--accent-ink` (anche il
dettaglio). Leggibile in tutte e 4 le palette, chiaro e scuro.

**Verificato** (dev :3000, browser reale, due client per il sync, chiaro + scuro, console pulita,
`test/smoke.sh` **16/16**)
- **Collasso**: › → editor a tutta larghezza col solo ‹ sul bordo; ‹ ripristina; editor chiuso →
  PDF/Log a tutta larghezza; click su un file nell'albero **riapre l'editor**; drag del divisorio
  intatto da aperto, morto da collassato.
- **Spell**: sul campo di prova di Tommy (`wehn i was a chidl` in math.tex) flagga **esattamente**
  `wehn`/`chidl` (non "Euler's", non la matematica, non `\beg`); tasto destro su `wehn` → **when**
  primo → click → riga corretta (poi ripristinata com'era). Italiano: "Qesto è sbagliatto perche
  l'altro va bene" → flaggati solo Qesto/sbagliatto/perche (è, l'altro, va, bene puliti — elisione
  riconosciuta); `perche`→**perché** primo, `Qesto`→**Questo** primo (maiuscola rispettata).
  **Add to dictionary** su "Alumère" (che i dizionari non conoscono): sottolineatura sparita
  **in entrambi i client all'istante**, `dictionary.json` scritto con la parola.
- **Popup**: `\beg` in Pastel Light e in **Slate Dark** (lo scenario dello screenshot di Tommy) →
  leggibile in entrambi; menu spell leggibile in chiaro e scuro.
- ⚠ Residui di verifica, dichiarati: "Alumère" **resta nel dizionario** del progetto Sample paper
  (sensato, direi da tenere); i miei edit di prova su math.tex sono stati **ripristinati al
  carattere**, ma restano 2-3 versioni auto in history e l'`updatedAt` è avanzato (le versioni
  scadono con la retention). Le righe `wehn i was a chidl` e `\beg` di Tommy sono rimaste **come
  le ha lasciate** (servono a lui per provare lo spell-check :).
- Inciampo del tool browser, nuovo per il diario: dopo un cambio tema via JS il **compositor
  headless non ridipinge** le regioni non toccate — gli screenshot mostravano la palette vecchia
  con gli stili computati già nuovi; un resize della finestra forza il repaint. (Le sonde sui
  computed style non mentivano; gli occhi sì.)

**Pesi nuovi nel repo**: `it-words.bloom` 9MB + dizionari ~2MB + typo.js — tutto statico, niente
CDN a runtime, il Dockerfile li copia e basta. **Nessun rebuild del bundle CM6.**

**Rimandato di proposito**: rimozione di una parola dal dizionario di progetto (per ora solo
add; si può editare `dictionary.json` a progetto chiuso), scelta della lingua per progetto
(oggi IT+EN sempre attivi insieme), spell nei commenti/chat.

**Processo**: implementato e verificato, **niente commit** — aspetto il check di Tommy.
⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-18 (novies) — Parità Overleaf, giro 5/5: Review panel + Chat ✅ (in attesa del check di Tommy)

Quinto e ultimo giro dell'arco "parità Overleaf", sul disegno chiesto da Tommy (screenshot Overleaf):
**rail di icone** a sinistra con 3 pulsanti — **Files / Review / Chat** — che **scambiano** il contenuto
della colonna sinistra (un pannello per volta, alla Overleaf nuovo). Files = l'albero di sempre;
**Review** = tutti i thread di commento del progetto (aperti, risolti, **orfani**) con salto-al-testo,
reply, resolve/reopen, delete; **Chat** = chat di gruppo del progetto. **Niente rebuild del bundle**
(solo DOM + tipi Yjs già nel bundle): file statici + 2 blocchi in `server.js`.

**Cosa c'è ora**
- **Rail** (`editor.html` + CSS): prima colonna del grid (46px), icone SVG a tratto, stato attivo
  in accento; **badge** rossi sul rail — su Review il conteggio dei thread aperti, su Chat i
  **non letti** (messaggi altrui arrivati a pannello chiuso; si azzera aprendo). I pannelli nascosti
  **escono dal grid** (`.pane[hidden]{display:none}` — il trappolone `[hidden]` vs author-CSS,
  **quarta** apparizione, stavolta previsto in anticipo).
- **Review panel** (`app.js`): card per thread in ordine di documento (file, poi posizione) con path,
  citazione cliccabile (**salto cross-file**: apre il file, cursore sul range, popover del thread —
  riusa `resolveAnchor`), messaggi con avatar/menzioni, reply con @autocomplete (stesso `mentionArea`;
  l'email di menzione parte col **path del thread**, non del file aperto), ✓ Resolve / ↺ Reopen
  (che ributta l'evidenzia se il testo esiste ancora), 🗑 con confirm. Tab **Open / Resolved**;
  i thread il cui testo non c'è più portano la targhetta **"text deleted"** (o "file deleted") —
  sono i "orfani" promessi dal giro 4. Il pannello legge lo stato **dalla `filesMap` condivisa**,
  quindi funziona anche per file non aperti nell'editor.
- **Chat**: `Y.Array("chat")` di oggetti piani `{id, by, at, text}` nello stesso doc → sync live
  gratis; messaggi consecutivi della stessa persona entro 3′ **si impilano** sotto un solo header;
  Enter invia (Shift+Enter va a capo), textarea che si auto-allarga, scroll incollato al fondo solo
  se ci sei già (chi legge la storia non viene strattonato). Empty state alla Overleaf.
- **Server**: `chat.json` accanto a `comments.json` (fuori da `files/`: non è un sorgente), stesso
  identico pattern — seed in `onLoadDocument` se l'array è vuoto, riscrittura in `onStoreDocument`
  **solo se cambiata** → un salvataggio di sola chat è "no change" per i file, **`updatedAt` fermo**
  (verificato: messaggi delle 16:12/16:16, `updatedAt` rimasto alle 16:06).

**Bug latente del giro 4 trovato e sistemato strada facendo**: `openThreads` ri-mostrava il popover
**dopo** che `renderThreadPopover` l'aveva chiuso (caso "tutti i thread morti nel frattempo") →
**pillola bianca vuota** sull'editor. Emergeva col salto dalla card: il popover si apre in un
`requestAnimationFrame`, e i frame possono arrivare **tardi** (tab in background) — se nel frattempo
il thread è stato risolto/cancellato, boom. Fix doppio: guardia in `openThreads` (se il render l'ha
chiuso, non ri-mostrare) + ricontrollo del thread dentro il rAF di `gotoThread`.

**Contorno**: ripulite le ultime stringhe italiane sfuggite al giro i18n — "(tu)" → "(you)" negli
avatar, "Sconosciuto" → "Unknown", "Torna ai progetti" → "Back to projects".

**Verificato** (dev :3000, browser reale, due utenti veri, chiaro + scuro, console pulita, `test/smoke.sh` 16/16)
- **Rail**: i 3 pulsanti scambiano il pannello; layout a 6 colonne col rail; splitter intatti.
- **Review**: commento creato su "godeeee" → card nel tab Open + badge "1" + evidenzia ambra;
  **salto cross-file** (da intro.tex la quote riporta su main.tex col cursore esatto sul range);
  reply dal pannello (thread a 2 messaggi); **Resolve dal pannello** → evidenzia sparita, badge a 0,
  card migrata in Resolved con riga "✓ Resolved by …"; **Reopen** → evidenzia e badge tornano;
  **orfano**: cancellato "godeeee" dal sorgente → card flaggata "text deleted", thread vivo;
  testo ripristinato e thread di test eliminato (confirm). I 2 thread risolti del giro 4 al loro posto.
- **Chat a due utenti** (DemoAccount + Paolo Rossi via magic-link, due tab): messaggio → compare
  nell'altro tab; risposta di Paolo → **badge non-letti "1"** sul rail del tab con la chat chiusa,
  si azzera aprendola; avatar/nomi/ore giusti. `chat.json` su disco coi 2 messaggi; log store sempre
  "**no change**".
- **Tema scuro**: review card e chat leggibili su `--panel/--ink/--line` (screenshot).
- ⚠️ Residuo voluto: i **2 messaggi di prova restano in chat** — un tab esterno (TP) tiene il doc
  vivo in memoria e ri-semina a ogni riavvio, quindi svuotarla ora è inutile; sono contenuto
  dimostrativo, si tolgono cancellando `chat.json` a progetto chiuso da tutti.
- Inciampo di verifica da ricordare: le coordinate manuali del tool browser sono in **spazio
  screenshot** (×1.6 rispetto ai CSS px del viewport) — tre click "fantasma" prima di capirlo;
  i click sui `ref_N` invece riportano CSS px. (E un rAF **non scatta** finché il tab non renderizza
  un frame: è così che si è palesato il bug del popover.)

**Processo**: regola nuova rispettata — implementato e verificato, **niente commit**: aspetto il
check di Tommy. ⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

**L'arco "parità Overleaf" (5 giri) è completo.** Prossimo: quello che Tommy decide — in lista
restano sicurezza giro 2 (allowlist/ACL), template (Step G), tag in massa, cestino.

---

## 2026-07-18 (octies) — Parità Overleaf, giro 4/5: Commenti stile Word ✅

Quarto giro dell'arco "parità Overleaf": **commenti ancorati al testo** con **@menzioni** ed
**email all'actionee**. Selezioni → compare un bottone 💬 accanto alla selezione → popover con
citazione del testo scelto e campo commento; digitando `@` si apre l'autocomplete sull'anagrafica
(D2) e la persona menzionata riceve una **email** col progetto linkato. Il testo commentato resta
**evidenziato in ambra**; click sull'evidenzia → **thread** (messaggi con avatar/ora, menzioni
colorate, risposta, ✓ Resolve, 🗑 Delete). È il giro che richiedeva il **rebuild del bundle CM6**
(decorazioni) — fatto in container Node usa-e-getta, bundle committato.

**Dove vivono i dati (la scelta di fondo)**
- I thread stanno in una **`Y.Map("comments")` dello stesso doc Yjs** (valore = oggetto piano):
  sync live a tutti i peer **gratis** (stesso canale dei file, zero endpoint nuovi) e persistenza
  che cavalca gli stessi hook: `onLoadDocument` semina la mappa da **`comments.json`** (accanto a
  `meta.json`, FUORI da `files/` — un commento non è un sorgente: non entra in compile, zip o
  history) e `onStoreDocument` la riscrive **solo se è cambiata**. Un salvataggio di soli commenti
  è "no change" per i file → **`updatedAt` non si muove** (come archivia/tag).
- **D1 — ancoraggio best-effort `{from, to, snippet}`** (le relative-position Yjs non sopravvivono
  al rebuild del doc da disco): mentre il file è aperto le decorazioni CM6 **si rimappano da sole**
  a ogni edit (locale e remoto — passano tutti dalla stessa pipeline di transazioni); il client che
  **edita** riscrive gli anchor "assestati" nella mappa (debounce 2s, solo se qualcosa si è mosso →
  niente ping-pong fra viewer); alla riapertura, se gli offset sono stali, lo **snippet rilocalizza**
  l'occorrenza più vicina. Testo commentato cancellato → l'evidenzia sparisce, il thread resta
  (lo mostrerà il review panel del giro 5).
- **D2 — `users.json` popolato al login**: upsert `{id, name, lastLoginAt}` a ogni verify (lock a
  catena di Promise come tags.json) + `GET /api/users` per l'autocomplete. Si può menzionare **solo
  chi ha già fatto login**.
- **Email = unica cosa che il client non può fare da sé** → endpoint minimale
  `POST /api/projects/:id/mentions`: destinatari validati contro `users.json` (niente mail cannon),
  no auto-notifica, cap 30/10min per mittente, SMTP off → log (stesso pattern del magic link).

**Rebuild del bundle**: `build/cm-entry.mjs` ora esporta anche `Decoration/WidgetType/ViewPlugin`
(view) e `StateField/StateEffect/RangeSet/RangeSetBuilder/Transaction` (state) — servono alle
decorazioni e a distinguere le transazioni utente (write-back solo sui MIEI edit). Il fallback CDN
di `loadCodeMirror` li ha già (moduli interi); bundle assente/vecchio → commenti spenti in silenzio,
il resto dell'editor vive.

**Verificato** (dev container :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh` 16/16)
- **Flusso intero a schermo**: selezione "compiled" → 💬 → popover con quote → `@pa` filtra
  l'anagrafica → pick "Paolo Rossi" → Comment → evidenzia ambra; click → thread (autore, ora,
  menzione colorata) → Reply → secondo messaggio nel thread.
- **Server**: email di menzione loggata (SMTP off) con mittente/progetto/file/testo giusti;
  `comments.json` scritto col thread completo; log store = "**no change**" → `updatedAt` fermo.
  `users.json` popolato da due login veri via magic-link (Paolo Rossi, Maria Delcarmen).
- **D1 sul campo**: riga inserita SOPRA il commento → l'evidenzia resta su "compiled" (rimappa
  live) e dopo il debounce l'anchor su disco passa 345→383 (**esattamente** i +38 caratteri);
  **reload** → l'evidenzia si ricostruisce giusta. **Due tab sullo stesso progetto**: il commento
  appare nel secondo tab; **✓ Resolve dal tab 2 → l'evidenzia sparisce in ENTRAMBI all'istante**.
  Delete con confirm → thread rimosso ovunque e da `comments.json`.
- **Tema scuro**: composer/popover sulle variabili `--panel/--ink/--line` → leggibili in dark.
- Progetto "Sample paper" **riportato intatto** (riga di test rimossa; resta solo il thread di
  prova risolto, invisibile finché non c'è il review panel).
- ⚠️ Inciampo del tool browser (già noto dal giro rinomina): Enter/BackSpace sintetici non arrivano
  agli handler — verificato con click reali e `execCommand`; per gli utenti veri la tastiera va.

**Due fix dal check di Tommy** (provato sul campo, stessa sessione)
1. **La selezione del testo non si vedeva** (né per commentare né per copia/incolla). Non c'entrano
   i commenti: CM6 disegna la selezione su un layer **dietro** gli sfondi delle righe, e la nostra
   riga attiva era **opaca** (`--ed-active-line` con `!important`) → copriva la selezione proprio
   dove si seleziona quasi sempre (la riga attiva; le selezioni corte ci vivono per intero). Fix:
   riga attiva = **velo translucido rgba** in tutte e 4 le palette (tinta calcolata per rendere a
   schermo come il colore di prima) → la selezione traspare. Nota a futura memoria nel CSS: quel
   valore DEVE restare translucido.
2. **Il bottone 💬 restava lì** anche cliccando altrove. Due cause, in due giri di check:
   la logica (ora si nasconde quando l'editor **perde il focus**, e alla Word **creare il commento
   consuma la selezione** — collassa + focus all'editor, così il fab non rispunta sul testo appena
   commentato; il mousedown del fab resta `preventDefault`, quindi cliccarlo non perde la selezione)
   — ma soprattutto **il solito `[hidden]` battuto dall'author-CSS**: `.comment-fab` ha
   `display:grid`, che vince su `[hidden]{display:none}` → `fab.hidden = true` settava la proprietà
   (le mie sonde JS dicevano "hidden") ma il bottone **restava disegnato**. È la **terza volta** che
   questo trappolone morde il progetto (`.projname-btn`, `.editor-empty`, ora `.comment-fab`):
   regola pratica — ogni elemento nascosto via attributo `hidden` che ha un `display` proprio nel
   CSS DEVE avere anche la riga `X[hidden]{display:none}`. E lezione di verifica gemella di quella
   synctex: **una proprietà non è una prova visiva** — il check va fatto sul pixel (screenshot),
   non sul flag che il codice stesso setta.

**Riverificato in browser** dopo i fix (chiaro + Slate Dark, console pulita): doppio-click su una
parola della riga attiva → selezione **visibile** in entrambe le palette; click sul PDF → fab
**sparito a schermo** (screenshot, non più solo la proprietà); commento creato → fab non ricompare,
selezione collassata; evidenzia ambra leggibile anche su fondo scuro. I miei commenti temporanei
di test rimossi.

**Alla domanda di Tommy**: sì, la **colonna sinistra con review panel + chat** non c'è ancora —
è il **giro 5** del piano (panel = lista/gestione dei commenti, anche risolti e orfani; chat).

**Processo**: prima applicazione vera della regola nuova — implementato, verificato, **Tommy ha
provato** (e trovato i due difetti sopra, corretti e riprovati), **OK arrivato → commit+push**.
**Email di menzione**: in dev l'SMTP resta spento (mail nel log); predisposto comunque il
passthrough opzionale delle variabili `SMTP_*` in `docker-compose.dev.yml` (default vuoti = spento,
si attiva con un `.env` locale) — ma la **prova con una mail vera si farà direttamente sul live**,
dove l'SMTP è già configurato. ⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

**Prossimo:** **giro 5 — Review panel + Chat** (panel = lista/gestione dei commenti, anche risolti
e orfani; chat = `Y.Array("chat")` + `chat.json` con lo stesso pattern di persistenza dei commenti).

---

## 2026-07-18 (septies) — SyncTeX: fix sfasamento di una riga (punti, non box) + freccia visibile ✅

Secondo giro di prova sul campo di Tommy dopo il fix del pollice: meglio, ma l'inverse atterrava
**sempre una riga sotto** quella cliccata. Causa: le **hbox** synctex (che usavo per il containment)
portano la riga dove il paragrafo/item **finisce** — il box di un bullet si chiude dove inizia il
successivo. I **record puntuali** (kern/glue/current), invece, vengono emessi man mano che la riga
sorgente avanza: la loro attribuzione segue la riga visiva da vicino, ed è pure **sensibile alla
colonna** (i punti di fine riga visiva appartengono già alla riga sorgente successiva).

**Cosa è cambiato** (`app.js`)
- **Inverse = punto valido più vicino** (peso verticale 3x; il containment sui box resta solo come
  fallback per synctex degeneri senza punti). I punti di file **non-progetto** (.aux/.toc, classi)
  sono filtrati con `hasPath` *prima* della scelta, così non rubano il click al testo vero accanto
  (es. le righe del TOC ora risolvono sui punti del sorgente vicino, non su `main.toc`).
- **Forward = mediana dei punti della riga**: scarta sia il punto vagante di fine-riga-precedente sia
  i box altrui attribuiti alla riga. La **banda** ora si aggancia alla geometria del box di riga vero
  sotto lo spot (solo geometria, l'attribuzione non conta) → abbraccia il testo invece di stargli
  sopra; su `\begin{equation}` evidenzia l'intero blocco equazione.
- **Freccia sul divisorio più visibile** (Tommy non la trovava): 30px (era 22), icona 16, ombra, e
  posizionata al **25% dell'altezza** della barra — a metà si mimetizza, in cima sfugge.

**Verificato** (click veri su punti scelti a schermo, console pulita) — tutti i bersagli **esatti**
(prima tutti +1): i 3 bullet → `intro.tex:6/7/8`; riga di Eulero → `math.tex:2`; click a metà del
paragrafo "ciaooo seee godeeee" su "seee" → `main.tex:27` (**column-aware**); equazione
sull'integrale → `math.tex:3` (l'env — i punti del contenuto stanno sulla parte destra della
formula). Forward su abstract/item/equation: banda sempre sulla riga giusta, misurata al bp
(es. riga 18 → banda [309,321] con baseline a 317). Freccia: centro a 218px = 25% esatto, il click
non avvia il drag.

**Processo (nuova regola, richiesta di Tommy):** d'ora in poi **niente commit/push senza il suo
check** — implementa → verifica → Tommy prova → OK → commit+push (diario incluso). Vale da subito;
i due giri di fix di oggi committati al volo sono esattamente il caso da evitare.

---

## 2026-07-18 (sexies) — SyncTeX: fix sfasamento di 1 pollice + freccia sul divisorio ✅

Tommy ha provato il giro 3 sul campo e **l'ha bucato subito**: forward sull'abstract evidenziava la
riga dell'autore, inverse simmetricamente sfasato (Eulero → "Così com e?", bullet → file/righe a caso
apparente). Lo schema c'era eccome: **tutto sfasato di esattamente 1 pollice (72bp) verso l'alto**.

**La causa** — le coordinate synctex **non sono coordinate di pagina**: sono relative all'**origine
TeX**, che sta (1in,1in) dentro l'angolo alto-sinistro. E gli engine differiscono: pdflatex/lualatex
*cuociono* il pollice nei valori e scrivono `X/Y Offset:0` nell'header; **xelatex** (il nostro default)
scrive valori relativi all'origine e mette il pollice **negli header Offset** (verificato compilando
con tutti e tre nel container). Il parser ignorava gli header → con xelatex mancava un pollice. Fix:
**pagina = raw + offset dall'header**, niente hardcode (un +72 fisso raddoppierebbe su xelatex).

**Perché i test del giro 3 non l'avevano preso**: erano **circolari** — confrontavano l'output del
codice coi valori synctex grezzi, non con la posizione **visiva** del testo. (L'unica lettura davvero
visiva diceva il giusto, e l'ho scartata "correggendo" i conti con l'ipotesi Letter-vs-A4 che faceva
quadrare i numeri circolari.) Lezione da diario: **la verifica di un mapping va ancorata a un
riferimento esterno** (qui: click reali su testo individuato a schermo), mai ai dati che il mapping
stesso produce.

**Più UX su richiesta di Tommy**: il bottone forward lascia l'header della preview e diventa una
**freccia → sulla barra divisoria** editor/PDF, stile Overleaf (tonda, `mousedown` fermato così
premerla non avvia il drag del divisorio; visibile anche dal tab Log — il salto porta da sé al PDF).

**Verificato** (browser reale, click veri su punti scelti a schermo — non più sintetici, console pulita)
- **I 3 esempi esatti di Tommy**: bullet "An editor with command autocomplete" → `intro.tex:8`;
  riga di Eulero → `math.tex:3`; equazione → `math.tex:5`; più "ciaooo" → `main.tex:29` e titolo →
  `main.tex:15`. (±1 riga = attribuzione a fine-paragrafo di synctex, come Overleaf.)
- **Forward**: cursore su riga 17 → banda a [297,308]bp con la prima riga dell'abstract a baseline 305.
- **Divisorio**: la freccia salta al PDF; il **drag funziona ancora** (provato avanti e indietro).

---

## 2026-07-18 (quinquies) — Parità Overleaf, giro 3/5: SyncTeX ✅

Terzo giro dell'arco "parità Overleaf": **SyncTeX** nei due sensi. **Forward** = bottone **⌖ Locate**
nell'header della preview: la riga del cursore → banda evidenziata sul punto corrispondente del PDF
(sfuma in ~2s) + scroll lì. **Inverse** = **doppio-click sul PDF** → si apre il file giusto col cursore
sulla riga (riusa `gotoIssue`, quindi anche cross-file: doppio-click su un bullet dell'intro apre
`sections/intro.tex`). Come da **D3**: parse **interamente client-side**, gunzip in browser via
`DecompressionStream` — **zero dipendenze nuove, nessun rebuild del bundle**.

**Cosa c'è ora**
- **Server** (2 ritocchi a `server.js`): `-synctex=1` fra i flag di latexmk; `/api/compile` ritorna
  anche `main.synctex.gz` in base64 + `synctexRoot` (la temp-dir) per normalizzare i path degli
  `Input:` (`/tmp/alumere-x/./sections/intro.tex` → `sections/intro.tex`).
- **Client** (`app.js`): parser del sottoinsieme synctex che serve — record dentro i blocchi `{pagina}`,
  hbox `(tag,riga:x,y:w,h,d` con estensioni, record puntuali `x/k/g/$/v` — indicizzato nei due sensi:
  `(file,riga) → spot` per il forward, `pagina → box/punti` per l'inverse. Coordinate in sp dall'alto
  della pagina (stessa orientazione del canvas): conversione diretta in punti PDF (`/65781.76`).
- **Forward**: riga senza record (commento, riga vuota) → si aggancia alla prima riga successiva che ne
  ha; fra i record della riga **preferisce le hbox vere** (glue/kern "vaganti" sulla stessa riga possono
  stare ben sopra il testo). La banda vive **dentro `.pdf-pages`** (position:absolute): il pinch la
  scala con le pagine e un re-render la pulisce da solo.
- **Inverse**: vince la **hbox più piccola** che contiene il click (le nidificate → la più specifica);
  click nei margini → record più vicino, pesando di più la distanza verticale. File fuori progetto
  (classi/pacchetti TeX) scartati con `hasPath`.
- Il bottone Locate compare solo con PDF **e** synctex in mano (stesso pattern della zoom bar in
  `showTab`); compile fallito → restano PDF e synctex **vecchi e coerenti fra loro**.

**Scelte (e perché)**
- **Parse client-side (D3 confermata)**: il server resta stateless (una riga di lettura file in più);
  niente endpoint di query synctex, niente stato per progetto.
- **Precisione = quella di synctex**: l'attribuzione è per **paragrafo** (i record portano la riga di
  fine paragrafo), quindi l'inverse può atterrare 1-2 righe sotto quella "vera" — come Overleaf.
- **Bonus (bug di robustezza sistemato)**: `computeFitScale` con pannello non impaginato
  (`clientWidth=0`, es. compile atterrato in un tab nascosto) **clampava il fit al minimo** → PDF
  minuscolo (120px). Ora larghezza 0 = mantieni il fit precedente; ci pensa la ResizeObserver quando
  il pannello torna ad avere una larghezza vera.

**Verificato** (dev container :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh` 16/16)
- **Forward al bp**: cursore su una riga dell'abstract → banda misurata a [225,236]bp = esattamente la
  baseline (233) della riga renderizzata; cross-file da `sections/math.tex` → banda sulla sezione
  "Some Mathematics". ⚠️ Inciampo di verifica utile: la pagina è **US Letter (612×792)**, non A4 —
  mezz'ora di "bug" che erano solo conversioni sbagliate nel test.
- **Inverse su 4 bersagli noti** (dispatch di dblclick a coordinate bp calcolate): riga "ciaooo" →
  `main.tex`, abstract → `main.tex:19`, TOC → `main.tex:21` esatto, bullet → `sections/intro.tex:7`
  esatto.
- **Multi-pagina** (progetto usa-e-getta via API, 2 pagine, poi eliminato): forward su riga di pagina 2
  → scroll a pagina 2 con banda in cima; inverse dal canvas di pagina 2 → riga giusta.
- Progetto "Sample paper" **intatto** (nessun edit di contenuto).

**Prossimo:** **giro 4 — Commenti** stile Word (selezione→commento ancorato, @menzione, email; D1
ancoraggio offset+snippet, D2 `users.json` al login). ⚠️ È il giro che richiede il **rebuild del bundle
CM6** (decorazioni) → committare il bundle a mano. ⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-18 (quater) — Parità Overleaf, giro 2/5: tab multi-file ✅

Secondo giro dell'arco "parità Overleaf" (dopo la rinomina). **Tab multi-file in alto**, stile VS Code /
Overleaf nuovo: apri più file → ognuno diventa un tab, click per switchare, × per chiudere. **Solo client**:
nessun endpoint, **nessun rebuild del bundle** (file statici, basta reload). I tab sono **vista personale**
(i peer non vedono i miei tab; l'awareness `activeFile` resta = file a fuoco).

**Cosa c'è ora** (`editor.html` + `app.js` + `styles.css`)
- **Barra tab** al posto della vecchia intestazione dell'editor (che mostrava un solo `#openPath`). Ogni
  tab: nome-file + × (la × compare su hover / sul tab attivo). Il tab **attivo** prende lo sfondo
  dell'editor (`--panel`) + barra accento in cima → si "salda" alla superficie sotto; gli inattivi sono
  `--panel-2` smorzati. La lista scrolla in orizzontale se i tab sono tanti; l'`auto-save` resta a destra.
- **Apertura**: qualsiasi via che apre un file (click sull'albero, salto-da-errore, ripristino history)
  aggiunge il tab se manca — `openFile` è il punto unico. **Click su un tab** = switch (ri-bind pulito
  della view CM, come già faceva il cambio-file). **Middle-click** su un tab lo chiude (come VS Code).
- **Chiusura**: la × toglie il tab; se era l'attivo passa al **vicino di destra** (poi sinistra); se non
  resta nulla → **empty-state** ("Nothing open — pick a file from Project…", editor nascosto).
- **Persistenza per progetto** (`localStorage["alumere.tabs:<id>"]` = `{open:[…], active}`): al reload la
  **workspace si ricostruisce** (tab + file attivo), scartando i path non più esistenti; se non c'è nulla
  di salvato si apre `main` come prima.
- **Coerenza con le operazioni sui file**: rinomina di file/cartella **sposta il tab in-place** (rimappa i
  path prima della mutazione, così la potatura in `onFilesChanged` lo risparmia); delete — o rimozione da un
  peer — **pota** i tab spariti; se sparisce l'attivo si passa a un tab superstite.
- **Disambiguazione**: due file con lo **stesso nome** (es. `sections/intro.tex` e `intro.tex`) mostrano la
  cartella davanti al nome finché dura la collisione; tooltip = path completo sempre.

**Scelte (e perché)**
- **Vista solo-client, non condivisa**: i tab sono "cosa sto guardando io", non stato del progetto (come
  Overleaf). Zero superficie server, zero rischio sul CRDT.
- **View ricreata al cambio tab** (invariato): un solo `Y.Text` bindato per volta → il contenuto di un file
  non può colare in un altro. I tab sono solo un elenco di path + quello attivo.
- **Empty-state con override `[hidden]`**: `.editor-empty{display:flex}` batterebbe la UA-rule
  `[hidden]{display:none}` → serve `.editor-empty[hidden]{display:none}` esplicito (stesso inciampo del
  `.projname-btn` del giro rinomina).

**Bonus (bug pre-esistente sistemato strada facendo):** il commit del tema scuro (`df54861`) aveva
**cancellato il selettore `.mini, .tabbtn {`**, lasciando orfane le regole base → i bottoni **＋file/
＋folder** e i tab **PDF/Log** erano senza padding/bordo/sfondo da qualche giro. Ripristinato (è proprio
l'area della barra tab).

**Verificato** (dev container :3000, browser reale, chiaro + scuro, console pulita per tutta la sessione)
- Apertura progressiva → **4 tab** (main/intro/math/references); **switch** cambia editor e evidenzia;
  **chiusura dell'attivo** → passa al vicino destro; **chiudi tutti** → empty-state (editor nascosto,
  messaggio giusto), e **riapertura dall'albero** ricrea il tab.
- **Persistenza**: reload → i tab tornano col file attivo giusto; un tab chiuso prima del reload **non**
  riappare.
- **Rinomina** di un file aperto → il tab segue il nuovo nome **in posizione**, resta attivo, contenuto
  preservato; **delete pota** il tab. **Disambiguazione** on/off creando ed eliminando un secondo
  `intro.tex`. Progetto "Sample paper" **riportato intatto** a fine test.

**Prossimo:** **giro 3 — SyncTeX** (forward editor→PDF + inverse doppio-click PDF→sorgente; D3 = parse
client-side, gunzip in browser via `DecompressionStream`, `-synctex=1` al compile). ⚠️ **Non è live**: file
statici → nessun rebuild del bundle, ma serve il **pull+rebuild sul VPS** (Albi).

---

## 2026-07-18 (ter) — Parità Overleaf, giro 1/5: rinomina progetto ✅

Nuovo arco di lavoro: **portare 5 cose di Overleaf** dentro Alumère (Tommy ha girato screenshot).
Piano concordato + **cadenza decisa insieme**: *una feature → verifica in browser → commit+push su
`main` → nuova sessione* per la successiva (sessioni pulite, ogni push è uno stato funzionante che
Albi porta live quando vuole).

**Le 5 feature (ordine consigliato) e le decisioni prese (D1/D2/D3):**
1. **Rinomina progetto** — *(questo giro)*.
2. **Tab multi-file** in alto (apri più file → tab; solo client, niente rebuild). *(prossimo)*
3. **SyncTeX** forward (editor→PDF) + inverse (doppio click PDF→sorgente). **D3 = parse client-side**
   (gunzip in browser via `DecompressionStream`, stateless; `-synctex=1` al compile).
4. **Commenti** stile Word (selezione→commento ancorato, @menzione *actionee*, email). **D1 = ancoraggio
   best-effort offset+snippet** (le relative-position Yjs non sopravvivono al rebuild del doc da disco).
   **D2 = `users.json` popolato al login** come anagrafica per le @menzioni (base anche per gli ACL futuri).
   ⚠️ È l'unica feature che richiede il **rebuild del bundle CM6** (decorazioni) → da committare a mano.
5. **Review panel + Chat** (chat = nuovo tipo Yjs `getArray("chat")` + `chat.json`, semplice; panel = UI dei commenti).

**Vincolo scoperto leggendo il codice:** il Dockerfile fa `npm ci --omit=dev` + `COPY . .` → CM6/esbuild
sono **devDependencies**, quindi l'immagine **NON** ricostruisce `public/vendor/codemirror.js`: usa quello
**committato**. Perciò un cambio al bundle (solo i commenti) = rebuild in container Node usa-e-getta +
**commit del bundle**; il VPS lo copia e basta.

**Cosa c'è ora (giro 1 — rinomina):**
- **Endpoint dedicato** `POST /api/projects/:id/rename {name}` (server.js). **Non** riuso `PUT /api/projects/:id`:
  quello fa `writeFiles` = `rm -rf files/` + riscrive da `files||[]`, quindi un PUT col solo `name`
  **svuoterebbe il progetto**. L'endpoint tocca solo `meta.name` (trim, cap 120) e **non bumpa `updatedAt`**
  (rinominare non è modifica di contenuto — come archivia/tag).
- **Editor** (`editor.html`+`app.js`+`styles.css`): il nome in topbar è un **menu a tendina** (`✎ Rename project`,
  stile del menu ⚙) → click apre l'**input inline** (Invio o clic-fuori = salva, Esc = annulla). Ottimistico con
  revert su errore; aggiorna nome **e** `document.title`.
- **Mirror live ai peer**: al salvataggio il client fa anche `metaMap.set("name", …)` e c'è un `metaMap.observe`
  → chi ha il progetto aperto vede il nuovo nome **dal vivo** (l'endpoint resta la fonte autorevole; il server
  ignora la chiave "name" nello store, quindi niente bump di `updatedAt`).
- **Home** (`archive.js`): nuova azione di riga **matita → Rename** (icona SVG uniforme, `prompt` + stesso endpoint).

**Intoppo (risolto):** `.projname-btn { display:inline-flex }` **batteva** l'attributo `[hidden]`
(la specificità dell'author-CSS vince sulla UA-rule di `[hidden]`) → il bottone non si nascondeva durante
l'edit inline. Fix: `.projname-btn[hidden] { display:none }`. Scoperto in browser con una sonda JS.

**Verificato** (container dev `:3000`, Node non è sull'host → tutto contro il container):
- **Endpoint via curl E2E** (login magic-link → cookie → rename): nome cambia, **`updatedAt` invariato**,
  **file NON cancellati**, casi d'errore **empty→400 / no-cookie→401 / id-inesistente→404**; `validId`
  = `/^[A-Za-z0-9_-]{1,64}$/` → niente `.`/`/`, **no traversal**.
- **Browser reale**: dropdown apre; input inline compare e **il bottone si nasconde** (post-fix); **Invio**
  committa (evento reale → persiste su disco + aggiorna titolo/nome, input rimosso, bottone ripristinato) e
  **blur** committa (clic fuori). Console pulita. Progetto riportato a "Sample paper" a fine test.
  *(Nota: il tool del browser non dispatcha un keydown Enter reale all'input — verificato che il mio handler
  parte con un `KeyboardEvent` vero; l'Invio degli utenti veri funziona.)*

**Prossimo:** **giro 2 — Tab multi-file** (solo client, niente server/bundle; propedeutico a inverse-search e
commenti cross-file). ⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-18 (bis) — Interfaccia tutta in inglese + rifiniture home ✅

Su richiesta di Tommy, **tutta l'interfaccia in inglese** (il testo/contenuto dei documenti può
restare all'occorrenza in italiano; l'UI no). Tradotte le stringhe visibili di **home**
(`index.html`, `archive.js`), **editor** (`editor.html`, `app.js`), **login** (`auth.js`) e i
messaggi **user-facing del server** (email magic-link, pagine "Confirm sign-in"/"Invalid link",
errori, template del nuovo progetto, log dev). `lang="it"` → `lang="en"` su entrambe le pagine.
I **commenti di codice** (interni, non interfaccia) sono lasciati come sono.

Più due rifiniture home:
- **Header colonne non in maiuscolo**: tolto `text-transform: uppercase` da `.proj-list-head` e
  `.side-tags-head` → "Title / Owner / Last modified / Actions" e "Tags" in sentence-case.
- **"New tag" in cima** alla sezione Tags (dopo l'intestazione, prima della lista), stile Overleaf.

**Verificato**: home ed editor ricaricati in inglese, console pulita; server riparte pulito (log ora
in inglese); sweep finale con grep → nessuna stringa italiana residua nell'UI.

*Nota:* le intestazioni dei pannelli dell'editor (PROJECT / PREVIEW / MAIN.TEX / AUTO-SAVE) restano
**maiuscole** per scelta di stile (CSS `.pane-head`) — non erano nella richiesta (era la tabella della
home); si girano in un attimo se le vuoi coerenti. ⚠️ Dev: serve il pull+rebuild sul VPS per il live.

---

## 2026-07-18 — Home stile Overleaf: lista + sidebar, azioni, archivio, tag + fix "ultima modifica" ✅

Grosso giro sulla **home**, con Overleaf come riferimento (disposizione e interazioni, non i
colori: pelle di Alumère, chiaro/scuro nostri). Da griglia di card a **due pannelli**. Tocca
`server.js` (nuovi endpoint + un fix history) e i 3 file client (`index.html`, `archive.js`
**riscritta**, `styles.css`). **Niente dipendenze nuove, niente rebuild del bundle**: file statici
+ `node --watch` → basta reload. Tutto verificato in browser (dev :3000), chiaro e scuro, console pulita.

**Decisione di fondo (Tommy):** modello **condiviso/globale**, non per-utente. Tag e archivio valgono
per tutti (è una libreria di lavoro condivisa). Niente "Tuoi/Condivisi", niente stato per-persona.
"Proprietario" = solo chi ha creato (informativo, non è controllo d'accesso — quello è sicurezza giro 2).

**Cosa c'è ora**
- **Layout a due pannelli**: topbar (brand + utente + ⚙) → **sidebar** sx (Nuovo progetto, viste, tag)
  + **main** (titolo + ricerca + tabella). Riempie lo schermo grande (il problema di resa su monitor
  largo si risolve qui).
- **Lista** (rimpiazza le card): `Titolo · Proprietario · Ultima modifica · Azioni`, tempo relativo
  ("3 mesi fa"), ricerca client-side.
- **Menu "Nuovo progetto"**: Progetto vuoto / Da template (disabilitato, "presto") / Carica progetto
  (.zip). "Carica .zip" tolto dalla topbar e infilato qui.
- **Azioni di riga** (icone **SVG uniformi** + **tooltip** su hover): **Scarica .zip** (`GET …/download`,
  zippa `files/`), **Scarica PDF** (`GET …/pdf`, compila da disco con euristica main.tex + xelatex — è
  l'ultimo stato *salvato*, non l'ultima battuta), **Archivia/Ripristina**, **Elimina**. In vista
  Archiviati l'archivia diventa ripristina. Il "copia" di Overleaf è escluso di proposito.
- **Archivio**: flag `meta.archived` (condiviso) + `POST …/archive`; vista **Archiviati** in sidebar.
  Non tocca `updatedAt` (non è una modifica di contenuto).
- **Tag condivisi**: registro globale `PROJECTS_DIR/tags.json` (`{id,name,color}`) + `meta.tags:[id]`.
  Endpoint: lista, crea (nomi duplicati bloccati case-insensitive, colore da palette fissa), elimina
  (**cascata**: tolto da tutti i progetti), `PUT …/tags` (setta l'array, id sconosciuti scartati; non
  tocca `updatedAt`). UI: sezione **Tag** in sidebar (pallino colorato + conteggio, filtra) + **Senza
  tag** + **＋ Nuovo tag** (nome + 8 colori); **chip** colorati sulle righe (× per togliere); **🏷** su
  hover apre il menu di assegnazione (spunta i tag, resta aperto e aggiorna dal vivo, oppure crea-e-assegna).
- **Fix "ultima modifica"**: `updatedAt` veniva bumpato a **ogni** salvataggio del doc, anche a vuoto
  (riconnessione, riapertura, redeploy ri-materializza file identici) → la home mostrava attività mai
  fatta e correva avanti rispetto alla cronologia. Ora `recordVersion` **ritorna null** sui no-op e
  `onStoreDocument` bumpa `updatedAt`/`updatedBy` **solo** quando registra un cambiamento vero → "ultima
  modifica" = timestamp dell'ultima voce di cronologia. È **da qui in avanti**: i progetti già
  disallineati si riallineano al primo salvataggio sostanziale.

**Scelte (e perché)**
- **Pelle nostra, layout loro**: Overleaf come riferimento di UX; colori e temi restano di Alumère.
- **`overflow:visible` sulla lista + angoli arrotondati a mano**: per non far tagliare i tooltip delle
  azioni (prima `overflow:hidden` serviva agli angoli tondi).
- **Icone SVG a tratto** al posto delle emoji: le emoji avevano metriche tutte diverse e non si
  allineavano mai nel box; gli SVG (16px, `currentColor`) si tematizzano da soli.
- **Tag globali su file**, non per-utente: coerente con la libreria condivisa, zero stato per-persona;
  `tags.json` sotto il volume dati (già nel backup). Lock a catena di Promise per le scritture del registro.
- **Assegnazione per-riga** (menu 🏷); tag in massa rimandato.
- **`updatedAt` solo su cambi sostanziali**: "ultima modifica" deve dire l'ultima modifica *vera*, non
  "ho ricompilato/riaperto".

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita)
- Menu Nuovo progetto; lista con le 4 colonne; azioni: **zip 200 `application/zip`**, **PDF 200
  `application/pdf` compilato in ~0.9s** (xelatex reale), archivia↔ripristina coi contatori, elimina.
- Fix updatedAt su **entrambi i rami**: store a vuoto → log `(… no change)`, `updatedAt` fermo;
  modifica vera (commento iniettato via la EditorView di CM6, poi annullato) → `updatedAt` bumpato +
  nuova versione, **allineati a 4 ms**.
- Tag: crea col colore scelto, assegna/rimuovi (chip + menu live che resta aperto), filtra per tag +
  Senza tag, elimina con cascata, nomi duplicati respinti, id inventati scartati.

**Rimandati di proposito**: **template** (Step G, da scrivere prima), **tag in massa** (multi-selezione),
**Cestino/soft-delete** ("archivia v2" — l'Elimina resta definitivo per ora).

**Prossimo**: altri screen di Tommy (editor?) per il prossimo giro. ⚠️ **Non è live**: file statici →
nessun rebuild del bundle, ma serve il **pull+rebuild sul VPS** (lo fa Albi) per portare online il giro.
Il dato nuovo (`tags.json`, `meta.archived/tags`) vive nel volume `alumere-data`, già coperto dal backup.

---

## 2026-07-17 (ter) — Giro UX: home, errori LaTeX, tema scuro, anteprima PDF.js ✅

Primo grosso giro dedicato a **interfaccia ed esperienza d'uso** (nessuna nuova logica di
dominio; la sicurezza giro 2 resta in pausa, per scelta di Tommy). Solo file client + un
endpoint. Sei commit su `main`, tutti verificati in browser.

**Cosa c'è ora**
- **Home** (`96d1af4`): bottone **＋ Nuovo progetto** che crea un progetto vuoto da template
  minimo (`POST /api/projects`; titolo = nome escapato per LaTeX, autore = chi crea) — prima
  l'unico ingresso era il `.zip`. Card **cliccabile** (click o Invio); **Elimina** declassato a
  controllo d'angolo visibile solo su hover.
- **Errori LaTeX leggibili** (`0315673`): `parseLatexLog` trasforma il log grezzo in una **lista
  cliccabile** sopra al log (badge errore/avviso, posizione); una riga con file+riga nota è un
  bottone che **apre il file e porta il cursore lì**. Chip di stato "N errori" + badge sul tab Log.
- **Toolbar snellita + lingua** (`b7b141a`): Motore LaTeX e Tema editor spostati in un **menu ⚙**;
  interfaccia **tutta in italiano** su entrambe le pagine (`lang=it`).
- **Tema scuro dell'intera app** (`df54861`, poi esteso): variabili `--panel/--ink/--line/…` con
  gemello scuro, attivato da `prefers-color-scheme` (auto) o da `data-app-theme` (scelta esplicita),
  riapplicato **prima del primo paint** da uno script inline (niente flash). Selettore **Aspetto**
  (auto/chiaro/scuro). *Nota:* la superficie dell'**editor** ha una palette propria (Tema editor),
  quindi in dark resta chiara finché non si sceglie Slate Dark/Nord — lasciato così di proposito.
- **Tre fix dal campo** (`e61d476`): (1) Aspetto anche dalla **home**, non solo dentro un progetto
  → logica estratta in **`public/theme.js` condiviso** (cabla `#appTheme` + il menu ⚙; preferenza
  unica per le due pagine). (2) **Trascinamento** editor/anteprima che si bloccava: era l'iframe
  del PDF che ingoiava gli eventi → `body.dragging` disattiva i pointer-event sull'anteprima durante
  il drag. (3) Prima versione dello zoom del solo PDF.
- **Anteprima PDF.js** (`1103756`): lo zoom "a stage" sull'iframe posizionava male la pagina e non
  era fluido. Sostituito con **PDF.js su `<canvas>`**, vendorizzato in **`public/vendor/pdfjs/`**
  (Apache-2.0, no CDN a runtime). Rendering nitido a `devicePixelRatio`, pagina centrata;
  **100% = adatta larghezza**, zoom = moltiplicatore **continuo**. **Pinch trackpad** (il Mac lo
  manda come `wheel+ctrlKey`) o ⌘/Ctrl+wheel → zoom fluido **ancorato al cursore**, valori fini a
  piacere (47%, 231%…). Bottoni −/adatta/＋, range 10–500%. Feedback immediato via transform CSS
  durante il gesto, **re-render nitido** all'assestamento.

**Scelte (e perché)**
- **`theme.js` condiviso** invece di duplicare: home ed editor cablano gli stessi controlli; una
  sola preferenza in `localStorage`. Il menu ⚙ e il suo Esc-per-chiudere vivono lì; app.js tiene
  solo Esc-per-cronologia e Cmd/Ctrl+S (non si accavallano: cronologia e menu non sono mai aperti
  insieme).
- **PDF.js, render SERIALIZZATI**: due `page.render()` concorrenti sulla **stessa** pagina PDF.js
  confliggono e lasciavano il canvas bloccato/sfocato (inciampo vero, costato un paio di giri). La
  soluzione robusta è un solo render alla volta, con **re-run** sull'ultimo zoom se ne arriva un
  altro durante — niente token/cancel, niente race.
- **Zoom = CSS transform durante il gesto + re-render crisp al fermo**: fluido *e* nitido, come i
  visualizzatori seri. `100% = fit-width` segue il ridimensionamento del riquadro (ResizeObserver).
- **Bonus**: renderizzando su canvas (non più col plugin PDF nativo) l'anteprima **si vede anche nel
  browser di test** headless — d'ora in poi l'anteprima è verificabile a schermo, non solo a sonde.

**Verificato** (dev container :3000, browser reale): creazione progetto (nome con `& %` escapato,
gate 401), card cliccabile, delete d'angolo; errore LaTeX finto → riga cliccabile che salta a
`main.tex:26`, percorso verde "Compilato ✓"; menu ⚙ + Esc; Aspetto cambia dalla home ed è condiviso
coi due sensi; drag fino in fondo all'anteprima senza stalli; **anteprima PDF.js nitida** a 46/100/
198/230%, pinch continuo ancorato al cursore, reset a 100%, scroll normale invariato. Console pulita.

**Prossimo**: altri appunti UX di Tommy (in arrivo). ⚠️ **Non è live**: PDF.js si carica come modulo
statico → **nessun rebuild del bundle**, ma serve comunque il **pull+rebuild sul VPS** (lo fa Albi)
per portare online tutto il giro.

---

## 2026-07-17 (bis) — Smoke test end-to-end committato ✅

Finora gli harness di verifica erano script usa-e-getta ricostruiti a ogni sessione; ora c'è
**`bash test/smoke.sh`** nel repo: un comando, ~1 minuto, **16 controlli** su tutta la superficie.
Avvia un container **isolato** (:3100, dati temporanei via `mktemp`; dev e prod mai toccati) e
attraversa: gate 401 → magic-link (SMTP off → link dal log) → login → progetti → **edit
collaborativo vero** (peer Yjs headless col cookie, `test/collab-edit.mjs`) → history (versioni,
autore, contenuto col marcatore, etichetta, tree, 401) → compile LaTeX → GC (fixture con blob
orfano+temp: rimossi; referenziato e versione: intatti). Serve solo docker+curl+python3 sull'host.

**Inciampi utili da ricordare**
- `HocuspocusProvider` con solo `url` **scarta `WebSocketPolyfill`** (inoltra soltanto
  url/connect/parameters alla websocket interna) → su Node parte la WebSocket globale senza
  header → niente cookie → 401 al gate → "connecting" infinito. Serve costruire
  `HocuspocusProviderWebsocket` esplicitamente col polyfill e passarla come `websocketProvider`.
- La **fixture GC va creata a server già su** (cartella progetti non vuota al boot = niente seed
  del progetto d'esempio) e **dentro il container** via `docker exec`: file creati dall'host in un
  bind-mount possono non propagarsi in tempo su Docker Desktop.

Esito: **16/16** — i fallimenti dei primi giri erano tutti bug dell'harness, l'app era a posto.

---

## 2026-07-17 — Rifiniture history: GC blob orfani + retention versioni ✅

Le ultime due rifiniture di M2. Solo `server.js` (~60 righe), zero client, zero dipendenze nuove.

**Cosa c'è ora**
- **Retention**: le versioni *auto* senza etichetta più vecchie di `HISTORY_RETENTION_DAYS`
  (default **90 giorni**) scadono. Sopravvivono sempre: le versioni **etichettate**, i
  **checkpoint**, i **ripristini**, la **baseline iniziale**, e comunque le **ultime 10**
  (`HISTORY_RETENTION_KEEP`) — un progetto fermo non perde mai la sua timeline recente.
  `HISTORY_RETENTION_DAYS=0` disattiva la retention.
- **GC dei blob orfani**: una passata periodica (ogni 6h, `HISTORY_GC_INTERVAL_H`; la prima
  ~15s dopo il boot) applica la retention e poi cancella da `history/objects/` ogni blob che
  nessuna versione superstite referenzia (scarti della retention, avanzi di amend dopo un
  crash) + i temp `.tmp-*` rimasti a terra. I file non riconosciuti (né sha né temp) non
  vengono toccati.

**Scelte (e perché)**
- **GC sotto lo stesso lock per-progetto di `recordVersion`**: mentre la passata gira su un
  progetto nessuno store può intrecciarsi → un blob su disco ma assente dall'indice è garbage
  *per costruzione*, niente euristiche fragili sull'età dei file.
- Milestone intoccabili + minimo di versioni recenti: la retention taglia solo il rumore
  (auto coalescente vecchio), mai i punti fermi voluti dalle persone.
- Log solo quando c'è qualcosa da dire (passata silenziosa se non rimuove nulla).

**Verificato** (container isolato su :3100 + dati temporanei; dev e prod mai toccati)
- Progetto finto con 7 versioni (initial, auto vecchie, etichettata, checkpoint, recenti) e 6
  oggetti su disco: la passata rimuove **esattamente** le 2 auto scadute e i 4 blob
  orfani/temp; salvi il blob condiviso, la milestone, il checkpoint, le recenti e un file
  estraneo (non-sha) lasciato apposta nella cartella.
- `HISTORY_RETENTION_DAYS=0`: nessuna versione toccata, rimossi solo i 2 veri orfani.
- Idempotenza: seconda passata sui dati già puliti → non trova nulla (e non logga).
- Dev container su :3000: hot-reload pulito col nuovo codice, load/store collab regolari.

**Prossimo**: sicurezza giro 2 (allowlist per-persona, ACL per-progetto). ⚠️ **Non è live**:
serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-16 (sera) — Rifiniture history: diff intra-riga + checkpoint manuale ✅

Le prime due rifiniture di M2 (le altre — GC blob orfani e retention — restano in lista). Tocca
`server.js` (~10 righe nell'hook di store) + i 3 file client. **Niente dipendenze nuove**: reload e basta.

**Cosa c'è ora**
- **Diff intra-riga**: dentro una riga modificata si evidenzia (sfondo più acceso) **solo la parte
  cambiata**, stile GitHub — cambi una parola e vedi la parola, non due righe intere rosse/verdi.
  LCS a livello di **parola** dentro la coppia di righe, riusando il `lcsCore` già esistente.
- **Checkpoint manuale**: bottone **📌 Checkpoint** nell'header della cronologia → chiede un nome
  (opzionale) e taglia **subito** una versione dello stato corrente: **attribuita a chi clicca**
  (non all'ultimo editor), **mai amendata** dai salvataggi successivi, badge "checkpoint" in timeline.
- Bonus emerso strada facendo: i **ripristini** ora hanno kind/badge proprio ("ripristino", il client
  lo prevedeva già ma il server non lo emetteva) e sono anch'essi **punti fermi non-amendabili**.

**Scelte (e perché)**
- **Il nonce `historyBreak` diventa un oggetto** `{nonce, kind, label?, by?}` (era una stringa): il
  meccanismo del checkpoint È il nonce del ripristino — serviva solo dire al server *che tipo* di
  versione forzata tagliare e per conto di chi. Retro-compatibile: un nonce stringa (client con
  scheda vecchia aperta) forza ancora la versione come prima. Il server continua a **non scrivere
  mai nel CRDT** (ricorda l'ultimo nonce in `meta.json`).
- **Checkpoint via doc Yjs, non endpoint REST**: un endpoint leggerebbe `files/` su disco, che è
  **indietro fino al debounce** (2-10s) rispetto al doc live → il checkpoint perderebbe le ultime
  battute. Bumpare il nonce nel doc cattura lo stato vero; la versione compare al giro di store
  (~2s, il client fa un piccolo poll e la mostra).
- **Accoppiamento righe del diff in ordine** (1ª rossa ↔ 1ª verde, …) anche nei **blocchi
  sbilanciati** — la prima versione accoppiava solo blocchi 1:1 e Tommy l'ha bucata subito sul
  campo (1 riga modificata + 1 nuova sotto = blocco 1→2, niente evidenza). Una **soglia di
  somiglianza** (≥30% di contenuto comune) scarta le coppie che non c'entrano: righe troppo diverse
  restano rosso/verde pieno, che dice di più di un'evidenzia-tutto.

**Verificato** (container isolato su :3100 + dati temporanei; dev e prod mai toccati)
- **Headless 20/20** (2 utenti veri via magic-link, peer Yjs col cookie): checkpoint con/senza
  etichetta; autore = chi clicca (B) e non l'ultimo editor (A); contenuto invariato → 0 file, blob
  dedup; l'edit dopo il checkpoint apre una versione nuova (il checkpoint non si amenda) e quello
  dopo ancora torna ad amendare; ripristino nuovo formato attribuito e badge-ato; nonce stringa
  legacy forza ancora; etichetta a posteriori; gate 401.
- **Browser reale** (login magic-link → editor): `Team`→`Squadra` evidenziati parola-per-parola nel
  diff; flusso checkpoint completo (prompt → versione "ATTUALE · CHECKPOINT" con etichetta, autore
  giusto, auto-selezionata, Ripristina disabilitato sull'attuale); **riverificato il caso sbilanciato
  di Tommy** dopo il fix (blocco 1→2: parola evidenziata + riga nuova verde piena). Console pulita.

**Prossimo**: GC periodico dei blob orfani + retention versioni vecchie (le due rifiniture rimaste),
oppure sicurezza giro 2 (allowlist per-persona, ACL per-progetto). ⚠️ **Non è live**: serve il
pull+rebuild sul VPS (Albi).

---

## 2026-07-16 — M2: history vera (timeline + diff + ripristino) ✅

La cronologia stile Overleaf. Ogni salvataggio del doc Yjs registra una **versione**; nuovo pannello con
**timeline + autore + diff + ripristino**. Tocca `server.js` (storage + hook + endpoint) e i 3 file client
(`app.js`, `editor.html`, `styles.css`). **Niente dipendenze nuove, niente cambio immagine Docker**: basta un reload.

**La scelta di fondo (e perché snapshot su disco, non log Yjs)**
Il diario indicava "history sul log Yjs", ma quel log oggi è **effimero**: il doc si ricostruisce dal disco a
ogni `onLoadDocument` e si materializza allo store — non c'è nessun update-log Yjs persistito. Costruirci sopra
la history vorrebbe dire **prima** persistere gli update (`gc:false` + compattazione, doc che cresce senza
limiti) + plumbing snapshot/diff a basso livello per-`Y.Text`: il percorso più costoso e rischioso. Scelto
invece lo **snapshot-per-salvataggio content-addressed su disco**: dà subito tutta la UX, resta *files-on-disk*,
non tocca l'immagine né ri-architetta Yjs, e lascia aperta la via del log Yjs per dopo. (È la scelta che il
diario stesso, più in basso, chiamava "giusta-dimensionata".)

**Cosa c'è ora**
- **Storage** (`server.js`), *fuori* da `files/` (che `writeFiles` fa `rm -rf`), sotto `history/`:
  `objects/<sha256>` = byte grezzi dei file **deduplicati per contenuto**; `index.json` = lista versioni
  `{id, at, by, label, kind, treeHash, files:[{path,sha,encoding?}]}`. Scritture **atomiche** (temp+rename);
  un **lock per-progetto** serializza le read-modify-write dell'index (uno store e una POST etichetta non si
  pestano i piedi).
- **Aggancio a `onStoreDocument`**: lo stesso save debounced è il confine di versione. **Baseline** allo
  `onLoadDocument` (lo stato iniziale su disco, la prima volta che il progetto si apre → `kind:"initial"`).
- **Coalescing** per una timeline leggibile: una raffica di scrittura dello stesso autore **fonde**
  nell'ultima versione (amend) finché non "si posa" (`HISTORY_COALESCE_MIN`, default 5′) o finché non cambia
  l'autore. L'amend **prune i blob rimasti orfani**. Uno store senza modifiche reali è un no-op (dedup per `treeHash`).
- **Ripristino sicuro**, fatto **dal client attraverso il doc Yjs** (non un write server su `files/`, che il
  doc live sovrascriverebbe): il testo viene sostituito **in-place sul `Y.Text`** (delete+insert sullo stesso
  tipo condiviso), così segue anche l'editor degli altri peer. Un **nonce `historyBreak`** nel meta-map
  condiviso **forza una versione nuova, non-amendabile**, così lo stato *da cui* ripristini non viene mai
  mangiato dal coalescing.
- **Endpoint** (tutti gated `requireUser`): `GET …/history` (timeline), `…/history/:v` (file + stato
  added/modified/removed vs precedente), `…/history/:v/file?path=&prev=1` (le due facce del diff),
  `…/history/:v/tree` (albero per il ripristino), `POST …/history/:v/label` (milestone).
- **UI**: pulsante **🕘 Cronologia** → overlay full-screen. Timeline con **avatar/colore riusati dalle
  presenze** (l'autore in cronologia ha la stessa faccia/colore del suo cursore), badge
  "stato iniziale"/"attuale"/etichetta. Diff **unificato** a due gutter con **fold** delle righe invariate
  ("⋯ N righe invariate ⋯"); toggle *con la precedente / con la copia attuale*. Bottoni `Ripristina` + `Etichetta`.

**Scelte (e perché)**
- **Coalescing per autore+tempo**, non "una versione per store": lo store è debounced ogni 2-10s → la timeline
  sarebbe illeggibile. L'amend tiene sempre l'ultima versione allineata allo stato più recente (uno *skip*
  puro perderebbe il lavoro finale se l'attività si ferma a metà finestra).
- **Content-addressed**: la maggior parte dei save tocca 1 file → un solo blob nuovo, il resto deduplicato
  (misurato: 7 blob per 16 slot-file).
- **Ripristino via nonce**, non un flag da azzerare: il server ricorda in `meta.json` l'ultimo nonce trattato
  (`lastHistoryBreak`), così il flag non va mai ripulito dal doc — cioè **il server non scrive mai nel CRDT**.
- **Orientamento del diff (fix da prova sul campo di Tommy)**: la versione selezionata è **sempre il lato
  "dopo"**, in entrambi i confronti → verde = righe che questa versione *ha*, rosso = righe che *le mancano*.
  Guardando lo *stato iniziale* "con la copia attuale", il testo aggiunto dopo esce in **rosso** (`− ciaooo`),
  non in verde: il diff descrive la versione che guardi, ed è l'anteprima esatta di cosa farebbe *Ripristina*.
  Prima usciva invertito (`+`), coi segni che cambiavano significato a seconda del toggle.

**Verificato** (tutto in **isolamento** su :3100 + dir temporanea; il container di prod e il volume `alumere-data` mai toccati)
- **Headless 22/22** (server reale, 2 utenti veri via magic-link, peer Yjs autenticati col cookie): baseline;
  coalescing (2 edit stesso autore → **1** versione); **prune del blob orfanato dall'amend**; cambio autore →
  **nuova** versione; diff (testo presente in "dopo", assente in "prima"); **ripristino stesso-autore/finestra
  → il nonce forza una versione nuova e lo stato precedente resta in cronologia**; l'edit successivo torna ad
  amendare (il nonce era il discriminante); etichette; dedup; gate **401** senza cookie.
- **Browser reale** (login magic-link vero → editor): overlay, timeline con avatar colorati, diff col fold
  "23 righe invariate", **ripristino end-to-end** (editor tornato allo stato iniziale, riga 1 senza il
  commento) → cronologia passata a **3 versioni** (base + edit + ripristino), console pulita.
- **Orientamento diff** (dopo il fix): riverificate in browser le tre direzioni — stato iniziale vs copia
  attuale → `− ciaooo` rosso; attuale vs copia attuale → "Nessuna differenza"; attuale vs precedente →
  `+ ciaooo` verde. Console pulita.

**Prossimo**: eventuale diff intra-riga (livello carattere), "checkpoint manuale" (il nonce è già pronto), GC
periodico dei blob orfani, retention delle versioni vecchie. Oppure sicurezza giro 2 (allowlist per-persona,
ACL per-progetto). ⚠️ **Non è live**: come sempre serve il pull+rebuild sul VPS (lo fa Albi). Il dato `history/`
vive dentro il volume `alumere-data`, quindi è **già coperto dal backup del volume**.

---

## 2026-07-16 — M1 Step 2: presenze con avatar + pulizia UX post-Yjs ✅

Il polish della collaborazione. **Nessuna funzionalità nuova**: rende leggibile e onesto quello che
l'app già faceva. Solo 3 file client (`app.js`, `editor.html`, `styles.css`) → **niente dipendenze
nuove, niente rebuild del bundle né dell'immagine**: basta un reload.

Fatti i punti **1 + 2**; il **3** (riconnessione) trattato come verifica + UI più esplicita; il **4**
(condivisione cartelle vuote) **lasciato aperto** di proposito, è il meno utile.

**Cosa c'è ora**
- **Avatar tondo con le iniziali** (`tommaso.panseri@` → **TP**), **colorato come il cursore** di quella
  persona → lo strip fa anche da **legenda** per i caret colorati nel testo. Hover → nome esteso
  (tooltip CSS in barra; `title` nativo nell'albero, dove lo scroller lo taglierebbe).
  **Pronto per la foto profilo**: `avatarEl()` ha già il ramo `<img>` — il giorno che si pubblica un
  `avatarUrl` nelle awareness, l'immagine compare da sola in barra e nell'albero, componente invariato.
- **Chi sta su quale file**: marcatori piccoli sulle righe dell'albero. I dati erano **già sul filo**
  (`activeFile` pubblicato dal 2026-07-05), mancava solo disegnarli.
- **Oltre 4 persone** → collasso in **"+N"**, che al hover elenca i nascosti.
- **Via il Save fasullo**: il bottone non salvava niente (faceva lampeggiare una scritta) e `#dirtyDot`
  era uno `<span>` vuoto mai riempito — relitti del modello pre-Yjs col PUT. Al loro posto un
  **"salvataggio automatico"** che **si nasconde quando sei offline**, invece di mentire.
- **Stato connessione da un solo punto** (`setConnState` → `body[data-conn]`): chip, barra offline,
  hint e avatar non possono più contraddirsi. Online → il chip sparisce (gli avatar *sono* il segnale);
  non-online → avatar ingrigiti (non sappiamo più chi c'è davvero).

**Scelte (e perché)**
- **Dedup per PERSONA, non per socket** (nuovo: `id` pubblicato nelle awareness). La stessa persona con
  due schede compariva **due volte** — scoperto sul campo, era la scheda Safari aperta. La domanda è
  "chi c'è", non "quante schede ha". ⚠️ Vale solo fra client sul codice nuovo: chi ha una scheda vecchia
  aperta si vede ancora doppio finché non ricarica.
- **`activeFiles` è un Set**: due schede possono stare su due file diversi → la persona si vede su
  **entrambi**; sceglierne uno sarebbe arbitrario.
- **Offline misurato a TEMPO, non da evento** (`OFFLINE_GRACE_MS = 5000`). Hocuspocus riprova da solo e
  resta in `"connecting"` per sempre: non esiste uno stato "disconnesso" da leggere → **la barra non
  sarebbe mai comparsa a nessuno**. Sotto la soglia (blip, o il nostro redeploy) si tace; sopra, si
  parla. Una volta accesa resta accesa fino al sync vero, o sfarfallerebbe a ogni retry.
- **Barra offline arancione, non rossa**: non è un errore né perdita di dati — il CRDT fa il merge al
  rientro. Il testo dice esattamente quello.
- **Redraw filtrato per firma**: awareness scatta a ogni movimento di cursore (= ogni tasto di ognuno).
  Ridisegnare strip+albero a quel ritmo era spreco e toglieva l'hover da sotto il mouse.
- **Avatar sovrapposti** (stile Google Docs) + tetto a 4: a 26px in fila occupavano 181px e
  **schiacciavano la barra** → "Recompile"/"Download PDF" andavano a capo *dentro* il bottone. Ora 110px
  (e il chip online sparisce: saldo netto +26px, ci stanno con 14px di margine a 1280).

**Verificato** (dev container, host non toccato; peer veri via ws autenticato col cookie)
- **Iniziali 10/10** contro la derivazione reale di `displayNameFromEmail`: TP, MR, **"Maria Del Carmen"
  → MC**, **`admin@` → AA**, più input degeneri (`""`/`null` → `?`). MC e AA riconfermate a schermo.
- **5 colleghi veri** collegati insieme + la scheda Safari: dedup provata (**7 entry grezze → 4 avatar +
  "+3"**, e Paolo con 2 sessioni resta **un** avatar ma appare su **entrambi** i suoi file); tooltip
  "Paolo Rossi" confermato in browser.
- **Offline**: barra **compare** su caduta vera (`docker stop`); **non compare** su riavvio breve del
  server (`node --watch`) ← il caso del redeploy. **Riconnessione**: pagina sopravvissuta al riavvio
  **senza reload** e presenze tornate da sole, incluso un peer entrato *dopo*.
- **Zero ridisegni dell'albero** su 31 caratteri battuti (filtro per firma). Console pulita.
  Progetto "Sample paper" **verificato intatto sul disco** dopo i test.

**Prossimo**: M2 (history vera su log Yjs) o sicurezza giro 2 (allowlist per-persona, ACL per-progetto).
⚠️ **Non è live**: come sempre serve il pull+rebuild sul VPS, che fa Albi.

---

## 2026-07-15 (dopo i primi test sul campo) — Magic-link: fix scanner + troncamento ✅

Primi test reali sul server, in più persone.
- **Collaborazione real-time: funziona.** Provata in due (Tommy + Paolo), si scrive insieme senza attriti. ✅
- **Magic-link: rotto per alcuni.** Il link andava dai **Mac** (Tommy, Paul, Fra) ma dava **"link non
  valido"** dal PC di lavoro (**Windows**) e da quello di Albi (**Linux**). Sembrava un problema di OS:
  **non lo è** — una GET con token in query è identica ovunque. La variabile vera è il **client di posta
  e la rete** attorno al link.

**Diagnosi — due cause, entrambe reali**
1. **Il token moriva al PRIMO GET, chiunque lo facesse** (`pendingLogins.delete` dentro la GET). Scanner
   di sicurezza della posta, antivirus, proxy aziendali e bot di anteprima **aprono** gli URL trovati
   nelle mail → bruciavano il token monouso → l'umano poi trovava "link non valido". Ecco perché
   fallivano proprio i **PC aziendali**.
2. **Mail solo `text/plain` + URL ~90 char.** Il quoted-printable lo spezza a 76 — visto sul filo:
   `<http://127.0.0.=\r\n1:3100/api/auth/verify?token=…>` — e i client che linkificano male **troncano il
   token**. Client diversi = macchine diverse → da lì la **falsa correlazione con l'OS**.

**Cosa c'è ora** (`fca0d1a`)
- **La GET non consuma più**: mostra una pagina **"Conferma l'accesso"**; il token è speso dalla **POST**
  dietro un click vero (gli scanner fanno GET e non premono bottoni). **Niente auto-submit in JS**,
  apposta: uno scanner che esegue script lo ribrucerebbe. Il token viaggia in query anche sulla POST →
  già coperto dalla redazione nei log di Caddy.
- **Mail multipart**: parte **HTML** con `<a href>` (l'URL sta in un attributo, dove nessun a-capo lo
  rompe) + testo con l'URL fra `<>` e una copia copia-incollabile.
- **Token pendenti persistiti** nel volume dati, stesso pattern del `.session-secret` → un riavvio non
  invalida più i link già in casella. Chiude un follow-up in lista da tempo.
- Le due paginette di auth erano **dark-mode-rotte** (testo scuro senza sfondo dichiarato → illeggibili):
  ora dichiarano `background` + `color-scheme` e usano la palette di `styles.css`.

**Verificato** (container isolati, **MailHog** come SMTP vero; host e server mai toccati) — **22/22**:
mail con parte HTML e token **integro (43 char)** in entrambe le parti; **link aperto DUE volte** (prima
"lo scanner", poi l'umano) e **la seconda funziona ancora** ← era esattamente il bug; POST monouso
(la seconda → 400); link ancora valido dopo un `kill -9` dell'app; gate dominio / 401 / token inventato
invariati. Più il giro in **browser vero**: click sul bottone → 302 → cookie HttpOnly → `/api/projects` 200.

**⚠️ Non è ancora live**: serve il redeploy sul server (`git pull` + rebuild).

---

## 2026-07-15 — Follow-up post-deploy chiusi: build riproducibile + config edge versionata ✅

Chiusi i follow-up non bloccanti lasciati aperti dal deploy, + sistemata una vulnerabilità high
trovata strada facendo. Mergiato in **`main`** in fast-forward e pushato (`9586cd5`).

**Prima, sanity-check del deploy (tutto verde)**
- `https://docs.alum-lab.com/api/health` → **HTTP 200**, TLS valido, IP `84.247.128.81`, body con gli
  engine TeX (`pdflatex/xelatex/lualatex`) → gira l'immagine reale, non il node minimale.
- DNS: **SPF ora c'è ed è corretto** (`v=spf1 include:spf.privateemail.com ~all`) — il follow-up SPF si
  è risolto; **DMARC** `p=none` con report; A record e MX privateemail coerenti. Il buco deliverability
  dei magic-link è chiuso.

**Cosa c'è ora (nei 2 commit)**
- **Build riproducibile** (`e89e1bc`): `package-lock.json` rigenerato (`nodemailer` era **assente** dal
  lock) e in sync; Dockerfile passa da `npm install` a **`npm ci --omit=dev`** (copia anche il lock).
- **`nodemailer` ^6.9.14 → ^9.0.3** (stesso commit): chiude **8 advisory high** (CRLF/SMTP-injection,
  SSRF via raw/file) sul percorso dei magic-link; `npm audit --omit=dev` → **0 vulnerabilità**. L'uso in
  `server.js` è l'API core (`createTransport` + `sendMail{from,to,subject,text}`), invariata 6→9 (il
  breaking di 9.x è solo Node ≥18; giriamo su 22).
- **Config edge versionata** (`dfc7442`): nuovo **`Caddyfile.alum-edge`** = copia di RIFERIMENTO del
  vhost realmente in prod (`reverse_proxy alumere:3000`, WS `/collab`, redazione `token` nei log). Fonte
  di verità resta `/opt/alum/caddy/Caddyfile` sul VPS.
- **`DEPLOY.md`**: distingue le **due modalità** (A standalone `prod` vs B integrazione col Caddy edge =
  quella live), nuova sezione "Deploy reale ALUM" con avvio `docker-compose.alum.yml` + **backup del
  volume corretto** (`alumere_alumere-data`, non `alumdocs_…`); rimossa la nota "build riproducibile
  opzionale" (ora è il default). **README**: file-tree aggiornato con i file dello stack alum.

**Verificato (Docker in locale, host non toccato)**
- Layer npm in un `docker build` **reale** (context = repo): `COPY` lock + `npm ci` verdi, `require()`
  runtime OK, `node --check server.js` OK, **dry `sendMail`** con la shape reale (jsonTransport) → messaggio
  corretto con nodemailer 9.
- `caddy validate` su **`Caddyfile.alum-edge`** e sul `./Caddyfile` prod → entrambi "Valid configuration".

**Prossimo**: push del branch + PR (in attesa dell'ok). Resta operativo solo **lanciare davvero il backup**
del volume sul VPS (comando pronto in `DEPLOY.md`) e valutare il backup/versioning dell'intera
`/opt/alum/caddy/`.

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
