#!/usr/bin/env bash
# Alumère — smoke test end-to-end. Avvia un container ISOLATO (porta e dati propri:
# dev e prod non vengono mai toccati) e attraversa tutta la superficie dell'app:
# auth magic-link, API progetti, editing collaborativo vero via Yjs, cronologia
# (versioni, contenuti, etichette, gate 401), compile LaTeX e GC dei blob orfani.
#
# Uso:   bash test/smoke.sh
# Env:   IMAGE (default alumdocs-app) · SMOKE_PORT (default 3100)
#
# Richiede solo docker + curl + python3 sull'host (niente Node locale). Esce 0 se
# tutti i controlli passano, 1 altrimenti.
set -u
IMAGE=${IMAGE:-alumdocs-app}
PORT=${SMOKE_PORT:-3100}
NAME=alumere-smoke
BASE="http://localhost:$PORT"
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
JAR="$TMP/cookies.txt"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ✓ $1"; }
ko() { fail=$((fail+1)); echo "  ✗ $1"; }
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
cleanup() { docker rm -f $NAME >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

echo "— avvio container isolato ($IMAGE su :$PORT, dati temporanei)"
docker rm -f $NAME >/dev/null 2>&1
docker run --rm -d --name $NAME -p "$PORT:$PORT" \
  -e PORT="$PORT" -e PROJECTS_DIR=/data/projects \
  -v "$REPO_DIR":/app -v /app/node_modules -v "$TMP/data":/data \
  -w /app "$IMAGE" node server.js >/dev/null || { echo "docker run fallito"; exit 1; }

for _ in $(seq 1 30); do curl -sf "$BASE/api/session" >/dev/null && break; sleep 1; done
curl -sf "$BASE/api/session" >/dev/null || { echo "il server non risponde su $BASE"; docker logs $NAME; exit 1; }

# Fixture per il GC: un progetto già dotato di history con un blob referenziato e uno
# orfano (+ un temp da crash). La passata post-boot (~15s) deve pulire solo gli orfani.
# Due accortezze: va creata a server già su (se la cartella progetti non è vuota al
# boot, il server salta il seed del progetto d'esempio che serve ai test collab), e
# DENTRO il container via exec — file creati dall'host in un bind-mount possono non
# propagarsi in tempo (Docker Desktop), e il test diventerebbe dipendente dalla macchina.
REF_SHA=$(printf 'b%.0s' $(seq 1 64)); ORPHAN_SHA=$(printf 'a%.0s' $(seq 1 64))
OBJ=/data/projects/gc-fixture/history/objects
cat > "$TMP/fixture.sh" <<EOF
set -e
F=/data/projects/gc-fixture
mkdir -p \$F/files \$F/history/objects
echo ciao > \$F/files/main.tex
printf referenziato > \$F/history/objects/$REF_SHA
printf orfano > \$F/history/objects/$ORPHAN_SHA
printf temp > \$F/history/objects/$ORPHAN_SHA.tmp-crash
NOW=\$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"id":"gc-fixture","name":"GC fixture","createdAt":"%s","updatedAt":"%s"}' "\$NOW" "\$NOW" > \$F/meta.json
printf '{"versions":[{"id":"v-smoke","at":"%s","by":null,"label":null,"kind":"auto","treeHash":"t","files":[{"path":"main.tex","sha":"$REF_SHA"}]}]}' "\$NOW" > \$F/history/index.json
EOF
docker cp "$TMP/fixture.sh" $NAME:/tmp/fixture.sh >/dev/null
docker exec $NAME sh /tmp/fixture.sh || { echo "creazione fixture GC fallita"; exit 1; }

echo "— auth"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects")
[ "$code" = 401 ] && ok "API protetta senza sessione (401)" || ko "API senza sessione: atteso 401, avuto $code"

curl -s -X POST "$BASE/api/auth/request" -H 'Content-Type: application/json' \
  -d '{"email":"smoke.test@example.com"}' >/dev/null
link=$(docker logs $NAME 2>&1 | grep -o 'http://[^ ]*verify?token=[^ ]*' | tail -1)
[ -n "$link" ] && ok "magic link emesso (SMTP off → log)" || ko "magic link non trovato nei log"
curl -s -c "$JAR" -o /dev/null -X POST "$link"
name=$(curl -s -b "$JAR" "$BASE/api/session" | json "d['user']['name']")
[ "$name" = "Smoke Test" ] && ok "login completato (sessione: $name)" || ko "sessione non valida dopo il verify"
COOKIE=$(grep alm_session "$JAR" | tail -1 | awk '{print $6"="$7}')

echo "— progetti"
pid=$(curl -s -b "$JAR" "$BASE/api/projects" | json "[p['id'] for p in d['projects'] if p['id']!='gc-fixture'][0]")
[ -n "$pid" ] && ok "progetto seed presente ($pid)" || ko "nessun progetto in lista"

echo "— collab (peer Yjs reale, con cookie)"
MARKER="SMOKE-$$-$RANDOM"
edited=$(docker exec -e ROOM="$pid" -e COOKIE="$COOKIE" -e WSURL="ws://localhost:$PORT" \
  -e MARKER="$MARKER" $NAME node /app/test/collab-edit.mjs | tail -1)
[ -n "$edited" ] && ok "edit collaborativo riuscito su $edited" || ko "il peer Yjs non è riuscito a editare"

echo "— history"
hist=$(curl -s -b "$JAR" "$BASE/api/projects/$pid/history")
nver=$(echo "$hist" | json "len(d['versions'])")
[ "${nver:-0}" -ge 2 ] && ok "versioni registrate: $nver (baseline + edit)" || ko "attese ≥2 versioni, avute ${nver:-0}"
vid=$(echo "$hist" | json "d['versions'][0]['id']")
vby=$(echo "$hist" | json "d['versions'][0]['by']['name']")
[ "$vby" = "Smoke Test" ] && ok "ultima versione attribuita a chi ha editato" || ko "autore ultima versione: ${vby:-nessuno}"
content=$(curl -s -b "$JAR" "$BASE/api/projects/$pid/history/$vid/file?path=$edited" | json "d['content']")
case "$content" in *"$MARKER"*) ok "il contenuto della versione contiene il marcatore";; *) ko "marcatore assente dalla versione";; esac
lab=$(curl -s -b "$JAR" -X POST "$BASE/api/projects/$pid/history/$vid/label" \
  -H 'Content-Type: application/json' -d '{"label":"fumo"}' | json "d['label']")
[ "$lab" = "fumo" ] && ok "etichetta applicata" || ko "etichetta non applicata"
ntree=$(curl -s -b "$JAR" "$BASE/api/projects/$pid/history/$vid/tree" | json "len(d['files'])")
[ "${ntree:-0}" -ge 1 ] && ok "tree della versione leggibile ($ntree file)" || ko "tree della versione vuoto"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects/$pid/history")
[ "$code" = 401 ] && ok "history protetta senza sessione (401)" || ko "history senza sessione: atteso 401, avuto $code"

echo "— compile"
npdf=$(curl -s -b "$JAR" -X POST "$BASE/api/compile" -H 'Content-Type: application/json' \
  -d '{"files":[{"path":"main.tex","content":"\\documentclass{article}\\begin{document}Fumo di prova.\\end{document}"}],"main":"main.tex","engine":"pdflatex"}' \
  | json "len(d['pdf']) if d['ok'] else 0")
[ "${npdf:-0}" -gt 1000 ] && ok "compile ok (PDF di $npdf byte base64)" || ko "compile fallita o PDF vuoto"

echo "— gc (passata post-boot sul progetto fixture)"
for _ in $(seq 1 30); do docker exec $NAME test ! -f "$OBJ/$ORPHAN_SHA" && break; sleep 2; done
docker exec $NAME test ! -f "$OBJ/$ORPHAN_SHA" && ok "blob orfano rimosso" || ko "blob orfano ancora presente dopo la passata"
docker exec $NAME test ! -f "$OBJ/$ORPHAN_SHA.tmp-crash" && ok "temp da crash rimosso" || ko "temp da crash ancora presente"
docker exec $NAME test -f "$OBJ/$REF_SHA" && ok "blob referenziato intatto" || ko "il GC ha cancellato un blob referenziato!"
nfix=$(docker exec $NAME cat /data/projects/gc-fixture/history/index.json | json "len(d['versions'])")
[ "$nfix" = 1 ] && ok "versione recente intatta (retention non la tocca)" || ko "indice fixture alterato"

echo
echo "Risultato: $pass passati, $fail falliti"
[ "$fail" -eq 0 ]
