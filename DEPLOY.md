# Deploy — Alumère in produzione (pubblico, login magic-link)

Questa guida porta Alumère online in modo sicuro: **HTTPS automatico** (Caddy),
**login passwordless via magic-link** ristretto al dominio aziendale, invio email via **SMTP**.
L'app non è esposta direttamente: sta dietro il reverse proxy sulla rete interna di Docker.

## Architettura

```
                          ┌────────────────────────────────────────────┐
   Internet  ─── 443 ───▶ │  Caddy  (TLS automatico, Let's Encrypt)     │
                          │        reverse_proxy  ──▶  app:3000         │
                          │                             │  (rete interna,│
                          │                             │   non pubblica)│
                          │                        ┌────▼─────────────┐  │
                          │                        │  app (Express +  │  │
                          │                        │  Hocuspocus/ws)  │  │
                          │                        │  volume dati ────┼──┼─▶ alumere-data
                          └────────────────────────┴──────────────────┴──┘
```

Gli upgrade WebSocket di `/collab` (collaborazione real-time) passano trasparenti attraverso Caddy.

---

## Prerequisiti

- Un **VPS Linux** con **Docker** + plugin **Docker Compose** (`docker compose version`).
- Un **dominio** (es. `docs.example.com`) su cui hai accesso al DNS.
- Porte **80** e **443** aperte verso il server (firewall / security group).
- Una **casella email reale** sul tuo dominio da cui inviare i link (es. privateemail).

---

## 1. DNS

Crea un record **A** che punta il dominio all'IP pubblico del server (e un **AAAA** se hai IPv6):

```
docs.example.com.   A   <IP_DEL_SERVER>
```

Verifica la propagazione prima di procedere (il certificato TLS non parte finché il DNS non punta qui):

```bash
dig +short docs.example.com     # deve restituire l'IP del server
```

## 2. Codice sul server

```bash
git clone https://github.com/Paul-Gnata/alumDocs.git
cd alumDocs
git checkout main
```

## 3. Configurazione (`.env`)

```bash
cp .env.example .env
nano .env        # compila i valori reali
```

Valori da impostare (dettaglio in `.env.example`):

| Variabile | Esempio | Note |
| --- | --- | --- |
| `PUBLIC_DOMAIN` | `docs.example.com` | Dominio pubblico; Caddy ci prende il certificato TLS. |
| `PUBLIC_BASE_URL` | `https://docs.example.com` | Base assoluta dei magic-link nelle email. **https**. |
| `ALLOWED_EMAIL_DOMAIN` | `example.com` | Solo queste email possono entrare. **Non lasciare vuoto in prod.** |
| `LOGIN_TOKEN_TTL_MIN` | `15` | Minuti di validità del link. |
| `COOKIE_SECURE` | `1` | Obbligatorio dietro HTTPS. |
| `TRUST_PROXY` | `1` | Fa leggere all'app l'IP reale del client (rate-limit per-IP). |
| `SESSION_SECRET` | *(vedi sotto)* | Firma i cookie. Genera:  `openssl rand -hex 32` |
| `SMTP_HOST` | `mail.privateemail.com` | Server SMTP della tua casella. |
| `SMTP_PORT` | `465` | `465` = SSL; `587` = STARTTLS. |
| `SMTP_USER` / `SMTP_PASS` | `noreply@example.com` / … | Credenziali della casella. |
| `SMTP_FROM` | `noreply@example.com` | Mittente mostrato (default = `SMTP_USER`). |

Genera un segreto di sessione forte:

```bash
openssl rand -hex 32
# copia l'output in SESSION_SECRET=...
```

## 4. Avvio

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

- La **prima build** scarica un subset di TeX Live: qualche minuto.
- **Caddy ottiene il certificato TLS** automaticamente (serve DNS che punta al server + porte 80/443 aperte).

Segui i log finché Caddy non ha il certificato:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
#   cerca:  "certificate obtained successfully"  /  "serving initial configuration"
```

## 5. Verifica

```bash
curl -I https://docs.example.com        # certificato valido + risposta HTTP
```

Poi dal browser:

1. Apri `https://docs.example.com` → compare l'overlay di login.
2. Inserisci una email **del tuo dominio** → "controlla la posta".
3. Apri il link ricevuto → **sei dentro** (nome derivato dall'email).
4. Prova una email esterna (`@gmail.com`) → **rifiutata** nella UI.
5. Apri lo stesso progetto in **due schede** → editing real-time (il WebSocket passa da Caddy).

Log applicativi (invio mail ed errori):

```bash
docker compose -f docker-compose.prod.yml logs -f app
```

> **Fallback senza SMTP:** se `SMTP_HOST` è vuoto, l'app non invia ma **stampa il link nei log** —
> utile per un primo test, inutile per l'uso reale. Configura SMTP prima di aprire agli altri.

---

## SMTP e deliverability (privateemail)

- Host tipico: `mail.privateemail.com`, porta `465` (SSL) o `587` (STARTTLS).
- Usa una **casella reale del tuo dominio** (non un alias): migliora deliverability e reputazione.
- Configura **SPF** e **DKIM** sul dominio (il pannello di privateemail fornisce i record), altrimenti
  le email dei link rischiano lo spam.
- Manda un link di prova a due-tre provider diversi (Gmail, Outlook, …) e controlla che arrivi in inbox.

---

## Operazioni

**Aggiornare / ri-deployare** dopo un `git pull`:

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

**Stato e log:**

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app     # o: caddy
```

**Backup dei dati.** Tutti i progetti (e il `.session-secret` su disco) vivono nel volume `alumere-data`.
Il nome reale del volume è prefissato dal nome-progetto compose (spesso `alumdocs_alumere-data`; verifica con
`docker volume ls`):

```bash
docker run --rm -v alumdocs_alumere-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/alumere-data-$(date +%F).tgz -C /data .
```

Ripristino: l'inverso (`tar xzf … -C /data`) su un volume vuoto, ad app ferma.

**Ruotare il segreto di sessione:** cambia `SESSION_SECRET` in `.env` e riavvia l'app
(`docker compose -f docker-compose.prod.yml up -d`). Invalida tutte le sessioni → tutti rifanno login.

---

## Checklist di sicurezza

- [ ] `ALLOWED_EMAIL_DOMAIN` = il tuo dominio vero (**non** vuoto).
- [ ] `COOKIE_SECURE=1` e il sito è servito in **HTTPS**.
- [ ] `SESSION_SECRET` impostato (o comunque persistito sul volume dati).
- [ ] L'app **non** pubblica porte sull'host: solo Caddy espone 80/443 (`docker compose … ps`).
- [ ] `.env` sta **solo** sul server: mai committato, mai dentro l'immagine (coperto da `.dockerignore`).
- [ ] Firewall: aperte solo `22` (SSH), `80`, `443`.
- [ ] Le credenziali SMTP sono di una casella dedicata.

---

## Troubleshooting

| Sintomo | Causa probabile / rimedio |
| --- | --- |
| Certificato non emesso | DNS non ancora propagato, oppure porte 80/443 chiuse, oppure il dominio non punta al server. Guarda i log di `caddy`. |
| Non resta loggato / loop 401 | Manca `COOKIE_SECURE=1` dietro HTTPS, oppure `PUBLIC_BASE_URL` è `http://` invece di `https://`. |
| La mail non arriva | Errore SMTP → la UI mostra "invio non riuscito". Controlla i log di `app`, lo spam, SPF/DKIM, le credenziali e la porta (465 vs 587). |
| "Troppe richieste" al login | Rate-limit per-email (5 / 10min). Con `TRUST_PROXY=1` il backstop per-IP usa l'IP reale, non quello di Caddy. |
| Debug diretto dell'app | Non è pubblicata sull'host. Usa `docker compose -f docker-compose.prod.yml exec app node -e "..."`, oppure aggiungi temporaneamente `ports: ["127.0.0.1:3000:3000"]` al servizio `app` e un tunnel SSH. |

---

## Nota — build riproducibile (hardening opzionale)

`package-lock.json` al momento non include `nodemailer`: il Dockerfile usa `npm install`, quindi
l'immagine viene comunque costruita correttamente (nodemailer c'è, l'invio mail funziona). Per build
**riproducibili** conviene rigenerare il lock e passare a `npm ci`. Node non è sull'host, quindi fallo
in un container usa-e-getta:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim npm install --package-lock-only
# poi, nel Dockerfile, sostituisci `npm install --omit=dev` con `npm ci --omit=dev`
```
