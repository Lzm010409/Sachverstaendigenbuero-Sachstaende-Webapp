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

## 3b. Pipedrive-Anbindung — was gilt (WICHTIG für Änderungen)

Der Hintergrundlauf (`server/worker.js`, Intervall `POLL_MINUTES`) macht alles
selbstständig: fällige Aufgaben holen → Notizen + Mails auswerten → Entwurf bauen →
in die Freigabe-Warteschlange legen. Nach außen wird **nur bei Freigabe** geschrieben.

**Datenquellen und ihre Eigenheiten — hart erarbeitet, bitte nicht „vereinfachen":**

| Thema | Wie es funktioniert / Falle |
|---|---|
| Mails | `GET /deals/{id}/mailMessages`, Volltext über `/mailbox/mailMessages/{id}?include_body=1`. **Nicht** den n8n-Webhook nutzen: dessen aktiver Zweig sucht per `mailThreads?folder=inbox&subject=<Deal-Titel>` und verfehlt Verläufe. (Der brauchbare Zweig im Workflow `Wo5g71jsZEoEZTZN` ist nicht verdrahtet.) |
| Custom-Felder | **Immer** über den Anzeigenamen auflösen (`server/fields.js`). Werteformat-Raten führte dazu, dass „Erste Zulassung" als Unfalldatum und das „Kennzeichen" als Schadennummer in Kundenmails landete. |
| Unfalldatum | **Existiert in diesem Konto nicht als Feld.** Wird deshalb weggelassen — nicht ersatzweise ein anderes Datum verwenden. |
| Empfänger | Deal-Feld **„Rechtsanwalt"** (Organisationsfeld → Org-ID) ist die belastbare Quelle. Adressen des Anspruchstellers sind ausgeschlossen (sonst ging die Anfrage an ihn selbst). |
| Kanzlei-Adresse fehlt | `/persons?org_id=…` **funktioniert nicht** — Pipedrive ignoriert den Filter und liefert alle Personen. Stattdessen lernendes Verzeichnis (`server/directory.js`), das nur aus dem autoritativen Anwaltsfeld lernt. |
| Dedup | Freigabe schreibt Notiz „✅ Sachstandsanfrage freigegeben"; diese wird beim nächsten Lauf gelesen. Pipedrive ist damit die Wahrheit — Redeploys legen nichts doppelt vor. |
| Anrede | `DUZEN_LISTE`, schreibweisentolerant (Schloßmacher = Schlossmacher). Generische Postfachnamen (Service, Info, Kanzlei) gelten **nicht** als Person. |

**Aufgaben-Betreffe** kommen in zwei Varianten vor: „Sachstand anfragen zu: X" und
„Sachstand anfragen: X". Aktenzeichen-Format ist `MMYY/NNNNTG` (z. B. `0626/1973TG` =
Juni 2026) — die ersten vier Stellen sind **Monat+Jahr**, nicht das Jahr.

Stand des letzten Live-Tests: 25–27 fällige Fälle, ~19–21 Entwürfe,
6 begründet übersprungen (reguliert/abwarten), 1 ohne Empfänger.

**Offene Punkte:**
- **Persistentes Volume** für `DATA_DIR=/data` ist in Coolify **noch nicht angelegt**
  (die Storages-API akzeptiert nur `type: "file"` — daher per UI: Application →
  Persistent Storage → + Add → **Volume Mount**, Mount Path `/data`, Host-Pfad leer).
  Ohne Volume geht nur die lokale Warteschlange bei einem Redeploy verloren;
  Freigaben bleiben dank Notiz-Dedup erhalten.
- **`PIPEDRIVE_BCC_DROPBOX`** setzen, damit Pipedrive gesendete Mails am Vorgang
  ablegt. Die Adressen folgen dem Muster `<konto>+deal<ID>@pipedrivemail.com`;
  `pd.dropboxFuerDeal()` setzt die Deal-Nummer je Fall ein, in der Variable genügt
  ein Beispiel. Der Betreff allein reicht **nicht** — Pipedrive matcht Mail-Sync über
  die Empfängeradresse und damit nur auf die Person, nicht auf den Deal.
- `ANTHROPIC_API_KEY` ist nicht gesetzt. „Ändern lassen" arbeitet dann deterministisch
  (kürzt den Text). Mit Key übernimmt das Modell die Umformulierung (`server/draft.js`).

## 3c. KI-Anbieter — entschieden: Anthropic (nicht über n8n)

**Entscheidung des Nutzers:** Entwürfe laufen direkt über die Anthropic-API
(`server/ai.js`), Modell `claude-sonnet-5`. Nicht über n8n umleiten.

Begründung, bitte nicht neu aufrollen:
- **n8n spart keinen Key.** Der Anthropic-Node in n8n braucht dieselbe
  Zugangsdaten-Art (API-Key aus console.anthropic.com). Eine Anmeldung mit dem
  Claude-Abo (Max) gibt es dort nicht — die OAuth-Anmeldungen in diesem n8n
  betreffen Google/Microsoft/Instagram, alle KI-Anbieter laufen über API-Keys.
- **Max-Abo ≠ API.** Getrennte Produkte, getrennte Abrechnung, keine Brücke.
- Der Umweg über n8n würde zudem Latenz, einen weiteren Ausfallpunkt und den
  Verlust des Prompt-Caching-Rabatts bedeuten — derselbe Fehler wie beim
  ursprünglichen Mail-Webhook.

**Im n8n vorhanden** (Stand 2026-07-26, 69 Credentials geprüft): OpenAI, Mistral
(mehrere, u. a. „Lechat Sachstandstoken"), Google Gemini, HuggingFace, Jina.
**Kein** Anthropic-Credential. Falls der Nutzer später doch auf ein bestehendes
Konto wechseln will, wäre `server/ai.js` die einzige anzupassende Stelle
(Chat-Completions-Format statt Messages-API; Prüfschritt und Fallback bleiben).

**Kostenbremse — nicht entfernen:** `server/worker.js` erzeugt einen Entwurf nur
neu, wenn sich der Fingerprint des Falls geändert hat. Ohne das würde jeder
30-Minuten-Lauf für jeden Fall erneut anfragen (~1000 Anfragen/Tag statt
einer Handvoll). Belegt durch zwei Läufe hintereinander: 3 Aufrufe, dann 0.

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
