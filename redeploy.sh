#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/alum/alumere
COMPOSE=docker-compose.alum.yml
HEALTH_PUBLIC=https://docs.alum-lab.com/api/health

cd "$APP_DIR"

# Safeguard: l'app non pubblica porte e sta dietro il Caddy edge condiviso.
# Senza il compose dedicato si userebbe docker-compose.yml (pubblica 3000 sull'host,
# fuori da alum_web) o docker-compose.prod.yml (secondo Caddy, collide su 80/443).
[ -f "$COMPOSE" ] || { echo "!! manca $COMPOSE — interrompo."; exit 1; }
docker network inspect alum_web >/dev/null 2>&1 || { echo "!! rete esterna alum_web assente — interrompo."; exit 1; }

OLD=$(git rev-parse HEAD)
echo "==> Commit attuale: $(git rev-parse --short HEAD)"

echo "==> git pull (fast-forward only)"
git pull --ff-only

echo "==> Rebuild + restart app"
docker compose -f "$COMPOSE" up -d --build

echo "==> Health check locale (fino a 60s — la prima build TeX Live e' lenta)"
for i in $(seq 1 30); do
  if OUT=$(docker compose -f "$COMPOSE" exec -T app \
      node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))" 2>/dev/null); then
    echo "OK locale: $OUT"
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "!! app KO in locale. Rollback:"
    echo "   git reset --hard $OLD && docker compose -f $COMPOSE up -d --build"
    exit 1
  fi
done

echo "==> Health check pubblico (via Caddy)"
curl -fsS "$HEALTH_PUBLIC" && echo || echo "!! pubblico KO — controlla 'docker logs caddy'"

echo "==> Pulizia immagini dangling"
docker image prune -f >/dev/null

echo "==> Deploy completato: $(git rev-parse --short HEAD)"
