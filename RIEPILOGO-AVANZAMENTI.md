# alumDocs — Riepilogo avanzamenti e decisioni

> Diario di bordo del progetto: **leggi questo file a inizio sessione** per essere
> subito sul pezzo (stato attuale, scelte fatte e perché, prossimi passi). Le
> sezioni datate in alto sono le più recenti; sotto resta il contesto di design di
> base. (Ex `alumDocs_latexUpdates.md`.)

---

## 2026-08-08 — Giro 18: il lavoro scritto a linea caduta non muore più col tab ✅ (check di Tommy OK)

**Il giro non nasce da una richiesta, nasce da una domanda.** «Ogni quanto viene fatto
l'autosalvataggio?» — e dietro c'era il motivo vero, detto subito dopo: su Overleaf capita che
cada la connessione e resti del lavoro non salvato. La risposta letta dal codice era
`debounce: 2000, maxDebounce: 10000`, e Tommy ne ha tratto la conclusione ragionevole:
«al massimo perdo 10 secondi».

**Non era così, ed è tutto il giro.** Quei numeri misurano un'altra distanza: quanto il *disco
del server* può restare indietro rispetto a quel che il server *ha già ricevuto*. Quando la linea
cade il server non riceve niente, quindi quel limite non descrive nessuna delle tue perdite.
Sono due guasti diversi e vale la pena tenerli separati:

| Guasto | Quanto perdi |
|---|---|
| Crasha il **server** | ≤ 10s (ricevuto ma non ancora scritto) |
| Cade la **tua** connessione e ricarichi | tutto dall'ultimo sync — **nessun limite** |

Ultimo sync alle 15:00, la linea cade, continui a scrivere, alle 15:25 ricarichi: venticinque
minuti. **La lezione da tenere**: un numero rassicurante trovato nel codice risponde alla domanda
che il codice si stava facendo, non necessariamente a quella di chi la legge. Chiedere «questo
numero misura la distanza che mi preoccupa?» costa una riga di ragionamento e qui separava una
risposta giusta da una falsamente tranquillizzante.

### Quel che già ci proteggeva, e il buco che restava

La difesa non è mai stata il debounce: è il **CRDT**. Da scollegato le modifiche continuano ad
applicarsi al Y.Doc locale, il provider ritenta da solo, e alla riconnessione Yjs **fonde** il tuo
lavoro con quello degli altri — nessuna finestra di conflitto. È il punto in cui siamo
strutturalmente meglio di Overleaf, che con l'OT quella fusione non la dà allo stesso modo. Il
problema di partenza di Tommy era quindi già risolto **nel caso normale**.

Il buco era stretto e cattivo: quelle modifiche vivevano **solo nella memoria del tab**. E la
fascia di offline rassicurava — correttamente — che non stavi perdendo niente, senza dire che
l'unica mossa capace di smentirla era proprio quella che viene istintiva quando qualcosa sembra
bloccato: ricaricare.

### La correzione: `y-indexeddb`, più due cose che non erano nell'import

Il doc vive anche nell'IndexedDB del browser. Attaccato **prima** del provider, così quel che hai
scritto offline è già nel doc quando lo stato del server ci atterra sopra: la fusione è una
fusione CRDT, sopravvivono tutti e due. È una cache, mai la fonte di verità.

**Le decisioni prese scrivendolo**

- **Il boot non poteva avvenire da offline, e questo era il lavoro vero.** `booted` si raggiungeva
  solo da `onSynced`: ricaricare senza server dava un editor bianco per sempre. Con la sola
  aggiunta della persistenza il doc sarebbe stato pieno e lo schermo vuoto — la modifica sarebbe
  sembrata fatta e non avrebbe salvato niente di visibile. `bootUI()` staccata da `onSynced`.
- **Si parte dalla copia locale solo dopo aver rinunciato al server**, riusando i 5s di
  `OFFLINE_GRACE_MS` che c'erano già. Lo stato del server è quello che vale aspettare: ha anche il
  lavoro degli altri, questa copia ha solo il nostro. Partire sempre da locale sarebbe stato un
  *altro* lavoro (caricamento istantaneo) con rischi suoi, infilato di straforo dentro questo.
- **Copia locale vuota → niente boot.** È la prima visita da quel browser: dipingere un albero
  vuoto direbbe «il progetto non ha file», che è una bugia. Meglio lasciare su la fascia.
- **Da offline non si compila.** È un giro sul server: potrebbe solo fallire, e apriresti su un
  errore su cui nessuno può agire. Resta in debito (`openCompilePending`) e parte al primo sync.
- **Lato server, lo stato Yjs si scrive al seed e non più solo al primo salvataggio.** Non era
  nella richiesta, ma la richiesta la rendeva necessaria: seminare costruisce item con **ID nuovi**,
  quindi due seed dello stesso `files/` producono due insiemi rivali sotto le stesse chiavi, e una
  `Y.Map` risolve tenendone uno e buttando l'altro. Finora invisibile (contenuto identico
  comunque). Con una copia in IndexedDB smette di esserlo: un progetto aperto, mai modificato e
  riaperto dopo un riavvio poteva buttare via **proprio la copia che teneva il lavoro offline di
  qualcuno**. È la stessa famiglia del guaio di duplicazione del giro 7, vista dal lato opposto.
- **La fascia ora dice il vero** («kept in this browser, reload included»): la vecchia formula era
  esatta solo se aspettavi, e quindi non era esatta.

### Verificato

(dev :3000, `test/smoke.sh` **31/31** prima e dopo, progetti di prova creati e poi cancellati —
nessun progetto di Tommy toccato)

- **Ricostruita la caduta di linea vera invece di simularla**: HTTP su, WebSocket giù, facendo
  girare al posto del dev un server con `COLLAB_PATH` diverso — stessa porta e stesso volume,
  perché l'IndexedDB è legato all'**origine** e doveva restare `:3000`. (`provider.disconnect()`
  non era un'opzione: `app.js` è un modulo, dalla console non si raggiunge.)
- Scritto `MARKER-OFFLINE-G18` da `○ offline` → **assente dal disco del server**. È esattamente lo
  stato che prima moriva col tab.
- **Ricaricata la pagina sempre da offline** → marker a riga 17, albero, tab, outline e PDF in
  cache tutti dipinti: la UI è partita dalla copia locale.
- Rimesso il server vero → riconnessione da sola, fascia sparita, e il marker **arrivato sul disco
  del server**.
- **Seed provato, non dedotto**: progetto nuovo aperto e mai toccato → `doc.ystate` presente con
  **zero** righe `collab stored`. Il timestamp da solo non distingueva seed e salvataggio.
- Non-regressione: due tab sullo stesso progetto (che ora condividono anche l'IndexedDB)
  sincronizzano dal vivo; compile all'apertura invariata; console pulita a parte il 404 già
  documentato (`/build` su progetto mai compilato).

**Il limite onesto, che resta di proposito**: `init()` chiede `/api/projects/:id` prima di aprire
il socket e senza risposta mostra la schermata d'errore. La copia locale quindi ti salva quando la
pagina si carica ma il socket no; se è morto anche l'HTTP la pagina non si carica affatto, quindi
il caso è teorico. Nel mezzo scomodo — pagina servita, API che tossisce — vedi la schermata
d'errore, ma **il lavoro non è perso**: è nell'IndexedDB e torna al primo caricamento riuscito.
Quel che sparisce del tutto è la regola «se sei offline non ricaricare».

**In coda restano**, dai giri vecchi: **sicurezza giro 2** (allowlist per-persona, ACL
per-progetto), **template** (Step G, da disegnare prima) e la questione **temi/`stex` vs Lezer**
parcheggiata nel giro 16.

⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi), fermo a `1541753` — gli mancano i giri
dall'8 in poi, questo compreso. `package.json` cambia, ma `y-indexeddb` è una **devDependency** e
l'immagine fa `npm ci --omit=dev`: nessuna dipendenza nuova arriva a runtime, se la porta il
bundle già committato.

---

## 2026-08-07 (bis) — Giro 17: il salto al collega arriva alla sua riga, non solo al suo file ✅ (check di Tommy OK)

**Tommy chiede una funzione che c'era già.** «Se schiaccio sull'icona di un collaboratore mi porta
solo al file, mi piacerebbe che mi portasse alla sua posizione.» Ma il salto del giro 8 fa
esattamente quello — e nel giro 8 era stato **misurato** (offset 18, column-aware). Quindi non era
una funzione mancante: era un **difetto**. La cosa utile del giro è tutta qui, e vale più della
correzione: quando quel che chiedi esiste già, la domanda giusta non è «come lo costruisco» ma
«perché non funziona».

### La misura che ha chiuso la questione in un colpo

Due client sullo stesso progetto, tutti e due su `main.tex`, **prima** di toccare niente:

```
{ activeFile: "main.tex", hasCursor: false, cursorFile: null }
{ activeFile: "main.tex", hasCursor: false, cursorFile: null }
```

Nessuno dei due pubblicava una posizione. Cliccato dentro l'editor di uno: compare
`cursorFile: "main.tex@667"`.

**La causa.** yCollab aggiorna il campo `cursor` solo sotto
`view.hasFocus && view.dom.ownerDocument.hasFocus()` — il fuoco del **sistema operativo**, non
quello del documento. Un collega che non ha mai cliccato dentro il testo, o la cui finestra sta
dietro un'altra, non pubblica posizione **affatto**. `peerLocation` si ritrova `index` a `null`,
e `gotoPeer` può solo aprire il file. Il sintomo di Tommy, esattamente.

**La seconda pista, provata e scartata come causa autonoma.** Il campo `cursor` è uno solo per
client, non uno per file: dopo un cambio file resta agganciato al Y.Text **precedente**, e il
controllo `abs.type === filesMap.get(file)` — giustamente — lo butta via. Sembrava un secondo
difetto indipendente; misurandolo non lo è. Con il fuoco, il `view.focus()` in fondo a `openFile`
ripubblica subito sul file nuovo (`sezioni/metodi.tex@0`). Morde **solo** senza fuoco, cioè è la
stessa causa vista da un'altra angolazione. Vale la pena averlo scritto: la correzione la copre
comunque, ma se avessi corretto *quella* avrei corretto il sintomo sbagliato.

### La correzione: un campo nostro, senza cancello e con l'etichetta del file

`caret: { file, rel }`, pubblicato da noi. Due proprietà, e sono tutte e due il punto:

- **Nessun vincolo di fuoco.** È quel che rende il salto affidabile invece che fortunato.
- **Si porta dietro il file a cui appartiene.** Una posizione relativa risolta contro il Y.Text
  sbagliato non dà un errore: dà un carattere, e quel carattere non c'entra niente con dove sta
  la persona. Un salto che atterra con sicurezza nel posto sbagliato è peggio di uno che non
  atterra — così `openFile` che cambia file non può invalidare quel che ha pubblicato l'editor
  di prima.

**Le decisioni prese scrivendolo**

- **Posizione relativa Yjs, non un numero di riga.** Stessa scelta di yCollab e per la stessa
  ragione: regge le modifiche concorrenti, quindi punta ancora allo stesso carattere quando un
  collega la decodifica un minuto dopo. Un indice assoluto sarebbe stato più semplice da leggere
  nel debug e sbagliato appena qualcun altro scrive due righe più su.
- **Si pubblica su `selectionSet`, non su `docChanged`.** Se sto fermo mentre un altro scrive, la
  mia posizione relativa **è già** lo stesso carattere: ripubblicare manderebbe traffico di
  awareness a ogni battuta di ogni collega per non dire niente di nuovo. (È la stessa prudenza che
  yCollab si compra con `compareRelativePositions`.)
- **Quello di yCollab resta come ripiego** (`own || st.cursor…`). Costa un `||` ed è quel che
  pubblica ancora un client rimasto su una versione vecchia — durante un rilascio non sono tutti
  aggiornati nello stesso istante.
- **All'apertura di un file si pubblica l'indice 0.** Deciso guardandolo: un collega che ha appena
  aperto un file e non si è mosso adesso ti porta **all'inizio del suo file** invece che «nel file,
  chissà dove». Non è una posizione vera, è la più onesta che abbiamo. Scelta condivisa da Tommy.
- **Azzerato quando non c'è niente di aperto** (e sui file binari, che un Y.Text non ce l'hanno).

### Verificato

(dev :3000, console **pulita** prima e dopo il ricaricamento, `test/smoke.sh` **31/31** — lato
server non è stata toccata una riga)

- **Ricostruita la condizione rotta di proposito**: un client come «Paolo Rossi» su
  `sezioni/metodi.tex` all'offset **426**, col suo `cursor` di yCollab forzato a `null`. Dall'altro
  client, fermo su `main.tex`, **click vero sull'avatar** → `open: "sezioni/metodi.tex"`,
  `landedAt: 426`, riga attiva `\subsubsection{Duplicati}`. Cambio di file **e** carattere giusto,
  con `hasCursor: false` per tutto il tempo: a portare la posizione è stato solo il campo nuovo.
- **Il campo esiste anche senza fuoco**: due client appena caricati, `hasFocus: false`,
  `hasCursor: false` — e `caretResolved: "sezioni/metodi.tex@0"` su entrambi. È esattamente il caso
  che prima dava il salto monco.
- **Il cambio file lo segue**: aperto un altro file, `caret` si sposta con lui.
- Sonda di diagnosi (`window.__diag`) **rimossa**, sintassi ricontrollata
  (`node --input-type=module --check`).
- Nessun progetto modificato: la prova è girata su «Outline test — sezioni annidate» muovendo solo
  cursori e cambiando file, **senza scrivere una battuta**.

**Nota di ambiente, che corregge una convinzione vecchia**: sull'host **Node c'è**
(`/opt/homebrew/bin/node`, v26.5.0). Per un controllo di sintassi non serve tirare su un container.

**Resta fuori di proposito**, come nel giro 8: il salto non *segue* il collega mentre si muove — è
un salto, non un follow-mode. E l'atterraggio non lampeggia: se la riga di arrivo dovesse risultare
difficile da individuare a occhio, è un lavoro suo.

**In coda restano**, dai giri vecchi: **sicurezza giro 2** (allowlist per-persona, ACL
per-progetto), **template** (Step G, da disegnare prima) e la questione **temi/`stex` vs Lezer**
parcheggiata nel giro 16.

⚠️ **Non è live**: `public/` soltanto, ma serve comunque il pull+rebuild sul VPS (Albi) — fermo a
`1541753`, quindi gli mancano i giri dall'8 in poi, questo compreso.

---

## 2026-08-07 — Giro 16: l'outline si richiude a tendina, e il titolo va in mezzo ✅ (check di Tommy OK)

**Tre modifiche chieste da Tommy guardando l'app, più una domanda che ha una risposta e nessun
lavoro (per ora).**

### Le frecce per singola voce — proprio quel che il giro 15 aveva escluso di proposito

Il giro scorso finiva dicendo «le frecce di richiusura **per singola voce** non ci sono, di
proposito: la testata richiude tutto, che è quel che chiedeva il punto 5». Adesso ci sono. **La
freccia richiude, il resto della riga salta** — la stessa divisione che ha una cartella
nell'albero dei file, e per la stessa ragione: sono due gesti diversi sullo stesso oggetto.

**Le decisioni prese scrivendolo**

- **Una piega si ricorda per PERCORSO nel documento, non per numero di riga.** Il numero di riga
  è la scelta ovvia e sbagliata: l'outline si ricostruisce a ogni modifica, e ogni riga che
  scrivi sposta i numeri di tutte quelle sotto — la piega si aprirebbe da sola sotto le dita.
  La chiave è invece la catena dei titoli dall'alto (`Front matter → Alpha`), che non si muove
  mentre scrivi altrove. **Due fratelli con lo stesso titolo** hanno un contatore, altrimenti
  chiuderne uno chiuderebbe anche l'altro — provato apposta con due capitoli identici parola per
  parola. Il giunto della chiave è un **NUL**, l'unico carattere che un titolo non può contenere:
  nessun titolo può così contraffare la chiave di un altro ramo.
- **Chiudere non spegne il «sei qui».** Col cursore dentro una sezione richiusa si illumina
  **l'antenato visibile più vicino**. L'alternativa — nessuna riga accesa — sarebbe stata una
  risposta peggiore della domanda: il pannello serve a dirti dove sei, e chiudere un ramo non ti
  sposta.
- **Le pieghe vivono quanto la sessione, non quanto una preferenza.** Sopravvivono al ri-parse e
  a un giro su un altro tab e ritorno (la chiave include il file), si azzerano al reload. Stessa
  posizione delle cartelle dell'albero: dicono dove stai guardando adesso, non qualcosa da
  ricordare la settimana prossima.
- **`drawOutline()` staccata da `refreshOutline()`.** Chiudere una freccia non cambia il
  documento, solo quali titoli sono a schermo: ri-analizzare il file a ogni click sarebbe stato
  sprecare la scansione per niente.
- **La freccia tiene il suo posto anche su una foglia** (slot vuoto da 12px), altrimenti i titoli
  dei fratelli si disallineerebbero a seconda che abbiano o no sottosezioni.

### La barra in alto: il logo È il link, il nome del progetto è il titolo

Via la freccia `←`: **il logo + il nome sono il link** alla lista progetti — un bersaglio solo
invece di una freccina appiccicata a una decorazione che sembrava cliccabile e non lo era. E il
nome del progetto esce dal blocco del marchio per diventare la **colonna centrale** della barra
(15px, grassetto, senza più il divisorio verticale che lo teneva attaccato al logo).

**Il quasi-difetto trovato misurando, e la riga di disegno che ha cambiato.** La prima versione
aveva `minmax(0,1fr)` su tutti e due i fianchi: due colonne uguali, che è esattamente ciò che
rende il centro *il centro della finestra* e non semplicemente «in mezzo ai due». Ma uguali vuol
dire che il lato largo non può prendere in prestito dal lato stretto — e a 560px la toolbar,
allineata a destra dentro una colonna più corta del suo contenuto, **sbordava di 11px sopra il
titolo**. Ora il fianco destro ha `min-content`: non può mai essere strizzato sotto quel che
contiene. Il centro invece può ridursi a zero, così su una finestra stretta è il **nome** a
cedere — ha i puntini di sospensione apposta — e la barra scivola fuori centro invece di
sovrapporsi a se stessa. Il centraggio perfetto e il non-sovrapporsi non possono valere insieme
a ogni larghezza: questa è la scelta di quale dei due mollare per primo.

**Misurato**: a 1280px le colonne escono `532.32 / 167.35 / 532.33` — il centro del nome cade a
640, cioè metà barra esatta. A 900px idem. A 560px nessuna sovrapposizione.

**Verificato** (dev :3000, chiaro **e** scuro, console **pulita** su caricamento fresco,
`test/smoke.sh` **31/31** — niente di nuovo lato server)
- **Sei livelli annidati**: freccia su ognuno tranne l'ultimo; `Beta`, senza figli, non ce l'ha.
- **Due `\section{Alpha}` sotto due `\part` diversi**: chiusa la prima, la seconda resta aperta.
- **Cursore a riga 10** — dentro `Deep leaf`, dentro `Alpha` chiusa — si accende `Alpha`, e solo
  quella (verificato sull'indice della riga, non sull'etichetta: i titoli erano omonimi).
- **Click sull'etichetta** di `Back matter` → cursore a riga 19, riga giusta, e la piega su
  `Alpha` regge.
- **Scritto del testo** con una piega chiusa: regge al ri-parse. **`main.tex` → `second.tex` →
  ritorno**: regge, e l'outline di `second.tex` non ne sapeva nulla.
- **Click sul logo** → lista progetti. **Menù ▾** centrato sotto il bottone; **Rename** apre il
  campo inline centrato e dimensionato come il titolo, Esc annulla.
- Progetto usa-e-getta del mio collaudo **eliminato**, cartella sparita da disco. Ne è rimasto uno
  **apposta**: «Outline test — sezioni annidate», che ho preparato per il check di Tommy (sei
  livelli, fratelli omonimi, titoli difficili, un file di sole `\subsection`, un `.bib`; `report`
  senza `hyperref` né `inputenc` — con XeLaTeX il primo si lamenta della matematica nei titoli e
  il secondo di essere inutile, così il log resta a **0 warning**). Da cestinare quando non serve
  più.

### La domanda sui temi: perché dracula da noi non è il dracula di Overleaf — **parcheggiata**

Tommy ha affiancato lo stesso tema nei due editor. **Non è il tema**: la tavolozza è identica
(esadecimali ufficiali di Dracula; sfondo, cursore e selezione combaciano). Quel che cambia è
**chi decide quale pezzo di testo prende quale colore**.

- Noi usiamo **`stex`**, il vecchio tokenizzatore di CodeMirror 5 riportato: uno *scanner*, non un
  parser. Non sa cos'è un ambiente, cos'è un titolo, dove comincia la matematica. Overleaf ha
  scritto **una grammatica LaTeX vera** (Lezer) — ed è la stessa cosa che gli dà le frecce di
  code folding sui `\begin`…`\end` che da noi non ci sono.
- **Misurato**: da noi il contenuto di `$…$` non è colorato affatto (solo i `$`), il nome
  d'ambiente è ciano dritto invece che verde corsivo, e c'è un'incoerenza che tradisce la causa —
  in `$e^{i\pi} + 1 = 0$` l'`1` e lo `0` sono **viola** (numeri), ma in `\frac{1}{3}` l'`1` e il
  `3` sono **ciano** (atom). Stesso carattere, due colori, per un motivo che non c'entra col
  significato.
- **Difetto di nome, non solo di parser**: `--ed-tok-math` **non colora la matematica** — colora
  il tag *atom*, cioè i nomi di ambiente e di pacchetto. Vale per tutti e dieci i temi.
- **Decisione di Tommy: lasciata così, ci si torna dopo.** Le due strade restano: sistemare la
  mappa dei tag (poco lavoro, tetto basso — solo quel che `stex` sa distinguere) oppure
  sostituire `stex` con una grammatica Lezer (giro suo: nuova dipendenza nel bundle vendorizzato
  e mappa dei colori riscritta).

**In coda restano**, dai giri vecchi: **sicurezza giro 2** (allowlist per-persona, ACL
per-progetto) e **template** (Step G, da disegnare prima).

⚠️ **Non è live**: `public/` soltanto, ma serve comunque il pull+rebuild sul VPS (Albi) — fermo a
`1541753`, quindi gli mancano i giri dall'8 in poi, questo compreso.

---

## 2026-08-05 (sexies) — Giro 15: l'outline delle sezioni, sotto l'albero ✅ (check di Tommy OK)

**Punto 5, l'ultimo della lista di Tommy.** Sotto il file tree, alla base della stessa colonna: un
maniglione da trascinare, una testata `▾ File outline` che richiude tutto in una striscia, e le righe —
una per titolo, rientrate come nel documento. Un click porta il cursore lì; la sezione in cui il cursore
si trova resta evidenziata e, se è fuori vista, il pannello si sposta da solo per mostrarla.

**Il parser non compila niente**: legge il sorgente e basta, con i commenti azzerati prima della scansione
(sostituiti da spazi, così ogni indice — e quindi ogni numero di riga — resta dov'era). Riconosce i sette
comandi da `\part` a `\subparagraph`, la variante stellata, il titolo breve fra parentesi quadre
(`\section[breve]{lungo}` → mostra il lungo), le graffe annidate nel titolo, e ripulisce il markup tenendo
le parole: `\textbf{Bold}` → *Bold*, `\label{…}` sparisce intero, `\%` torna a essere `%`, `\LaTeX` si
scrive per esteso invece di svanire.

**Le decisioni prese scrivendolo**
- **Legge il file APERTO, non il progetto** — la lettura di Overleaf. È anche l'unica in cui
  «dove sono» vuol dire qualcosa: l'evidenziazione segue un cursore, e il cursore sta in un file solo.
  *Conseguenza da guardare in faccia, vista la lezione del giro 14*: in un documento spezzato in file
  inclusi, con `main.tex` davanti l'outline dice «nessuna sezione», perché lì dentro davvero non ce ne
  sono — stanno nei file `\input`-ati, e l'outline appare aprendo quelli. È il comportamento di Overleaf;
  se preferisci un outline **di progetto**, che segua gli `\input` e attraversi i file, è un altro
  disegno (e un altro giro): dimmelo.
- **Il rientro si misura sul file, non sulla scala di LaTeX.** Un file fatto di soli `\subsection` è un
  elenco piatto, non un elenco spinto tre passi a destra. Quindi la profondità esce da una pila di
  antenati aperti — la forma che ha il documento, non quella che avrebbe nel manuale.
- **Mentre digiti, una graffa non ancora chiusa non produce nessuna riga.** Provato dal vivo: scritto
  `\subsection{Typed live` l'outline non si muove, alla `}` la riga compare. L'alternativa — prendere
  tutto quel che segue come titolo — avrebbe fatto lampeggiare mezzo documento dentro il pannello a ogni
  sezione nuova.
- **Il click parcheggia il titolo in cima alla vista** (`y: "start"`), non lo fa entrare di stretta misura
  dal bordo basso: da una mappa ti aspetti di atterrare **sulla** sezione, col suo testo sotto.
- **Altezza e stato richiuso si ricordano** (`localStorage`, come i tab e il tema).

**Il difetto trovato misurando, e che cambia una riga di disegno.** La prima versione, quando il limite
massimo scattava, **riscriveva** l'altezza voluta: una finestra stretta per un attimo si portava via la
scelta per sempre — riallargando, l'outline restava schiacciato. Ora `outlineH` è **la richiesta**, il
limite si applica solo sulla strada verso il DOM e non torna mai indietro. E la misura non si prende più
una volta sola all'avvio ma con un `ResizeObserver` sulla colonna: una pagina che nasce in una scheda di
sfondo si dispone a **zero** — misurata lì, l'outline sarebbe rimasto al minimo per tutta la sessione.
(Beccato proprio così: nel pannello del browser nascosto `body.clientHeight` è 0. Quarta incarnazione
della stessa trappola — giri 5, 6, 14, questa — stavolta sulle misure invece che sui frame.)

**Verificato** (dev :3000, chiaro **e** scuro, console **pulita**, `test/smoke.sh` **31/31** — niente di
nuovo lato server. Due progetti usa-e-getta, entrambi **eliminati** a fine giro — uno mio con `report`,
un file incluso e un `.bib`, e un secondo per il check di Tommy, perché sul progetto d'esempio non c'è
abbastanza struttura da guardare: in libreria è rimasto solo «Sample paper»)
- **21 casi sul parser vero** (script usa-e-getta che **ritaglia** le funzioni da `app.js` invece di
  ricopiarle, così non può divergere; non è in `test/` — se lo vogliamo stabile va scritto come
  `smoke.sh`, in un container suo): stellate, titolo breve, commenti interi e a metà riga, `\%`, markup e
  matematica nel titolo, graffe annidate, titolo su due righe, `\sectioning{}` che non è una sezione,
  graffa mai chiusa, file di soli `\subsection`. **2000 sezioni in 16,6 ms** — la scansione resta lineare.
- **Click su «Deeper still»** → cursore sulla **riga 24**, esattamente `\subsubsection{Deeper still}`.
- **Cursore a fine documento** → si illumina «Ninety-nine % sure» (l'ultima sezione prima di lì), e con il
  pannello al minimo (72px, contenuto 220px) la riga **rientra in vista da sola** — muovendo solo lo
  scorrimento dell'outline, non quello della colonna.
- **Cambio file**: `notes.bib` → «l'outline legge sorgenti LaTeX»; `parts/included.tex` → le sue quattro
  voci; chiusi tutti i tab → «Nothing open».
- **Sezione commentata via** (riga 30 del file di prova): non compare. **`\section*`**: compare.
- **Maniglione**: 190→310px, il valore si salva; tirato in giù si ferma a **72px**; richiuso → l'albero si
  riprende tutta la colonna (554px) e il maniglione smette di essere una maniglia. Ricaricata la pagina:
  richiuso com'era, e riaprendolo torna a **310px** — la richiesta è sopravvissuta.
- **Rail**: andata e ritorno su Review e colonna richiusa e riaperta senza che l'altezza si perda.
- **Controprova sul progetto d'esempio**: `sections/math.tex` mostra «Some Mathematics» evidenziata;
  `main.tex` — che ha solo `\input` — dice onestamente che sezioni non ne ha.

**Cosa NON c'è, di proposito**: le frecce di richiusura **per singola voce** (Overleaf le ha; qui la
testata richiude tutto, che è quel che chiedeva il punto 5) e l'outline di progetto di cui sopra.

**Anche la lista di idee di Tommy è finita** (cinque punti: tre nel giro 13, il quarto nel 14, questo il
quinto). Restano dai giri vecchi: **sicurezza giro 2** (allowlist per-persona, ACL per-progetto) e
**template** (Step G, da scrivere prima).

⚠️ **Non è live**: `public/` soltanto, ma serve comunque il pull+rebuild sul VPS (Albi) — fermo a
`1541753`, quindi gli mancano i giri dall'8 in poi, questo compreso.

---

## 2026-08-05 (quinquies) — Giro 14: il PDF si apre dove sta il cursore ✅ (check di Tommy OK)

**Punto 4 della lista di Tommy.** Il giro 13 aveva già stabilito che costava poco: la macchina SyncTeX
c'era tutta dal giro precedente (`syncForward()` **è** la freccina ➜ sul divisorio). Il lavoro previsto era
chiamarla da sola e decidere i casi di bordo. Quello imprevisto — e più grosso — è saltato fuori provando.

**Il salto, e quali compilazioni lo meritano.** Solo quelle che **chiedi tu**: Recompile e ⌘S. Non salta
la compilazione **all'apertura** del progetto (lì il cursore è soltanto dove l'ha lasciato la sessione
scorsa) né quella dopo un **ripristino dalla history** (lì punta dentro un documento appena sostituito
sotto di lui). Le altre regole cadono da sé:
- Su una compilazione **fallita** non si salta: davanti resta il log, e portare qualcuno dentro un PDF
  vecchio sarebbe una bugia.
- Quando il salto **non si può fare** non succede niente — nessuna mappa synctex, o un file aperto che
  nella build non è mai entrato (un `.bib`, un `.tex` che nessuno include). Il PDF resta dov'era.
- Il bottone va **avvolto** nel listener (`() => compile({...})`): passato per riferimento, l'oggetto
  Event del click sarebbe finito dentro le opzioni.

**Il difetto preesistente che rendeva la funzione inutile.** Col file incluso aperto il salto non partiva —
**e non partiva nemmeno la freccina manuale**, quindi non era colpa della chiamata nuova. Guardando il
file synctex vero: `Input:15:…/sections/beta.tex` **c'è**, ma **oltre la riga `Content:`**, e il parser
smetteva di leggere gli `Input:` appena entrava nel contenuto. Il motivo sta nel formato: un file incluso
a metà documento viene aperto **dopo** che la prima pagina è già stata sfornata, e synctex ne scrive il
record lì dove succede.
- Quindi **il salto non ha mai funzionato per nessun file `\input`-ato a metà documento**, in nessuna delle
  due direzioni: `tagOf` non lo trovava (avanti) e `pathOf` non sapeva ricondurre un click al file (inverso).
- **Non se n'era accorto nessuno** perché su un documento corto TeX apre tutto prima di sfornare pagina 1,
  e lì ogni record sta in testa — che è esattamente la forma del progetto d'esempio su cui la cosa era
  stata collaudata nei giri scorsi. Il caso rotto era proprio quello «documento molto lungo» da cui è nata
  la richiesta.
- Corretto leggendo gli `Input:` ovunque compaiano. Nessuna ambiguità: i record del contenuto iniziano
  tutti con un singolo carattere-codice (`{ } ( ) h v x k g $ [ ]`), mai con una `I` maiuscola.

**Verificato** (progetto **usa-e-getta da 10 pagine** con un file incluso e un `.bib`; console pulita,
`test/smoke.sh` **31/31** — niente di nuovo lato server)
- Cursore su **GAMMA-12** → ricompilo → **pagina 9/10**, fascia dentro quel paragrafo.
- Cursore su **BETA-10 nel file incluso** → **pagina 6/10**, paragrafo giusto. *(Prima del fix: niente,
  in silenzio.)*
- **Doppio click** sulla pagina 6 → apre `beta.tex` alla **riga 29**, il paragrafo cliccato: il fix ripara
  tutti e due i versi.
- **⌘S col cursore nel preambolo** → la riga senza output cade in avanti e si torna a **pagina 1**, fascia
  sulla prima riga stampata.
- **`.bib` aperto** → compilo → il PDF **resta a pagina 9**, nessuno scatto.
- **Compilazione fallita** (`\comandoInesistenteXYZ`) → log in primo piano, `main.tex:69` segnalato,
  **nessun salto**.
- **Controprova sul progetto d'esempio**: `sections/math.tex` continua a risolversi — il parser non ha
  rotto il caso comune.
- Progetto di prova **cestinato ed eliminato**, cartella sparita da disco (in libreria è rimasto solo
  «Sample paper»).
- **Scoperta misurando**, contro quel che davo per scontato: **una compilazione conserva già la posizione
  di scorrimento**, non riparte dall'alto. Quindi il cambiamento vero non è «invece di tornare in cima» ma
  **«invece di restare dov'eri, vai dove sei»** — che è poi esattamente la richiesta, ma val la pena
  raccontarlo giusto.
- **Nota di metodo**: il primo istinto, quando il file incluso non saltava, era di aver sbagliato la
  chiamata nuova. A scagionarla è stato provare la **freccina manuale** (rotta uguale) e poi andare a
  leggere il **file synctex vero** invece del codice. Il difetto era a due strati di distanza da dove
  stavo guardando.

**Restano dalla lista di Tommy**
- **Punto 5, l'outline delle sezioni** stile Overleaf: parser dei `\section` + pannello sotto l'albero con
  maniglione e testata richiudibile, click che porta alla riga, evidenziazione della sezione corrente. È
  l'ultimo della lista ed è un giro intero suo.

---

## 2026-08-05 (quater) — Giro 13: la history nel rail, il 100% che vuol dire qualcosa ✅ (check di Tommy OK)

**Il primo giro nato da una lista di idee di Tommy, non dalla lista del 18 luglio** (quella è chiusa dal
giro 12). Cinque punti; questo giro ne fa **tre**, i due grossi restano fuori di proposito: il **salto
automatico al cursore dopo la compilazione** (giro suo — la macchina SyncTeX c'è già tutta, `syncForward()`
è la freccina ➜ sul divisorio, il lavoro è chiamarla da sola e decidere i casi di bordo) e l'**outline delle
sezioni** stile Overleaf (parser + pannello sotto l'albero: un giro intero).

**① Il 🕘 lascia la toolbar del PDF per il rail**, sotto la chat. Apre un **overlay**, non un pannello
laterale: quindi come il ⚙ del giro 9 sta **fuori dal `<nav>`** e non prende mai `.active`, che lì dentro
vuol dire «questo pannello è nella colonna». Il precedente esisteva già, l'ho solo ricalcato. Niente
doppioni: dalla toolbar sparisce.
- **Le due soglie del pannello stretto scendono di ~32px** (458→419, 328→304). Erano *misurate* attorno a
  un bottone che adesso non c'è più: lasciarle lì avrebbe sfoltito i controlli prima del necessario.

**② Il 95% che dava fastidio a Tommy non era un difetto: era il denominatore.** La percentuale voleva dire
«la pagina alla sua dimensione reale a 96dpi» — la lettura di Overleaf. Il 95% era il numero onesto per la
sua finestra, e su un altro schermo sarebbe stato 87% o 112%: nessuno l'aveva scelto. Ora la base è la
**pagina intera in vista**, che è anche la vista di apertura → **si apre a 100%**.
- **Decisione di Tommy**, presa prima di scrivere: sì al cambio di base, e **apertura a fit-to-height**
  («più leggibile a livello iniziale»).
- **Una deviazione dalla richiesta letterale, dichiarata prima del check**: 100% è il **minore fra
  fit-height e fit-width**, non fit-height alla lettera. Sul suo schermo largo vincola comunque fit-height,
  quindi vede esattamente quel che ha chiesto; ma a pannello stretto e più alto di un A4 il fit-height
  letterale spinge la pagina **fuori in larghezza**, e una vista di default da scorrere di lato non è una
  vista di default. La voce **«Fit to height» del menù resta letterale**: la scegli e la ottieni, barra
  compresa (116% misurato).
- **Un fit diventa una modalità, non un colpo singolo.** Senza, bastava trascinare il divisorio e
  l'etichetta scivolava a 103% — proprio la cosa che dava fastidio. Ed è ciò che rende vero «di default a
  ogni compilazione»: **ricompili e torni alla pagina intera, a meno che tu non abbia scelto uno zoom tuo**,
  che allora sopravvive. Le due letture della richiesta si risolvono da sole così.
- **Spunta esclusiva nel menù**: a pagina intera si accende il fit che vincola e **non anche «100%»** — che
  ormai è lo stesso punto, e due spunte in un menù sembrano un difetto.

**③ Numero e freccetta, due bottoni saldati in una pastiglia sola.** Il numero riporta a 100%, solo la
freccetta apre i preset; l'hover accende metà pastiglia, ed è quello a insegnare la differenza. Il numero
chiude il menù da sé, perché per il gestore del click-fuori è "dentro".

**Tre difetti trovati per strada, due miei**
- `fitHeightZoom()` misurata **prima che il pannello avesse una larghezza** (`fitScale` ancora stantio):
  prima non contava, adesso è la base della percentuale e finiva **dentro `zoom`** → pagina grande **un
  quarto** con l'etichetta che diceva serenamente 100%. Guardia come quella che `computeFitScale` aveva già.
- L'anteprima istantanea calcolava la scala dal **solo rapporto degli zoom**: giusto finché nessuno
  rifittava, ma un resize sposta anche `fitScale` → **ingrandiva del 10% una pagina che doveva rimpicciolire
  di un quarto**. Ora `liveScale()` tiene conto di entrambe le metà (`renderedFit × renderedZoom`).
- **Preesistente, segnalato da Tommy al check**: la pagina si poteva **trascinare di lato anche quando era
  più piccola del pannello**. `.pdf-sizer` non ha mai misurato il contenuto — lo prendeva da `.pdf-pages`,
  che è un blocco *dentro* di lui, quindi il suo `offsetWidth` **è** la larghezza del contenitore: un valore
  che si moltiplicava addosso a ogni zoom partendo da quella del pannello. Corretto misurando la tela più
  larga più il padding. Cade anche una cosa che nessuno aveva notato: `.pdf-sizer { margin: 0 auto }`
  esisteva dal giorno uno col commento «centra la pagina quando è più stretta del pannello» ed **era codice
  morto**, perché il contenitore riempiva sempre il pannello.

**Coda, dal check di Tommy**
- **Il «Restore» disabilitato della history era illeggibile.** La regola toglieva lo sfondo accento ma
  teneva il **colore di testo scritto per quello sfondo**, al 45% di opacità: su pannello scuro spariva.
  Testo muto, bordo neutro, 85% — leggibile nei due temi, e lontanissimo dal primario blu di quando è attivo.

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh` **31/31** — niente
di nuovo lato server, quindi nessun check aggiunto)
- Apertura e ricompilazione **a 100% con la pagina intera**, senza traboccamenti; a **347px** idem, con la
  toolbar che sfoltisce (`data-tight`) e non sfora.
- **Lo zoom esplicito sopravvive alla ricompilazione**: a 150% si ricompila e resta 150%; a 100% resta 100%.
- Menù: **«Fit to height» letterale** (116% + barra orizzontale), spunta esclusiva, Esc, click fuori, e il
  numero che chiude *e* riporta a 100% anche col menù aperto.
- Contenitore: giro **100% → 200% → 100%** e torna a **638 = 606+32** esatti, centrato
  (`margin:auto` = 30px per lato), zero scorrimento orizzontale.
- **Nota di metodo, di nuovo decisiva.** Tre volte stavo per attribuirmi (o negare) roba a occhio, e tre
  volte l'ha stabilito una misura A/B col codice originale rimesso: il traboccamento della pagina **era
  preesistente** (originale a 67%: contenitore **564** contro contenuto **582**; dopo: **533 = 533**), e la
  geometria a parità di finestra è **identica al pixel** — cambia solo il numero (56% → 100%). Terza:
  il render che sembrava incastrato **non lo era**, PDF.js disegna dentro `requestAnimationFrame` e nel
  browser incorporato il frame non arriva finché non forzo uno screenshot. Senza quella verifica avrei
  «corretto» un blocco che non esisteva.
- **Quello che non ho potuto provare qui e ha provato Tommy**: il **trascinamento del divisorio** (stesso
  motivo, il resize non si assesta senza frame). Suo verdetto: «funziona bene».

---

## 2026-08-05 (ter) — Giro 12: selezione multipla e azioni in massa, alla Overleaf ✅ (check di Tommy OK)

**L'ultimo punto rimasto in lista dal 18 luglio.** Il cestino era caduto stamattina; questo era l'altro,
e si porta dietro quello che il giro 11 aveva dichiarato mancante: «cestinare venti progetti sono venti
click». Ora sono due. Come per i giri 9 e 10, il modello è preso dai **file veri di Overleaf**
(`overleaf/overleaf`, `services/web/frontend/js/features/project-list/components/table/`) invece che a
occhio — e le loro colonne sono già le nostre: checkbox, Title, Owner, Last modified, Actions.

**Le due decisioni di Tommy**, prese prima di scrivere una riga: il **download in massa fa uno .zip per
progetto**, uno dopo l'altro (l'alternativa era un endpoint nuovo che li impacchetta in un archivio solo,
come fa Overleaf — costava mezzo giro in più e il prezzo di questa scelta è il permesso che il browser
chiede al secondo file); e nel menu dei tag si resta **fedeli a Overleaf: spunta o niente**, senza il
trattino per il caso misto.

**① La colonna delle checkbox**, prima di Title, col «seleziona tutto» in testata e il suo stato
indeterminato. Sono `<input type="checkbox">` nativi di proposito: `accent-color` li dipinge del blu
dell'app, `color-scheme` (già su `:root` per entrambi i temi) li rende leggibili al buio, e tastiera +
stato indeterminato arrivano gratis — un div fatto a mano avrebbe dovuto tutti e tre. La riga selezionata
prende la **barretta d'accento a sinistra**: l'hover già tinge la riga, serviva un segno che resta quando
il mouse se ne va.
- **Il click sulla checkbox non apre il progetto**, e a mangiarselo è **tutta la cella**, non solo la
  casella: se no i pochi pixel di padding intorno navigavano via lo stesso.
- Anche `Invio` sulla riga ora vale **solo se il fuoco è sulla riga**. Prima l'evento saliva da qualunque
  controllo dentro; con una checkbox lì dentro sarebbe diventato un modo per uscire dalla pagina per sbaglio.

**② La barra prende il posto della ricerca** quando c'è una selezione — Overleaf fa lo stesso, e i due
non si contendono l'angolo. Le azioni cambiano con la vista: `Tags ▾ · Download · Archive · Trash` in
lista, `Tags ▾ · Download · Restore · Trash` in archivio, solo `Restore · Delete permanently` nel cestino.
- **Una deviazione da Overleaf, voluta**: loro nascondono i tag in archivio. Da noi il 🏷 di riga lì c'è
  già dal giro 7, e una barra che contraddice la riga sotto è un pezzo rotto.
- **Il download in massa non c'è nel cestino**: il giro 11 aveva deciso che una riga cestinata offre solo
  Restore e Delete permanently, e non ha senso smentirlo qui.
- I bottoni stanno **tutti nel markup** e si nascondono per vista, non si rigenerano: al popover dei tag
  serve un elemento d'ancoraggio che non gli sparisca sotto.

**③ Tag in massa, con la regola di Overleaf.** La spunta vuol dire «ce l'hanno **tutti**»; il click la
toglie a tutti quando l'hanno tutti, altrimenti **lo aggiunge solo ai mancanti** — che è l'unica cosa che
«add to tag» possa significare per una selezione mista. Il menu è lo stesso del 🏷 di riga, generalizzato
a una **lista** di progetti (una sola voce per il caso singolo).

**④ Cestina, archivia, ripristina, elimina: cicli sugli endpoint per-progetto.** Nessuna superficie nuova
sul server — per questo `smoke.sh` resta a 31 check, senza aggiunte: non c'era niente di nuovo da
sorvegliare lì. Sequenziali di proposito: scritture parallele sugli stessi `meta.json` non comprano nulla,
e una raffica rende impossibile raccontare onestamente un fallimento parziale («3 di 7 non riuscite» vuole
il conteggio). Il contatore è a schermo mentre girano (`Moving to trash 3/5…`).
- Conferma su **cestina** ed **elimina definitivamente**, col dialogo del giro 11 (fuoco su Cancel, corallo
  solo sull'irreversibile). Archivia e ripristina no: sono reversibili, esattamente come le azioni di riga.
- Dopo un'azione la selezione **si azzera**: quei progetti hanno lasciato la vista, e una spunta rimasta
  lì li avrebbe fatti resuscitare selezionati appena entravi nella vista dove sono andati. Taggare e
  scaricare invece la tengono — non hanno spostato niente.
- Il ripristino in massa **dice il rename**, come quello singolo: `5 projects restored ✓ (1 renamed)`. Un
  progetto che torna zitto come «Thesis (2)» sembra un bug, non un nome occupato nel frattempo.

**⑤ La ricerca restringe, non distrugge.** Il `Set` tiene gli id, ma tutto agisce su quelli che **vedi**:
filtri e la barra parla di meno, pulisci il filtro e tornano. Cambiare vista invece azzera — quello è un
lavoro diverso.

**Due cose sistemate per strada, tutte e due colpa mia**
- I messaggi nuovi sono frasi («5 projects moved to trash ✓») e a 375px la pastiglia di stato andava a
  **4 righe dentro una topbar da 50px**. Ora è a riga singola con ellissi, e il testo pieno vive nel
  tooltip (`setStatus` scrive anche `title`).
- La colonna delle checkbox aveva schiacciato il **nome del progetto a 0px** sotto i 760px. Ho nascosto lì
  il 🏷 di riga: si rivela solo all'hover, che su uno schermo stretto non esiste, e costava 32px per un
  bottone irraggiungibile — il `Tags ▾` della barra fa lo stesso lavoro.

**Coda, dopo il check di Tommy**
- **La pastiglia di stato non scadeva mai.** Il difetto era più largo di com'era stato notato: *nessun*
  messaggio se ne andava, restava finché non ricaricavi o non ripartiva un `load()`. Lo svuota-cestino lo
  rendeva evidente perché è l'ultima cosa che fai in quella vista, e poi te ne vai. Ora un **successo dura
  4 secondi** e sparisce da solo; un **errore no**, quello devi poterlo leggere con calma.
- **Via il badge «draft»** dalla home, `<span>` e regola CSS (nell'editor non c'era già più).

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh` **31/31**)
- **Il caso misto dei tag**, che è il cuore del giro: `zz-blue` su A e B, non su C. Un click → finisce
  **solo su C**, A e B saltati (conteggi 2→3 e «Senza tag» 4→3, popover che resta aperto e si riposiziona);
  secondo click con la spunta piena → tolto a tutti e tre, confermato via API (`tags: []` su tutti).
- **Giro completo su 5 progetti usa-e-getta**: `5 projects archived ✓` → dialogo «Move 5 projects to
  trash?» → `5 projects restored ✓ (1 renamed)` (avevo occupato «zz-bulk-A» nel frattempo → tornato come
  **`zz-bulk-A (2)`**) → `5 projects deleted permanently ✓`, con le **cartelle sparite da disco**
  (controllate dentro il container).
- **La regola del giro 11 regge anche in massa**: i cestinati che erano archiviati tornano **nell'archivio**,
  non in lista — verificato che `archived` sopravviva al viaggio su tutti e cinque.
- **Le viste**: archivio `[Tags, Download, Restore, Trash]`, cestino `[Restore, Delete permanently]` con la
  colonna «Deleted». Dialogo dell'eliminazione: fuoco su **Cancel** (letto `activeElement`), bottone corallo
  «Delete 5 projects», la frase irreversibile al suo posto.
- **La ricerca non distrugge**: 2 selezionati → filtro → «1 selected» → filtro pulito → «2 selected».
  Nessuna riga visibile → «0 selected», barra via, ricerca che torna col testo intatto.
- **Il click sulla checkbox non apre**: URL invariato.
- **375px**: la barra va a capo su una riga sua, quattro bottoni leggibili; pastiglia da 68px a **25px**,
  una riga sola; nome del progetto da **0 a 11px** (la linea di partenza era 13).
- **La coda**: `Trash emptied ✓` ancora lì a 2s, **sparita a 4,6s**, anche tornando su «All projects».
  L'errore invece resta: un 409 vero («Move the project to the trash first.») ancora a schermo **dopo 5s**,
  e un successo subito dopo si cancella comunque — il timer non resta incastrato.
- **Il download in massa l'ha verificato Tommy nel browser vero**: qui le due richieste tornano 200 e il
  contatore gira (`Downloading 1/2…` → `2 zips downloaded ✓`), ma nel browser incorporato **i file non
  atterrano su disco**, quindi il prompt «consentire più download?» non era osservabile da qui.
- Prove tutte su progetti **usa-e-getta**, cancellati a fine giro (libreria di nuovo col solo «Sample
  paper», `meta.json` intatto, `updatedAt` fermo al 2 agosto, zero tag). Tema mai toccato.
- **Nota di metodo**: stavo per attribuire alla mia colonna un overflow orizzontale di 89px a 375px. A
  stabilire che era preesistente è stata una misura A/B — rimettere la griglia vecchia con un `<style>`
  temporaneo e rimisurare: **89px in entrambi i casi**. Senza quella misura avrei «aggiustato» una cosa
  che non avevo rotto io, e non avrei visto la pastiglia, che invece era mia davvero.

**Rimandato di proposito**
- **Shift-click per selezionare un intervallo**: Overleaf non ce l'ha, e ricerca + «seleziona tutto» copre
  già il caso dei venti progetti (filtra, spunta la testata, agisci).
- **Difetto preesistente, non toccato**: a 375px la topbar sfora di ~85px in orizzontale ogni volta che c'è
  un messaggio di stato — è brand + nome utente + Switch + ⚙ + pastiglia che non ci stanno. Si vede solo
  mentre il messaggio è a schermo, e sistemarlo vuol dire ripensare la topbar stretta: è un giro suo.
  (I giri precedenti non l'avevano visto perché `.status:empty` la fa sparire: senza messaggio, nessun
  trabocco.)
- **Aprire un cestinato via URL diretto** funziona ancora e l'editor non ha il cartello: resta dal giro 11,
  da fare quando si toccherà l'editor.

**La lista del 18 luglio è finita.** Restano: **sicurezza giro 2** (allowlist per-persona, ACL per-progetto)
e **template** (Step G, da scrivere prima).

⚠️ **Non è live**: `public/` soltanto, ma serve comunque il pull+rebuild sul VPS (Albi) — fermo a
`1541753`, quindi gli mancano i giri 8, 9, 10, la coda, l'11 e questo.

---

## 2026-08-05 (bis) — Giro 11: il cestino, e l'eliminazione definitiva diventa a due stadi ✅ (check di Tommy OK)

Il primo dei due punti rimasti in lista dal 18 luglio (l'altro è **tag in massa**). Fino a ieri
`DELETE /api/projects/:id` faceva `rm -rf` della cartella dietro un `confirm()` nativo: **un click e
un progetto spariva per tutti**, senza rete. Ora la cancellazione è in due tempi, e il colpo
irreversibile è l'unico che non si può dare per sbaglio. Dopo il check di Tommy è stato
**committato e pushato** (`67cd94c` + `7a61f90`).

**Le due decisioni di Tommy**, prese prima di scrivere una riga: il cestino **non si svuota da solo**
(niente scadenza a 30 giorni: nessuna perdita di dati a sorpresa e nessun job periodico da
sorvegliare), e **conferma su entrambi i pulsanti**, con testi diversi.

**① Due stadi, e il secondo è chiuso a chiave dal server.** Il Delete di riga ora sposta nel cestino
(`meta.deleted` + `deletedAt` + `deletedBy`, stessa forma di `archived`: niente si muove su disco e
`updatedAt` non si tocca — buttare via non è editare). Il `DELETE` vero **rifiuta con 409 un progetto
che non sia già nel cestino**. È in `server.js`, non nella UI, di proposito: è l'unica chiamata
dell'API che non si può annullare, e una regola che vive solo nel client la aggira chiunque.
Resta idempotente su una cartella senza `meta.json` (è già detrito).

**② Il pop-up chiesto da Tommy**, e `window.confirm()` va in pensione. Un dialogo vero
(`confirmDialog`), perché il nativo non si può tematizzare, non sa dire **quale** bottone è quello
pericoloso, e stampa l'origine sopra la domanda ("localhost:3000 says") — brutta compagnia per "questa
azione è irreversibile". Tre dettagli che contano:
- **Il fuoco parte su Cancel**, non sull'azione: un Invio distratto non deve distruggere niente.
- **Tab resta dentro** il dialogo (ciclo fra i due bottoni), Esc e il click sullo sfondo annullano.
- Il bottone distruttivo è **corallo**, quello reversibile è l'accento normale. Spostare nel cestino
  e distruggere non devono somigliarsi.
- Ci è passato anche l'**elimina tag**, che era l'ultimo `confirm()` nativo rimasto sulla home:
  lasciarne uno accanto a un dialogo vero sembrava un pezzo rotto.

**③ La vista Cestino**, gemella di Archiviati: voce nel rail col conteggio, e un progetto cestinato
**sparisce da ogni altra vista** — archivio, tag, "Senza tag", conteggi compresi. Sta uscendo dalla
libreria, non deve continuare a colorarla. Dentro: solo **Restore** e **Delete permanently**, la
colonna "Last modified" diventa **"Deleted"** (lì la data utile è quella del cestinamento), i chip dei
tag restano ma in sola lettura, e in cima c'è **Empty trash** (compare solo a cestino pieno).
- **La riga non apre più niente al click**: nessuno deve lavorare per mezz'ora dentro un progetto
  condannato e perdere tutto quando qualcuno svuota. Restore è un click, e rimette il progetto
  esattamente dov'era — `archived` non viene toccato, quindi un archiviato torna nell'archivio.

**④ Il nome non resta in ostaggio.** `findProjectByName` **salta i cestinati**: se no, creando
"Thesis" ti prendevi un 409 che punta a un progetto che non puoi vedere. Il conto si paga al
ripristino, dove il nome può essere stato occupato nel frattempo: il server **suffissa** come già fa
l'upload di zip (`Thesis (2)`) invece di rifiutare — un restore che fallisce per un'etichetta
lascerebbe il progetto bloccato nel cestino con l'unica uscita di cancellarlo. Il client lo dice:
`Restored as "Thesis (2)" ✓`.

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh` **31/31** —
era 23, otto check nuovi tutti sul cestino)
- **I due dialoghi a schermo**: "Move to trash?" con l'azione in accento, "Delete permanently?" con la
  frase richiesta *"This action is irreversible. Are you sure you want to continue?"* sul bottone
  corallo. Esc annulla senza toccare niente (verificato: nessun progetto cestinato dopo l'Esc), Tab
  cicla Cancel → Delete → Cancel, il fuoco parte su Cancel.
- **Giro completo**: cestinato → riga con icona in grigio, "Deleted now · Paolo Rossi", solo le due
  azioni, chip senza ×, click sulla riga **non apre** (URL invariato). Restore → torna in lista **col
  suo tag**, cestino vuoto e "Empty trash" sparito da solo.
- **Delete definitivo**: confermato → sparito dalla lista **e la cartella non è più su disco**
  (controllata dentro il container). Empty trash su 4 progetti → "Delete 4 projects" nel dialogo,
  poi "Trash emptied ✓".
- **Le tre regole del server**, provate via API: `DELETE` su progetto vivo → **409 "Move the project
  to the trash first."**; creare un omonimo di un cestinato → **200**; ripristinarlo → **`zz-trash-A
  (2)`**.
- **Isolamento dalle altre viste**: tag con un solo progetto, cestinato → conteggio a zero e vista del
  tag vuota. L'elimina-tag conta invece **anche** i cestinati ("removed from 1 project"), perché la
  cascata arriva pure lì — verificato che dopo l'eliminazione il cestinato avesse `tags: []`.
- **Finestra a 375px**: titolo, Empty trash e ricerca convivono senza trabocco (`scrollWidth ==
  clientWidth` sia sulla pagina sia sulla testata).
- Prove tutte su progetti **usa-e-getta**, cancellati a fine giro (libreria di nuovo col solo "Sample
  paper", il suo `meta.json` intatto, `updatedAt` fermo al 2 agosto). Tema rimesso su "auto".
- Solita trappola del tool, quinta volta: col pannello del browser nascosto il viewport è **0x0** e
  `read_page` torna vuoto — uno screenshot forza un frame e si riparte.

**Rimandato di proposito**
- **Aprire un cestinato via URL diretto** (o segnalibro) **funziona ancora**: la riga non ci porta più,
  ma l'editor non ha un cartello "questo è nel cestino". Da fare quando si toccherà l'editor.
- **Nessuna selezione multipla**: cestinare venti progetti sono venti click. È esattamente il punto
  **tag in massa**, che porta con sé archivia/cestina in massa — l'altro giro rimasto in lista.
- **Nessuna GC del cestino**: per scelta, vedi sopra.

⚠️ **Non è live**: `server.js` + file statici, serve il pull+rebuild sul VPS (Albi) — fermo a
`1541753`, quindi gli mancano i giri 8, 9, 10, la coda e questo.

---

## 2026-08-05 — Coda del giro 10: il doppio render e il badge che non tornava dalla cache ✅ (check di Tommy OK)

I due residui dichiarati a fine giro 10, chiusi. Il giro 10 nel frattempo è stato **committato e
pushato** (`626b275` + `34968af`) dopo il check di Tommy.

**① Il PDF non si renderizza più due volte all'apertura** (bug pre-esistente dal giro 3). Un
`ResizeObserver` consegna **una callback appena inizia a osservare**, e quella arrivava mentre il
primo render era ancora in corso: `rendering` era true, la chiamata alzava `pendingRender` e il
`do/while` di `renderPdf` ridisegnava tutte le pagine **alla stessa identica scala**. Ora la
callback ridisegna solo se i pixel cambierebbero davvero — `fitScale` diversa da prima **oppure**
canvas non ancora alla `zoom` corrente. Due casi in più che smettono di sprecare lavoro, gratis:
quando cambia **solo l'altezza** del pannello (il fit dipende solo dalla larghezza) e quando il
pannello è **collassato** (a larghezza 0 `computeFitScale` tiene il fit vecchio, quindi saltare è
corretto).

**② Il badge del log si ripopola dalla cache.** Il server tiene anche **`build.log`** accanto a
`build.pdf`/`build.synctex.gz`/`build.json` e lo restituisce da `GET /api/projects/:id/build`; il
client, se il campo c'è, ripopola log e badge **prima ancora** di disegnare il PDF (`renderIssues`
è sincrono e sta prima di `loadPdf`). Tetto di **512KB** sul file: un log vero è decine di KB, solo
uno impazzito diventa grosso, e ogni apertura di quel progetto se lo porterebbe dietro — se sfora si
tiene la **testa**, dov'è la prima cosa andata storta.
- **Retrocompatibilità**: le build messe in cache prima di oggi non hanno il log → il campo torna
  `null` e il client **non tocca** il badge. "Non sappiamo il log di quella build" non è la stessa
  cosa di "quella build era pulita".
- La cache è per definizione l'ultima build **riuscita**, quindi da lì esce al massimo un badge
  **ambra**: un rosso da errori non ci finisce mai, perché una build con errori non lascia un PDF
  da rimostrare.

**Verificato** (dev :3000, browser reale, console pulita, `test/smoke.sh` **23/23** — un check nuovo
sul log servito dalla cache)
- **Doppio render, A/B sullo stesso progetto**: comportamento pre-fix **2** rasterizzazioni
  all'apertura, col fix **1**. Catturata anche la decisione della callback: `prevFit 0.5474 =
  fitScale 0.5474`, `renderedZoom 1 = zoom 1` → skip. Cioè il render tagliato è esattamente quello
  che ridisegnava l'identico.
- **Il comportamento utile è intatto**: pannello allargato (367 → 547px) → PDF ri-adattato da **41%
  a 63%**, nessun trabocco (`scrollWidth <= clientWidth`).
- **Badge dalla cache**: riapertura → **ambra "3"**, tooltip "Compilation log — 3 warnings", stato
  "Compiled ✓" **senza ricompilare**; click sull'icona → il log vero della build (9416 byte,
  intestazione latexmk) coi suoi 3 warning nella lista, bottone acceso e tooltip "Back to the PDF".
- **Cache stale**: il badge è a schermo prima ancora che il PDF sia disegnato, poi l'auto-compile
  conferma lo stesso esito.
- **Retrocompatibilità provata sul campo**: `build.log` rinominato a mano nel container → `log:
  null`, badge nascosto, pannello log vuoto, nessun errore in console.
- Progetto **usa-e-getta cancellato** a fine giro; il Sample paper di Tommy non è stato nemmeno
  aperto (`updatedAt` fermo al 2 agosto).
- **Nota di metodo — quarta incarnazione della solita trappola**, e stavolta è costata: col pannello
  del browser nascosto il tab è `hidden`, rAF non scatta e **PDF.js resta appeso a metà
  `page.render()`**; `rendering` resta true e **assorbe in `pendingRender` tutte le chiamate
  successive**. Contare le rasterizzazioni in quello stato dà numeri che si contraddicono — due
  misure hanno detto il contrario l'una dell'altra prima che capissi perché. La via d'uscita:
  strumentare il **punto di decisione** invece dell'effetto (non dipende da PDF.js) e forzare un
  frame con uno screenshot prima di ogni lettura.

⚠️ **Non è live**: il VPS (Albi) è fermo a `1541753` — gli mancano i giri 8, 9 e 10 (già su `main`)
e questa coda quando sarà committata.

---

## 2026-08-02 (ter) — Giro 10: la barra strumenti del PDF alla Overleaf (il punto ④) ✅ (check di Tommy OK)

Il punto rimandato dal giro 9, con le decisioni prese da Tommy. Come per i temi del giro 9,
l'ordine dei controlli è preso dai file veri di Overleaf
(`overleaf/overleaf`, `services/web/frontend/js/features/pdf-preview/components/`) invece che a
occhio: a sinistra i comandi della **build**, a destra quelli della **vista**.

**Cosa c'è ora nell'header del pannello PDF** — `[🕘] [Compile] [log] [⬇]` … `[⌃ ⌄ 1 / 7] [− + 57% ▾]`.
La topbar in alto resta con le sole cose che riguardano la **stanza** e non la build: avatar delle
presenze e stato del sync. Il titolo "Preview" è sparito: la barra dice già cos'è quel pannello, e
in 487px non c'era spazio da regalare. Tutto è dimensionato per stare dentro `--head-h` (34px), così
la fascia degli header resta allineata con quella dell'albero file e dei tab dell'editor — un header
PDF più alto avrebbe sfalsato la riga su tutta l'app.

**① Il pulsante che è anche lo stato** (la richiesta di Tommy: un solo elemento, non chip + bottone).
`Compile` → `Compiling…` → `Compiled ✓` / `N errors`, e **al passaggio del cursore diventa
`↻ Recompile`**. Dettagli che contano:
- **Mentre compila è `disabled`**: niente hover, niente click, cursore normale — "non posso fare
  nulla" preso alla lettera. Per coerenza anche **⌘S ora ignora** una seconda richiesta mentre una
  build è in corso (prima ne partivano due in parallelo, l'ultima vinceva).
- **Le due facce stanno nella stessa cella di un grid** e una è a `opacity:0`: il bottone è largo
  quanto la più larga e **non salta** quando ci passi sopra (misurato: 103,06px in entrambi gli
  stati). Un `min-width:112px` tiene ferma anche la larghezza fra uno stato e l'altro, se no la
  riga di icone accanto ballava di 7px a ogni compilazione.
- Lo hover offre "Recompile" **solo** da `ok`/`err`: su un progetto mai compilato la scritta resta
  "Compile" — proporre di *ri*compilare qualcosa che non esiste sarebbe una bugia.
- `setStatus(kind, text)` ha la stessa firma di prima e ora pilota il bottone: il restore della
  cronologia ("Restoring…"/"Restored ✓") continua a funzionare senza toccarlo, e per giunta
  disabilita il pulsante durante il ripristino.

**② History e Download a icona**, la ⏱ subito a sinistra del pulsante di compilazione come chiesto,
il ⬇ dopo il log come su Overleaf. Stesso tratto SVG del rail; nessuna logica toccata (gli id sono
gli stessi, i listener pure).

**③ Il log non è più un tab ma un'icona con badge**: rosso col numero di **errori**, ambra col numero
di **warning** quando errori non ce ne sono, assente se non c'è niente da dire (`parseLatexLog` le
due categorie le distingueva già dal giro 3, ma contavamo solo gli errori). Lo stesso bottone fa da
interruttore PDF⇄log: quando il log è a schermo si accende in accento e il tooltip diventa "Back to
the PDF". Sparito `#tabPdf`.

**④ Pagine e zoom come Overleaf.** Navigazione: chevron su/giù, la pagina corrente in un campo in cui
si può **scrivere** (Invio ti porta lì, fuori range viene clampato) e `/ N`; l'indicatore segue lo
scroll (una sola rilettura per frame). Zoom: `−`/`+` a passo **moltiplicativo** (×1.1, così un click
pesa uguale al 50% e al 400%) più la tendina di Overleaf — Fit to width, Fit to height, 50/75/100/
150/200/400% — con la spunta sulla voce attiva.
- **La percentuale cambia significato, di proposito.** Prima "100%" voleva dire "largo quanto il
  pannello"; ora è la percentuale della **dimensione reale** della pagina (100% = pagina a 96dpi,
  la convenzione di pdf.js e di Overleaf). È l'unica lettura in cui "Fit to width" e "100%" sono due
  voci diverse e sensate nello stesso menu. Dentro, `zoom` resta il moltiplicatore su fit-width che
  serve alla matematica della pinch: la conversione vive in tre funzioni di una riga (`pctOfZoom`,
  `zoomOfPct`, `clampZoom`), e i limiti sono passati da "×0.1…×5" a "10%…400% reali" perché il 400%
  con un pannello stretto sfondava il vecchio tetto.
- Le voci passano dallo stesso `zoomToCenter` dei pulsanti: quello che stavi leggendo resta dov'era.

**⑤ Due casi di bordo chiusi.**
- **Pannello PDF collassato**: i comandi ci vivono dentro, quindi ⌘S ora **riapre il pannello** prima
  di compilare (`revealPreview`, gemello di `revealEditor`) — altrimenti premeresti nel vuoto, col
  risultato e l'eventuale log nascosti dietro una colonna chiusa.
- **Pannello stretto**: un `ResizeObserver` sull'header toglie prima la navigazione pagine (sotto
  458px di contenuto) e poi lo zoom (sotto 328px); i comandi della build non spariscono mai — perdere
  Compile perché hai tirato il divisorio è l'unica cosa a cui non potresti rimediare.

**Verificato** (dev :3000, browser reale, chiaro + scuro, `test/smoke.sh` **22/22**)
- **Stati del pulsante**, tutti visti a schermo: `Compile` su progetto senza PDF, `Compiling…`
  arancione con spinner e `disabled=true` (mouse fermo sopra: la faccia "Recompile" resta a
  `opacity:0`), `Compiled ✓` verde, `1 error` corallo. Hover → `Recompile` in accento, larghezza
  identica al pixel.
- **Badge**: build con 3 warning → badge **ambra "3"**, tooltip "Compilation log — 3 warnings";
  `\undefinedcommandhere` → badge **rosso "1"**, log aperto da solo con la riga cliccabile
  `main.tex:5`, bottone log acceso e tooltip "Back to the PDF"; riclick → torna al PDF, pagine e
  zoom ricompaiono.
- **Pagine** su un PDF di 7 pagine: `⌄` → pagina 2 (scrollTop 665 = cima pagina 2 − 8); scritto "6"
  + Invio → pagina 6 (3293 su 3301); `99`→7, `0`→1, `abc`→1; scroll a mano → l'indicatore passa a
  5 mentre a schermo si legge il piè di pagina "5"; frecce disabilitate a inizio e fine.
- **Zoom**: `Fit to height` → pagina renderizzata **427×604** in un pannello alto 636 (604 = altezza
  utile esatta); `100%` → pagina a dimensione reale con scroll orizzontale; la spunta segue la voce.
- **Stretto**: a 431px sparisce la navigazione pagine, a 325px anche lo zoom, `scrollWidth ==
  clientWidth` in entrambi i casi (nessun trabocco).
- **Collassato**: `›` chiude il pannello (colonna a 0px), ⌘S lo **riapre** e la build parte.
- **Contorno**: History apre l'overlay col nome giusto, Download prepara `zz-toolbar-test.pdf` dal
  blob, chiaro e scuro entrambi leggibili, home page non toccata (`.iconbtn` lì non si usa).
- Le prove vere sono state fatte su un **progetto usa-e-getta** (multipagina, poi rotto apposta per
  gli errori) **cancellato a fine giro**: il Sample paper di Tommy non è stato toccato — le sue righe
  di prova sono dov'erano e `updatedAt` non si è mosso. Libreria di nuovo col solo "Sample paper".

**Da sapere, non risolto qui**
- **Il PDF si renderizza due volte all'apertura**, ed è **pre-esistente** (giro 3): il
  `ResizeObserver` su `.preview-body` scatta la prima volta mentre il primo render è ancora in corso,
  alza `pendingRender` e il `do/while` di `renderPdf` rifà tutto da capo. In un browser vero è solo
  lavoro sprecato; qui l'ho beccato perché nel tab del tool congelato la seconda passata restava
  appesa. Si chiude con due righe, ma è un'altra cosa dal punto ④.
- **Il badge non si ripopola dalla cache**: riaprendo un progetto si rivede il PDF salvato ma non i
  suoi warning, perché la build in cache porta il PDF, non il log. Era già così coi tab.
- Nota di metodo per il prossimo giro col browser di prova: se il pannello del browser è nascosto il
  tab è `visibilityState:"hidden"` e **rAF non scatta** → PDF.js resta appeso a metà `page.render()`
  e con lui tutta la catena `loadCachedBuild → loadPdf`. Non è un bug dell'app: uno screenshot (che
  forza un frame) la sblocca. Terza incarnazione della stessa trappola (giro 5, giro 6, questa).

⚠️ **Non è live**: file statici, ma serve comunque il pull+rebuild sul VPS (Albi) — che resta fermo
a `1541753`, quindi gli mancano ancora i giri 8, 9 e 10.

---

## 2026-08-02 (bis) — Giro 9: ⚙ nel rail, i temi editor di Overleaf, icone ricentrate ✅ (check di Tommy OK)

Tommy ha messo quattro punti con screenshot alla mano. I primi tre sono piccoli e indipendenti
e stanno qui; **il quarto** (allineare la barra strumenti al modello Overleaf, log compreso) è
una ristrutturazione a parte — vedi in fondo. Dopo il check di Tommy è stato **committato e
pushato** (`ec981b3` + `aadcee2`).

**① La ⚙ scende nel rail, in fondo.** Era nella toolbar in alto; ora vive col resto dei
pannelli, come su Overleaf. Il rail passa da `<nav class="rail">` a `<div class="rail">` che
contiene un `<nav class="rail-panels">` (i tre bottoni di pannello, etichetta di accessibilità
invariata) più la ⚙, tenuta giù da `margin-top:auto`. Sta **fuori** dal `<nav>` di proposito:
non è un pannello ma un popup, e infatti non prende mai la classe `.active` — verificato.
Il popup non può scendere verso il basso da lì, quindi si apre **di lato** (`left:100%`) e
cresce verso l'alto (`bottom:0`). Il cablaggio in `theme.js` è rimasto intatto: cerca
`#settingsMenu`/`#settingsBtn` per id, non per posizione, quindi la home — che la ⚙ ce l'ha
ancora in topbar, non avendo un rail — continua a funzionare senza una riga di differenza.
Il glifo testuale ⚙ è diventato un SVG con lo stesso tratto degli altri tre.

**② I sette temi editor di Overleaf**, presi dai loro veri file CM6
(`overleaf/overleaf`, `services/web/frontend/js/features/source-editor/themes/cm6/*.json`):
Eclipse, Overleaf Light, TextMate · Cobalt, Dracula, Monokai, Overleaf Dark. La tendina ora è
raggruppata **Light / Dark** come la loro, coi nostri quattro in coda a ciascun gruppo (11 in
totale). Nessun impianto nuovo: il sistema temi era già CSS-only (`body[data-editor-theme]` +
13 variabili), quindi è stato un lavoro di **mappatura**, non di codice. Due punti dove la
copia letterale non era possibile, ed è scritto nel CSS:
- **I token.** Le loro palette sono su tag generici (`keyword`, `string`, `typeName`…), le
  nostre su ruoli LaTeX. Regola fissa: command←keyword, comment←comment, string←string,
  number←number (o `literal`), math←`typeName` — l'altro accento del tema, che sta bene
  sulla matematica — bracket/meta←il tono spento. Dove Overleaf lascia un ruolo senza colore
  (i numeri di Dracula) si cade sulla palette canonica del tema, non sul testo normale.
- **`--ed-active-line` deve restare traslucido**, ed è stato **riverificato sul campo** invece
  che dato per buono: con un colore pieno (`#44475a`, il valore vero di Dracula) una selezione
  sulla riga del cursore **sparisce del tutto** — il layer di selezione di CodeMirror sta a
  `z-index:-2`, sotto lo sfondo della riga. Quindi i temi che tingono la riga attiva con un
  colore pieno (Dracula, Monokai, Overleaf Dark) ricevono l'overlay equivalente. Eclipse a
  monte non la evidenzia affatto: gliene abbiamo messa una tenue, se no il cursore si perde.
- Gli id sono anche le chiavi in `localStorage`: una volta usciti non si rinominano, o la
  scelta salvata di tutti si azzera in silenzio. Il default resta **Pastel Light** — chi non
  ha mai scelto non si ritrova l'editor cambiato sotto le mani.
- Provenienza e licenze sono annotate nel blocco CSS: sono temi Ace convertiti da Overleaf,
  ognuno con la sua licenza nel loro repo; i due "Overleaf Light/Dark" sono roba loro.

**③ Icone ricentrate nei bottoni** della lista progetti. Causa trovata misurando, non a occhio:
`.row-act` è 28px in `border-box` ma non azzerava il **padding di default del `<button>`**
(`1px 6px`) — restavano 14px di area utile, l'icona da 16px traboccava e finiva a 7px da
sinistra e 5px da destra. Sul badge "PDF" (18,8px di testo) era 7 contro 2,2. Un `padding:0`
e tornano centrate al pixel (L=R=6, T=B=6; misurato, non stimato).
- **Effetto collaterale scoperto e chiuso**: era proprio quel padding a tenere i bottoni
  rigidi come flex-item. Tolto, in una finestra stretta si schiacciavano a 18,7px. Serviva
  anche `flex:0 0 auto`. Beccato per fortuna: il viewport del browser di prova è collassato
  a zero da solo e ha reso la cosa evidente.
- Stesso identico difetto su **`.tag-add`** (l'etichetta accanto al nome progetto): 14px in
  un box da 8px, 6px di sbilanciamento. Sistemato con la stessa riga — è la stessa riga della
  tabella, sarebbe stato strano lasciarlo storto. Una passata automatica su **tutti** i
  bottoni-icona delle due pagine ora non trova più niente di scentrato.

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh`
**22/22**)
- **⚙ nel rail**: apre col click, chiude cliccando fuori e con Esc (le tre strade di
  `theme.js`, provate una per una). Popup leggibile anche col **pannello laterale collassato**
  (galleggia sull'editor: sta nel rail, non nel pannello, quindi il `visibility:hidden` del
  collasso non lo tocca) e con **Review/Chat** attivi. Mai la classe `.active`.
- **Temi**: tutte e 11 le palette risolvono davvero le 13 variabili (controllo automatico:
  nessuna che ricada sui default di `:root` per un blocco CSS mancante o un id scritto male).
  Guardati a schermo Overleaf Light, Overleaf Dark, Eclipse, TextMate, Cobalt, Monokai: ognuno
  riconoscibile — Cobalt col suo blu notte e i comandi arancioni, Eclipse col magenta scuro,
  Monokai col rosa. Scelta salvata e ripresa dopo un reload.
- **Icone**: L=R e T=B su ogni bottone delle due pagine, larghezza tornata a 28px.
- Nota di metodo, a correzione del giro 8: le coordinate del tool browser sono nello spazio
  che il tool stesso dichiara in **"Screenshot size"** (qui 800×500) — l'immagine che si vede
  è il doppio (retina), quindi va **dimezzata**, non moltiplicata. Tre click a vuoto prima di
  capirlo, di nuovo.

**Rimandato di proposito → il punto ④, la barra strumenti alla Overleaf.** Oggi Compile e
Download PDF stanno nella topbar globale e il log è un tab accanto a PDF; Overleaf li mette
tutti nell'header del pannello PDF, col log come icona a badge (arancione = warning, rosso =
errori). Il parsing già distingue le due categorie (`parseLatexLog`), oggi però contiamo solo
gli errori. Da decidere prima di partire: se Compile emigra nell'header, **cosa succede quando
il pannello PDF è collassato** (oggi il pulsante è sempre raggiungibile); se prendiamo anche
la navigazione pagine ("6 / 7") e lo zoom a tendina; dove finiscono avatar presenze e il chip
"Compiled ✓", che Overleaf lì non ha.

⚠️ **Non è live**: file statici, ma serve comunque il pull+rebuild sul VPS (Albi) — che è
ancora fermo a `1541753`, quindi gli manca anche tutto il giro 8.

---

## 2026-08-02 — Giro 8: salta-al-collega, preview senza scritta, PDF già pronto all'apertura, nomi progetto unici ✅ (check di Tommy OK)

Quattro richieste di Tommy in un colpo solo. Dopo il suo check è stato **committato e pushato**
(`f02aea0` + `6f2db8f`).

**① Click sull'avatar di un collega → si salta dove sta lui.** L'avatar nella toolbar era solo
informativo; ora quello **degli altri** (non il proprio) è un teletrasporto: apre il suo file e ci
porta il cursore. La posizione arriva da due campi di awareness già pubblicati — `activeFile`
(nostro, da `openFile`) e `cursor` (di yCollab). Il secondo è in **relative-position Yjs**, quindi
si decodifica contro il doc vivo e atterra sul carattere giusto anche se nel frattempo il testo si
è mosso; se manca (peer appena entrato, file binario) si apre comunque il file. Un collega con più
tab aperti: vince il tab che ha un cursore. Il tooltip ora dice anche **dove** sta ("Paolo Rossi —
in sections/math.tex · click to follow") e l'`aria-label` lo segue. Editor collassato → il salto lo
riapre (`revealEditor`, come già fanno errori e card di review).

**② Via "Press Compile to generate the PDF"** dalla preview: rimossi `#previewEmpty` e la sua
regola CSS, e le tre righe che lo mostravano/nascondevano in `compile()` e `showTab()`. Resta il
fondo grigio della preview, com'è stato chiesto.

**③ Il PDF c'è già quando apri il progetto.** Prima ogni apertura ripartiva da zero: pannello
vuoto finché latexmk non finiva. Ora l'ultima compilazione **riuscita** viene tenuta per progetto —
`build.pdf` + `build.synctex.gz` + `build.json` accanto a `meta.json`, **fuori da `files/`**: un
artefatto di build non è un sorgente e non deve entrare in compile, zip o history (stessa logica di
`comments.json`/`chat.json`). `/api/compile` la salva quando riceve il nuovo campo `projectId`
(best-effort: se il salvataggio fallisce la compile resta valida), e `GET /api/projects/:id/build`
la restituisce con la stessa forma JSON di una compile vera, così il client la dà in pasto allo
stesso codice.
- Il server marca la build **`fresh`** confrontando il suo timestamp con `updatedAt` del progetto:
  se nessuno ha salvato da allora, il PDF **è** quello dei sorgenti correnti → l'auto-compile
  all'apertura **si salta del tutto** (apertura istantanea, niente latexmk inutile). Stale → il PDF
  vecchio si vede subito e la compile lo sostituisce quando arriva.
- Le corse sono chiuse in un punto solo: `onSynced` **aspetta la promise** della cache prima di
  decidere, e un `compileStarted` fa stare la cache in disparte se l'utente ha già premuto Compile —
  un risultato vero, anche fallito col suo log, batte sempre il PDF di ieri.
- Effetto collaterale gradito: **Download PDF** funziona appena aperto il progetto (`pdfBlob` è già
  pieno), e il synctex della cache alimenta subito le frecce forward/inverse.

**④ Due progetti non possono avere lo stesso nome.** Un solo controllo condiviso
(`findProjectByName`, case-insensitive e trim) su **create**, **rename** e il PUT legacy → **409**
con messaggio leggibile; il client mostra già `data.error`, quindi niente da cambiare lì.
L'**upload di uno zip** fa eccezione di proposito: i byte sono già sul server, un 409 costringerebbe
a rinominare e ricaricare tutto, quindi auto-suffissa `Thesis (2)`, `(3)`… La rinomina **allo stesso
nome** resta lecita (l'`exceptId` esclude il progetto da sé stesso) — serve per cambiare solo le
maiuscole.

**Verificato** (dev :3000, browser reale, due utenti veri via magic-link, chiaro + scuro, console
pulita, `test/smoke.sh` **22/22**)
- **Salto**: DemoAccount messo a fine riga 7 di `math.tex`, Paolo su `main.tex` riga 1 → click
  sull'avatar DA dal tab di Paolo → **cambia file** (main→math) e cursore a **offset 18**, cioè
  esattamente sul caret di DemoAccount (column-aware, non solo la riga). Il proprio avatar non è
  cliccabile (niente classe, niente listener, cursore normale). Editor collassato → riaperto dal
  salto. Tooltip col file giusto in entrambi i tab.
- **Preview**: `#previewEmpty` non esiste più nel DOM, `.preview-body` resta sul suo grigio.
- **Cache**: progetto già compilato → riapertura con PDF **immediato** e stato "Compiled ✓", e
  `build.pdf` **non riscritto** (mtime fermo) = nessun latexmk inutile. Poi un edit vero (salvato,
  `updatedAt` avanzato) → riapertura: PDF vecchio subito, auto-compile parte, `build.json` aggiornato
  al secondo. Progetto nuovo: 404 sulla cache, compile normale.
- **Nomi**: "Sample paper" e "  sample PAPER " rifiutati con 409 e messaggio; nome nuovo 200;
  rename su nome altrui 409; rename a sé stesso 200; due zip con lo stesso nome → "(2)" e "(3)".
  I progetti di prova cancellati, la libreria è tornata al solo "Sample paper".
- **Smoke esteso** (era 16, ora **22**): tre check sulla build cache (404 prima, PDF servito dopo,
  flag `fresh`) e tre sull'unicità dei nomi. Erano proprio le due aree senza copertura.
- ⚠️ Residui dichiarati: il **Sample paper è tornato intatto al carattere** (la riga di prova
  aggiunta e rimossa), ma `updatedAt` è avanzato e restano 1-2 versioni auto in history (scadono
  con la retention). Le righe di prova di Tommy (`when i was a chidl`, `ciaooo seee godeeee`) sono
  rimaste **come le ha lasciate**.
- Inciampo del tool browser, di nuovo: le coordinate manuali sono nello **spazio dell'immagine**
  (1600×900), non in CSS px (1280×720) — tre click a vuoto sull'avatar prima di ricordarsene. E un
  tab **in secondo piano non riceve i tasti**: per piazzare un cursore lì è servita la Selection API.

**Rimandato di proposito**: nessuna GC per `build.pdf` (è **uno per progetto**, sovrascritto ogni
volta — non cresce); il salto non "segue" il collega mentre si muove (è un salto, non un follow-mode).

⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-29 — VPS ALUM riportato su `main`, redeploy, e chiusura dell'advisory adm-zip ✅

Sessione operativa sul server (`/opt/alum/alumere`), non di sviluppo.

**① Dal branch di deploy a `main`.** La copia sul VPS era su `deploy/alum-server` con un merge di
`main` **lasciato a metà** (conflitto su questo diario). Merge abortito e `main` portato avanti in
fast-forward `94dee35..1541753` (48 commit). **Nulla perso**: `deploy/alum-server` aveva un solo
commit proprio (`3fb21e9`) e il suo contenuto era già su `main` — `docker-compose.alum.yml`
identico (`git diff` vuoto) e la sezione "Deploy reale su VPS ALUM" già nel diario. Il branch
resta comunque su locale e su `origin`. Tutti i file di host (Caddy, compose, Dockerfile, `.env`)
verificati identici byte-per-byte dopo lo switch.

**② `redeploy.sh` versionato** (`0f94247`): girava solo sul server, non tracciato. Contiene i
safeguard che distinguono QUESTO deploy dagli altri compose del repo (pretende
`docker-compose.alum.yml` e la rete `alum_web`). **`.env` resta fuori dal repo** — ha
`SESSION_SECRET` e `SMTP_PASS` valorizzati, su GitHub finirebbero pubblici e nella storia.

**③ Redeploy**: `main` a `1541753` ora live, health locale e pubblico via Caddy entrambi
`{"ok":true,"engines":[...]}`.

**④ `npm audit` → 1 high, chiusa.** `adm-zip 0.5.18`, dipendenza diretta:
[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) (CVSS 7.5, CWE-400/789) —
uno zip malevolo fa allocare 4 GB. Superficie: `POST /api/projects/upload` (`server.js:756`) e
`POST /api/unzip` (`server.js:801`), **entrambi dietro `requireUser`** → serve un utente
autenticato del dominio consentito; impatto solo disponibilità. Il terzo uso
(`/api/projects/:id/download`, `server.js:832`) è in sola scrittura, non toccato. Due mosse:
- **`mem_limit: 1g`** su `docker-compose.alum.yml` (vedi DEPLOY.md): mitigazione che vale anche per
  qualsiasi altro runaway — senza limite un solo servizio poteva portare giù gli altri 13 container
  del VPS. Nessuna swap sull'host, quindi il tetto è duro.
- **upgrade a `adm-zip@0.6.0`** (`npm audit` → 0 vulnerabilità). L'unico breaking della 0.6.0 è il
  comportamento di `extractEntryTo()`, che **non usiamo** (verificato con grep); min Node passa a
  14, il container gira 22. `npm` non è sull'host: package.json/lock aggiornati con un container
  `node:22` usa-e-getta (`--package-lock-only`).

**⑤ Due buchi nei test, scoperti qui** (pre-esistenti, non regressioni):
- **`test/smoke.sh` non gira sull'immagine di produzione.** Esegue `test/collab-edit.mjs`, che
  importa `@hocuspocus/provider` = **devDependency**, mentre l'immagine è buildata `npm ci
  --omit=dev` → 6 check falliscono a prescindere (collab + history). Verificato con una prova di
  controllo: **identico 10/16 anche sull'immagine 0.5.18 pre-upgrade**. Serve un'immagine con le
  dev-deps (`FROM alumere-app + npm ci`): così **16/16 verdi** col nuovo lock. Nota: il default
  `IMAGE=alumdocs-app` nell'header dello script punta a un nome d'immagine che su questo VPS non
  esiste più (`docker images`), quindi `bash test/smoke.sh` senza `IMAGE=` non parte.
- **lo smoke non copre affatto i percorsi zip** (nessun match per `zip` nello script) — cioè
  esattamente il codice toccato da questo upgrade. Coperti a mano con un test mirato (10 check:
  strip della top-folder, sottocartella annidata, binario, filtro `__MACOSX`/`.DS_Store`,
  round-trip del download con CRC), tutti verdi. **Vale la pena versionarlo** in `test/`.

## 2026-07-21 — Giro 7: header del tree alla Overleaf + upload (popup e drag&drop) + collasso via rail ✅ (check di Tommy OK)

Quattro richieste di Tommy (con screenshot di Overleaf come riferimento), lavorate in autonomia
con suo consenso esplicito per i comandi della sessione. Dopo il suo check è stato **committato e
pushato** (`765b90c` + `1541753`).

**① Titoli dei pannelli in minuscolo** — via il `text-transform: uppercase` da `.pane-head`
(`styles.css`): ora "File tree" (rinominato da "Project"), "Review", "Chat", "Editor", "Preview"
con la sola iniziale maiuscola, come chiesto.

**② Header del tree coi pulsanti a icona** (alla Overleaf): *new file*, *new folder*, *upload*
(SVG stroke in stile rail, nuova classe `.iconbtn`). L'upload apre il popup **"Add files"**
fotocopiato da Overleaf ma **solo l'area drag&drop** (niente sidebar Zotero/Mendeley/…):
"Drop or paste your files… Select files / select a folder", con i due link su input file nascosti
(il secondo con `webkitdirectory`). Accetta qualsiasi file; **paste** di screenshot supportato
(listener su document, attivo solo a popup aperto); Esc / ✕ / click sullo scrim chiudono.

**③ Upload nel doc Yjs, zip estratti** — scelta di fondo: **tutto passa dal Y.Map condiviso**
client-side (testo → `Y.Text` editabile, resto → `{encoding:"base64"}`), MAI da una scrittura
server su files/ — verrebbe sovrascritta dal persist debounced del doc (stesso motivo del
restore della history). Conseguenze:
- sync live a tutti i peer, persistenza e history gratis (passano dagli hook già esistenti);
- **.zip**: il client non sa dezippare → nuovo endpoint **`POST /api/unzip`** (`server.js`,
  AdmZip già in casa) che NON tocca nessun progetto: torna la lista piatta
  `{path, content, encoding?}` (stesse regole dell'upload progetto: top-folder comune strippata,
  `__MACOSX`/`.DS_Store` saltati) e il client la fonde nel doc. Zip droppato in una cartella →
  contenuto estratto lì.
- **Sovrascrittura**: un upload su un path esistente aperto in editor **riusa il Y.Text** (delete
  + insert) — un Y.Text nuovo orfanerebbe gli editor collegati; verificato che l'editor aperto
  si aggiorna live.
- Limite 25MB/file (il body JSON del server è 60mb e il base64 gonfia ×1.33); file saltati
  elencati in un alert; 1 solo file di testo caricato → viene aperto.

**④ Drag&drop diretto nel tree** — droppa su una **cartella** (evidenza tratteggiata) e finisce
lì; su un **file** → nella sua cartella; su spazio vuoto → root. Cartelle intere droppate:
struttura preservata (walk ricorsivo `webkitGetAsEntry`, batch da 100 di `readEntries`).
`dtHasFiles` filtra i drag interni di testo. Hint sotto il tree aggiornato.

**⑤ Collasso via rail** — click sull'icona rail del pannello **già attivo** → l'intera colonna
si chiude (stile VS Code); altro click riapre; vale per File tree, Review e Chat. Stesso trucco
del collasso editor/PDF: colonna a 0px nel grid (un display:none slitterebbe le colonne),
pannello `visibility:hidden`, divisorio parcheggiato (`data-side-collapsed` sul workspace).
A colonna chiusa nessuna icona rail è "active"; i messaggi chat arrivati con chat selezionata
ma colonna chiusa contano da unread (badge).

**⑥ Bug trovato da Tommy al check: chat duplicata "n" volte** — causa: il server non
persisteva lo STATO Yjs, rimaterializzava (files/ + chat.json) e al load ri-seminava. A ogni
riavvio (oggi tanti: `node --watch` sui miei edit) il re-seed creava item CRDT **con ID nuovi**;
un client ancora connesso rifondeva i **suoi** item originali: le Y.Map convergono per chiave
(file, commenti — mai duplicati), i **Y.Array concatenano** → chat e dizionario duplicati una
volta per riavvio-con-client-vivo. Fix doppio:
- **`doc.ystate` per progetto** (`server.js`): a ogni store si salva anche
  `Y.encodeStateAsUpdate(document)`; al load si fa `applyUpdate` di quello (stessi item, stessi
  ID → merge idempotente) e si ri-semina dai JSON **solo** se non esiste (primo open /
  progetto pre-giro-7). files/ e i .json restano come materializzazione leggibile. Il PUT
  legacy che riscrive files/ da fuori ora **cancella** lo state (sennò resusciterebbe il
  vecchio contenuto).
- **Dedup deterministica client** (`app.js`, in onSynced): chat per `id` messaggio, dizionario
  per parola — l'ordine di un Y.Array è convergente, quindi ogni peer sceglie le STESSE copie
  da cancellare (concorrenza sicura, niente over-delete). Ripulisce il pregresso ovunque e
  fa da rete di sicurezza.
- Verificato: chat tornata a 3 messaggi (deletes propagati ai peer), `chat.json` riscritto a 3,
  e il test di regressione vero — `docker restart` col client connesso → **ancora 3**, load da
  `doc.ystate` nei log. smoke.sh di nuovo 16/16 (copre la migrazione senza state).

**Verificato** (dev :3000, browser reale, chiaro + scuro, console pulita, `test/smoke.sh`
**16/16**): titoli ok nei due temi; toggle rail su files e review (apri/chiudi/riapri, editor
che si ri-misura, PDF che si ri-adatta); popup identico all'originale e leggibile in scuro;
drop di .tex alla root (creato, aperto in tab, popup autochiuso); PNG generato via canvas
droppato su `sections/` (arrivato lì, icona 🖼); zip con `myproj/{chapter1.tex, figs/logo.png}`
+ `__MACOSX` → estratto alla root senza la top-folder e senza junk; sovrascrittura di notes.tex
aperto → contenuto live in editor; persistenza su disco controllata nel container (PNG con
header sano, testo aggiornato, store log a 8 file). Poi ripulito tutto: progetto tornato ai
4 file originali, tema rimesso su light, testzip.zip rimosso da public/.

---

## 2026-07-20 (bis) — Mini-giro: autocomplete a prefisso + un filo d'interlinea ✅ (check di Tommy OK)

Richiesta veloce di Tommy (screenshot del popup): **① voci troppo appiccicate** e **② il fuzzy
match di CM6** che con `\be` proponeva anche `\subsection` (b…e sparsi nella parola). Due tocchi:
- **Match a prefisso** (`app.js`, `latexCompletions`): `filter: false` spegne il fuzzy di CM6 e
  si filtra a mano — restano solo le opzioni che **iniziano** col testo digitato
  (case-insensitive), in ordine alfabetico; vale per comandi e per i nomi di environment in
  `\begin{…}`. Zero match → popup chiuso (return null). Tolto il `validFor` apposta: con
  `filter:false` CM riuserebbe la lista cachata senza rifiltrarla, quindi la source ri-gira ad
  ogni tasto (lista minuscola, costo zero). Effetto collaterale accettato: sparisce il grassetto
  sulle lettere matchate (CM non calcola più gli span di match), ma il match ora è sempre il
  prefisso appena digitato.
- **Interlinea** (`styles.css`): +3px di padding verticale per voce. "Giusto un filo", com'era
  chiesto.

**Verificato** (dev :3000, Sample paper): `\be` → solo begin/beta; `\bet` → solo `\beta`;
`\betz` → chiuso; `\begin{it` → solo `itemize`; console pulita; riga di prova ripulita al
carattere (restano le solite versioni auto in history). Le righe di test di Tommy in math.tex
intatte. Nessun rebuild del bundle CM6.

---

## 2026-07-20 — Giro 6: collasso pannelli + spell-check IT/EN + popup autocomplete leggibile ✅ (check di Tommy OK)

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

**Processo**: implementato e verificato; dopo il check di Tommy, **committato e pushato**
(`1d8a723` + `6329c8e`).
⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

---

## 2026-07-18 (novies) — Parità Overleaf, giro 5/5: Review panel + Chat ✅ (check di Tommy OK)

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

**Processo**: regola nuova rispettata — implementato e verificato; dopo il check di Tommy,
**committato e pushato** (`7d92808` + `da5336e`).
⚠️ **Non è live**: serve il pull+rebuild sul VPS (Albi).

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
