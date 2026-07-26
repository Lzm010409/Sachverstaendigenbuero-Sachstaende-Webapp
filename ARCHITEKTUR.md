# Wie die Lösung technisch funktioniert

Diese Datei beschreibt den **Ist-Zustand des Codes** — wofür jeder Baustein da ist,
in welcher Reihenfolge entschieden wird und warum es so gebaut ist. Sie richtet sich
an jemanden, der den Code später ändern muss.

- Bedienung und Fachregeln aus Anwendersicht: **[BENUTZUNG.md](BENUTZUNG.md)**
- Zugänge, Deployment, offene Punkte: **[STATUS.md](STATUS.md)**
- Alle Umgebungsvariablen: **[.env.example](.env.example)**

---

## 1. Aufbau in einem Satz

Ein einzelner Node/Express-Dienst liefert die Oberfläche aus `public/` aus, beantwortet
`/api/*` und betreibt im selben Prozess einen Hintergrundlauf, der einmal täglich die
fälligen Fälle aus Pipedrive holt, bewertet und Entwürfe in eine Warteschlange legt.

Kein Framework im Frontend, keine Datenbank, kein zweiter Dienst. Der Zustand steht in
einer JSON-Datei unter `DATA_DIR`. Das ist bewusst so: Der Datenbestand ist klein
(einige Dutzend Fälle), und alles, was zählt, wird ohnehin nach Pipedrive
zurückgeschrieben.

```
                 einmal täglich
Pipedrive  ──────────────────────►  worker.js
 (Aufgaben, Deals,                    │
  Notizen, Mails)                     ├─ analyze.js   entscheiden: anfragen oder nicht?
                                      ├─ draft.js     Entwurf aus dem Baukasten
                                      ├─ ai.js        Entwurf durch das Modell
                                      └─ store.js     Warteschlange (JSON)
                                             │
    Browser ◄── index.js /api/* ◄────────────┤
       │                                     └─ digest.js  Tagesübersicht per Mail
       │ Freigabe
       ▼
   index.js ──► Pipedrive-Notiz  +  Outlook-Entwurf (graph.js)
```

---

## 2. Die Bausteine

| Datei | Aufgabe |
|---|---|
| `server/index.js` | Express: statische Dateien, `/api/*`, Freigabe-Pfad |
| `server/worker.js` | Der Lauf: Aufgaben holen, bewerten, Entwürfe erzeugen, Zeitplan |
| `server/analyze.js` | Entscheidungskaskade je Fall (Abschnitt 4) |
| `server/rules.js` | Zehn Fall-Kategorien, davon zwei ohne Anfrage (`NO_REQUEST_IDS`) |
| `server/draft.js` | Deterministischer Entwurf aus Bausteinen, Betreffzeile, Anrede |
| `server/ai.js` | Anthropic-Anbindung mit erzwungenem Antwortschema + `validateDraft()` |
| `server/pipedrive.js` | API-Zugriff mit Zwischenspeichern, `dropboxFuerDeal()` |
| `server/fields.js` | Deal-Felder über ihre **Namen** auflösen statt über geratene IDs |
| `server/directory.js` | Gelernte Mailadressen je Kanzlei/Versicherung |
| `server/graph.js` | Microsoft Graph: Outlook-Entwurf anlegen, Mail versenden |
| `server/digest.js` | Tägliche Übersicht der offenen Fälle |
| `server/auth.js` | Anmeldung über Microsoft Entra ID, signiertes Sitzungs-Cookie |
| `server/store.js` | Warteschlange als JSON, Zusammenführen und Entscheidungen |
| `public/index.html`, `public/app.js` | Oberfläche, mobil und am Schreibtisch |

---

## 3. Ein Lauf, Schritt für Schritt

`worker.js` → `runOnce()`:

1. **Fällige Aufgaben holen.** `getOpenTasks()`, dann filtern auf `type === "task"`,
   Betreff beginnt mit „Sachstand anfragen", `due_date <= heute`, und es hängt ein Deal
   dran. Sortiert nach Fälligkeit, gekappt bei `MAX_CASES_PER_RUN`.
2. **Bekannte Fälle überspringen.** Wurde ein Fall vor weniger als `FALL_TTL_STUNDEN`
   analysiert und wartet noch auf eine Entscheidung, wird er unverändert übernommen —
   *ohne einen einzigen Pipedrive-Aufruf*. Der Knopf „Aktualisieren" setzt `force` und
   umgeht das.
3. **Fall laden.** Deal, Notizen und Mailverlauf parallel; dazu die Deal-Felder über
   `fields.js` und die im Deal hinterlegte Kanzlei.
4. **Bewerten.** `analyzeCase()` liefert Status, Empfänger und — die wichtigste Angabe —
   `needsDraft`.
5. **Entwerfen**, falls nötig. Erst der deterministische Baukasten, dann gegebenenfalls
   das Modell (Abschnitt 5).
6. **Einsortieren.** `store.mergeCases()` führt die Fälle mit der Warteschlange
   zusammen; bereits getroffene Entscheidungen bleiben erhalten.

`start()` prüft alle `TAKT_MINUTEN` nur die Uhrzeit — das kostet nichts. Ist die Stunde
`LAUF_STUNDE` erreicht und heute noch kein Lauf vermerkt (`laufGemachtAm`), läuft er
einmal. Sonst wird nur geprüft, ob die Tagesübersicht fällig ist.

**Ausstehende Freigabe-Notizen laufen bewusst außerhalb dieses Tageslaufs.**
`notizenNachtragen()` steht am Anfang jedes Taktes, nicht in `runOnce()`. Am Tageslauf
aufgehängt hätte eine abends abgelehnte Notiz bis zum nächsten Morgen gewartet, obwohl
das Pipedrive-Kontingent um Mitternacht zurückgesetzt wird. Die Wartezeit zwischen den
Anläufen verdoppelt sich (15 Minuten bis höchstens 6 Stunden), und beim ersten
Fehlschlag eines Durchgangs wird abgebrochen — ist das Kontingent leer, scheitern die
übrigen ohnehin und verbrennen nur Aufrufe. `runOnce({force: true})` aus dem Knopf
„Aktualisieren" übergeht die Wartezeit. Nach drei Tagen wird aufgegeben.

---

## 4. Die Entscheidungskaskade

`analyze.js` arbeitet der Reihe nach; der erste Treffer, der `skipReason` setzt,
beendet die Kette. **Kein Skip-Grund heißt Entwurf.**

| # | Prüfung | Ergebnis |
|--:|---|---|
| 1 | Regulierungssignal in Mails/Notizen | `reguliert` → kein Entwurf |
| 2 | Neueste Nachricht ist eine Frage **an uns** | `rueckfrage` → Entwurf, aber mit Hinweis |
| 3 | „abwarten"-Vermerk (30 Tage) oder Gerichtsverfahren (60 Tage), noch frisch | `abwarten` → kein Entwurf |
| 4 | Unsere letzte Sachstandsanfrage jünger als die Frist | `bereits_angefragt` → kein Entwurf |
| 5 | Keine Mailadresse der Gegenseite auffindbar | `unklar` → kein Entwurf |
| — | sonst | `faellig` / `ueberfaellig` → Entwurf |

Drei Feinheiten, die jeweils aus einem echten Fehlverhalten entstanden sind:

**Signale zählen erst ab Erstellung der Aufgabe.** `notBefore: task.add_time`. Ohne
diesen Schnitt las die Prüfung eine zwei Jahre alte Notiz als „bereits reguliert" — der
Fall verschwand dauerhaft. Wer die Aufgabe angelegt hat, kannte den alten Vermerk.

**Nicht jede Zahlung ist eine Regulierung.** `RE_KEINE_REGULIERUNG` schließt Vorschuss,
Gerichtskostenvorschuss und Teilzahlung aus. „Vorschuss bezahlt" ist kein Abschluss.

**Die Frist hängt am Alter unserer letzten Anfrage, nicht am Fälligkeitsdatum der
Aufgabe.** Am Fälligkeitsdatum aufgehängt war die Regel in beide Richtungen falsch: eine
Anfrage kurz *vor* dem Termin unterdrückte nichts, eine Anfrage kurz *nach* einem alten
Termin unterdrückte dauerhaft. Als „unsere Anfrage" zählen nur ausgehende Mails mit
„Sachstand" im Betreff und Freigabe-Notizen am Deal — Letztere überleben einen Neustart
und sind damit die belastbare Quelle, auch wenn die lokale Warteschlange verloren geht.

---

## 5. Wie ein Entwurf entsteht

**Erst deterministisch.** `draft.js` baut aus den geprüften Angaben einen vollständigen
Entwurf: Anrede (`DUZEN_LISTE` entscheidet über Du oder Sie), Aktenzeichen, Schadendatum,
Betreff `Sachstandsanfrage · <Name> · [Az. <Token>]`. Dieser Text ist das Netz — ohne
API-Schlüssel und bei jedem Fehler des Modells geht er raus.

**Dann das Modell.** `ai.js` ruft Anthropic mit erzwungenem Antwortschema auf
(Kategorie, Einschätzung, Schwerpunkt, `anfrage_sinnvoll`, Entwurf). Der Systemtext wird
zwischengespeichert (`cache_control`), weil er sich zwischen Fällen nicht ändert.

Die Arbeitsteilung ist die eigentliche Entwurfsentscheidung: **Fakten und
Skip-Entscheidungen kommen aus Regeln, Formulierung und Schwerpunkt vom Modell.** Das
Modell entscheidet nie, *ob* angefragt wird, sondern nur, *wie* — mit einer Ausnahme:
Ergibt seine Kategorie eine Sachlage, zu der eine Sachstandsanfrage nicht passt
(`NO_REQUEST_IDS`, etwa eigene titulierte Forderung), entfällt der Entwurf, der Fall
bleibt aber mit Begründung sichtbar.

**Danach die Prüfung.** `validateDraft()` verwirft den KI-Text und behält den Baukasten,
wenn ein fremdes Aktenzeichen auftaucht, eine unbelegte Nummer genannt wird, Anrede oder
Grußformel verändert wurden oder Mahn- und Drohsprache vorkommt. Verworfene Entwürfe
landen mit Grund im Log.

---

## 6. Die drei Kostenbremsen

Die Pipedrive-API hat ein Tageskontingent, und jeder Modellaufruf kostet Geld. Beides
war einmal ein echtes Problem: halbstündliche Läufe ergaben über 6000 Abrufe am Tag, und
ohne Wiederverwendung hätte jeder Lauf für jeden Fall neu beim Modell angefragt.

| Bremse | Wo | Wirkung |
|---|---|---|
| Ein Lauf am Tag | `worker.start()` | rund 110 statt über 6000 Abrufe |
| Fall-Fenster `FALL_TTL_STUNDEN` | `runOnce()` | unveränderter Fall = null Abrufe |
| Fingerabdruck | `runOnce()` | gleicher Fall = kein Modellaufruf |

Der Fingerabdruck ist `neueste Mailzeit | Anzahl Mails | Anzahl Notizen | Fälligkeit`.
Ändert er sich nicht und liegt ein geprüfter KI-Entwurf vor, wird dieser wiederverwendet.

> Beim Ändern zu beachten: Der Fingerabdruck muss **vor** dem Modellblock berechnet
> werden. Stand er einmal darunter, warf JavaScript einen Zugriffsfehler, sobald ein
> Vorgänger-Fall existierte — beim ersten Lauf fiel das nicht auf, danach fehlten still
> die Hälfte der Fälle.

Dazu kommen Zwischenspeicher in `pipedrive.js` (Organisationen, `ORG_CACHE_STUNDEN`) und
`fields.js` (Feldnamen, eine Stunde).

---

## 7. Warteschlange und Persistenz

`store.js` hält alles in einer Datei `queue.json` unter `DATA_DIR`. `cases` ist ein
**Objekt**, indiziert nach Fall-ID.

`normalize()` prüft diese Form bei jedem Laden und rettet Einträge, wenn stattdessen ein
Array ankommt; `save()` vergleicht zusätzlich die Fallzahl vor und nach dem Serialisieren.
Hintergrund: Ist `cases` versehentlich ein Array, schreibt `mergeCases()` benannte
Eigenschaften hinein, die `JSON.stringify` **stillschweigend verwirft** — die Oberfläche
meldet dann „17 Entwürfe" und zeigt keinen einzigen Fall. Der Schaden ist unauffällig,
deshalb die zwei Prüfungen.

Ohne persistentes Volume geht die Warteschlange bei jedem Deployment verloren. Das ist
ärgerlich (die Entwürfe werden neu erzeugt), aber nicht gefährlich: **doppelte Anfragen
entstehen dadurch nicht**, weil Kaskadenschritt 4 die Freigabe-Notiz in Pipedrive liest.

---

## 8. Freigabe und Versand

Im `approve`-Handler von `index.js`, in dieser Reihenfolge:

1. Freigabe als Notiz am Deal protokollieren (`pd.addNote`).
2. Entwurf ins Outlook-Postfach legen (`graph.createDraft`) — als HTML **ohne** feste
   Schriftart und Farbe, damit er die Outlook-Einstellungen erbt.
3. Blindkopie an die **deal-eigene** Pipedrive-Dropbox (`pd.dropboxFuerDeal`).
4. Entscheidung in der Warteschlange vermerken, Link zum Entwurf zurückgeben.

**Es wird nichts automatisch versendet.** Abgeschickt wird von Hand aus Outlook. Der
einzige selbsttätige Versand der Lösung ist die Tagesübersicht an den eigenen Posteingang.

Zur Zuordnung: Pipedrive erkennt synchronisierte Mails über die *Empfängeradresse* und
damit nur die **Person** — eine Kanzlei hängt an vielen Deals gleichzeitig. Der Betreff
mit Name und Aktenzeichen hilft beim Suchen, ordnet aber nichts zu. Erst die Adresse
`<konto>+deal<ID>@pipedrivemail.com` legt die Mail am richtigen Vorgang ab.
`dropboxFuerDeal()` baut sie aus `PIPEDRIVE_BCC_DROPBOX` und der Deal-ID; ein dort schon
enthaltener `+deal`-Zusatz wird ersetzt. Fehlt die Variable oder ist die Deal-ID nicht
numerisch, entsteht **kein** BCC statt einer falschen Adresse.

---

## 9. Anmeldung

`auth.js` macht Authorization Code Flow mit PKCE gegen Entra ID, ohne Fremdbibliothek.
Das Ergebnis ist ein HMAC-signiertes Cookie (`SESSION_SECRET`, Laufzeit
`SESSION_STUNDEN`); der Vergleich läuft über `crypto.timingSafeEqual`. `verifyIdToken()`
prüft Zielgruppe, Mandant, Aussteller und Ablauf und wertet `ENTRA_ERLAUBTE_NUTZER` aus.

Sind die Entra-Variablen nicht gesetzt, greift Basic-Auth als Notausgang. `/api/health`
bleibt in beiden Fällen offen — der Healthcheck des Containers braucht ihn.

---

## 10. Die API

| Methode | Pfad | Zweck |
|--:|---|---|
| GET | `/api/health` | Healthcheck; meldet zusätzlich, welche Anbindungen eingerichtet sind (nur Ja/Nein) |
| GET | `/api/config` | Betriebsmodus, angemeldeter Nutzer |
| GET | `/api/cases` | Fälle der Warteschlange |
| POST | `/api/refresh` | Lauf sofort erzwingen (`force`) |
| POST | `/api/cases/:id/rewrite` | Entwurf umschreiben `{instruction}` |
| POST | `/api/cases/:id/approve` | freigeben `{draft}` — **kein Auto-Versand** |
| POST | `/api/cases/:id/skip` | überspringen `{reason}` |

---

## 11. Fallen, die schon einmal Zeit gekostet haben

- **Aktenzeichen `MMYY/NNNNTG`.** Die ersten vier Stellen sind **Monat+Jahr**, nicht das
  Jahr: `0626/1973TG` ist Juni 2026.
- **Der Browser-Cache.** `index.html` wird mit `Cache-Control: no-cache` ausgeliefert und
  lädt `app.js?v=<Änderungszeit>`. Ohne das lud der Browser altes JavaScript zu neuem CSS
  — das Ergebnis sah aus wie ein kaputtes Layout und war keins.
- **Coolify-API.** Die Domain heißt beim Schreiben `domains` und beim Lesen `fqdn`. Das
  Feld für Bauzeit-Variablen heißt `is_buildtime` (nicht `is_build_time`). Eine
  vorhandene Variable braucht `PATCH`, sonst kommt 409. Werte gibt die API **nicht**
  zurück — deshalb meldet `/api/health`, was im laufenden Container angekommen ist.
- **Volumes** lassen sich nicht über die API anlegen (nur `type: "file"`), das geht nur
  in der Oberfläche.
- **Rasterlayout.** In CSS-Grid braucht eine Spalte `minmax(0, 1fr)` und `min-width: 0`,
  sonst werden Inhalte abgeschnitten. Rein numerische Tests haben das nicht gefunden,
  weil `overflow-x: hidden` den Fehler verdeckte — sichtbar wurde er erst im Screenshot.
- **`<button>` erbt keine Textfarbe.** Ohne ausdrückliches `color` nimmt es die Vorgabe
  des Browsers für Schaltflächen — gemessen `rgb(0,0,0)`. Die Fallnamen in der Liste
  waren dadurch im Dunkelmodus schwarz auf dunkelblau (1,6:1). Dazu gehört
  `color-scheme: light dark` auf `:root`: Ohne diese Angabe verwendet der Browser für
  Bedienelemente, Rollbalken und Textfelder weiter die hellen Systemvorgaben, während
  die eigenen Variablen längst dunkel sind.
- **Farben nicht nach Gefühl ändern.** Jede Textfarbe muss auf jeder Fläche, auf der
  sie vorkommt, mindestens 4,5:1 erreichen — auch `--text-faint`, das bei 11–12 px für
  Beschriftungen und Datumsangaben verwendet wird. Eine Tabelle der Variablen genügt
  als Nachweis **nicht**: Der Fehler oben stand in keiner Variable, sondern entstand
  erst beim Rendern. Gemessen wird deshalb im Browser über alle sichtbaren
  Textelemente gegen ihren tatsächlichen Hintergrund.
- **Dämpfen nie über `opacity`.** `.case.done` hatte `opacity: .5`; der Name fiel damit
  auf 1,6:1, obwohl gerade freigegebene Fälle noch Stunden lesbar bleiben sollen.
  Zurückhaltung über Flächen- und Textfarbe herstellen.
