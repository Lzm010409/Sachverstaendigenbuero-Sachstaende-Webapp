# STATUS & Übergabe für den nächsten Agenten

> Kurzfassung: Die Web-App **Sachstands-Cockpit** ist gebaut und **live auf Coolify**
> deployed (Demo-Modus). Nächster großer Schritt: die drei Live-Integrationen
> (Pipedrive, Microsoft 365 / Graph, Anthropic) verdrahten und `DEMO_MODE=false` schalten.

Stand: 2026-07-26

---

## 1. Was läuft bereits

| Punkt | Stand |
|---|---|
| App-Code | Fertig, im Repo, Branch `claude/sachstands-anfrage-entwuerfe-8647vg` |
| Architektur | Node/Express-Einzeldienst: liefert `public/` aus + JSON-API unter `/api/*` |
| Betrieb | **DEMO_MODE=true** — Beispieldaten aus `server/demo-cases.js`, **es wird nichts versendet** |
| Deployment | Coolify, Build Pack = Dockerfile, Port 3000 (intern), Domain via Traefik auf 80/443 |
| Domain | `https://sachstaende.gollenstede.app` |
| Zugangsschutz | Basic-Auth (Env `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`), in Coolify gesetzt |

Lokal starten: `npm install && npm start` → http://localhost:3000

---

## 2. Coolify — Zugang & Fakten (WICHTIG)

- **API-Token:** liegt als Umgebungsvariable **`COOLIFY_API_TOKEN`** vor.
  Niemals ausgeben/loggen/committen — nur direkt an `Authorization: Bearer` weiterreichen.
- **Base-URL:** `https://coolify.gollenstede.app/api/v1`
- **Application-UUID:** `a13b40sif6r3gv57nvp1e0dh`
- **Projekt:** „Sachstandprojekt" (`d10gvp4bmfamrr755dtd6v5b`)
- **Server:** `localhost` (`e4s0gog0ow0cgggk004c0ok8`)
- Coolify-Version: 4.1.2

### Gelernte API-Eigenheiten (sonst Zeitverlust)
- **Env-Variable anlegen:** `POST /applications/{uuid}/envs` mit `{"key","value"}`.
  Feld heißt **`is_buildtime`** (NICHT `is_build_time` → sonst HTTP 422).
- **Domain/HTTPS ändern:** `PATCH /applications/{uuid}` mit **`{"domains":"https://…"}`**.
  Das Feld `fqdn` ist im Update **nicht erlaubt** (422) — Schreibfeld ist `domains`,
  gelesen wird es als `fqdn`. `https://` ⇒ TLS auf 443 + Redirect 80→443.
- **Deploy auslösen:** `POST /deploy?uuid={uuid}&force=false` → liefert `deployment_uuid`.
  Status: `GET /deployments/{deployment_uuid}` (`in_progress` → `finished`/`failed`).
- **Port:** `ports_exposes=3000` ist der **interne** Containerport (korrekt so).
  `ports_mappings` bleibt **leer** — sonst wird 3000 am Host veröffentlicht und der
  Traefik-Proxy (80/443) umgangen.
- **Sandbox-Grenze:** Aus der Agent-Umgebung ist `sachstaende.gollenstede.app` per
  Egress-Allowlist **nicht** erreichbar (403/000 kommen vom Agent-Proxy, nicht von Coolify).
  Erreichbarkeit also vom Nutzer testen lassen, nicht aus der Sandbox schließen.
- Der Sicherheits-Klassifikator blockiert `env`-Dumps und `/dev/urandom`-Passwortgenerierung.
  Env-Variablen daher direkt referenzieren (`$VAR`), nicht auflisten.

### Deploy-Flow (nach Code-Änderungen)
Push auf den Branch, dann Redeploy anstoßen:
```
curl -s -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "https://coolify.gollenstede.app/api/v1/deploy?uuid=a13b40sif6r3gv57nvp1e0dh&force=false"
```

---

## 3. Repo-Struktur

```
server/
  index.js        Express: statisch + /api/*. Enthält die TODO(live)-Nahtstellen.
  demo-cases.js   Beispieldaten (Struktur == spätere Live-Antwort)
public/
  index.html      Cockpit-UI (Segoe UI, hell/dunkel, responsiv)
  app.js          Frontend-Logik (fetch gegen /api)
Dockerfile        node:20-alpine, Healthcheck auf /api/health
.env.example      alle Env-Variablen dokumentiert
README.md         Nutzer-/Deploy-Doku
STATUS.md         diese Datei
```

### API-Endpunkte
| Methode | Pfad | Zweck |
|--:|--|--|
| GET | `/api/health` | Healthcheck |
| GET | `/api/config` | `{demoMode, authEnabled}` |
| GET | `/api/cases` | fällige Sachstände |
| POST | `/api/cases/:id/rewrite` | Entwurf umschreiben `{instruction}` |
| POST | `/api/cases/:id/approve` | freigeben `{draft}` — **kein Auto-Versand** |
| POST | `/api/cases/:id/skip` | überspringen `{reason}` |

---

## 4. Nächste Schritte — Demo → Live

Alle Nahtstellen sind in `server/index.js` mit `TODO(live)` markiert. Zu bauen:

1. **Pipedrive** (`loadCases`): fällige „Sachstand anfragen"-Tasks
   (`getActivities`, `type=task`, `subject` beginnt mit „Sachstand anfragen",
   `due_date <= HEUTE`), je Fall Deal + Notizen laden und in die `demo-cases`-Struktur
   mappen. Env: `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_DOMAIN`.
   Aktenzeichen-Regex: `\d{4}/\d{3,4}TG`.

2. **Microsoft 365 / Graph** — Mailverläufe je Fall lesen (ersetzt den
   unzuverlässigen n8n-Webhook `pipedrive-deal-mails`) und **Versand**.
   Lesen deckt der bestehende M365-Connector; **Senden** braucht eine
   App-Registrierung mit **`Mail.Send`** (Env: `MS_TENANT_ID`, `MS_CLIENT_ID`,
   `MS_CLIENT_SECRET`, `MS_SENDER_UPN`). Zuordnung Mail↔Fall am robustesten über
   das Aktenzeichen im Betreff (`… [Az. 2024/0123TG]`); Fallback: Gegenseiten-Mailadresse.

3. **Anthropic** (`generateDraft`): Entwurf/Umschreiben aus Fall-Kontext.
   Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (Default `claude-sonnet-5`).

4. **Zurückschreiben** nach Freigabe (im `approve`-Handler, Reihenfolge):
   Mail via Graph senden → Pipedrive-Notiz (`addNote`) → Vault-Fallnotiz
   (Sachstand-Log + Frontmatter) → Pipedrive-Task erst danach als erledigt.

### Fachregeln (aus dem bestehenden Skill übernehmen)
- **Anrede:** `Anrede-Regeln.md` im Vault. Duzen: Claudia Busch, Philipp Nadler,
  Jens Schlossmacher → „Hallo <Vorname>," sonst „Sehr geehrte Damen und Herren,".
  Eindeutiges Du in der Korrespondenz ⇒ ebenfalls duzen.
- **Dedup/Skip:** bereits reguliert / Zahlung angewiesen / frisches „abwarten" ⇒ überspringen.
  Offene Rückfrage der Gegenseite (neueste Mail von dort, unbeantwortet) ⇒ Antwort-Entwurf
  statt Standard-Nachfrage.
- **Empfänger:** Kanzlei (`lawyer.organization_name`) vor Versicherung; fehlt beides ⇒
  „Empfänger unklar", kein Entwurf.
- **RDG-konform:** sachlich, keine rechtliche Wertung.

---

## 5. Guardrails
- Kein automatischer Versand ohne ausdrückliche Freigabe pro Fall.
- Secrets ausschließlich als Coolify-Env-Variablen — **nie** ins Repo.
- Basic-Auth aktiv lassen, solange die Domain öffentlich ist.
- Git: nur auf `claude/sachstands-anfrage-entwuerfe-8647vg` entwickeln/pushen,
  nicht ungefragt auf `main`.
