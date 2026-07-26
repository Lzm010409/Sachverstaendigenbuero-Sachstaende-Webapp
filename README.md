# Sachstands-Cockpit

Eine kleine Web-App zur Vorbereitung, Freigabe und (perspektivisch) zum Versand von
**Sachstandsanfragen** an Rechtsanwälte und Versicherungen — für das
Kfz-Sachverständigenbüro Gollenstede.

Statt nächtlicher Batch-Notizen in Pipedrive gibt es eine Oberfläche, die den Ablauf
abbildet, den man tatsächlich haben will:

> **Aktueller/letzter Stand ansehen → Entwurf prüfen → freigeben, ändern lassen oder überspringen.**

Die App läuft als **einzelner Node/Express-Dienst**, der das Frontend ausliefert und
eine kleine JSON-API bereitstellt. Sie ist so gebaut, dass sie **sofort deploybar** ist:
im `DEMO_MODE` arbeitet sie mit Beispieldaten, ganz ohne externe Systeme.

---

## Schnellstart (lokal)

```bash
npm install
npm start
# -> http://localhost:3000
```

## Aufbau

```
server/
  index.js        Express-Server: liefert public/, stellt /api/* bereit
  demo-cases.js   Beispieldaten für den Demo-Modus
public/
  index.html      Cockpit-Oberfläche (Segoe-UI, hell/dunkel)
  app.js          Frontend-Logik (fetch gegen /api)
Dockerfile        Produktions-Image für Coolify
.env.example      alle Umgebungsvariablen
```

## API

| Methode | Pfad                       | Zweck                                            |
|--------:|----------------------------|--------------------------------------------------|
| GET     | `/api/health`              | Healthcheck (für Coolify)                        |
| GET     | `/api/config`              | `{ demoMode, authEnabled }`                       |
| GET     | `/api/cases`               | Liste der fälligen Sachstände                    |
| POST    | `/api/cases/:id/rewrite`   | Entwurf umschreiben (`{ instruction }`)          |
| POST    | `/api/cases/:id/approve`   | Entwurf freigeben (`{ draft }`) — **kein Auto-Versand** |
| POST    | `/api/cases/:id/skip`      | Fall überspringen (`{ reason }`)                 |

---

## Deployment auf Coolify

1. **Coolify → Projekt → New Resource → Application → Git-based** (privates Repository).
2. Als Quelle **dieses Repository** wählen, Branch `claude/sachstands-anfrage-entwuerfe-8647vg`
   (bzw. später `main`).
3. **Build Pack: Dockerfile** (die `Dockerfile` im Wurzelverzeichnis wird erkannt).
4. **Port 3000** freigeben, gewünschte Domain zuweisen.
5. **Environment Variables** setzen (siehe `.env.example`) — fürs erste genügt:
   ```
   DEMO_MODE=true
   BASIC_AUTH_USER=luke
   BASIC_AUTH_PASS=<eigenes Passwort>
   ```
6. **Deploy.** Jeder weitere Push auf den Branch deployt automatisch neu.

Nach dem Deploy ist die App unter der zugewiesenen Domain erreichbar und sofort
bedienbar (mit Beispieldaten).

---

## Vom Demo- zum Live-Betrieb

Der Live-Modus (`DEMO_MODE=false`) ist im Code an den mit `TODO(live)` markierten
Stellen in `server/index.js` vorbereitet. Zu verdrahten sind drei Integrationen:

1. **Pipedrive** — fällige „Sachstand anfragen“-Tasks + Deal + Notizen laden
   (`PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_DOMAIN`).
2. **Microsoft 365 / Graph** — Outlook-Mailverläufe je Fall lesen und Entwürfe/Versand.
   Lesen deckt der bestehende M365-Connector; **Senden** braucht eine App-Registrierung
   mit `Mail.Send` (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SENDER_UPN`).
3. **Anthropic** — Entwurfserzeugung aus dem Fall-Kontext (`ANTHROPIC_API_KEY`).

Solange diese Werte fehlen bzw. `DEMO_MODE=true` gesetzt ist, bleibt die App im
sicheren Demo-Betrieb: **es wird nichts versendet und nichts in Fremdsystemen geändert.**

## Sicherheit

- Kein automatischer Mailversand ohne ausdrückliche Freigabe pro Fall.
- Zugangsschutz über Basic-Auth (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS`).
- Secrets ausschließlich als Coolify-Env-Variablen, niemals im Repository.
