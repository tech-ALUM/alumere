// Alumère — M0 real-time spike.
// A single shared CodeMirror document synced over Yjs + Hocuspocus (ws /collab),
// with colored remote cursors labeled by the signed-in user. Intentionally
// STANDALONE: it does not touch the real editor (app.js) — that integration is M1.
// The point is to prove the end-to-end pipe: deps + bundle + websocket + Docker.

const ROOM = "alumere-spike";           // one shared room for the whole spike
const $ = (id) => document.getElementById(id);

// Deterministic color per user, so the same person keeps the same cursor color.
function colorFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { color: `hsl(${hue} 65% 45%)`, colorLight: `hsl(${hue} 65% 45% / 0.25)` };
}

function setConn(text, kind) {
  const el = $("connState");
  el.textContent = text;
  el.className = "status " + (kind || "idle");
}

async function main() {
  // 1) Identity first (auth.js shows the name overlay) so cursors carry a real name.
  let user = { id: "anon", name: "Anonimo" };
  if (window.Alumere) {
    await window.Alumere.ready;
    if (window.Alumere.user) user = window.Alumere.user;
  }

  if (!window.CM6 || !window.YCOLLAB) {
    $("editor").textContent =
      "Bundle non caricato: manca window.YCOLLAB. Ricostruisci public/vendor/codemirror.js (npm run build:client).";
    setConn("bundle mancante", "err");
    return;
  }

  const { EditorView, lineNumbers, drawSelection, keymap } = window.CM6.view;
  const { EditorState } = window.CM6.state;
  const { defaultKeymap } = window.CM6.commands;
  const { Y, HocuspocusProvider, yCollab, yUndoManagerKeymap } = window.YCOLLAB;

  // 2) Shared Yjs document + Hocuspocus provider on the same port, path /collab.
  const ydoc = new Y.Doc();
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const provider = new HocuspocusProvider({
    url: `${wsProto}://${location.host}/collab`,
    name: ROOM,
    document: ydoc,
  });
  const ytext = ydoc.getText("codemirror");
  const undoManager = new Y.UndoManager(ytext);

  // 3) Local presence: name + color for this user's remote cursor.
  const { color, colorLight } = colorFor(user.id || user.name || "anon");
  provider.awareness.setLocalStateField("user", { name: user.name, color, colorLight });

  // 4) Connection / sync status + live presence chips.
  setConn("connessione…", "busy");
  provider.on("status", (e) => {
    if (e.status === "connected") setConn("● connesso", "ok");
    else setConn("○ " + e.status, "busy");
  });
  provider.on("synced", () => setConn("● sincronizzato", "ok"));
  provider.on("disconnect", () => setConn("○ disconnesso", "err"));

  function renderPeers() {
    const box = $("peers");
    box.innerHTML = '<span class="peers-label">Presenti:</span>';
    for (const [, state] of provider.awareness.getStates()) {
      const u = state && state.user;
      if (!u) continue;
      const chip = document.createElement("span");
      chip.className = "peer";
      chip.style.background = u.color || "#8a95a1";
      chip.textContent = u.name || "?";
      box.appendChild(chip);
    }
  }
  provider.awareness.on("change", renderPeers);
  renderPeers();

  // 5) The editor, bound to the shared Y.Text. yCollab gives live sync AND remote
  // cursors/selections; collaborative undo is scoped per-user via the UndoManager.
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        drawSelection(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...yUndoManagerKeymap]),
        yCollab(ytext, provider.awareness, { undoManager }),
      ],
    }),
  });
  view.focus();
}

main();
