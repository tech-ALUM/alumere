// Alumère — peer Yjs headless per lo smoke test (test/smoke.sh lo lancia con
// `docker exec` dentro il container di prova). Entra nella stanza del progetto col
// cookie di sessione, aspetta il sync, firma il meta come editor, appende un
// marcatore in coda al primo file di testo e lascia al server il tempo dello store
// debounced. In stdout (ultima riga) finisce il path del file toccato, così lo
// script chiamante sa dove andare a cercare il marcatore nella history.
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

const { ROOM, COOKIE, WSURL = "ws://localhost:3100", MARKER = "SMOKE" } = process.env;
if (!ROOM || !COOKIE) { console.error("servono ROOM e COOKIE nell'ambiente"); process.exit(2); }

// Il gate del socket è lo stesso cookie firmato della REST API: va negli header
// dell'upgrade, e in Node l'unico modo è un polyfill che li aggiunge.
class WS extends WebSocket {
  constructor(url, protocols) { super(url, protocols, { headers: { Cookie: COOKIE } }); }
}

const doc = new Y.Doc();
// La websocket va costruita esplicitamente: se a HocuspocusProvider si passa solo
// `url`, quella interna che si crea da solo NON riceve WebSocketPolyfill e su Node
// ripiega sulla WebSocket globale, che non può mandare il cookie (→ 401 al gate).
const socket = new HocuspocusProviderWebsocket({ url: `${WSURL}/collab`, WebSocketPolyfill: WS });
const provider = new HocuspocusProvider({ websocketProvider: socket, name: ROOM, document: doc });

const die = (msg) => { console.error(msg); process.exit(1); };
const timer = setTimeout(() => die("timeout: sync mai completato"), 20000);

// Il seed del doc arriva in una transazione che può atterrare un attimo dopo il
// primo sync: breve poll invece di fidarsi del primo stato.
async function firstTextEntry() {
  const files = doc.getMap("files");
  for (let i = 0; i < 100; i++) {
    for (const [p, v] of files.entries()) if (v instanceof Y.Text) return [p, v];
    await new Promise((r) => setTimeout(r, 100));
  }
  die("nessun file di testo nel doc");
}

provider.on("synced", async () => {
  clearTimeout(timer);
  const [path, text] = await firstTextEntry();
  doc.getMap("meta").set("updatedBy", { id: "smoke.test@example.com", name: "Smoke Test" });
  text.insert(text.length, `\n% ${MARKER}\n`);
  await new Promise((r) => setTimeout(r, 5000));   // store debounce: 2s, max 10s
  provider.destroy();
  console.log(path);
  process.exit(0);
});
