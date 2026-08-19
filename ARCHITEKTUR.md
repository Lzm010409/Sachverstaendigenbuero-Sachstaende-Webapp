# Wie die Lösung technisch funktioniert

Diese Datei beschreibt den **Ist-Zustand des Codes** — wofür jeder Baustein da ist,
in welcher Reihenfolge entschieden wird und warum es so gebaut ist. Sie richtet sich
an jemanden, der den Code später ändern muss.

- Bedienung und Fachregeln aus Anwendersicht: **[BENUTZUNG.md](BENUTZUNG.md)**
- Datenbank ausrollen, Import, Rückweg: **[DATENBANK-UMSTELLUNG.md](DATENBANK-UMSTELLUNG.md)**
- Zugänge, Deployment, offene Punkte: **[STATUS.md](STATUS.md)**
- Alle Umgebungsvariablen: **[.env.example](.env.example)**

---

## 1. Aufbau in einem Satz

Ein einzelner Node/Express-Dienst liefert die Oberfläche aus `public/` aus, beantwortet
`/api/*` und betreibt im selben Prozess einen Hintergrundlauf, der einmal täglich die
fälligen Fälle aus Pipedrive holt, bewertet und Entwürfe in eine Warteschlange legt.

Kein Framework im Frontend. Der Zustand liegt in einer eigenen Postgres-Datenbank, die
in Coolify eine **eigene Ressource** ist und deshalb gesichert werden kann — vorher waren
es JSON-Dateien in einem Volume, für das es kein Backup gibt (Abschnitt 7).

```
                 einmal täglich
Pipedrive  ──────────────────────►  worker.js
 (Aufgaben, Deals,                    │
  Notizen, Mails)                     ├─ analyze.js   entscheiden: anfragen oder nicht?
                                      ├─ draft.js     Entwurf aus dem Baukasten
                                      ├─ ai.js        Entwurf durch das Modell
                                      └─ store.js     Warteschlange (Postgres)
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
| `server/store.js` | Warteschlange in Postgres, Zusammenführen, Entscheidungen, Aufräumen |
| `server/db/schema.js` | Das Datenbankschema (Drizzle), `drizzle/` die erzeugten Migrationen |
| `server/db/index.js` | Die Verbindung — die einzige Stelle, die `DATABASE_URL` liest |
| `scripts/starten.mjs` | Startvorgang: Migrationen anwenden, dann den Server starten |
| `scripts/import-altbestand.js` | Einmaliger Import der alten JSON-Dateien |
| `server/zeit.js` | Ortszeit über `Intl` — der Container läuft in UTC (Abschnitt 11) |
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
3. **Fall laden.** Zuerst der Deal allein — wegen der Phase (siehe unten); erst danach
   Notizen und Mailverlauf parallel, dazu die Deal-Felder über `fields.js` und die im
   Deal hinterlegte Kanzlei.
4. **Bewerten.** `analyzeCase()` liefert Status, Empfänger und — die wichtigste Angabe —
   `needsDraft`.
5. **Entwerfen**, falls nötig. Erst der deterministische Baukasten, dann gegebenenfalls
   das Modell (Abschnitt 5).
6. **Einsortieren.** `store.mergeCases()` führt die Fälle mit der Warteschlange
   zusammen; bereits getroffene Entscheidungen bleiben erhalten.

### Der Phasenfilter

Die Aufgabe „Sachstand anfragen" entsteht in Pipedrive automatisch und bleibt danach am
Deal hängen, egal wohin dieser wandert. Ohne Filter landete deshalb auch ein längst
bezahlter Fall in der Freigabe — dort ist nichts mehr nachzufragen. Umgekehrt gehören
Klage und Teilbezahlt sehr wohl dazu.

`PIPEDRIVE_STUFEN` bestimmt, welche Phasen durchkommen. Konfiguriert wird über die
**Namen** aus Pipedrive, nicht über Nummern: Die Nummern stehen dort nirgends sichtbar,
und wer die Einstellung später liest, soll erkennen, was gemeint ist. Nummern werden
trotzdem akzeptiert. Drei Schreibweisen:

| Wert | Wirkung |
|---|---|
| `Versendet, Teilbezahlt, Klage` | nur diese Phasen (Voreinstellung) |
| `nicht: Aufgenommen, In Bearbeitung` | alle außer diesen |
| `alle` | kein Filter |

Die Namen werden über `pd.getStages()` in Nummern übersetzt (gepuffert, `STUFEN_CACHE_STUNDEN`,
Voreinstellung 12 h — sonst kostete jeder Lauf einen weiteren Aufruf).

Drei Entscheidungen, die man beim Lesen sonst für Nachlässigkeit hält:

- **Der Deal wird VOR Notizen und Mails geholt.** Fällt der Fall über die Phase heraus,
  spart das zwei weitere Aufrufe des Tageskontingents — je Lauf und Fall.
- **Im Zweifel wird durchgelassen, nie ausgesperrt.** Ein Tippfehler in einem Namen wird
  gemeldet (Protokoll, Lauf-Zusammenfassung, `/api/diagnose/stufen`), die übrigen Namen
  greifen weiter. Lässt sich *kein* Name auflösen oder scheitert `getStages()` (leeres
  Kontingent), wird gar nicht gefiltert. Ein Deal ohne erkennbare Phase kommt ebenfalls
  durch. Der umgekehrte Weg — Filter greift zu weit — hieße: Fälle verschwinden
  wortlos aus der Freigabe.
- **`Number(null)` ist `0`, und `0` sieht aus wie eine gültige Phasennummer.** `stufeVonDeal()`
  gibt bei fehlender Angabe ausdrücklich `null` zurück. Ohne diese Unterscheidung wäre
  ein Deal ohne Phase still ausgesperrt worden.

Ein Fall, der inzwischen in eine ausgeschlossene Phase gewandert ist, wird aus der
Warteschlange **entfernt** — aber nur, wenn er noch unentschieden ist. Das ist kein
Aufräumen nach Abwesenheit (siehe `store.aufraeumen`, Abschnitt 4), sondern nach
positiver Feststellung: Der Deal wurde in diesem Lauf geladen und seine Phase gelesen.
Entschiedene Fälle bleiben stehen, damit ihre Ergebniskarte die Frist ausleben kann.

Der Übernahme-Zweig aus Schritt 2 prüft die zuletzt **gespeicherte** Phase — er holt
bewusst nichts von Pipedrive, das ist sein Sinn. Er greift also bei einer geänderten
Einstellung, nicht bei einem gerade umgezogenen Deal; der fällt beim nächsten vollen
Durchgang heraus (spätestens nach `FALL_TTL_STUNDEN`) oder sofort über „Aktualisieren".
Fälle aus der Zeit vor dem Phasenfilter haben keine gespeicherte Phase und werden
durchgelassen statt reihenweise entfernt.

Sichtbar ist das Ganze an drei Stellen: die Phase steht in der Fallansicht unter
„Phase", die Kopfzeile nennt „N nicht in der Phase" (mit der Einstellung als Tooltip),
und `GET /api/diagnose/stufen` listet alle Phasen aus Pipedrive mit `wirdAngefragt`.
Die Warnung „X von Y fälligen Fällen nicht abgerufen" zieht die aussortierten ab —
sonst hätte sie nach Einführung des Filters jeden ausgeschlossenen Fall als Ausfall
gemeldet.

`start()` prüft alle `TAKT_MINUTEN` nur die Uhrzeit — das kostet nichts. Ist die Stunde
`LAUF_STUNDE` erreicht und heute noch kein Lauf vermerkt (`laufGemachtAm`), läuft er
einmal. Sonst wird nur geprüft, ob die Tagesübersicht fällig ist.

**Ausstehende Nacharbeiten laufen bewusst außerhalb dieses Tageslaufs.**
`nacharbeiten()` steht am Anfang jedes Taktes, nicht in `runOnce()`, und holt beides
nach: die Notiz am Deal und das Abschließen der Aufgabe. Am Tageslauf
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
Entwurf: Anrede (`VERTRAUTE_KONTAKTE` entscheidet zwischen „Guten Tag," und „Sehr geehrte
Damen und Herren,"), Aktenzeichen, Schadendatum,
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

Dazu kommt eine **Stilprüfung**: Der Text soll über den Vorgang sprechen, nicht den
Empfänger ansprechen, und keine vorauseilenden Klauseln enthalten („Sollten Sie
Rückfragen haben…", „Für Rückfragen stehen wir zur Verfügung"). Die Regeln stehen im
Systemtext (`rules.js`), aber Regeln im Prompt driften — nach genügend Fällen taucht die
Formel wieder auf. Die Prüfung ist deshalb das Netz und **bewusst eng gefasst**: nur
feste Wendungen, keine Heuristik über „Sie" oder Fragezeichen. Eine zu breite Prüfung
hat hier schon einmal brauchbare Entwürfe kassiert.

Wichtig: `refineDraft()` in `draft.js` („Ändern lassen") hat einen **eigenen**
Systemtext. Er muss dieselben Stilregeln tragen — sonst holt ein „kürzer" genau die
Formeln zurück, die beim Erzeugen ausgeschlossen sind.

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

Der Bestand liegt in einer **eigenen Postgres-Datenbank**, angesprochen ausschließlich
über `DATABASE_URL`. Ausrollen, Import und Rückweg: **[DATENBANK-UMSTELLUNG.md](DATENBANK-UMSTELLUNG.md)**.

| Tabelle | Inhalt |
|---|---|
| `fall` | ein Fall der Warteschlange, Schlüssel `task-<Aufgaben-ID>` |
| `nacharbeit` | Notizen und Aufgabenabschlüsse, die Pipedrive abgelehnt hat |
| `lauf` | genau eine Zeile: letzter Lauf, Zusammenfassung, Tagesstempel |
| `verzeichnis_organisation` / `verzeichnis_adresse` | das gelernte Adressverzeichnis |

Vorher waren es zwei JSON-Dateien unter `DATA_DIR`. Der Grund für den Wechsel ist kein
technischer Ehrgeiz, sondern Coolify: Gesichert werden **Datenbank-Ressourcen**, nicht
Volumes und nicht Hostpfade. In dieser Anwendung war zudem gar kein Volume eingebunden —
der Bestand war bei jedem Deploy weg.

**Der Zustand im Speicher ist unverändert geblieben.** `load()` setzt aus den Tabellen
dasselbe Objekt zusammen, das früher in `queue.json` stand
(`{ cases, offeneNacharbeiten, lastRun, lastRunSummary, version }`), und `save()` schreibt
es zurück. Deshalb sind `mergeCases`, `aufraeumen`, `setDecision`, `setEditedBody`,
`listCases` und `pendingCount` **wortgleich** geblieben: Sie arbeiten auf dem Objekt, nicht
auf dem Speicher. Asynchron geworden sind nur `load` und `save` — das erzwingt die
Datenbank, und mehr hat sich an der Schnittstelle nicht geändert.

**Warum Spalten UND `daten jsonb` je Fall.** Ein Fall ist ein Abbild dessen, was Pipedrive
hergibt — rund vierzig Felder, die sich mit der Fachlogik weiterentwickeln (zuletzt kamen
`stageId`/`stageName` dazu). Eine Spalte je Feld hieße: eine Migration für jede
Anzeigeänderung. Deshalb steht der vollständige Fall in `daten`, und die Felder, nach
denen wirklich gesucht, sortiert und aufgeräumt wird, stehen zusätzlich als Spalten. Sie
werden bei jedem Schreiben aus `daten` abgeleitet und können deshalb nicht auseinanderlaufen.

**`save()` ersetzt, es ergänzt nicht.** Was nicht mehr im Zustand steht, wird gelöscht.
Das ist kein Nebeneffekt, sondern der Weg, auf dem `aufraeumen()` und der Phasenfilter
Fälle wieder loswerden — genau wie beim vollständigen Neuschreiben der Datei.

**Zwei Zeichen, die Postgres nicht speichern kann**, und die JSON klaglos schluckte: das
Nullbyte `U+0000` und eine einzelne Ersatzstelle (`U+D800`–`U+DFFF` ohne Partner, entsteht
beim Abschneiden eines Textes mitten in einem Emoji). Beides steckt regelmäßig in
Mailtexten, die Pipedrive aus Anhängen liefert, und beides ließ vor der Absicherung das
gesamte `insert` scheitern — mitsamt Lauf und Freigabe. `textBereinigen()` entfernt sie
beim Schreiben und meldet es im Protokoll. Gültige Zeichenpaare und die übrigen
Steuerzeichen bleiben unangetastet; das ist gemessen, nicht vermutet.

`normalize()` prüft die Form bei jedem Laden und rettet Einträge, wenn `cases` als
Array ankommt; der Dateipfad vergleicht zusätzlich die Fallzahl vor und nach dem
Serialisieren. Hintergrund: Ist `cases` versehentlich ein Array, schreibt `mergeCases()`
benannte Eigenschaften hinein, die `JSON.stringify` **stillschweigend verwirft** — die
Oberfläche meldet dann „17 Entwürfe" und zeigt keinen einzigen Fall. Aus einer Tabelle
kann diese Form nicht mehr kommen; die Prüfung bleibt für den Dateipfad und den Importer
stehen, und damit ihr Grund nicht mit ihr verschwindet.

**Der Dateipfad ist noch da.** `store.ausDatei()` / `directory.ausDatei()` lesen weiter
`queue.json` und `directory.json`; fehlt `DATABASE_URL`, läuft die Anwendung ganz darauf
(mit Warnung beim Start und `"speicher": "datei"` in `/api/health`). Das ist Absicht,
solange der Import in Produktion nicht verifiziert ist. Sein Ausbau ist ein eigener,
späterer Schritt.

**Aufräumen.** `aufraeumen()` entfernt entschiedene Fälle nach `AUFBEWAHREN_TAGE`
(Vorgabe 14). Vorher wuchs die Warteschlange unbegrenzt — `mergeCases()` legt an und
aktualisiert, entfernte aber nie. Entscheidend: Entfernt wird **ausschließlich nach
Alter**, niemals deshalb, weil ein Fall im letzten Lauf fehlte. Fehlen kann er auch,
weil sein Abruf an einem leeren Pipedrive-Kontingent gescheitert ist; ein Aufräumen nach
Abwesenheit hätte genau dann die Freigabe-Spur gelöscht.

**Wiedervorlegen nur mit neuem Entwurf.** Ein entschiedener Fall wird nur dann erneut
vorgelegt, wenn sich der Fingerabdruck geändert hat **und** `needsDraft` wieder wahr ist.
Ohne die zweite Bedingung setzte sich der Fall selbst zurück: Die Freigabe schreibt eine
Notiz an den Deal, der Fingerabdruck zählt Notizen — jede Freigabe machte den Fall beim
nächsten Lauf „verändert", die Entscheidung wurde verworfen, und er stand als „Bereits
angefragt" statt „Freigegeben" da, ohne Link zum Outlook-Entwurf.

**Der Start legt das Schema selbst an.** `scripts/starten.mjs` wendet vor dem Lauschen die
Dateien aus `drizzle/` an und merkt sich Name und Prüfsumme in `__migrationen`. Ein
zweiter Start ändert nichts; eine nachträglich veränderte Migration erzeugt eine Warnung
statt einer stillschweigenden Heilung. Das Skript benutzt ausschließlich `postgres` —
drizzle-kit ist eine Entwicklungsabhängigkeit und liegt nicht im Laufzeit-Abbild.

Ginge der Bestand doch einmal verloren, wäre das ärgerlich (die Entwürfe werden neu
erzeugt), aber nicht gefährlich: **doppelte Anfragen entstehen dadurch nicht**, weil
Kaskadenschritt 4 die Freigabe-Notiz in Pipedrive liest.

---

## 8. Freigabe und Versand

Im `approve`-Handler von `index.js`, in dieser Reihenfolge:

1. Entwurf ins Outlook-Postfach legen (`graph.createDraft`) — als HTML **ohne** feste
   Schriftart und Farbe, damit er die Outlook-Einstellungen erbt, mit der
   **deal-eigenen** Pipedrive-Dropbox als Blindkopie (`pd.dropboxFuerDeal`).
2. Freigabe als Notiz am Deal protokollieren (`pd.addNote`).
3. **Aufgabe abschließen** (`pd.completeTask`). In Pipedrive hängen daran
   Automatisierungen, die die nächste Wiedervorlage anlegen; bleibt die Aufgabe offen,
   entsteht keine Erinnerung und der Fall steht am nächsten Tag wieder in der Liste.
4. Entscheidung in der Warteschlange vermerken, Link zum Entwurf zurückgeben.

Die Reihenfolge ist bindend, und zwar in beide Richtungen:

- **Entwurf vor Notiz.** Andersherum riss ein Fehler der Notiz — praktisch immer ein
  aufgebrauchtes Tageskontingent — die ganze Freigabe mit, und der Entwurf entstand nie,
  obwohl Outlook einwandfrei erreichbar war.
- **Notiz vor Aufgabe.** Die Notiz ist die Spur der Anfrage; sie muss stehen, bevor der
  Vorgang als erledigt gilt.
- **Der Abbruch „weder Entwurf noch Notiz" vor dem Abschließen der Aufgabe.** Sonst wäre
  die Aufgabe in Pipedrive erledigt, während die Anwendung die Freigabe verwirft — der
  Fall käme in keinem Lauf mehr vor, ohne dass je eine Anfrage herausgegangen wäre.

Schlägt Schritt 2 oder 3 fehl, wird der jeweils offene Schritt in
`state.offeneNacharbeiten` vorgemerkt und selbsttätig nachgeholt (Abschnitt 3). Jeder
gelungene Schritt wird sofort abgehakt, damit ein Fehlschlag im zweiten Schritt den
ersten nicht wiederholt — sonst entstünden bei jedem Anlauf weitere Notizen am Deal.
Einsehbar unter `GET /api/diagnose/nacharbeiten`, ohne einen einzigen Pipedrive-Aufruf.

Zwei Dinge, die dabei leicht übersehen werden:

- **Der Nachtrag muss an den Fall zurückschreiben.** `nacharbeiten()` trägt `caseId`
  mit und setzt `cases[id].notiz` bzw. `.aufgabe`. Ohne das stand in der Ergebniskarte
  für immer „Noch nicht angelegt", auch wenn die Notiz längst am Deal hing — die
  Warteschlange wusste Bescheid, der Fall nicht.
- **Jede offene Zeile hat einen eigenen Knopf** (`POST /api/cases/:id/nachholen` mit
  `schritt: notiz | aufgabe | entwurf`). Ein einzelner Schritt kostet **einen**
  Pipedrive-Aufruf; „Aktualisieren" zieht alle Fälle neu und kostet rund 110. Wer den
  Schritt hier ausführt, muss ihn auch aus `offeneNacharbeiten` entfernen — sonst legt
  der Nachtrag später eine zweite Notiz an.

**Überspringen läuft denselben Weg** — Notiz mit dem Grund (`renderSkipNote`), dann
Aufgabe abschließen, bei Fehlschlag dieselbe Nacharbeits-Warteschlange. Das gilt für
**jeden** Skip-Grund, nicht nur für `reguliert`.

Das war bis zum 28.07.2026 anders: Damals blieb die Aufgabe bei „Frist läuft" oder
„abwarten" offen, aus Sorge, der Fall verschwände dauerhaft aus der Wiedervorlage. Diese
Sorge war unbegründet — in Pipedrive hängt am Abschluss der Aufgabe die Automatisierung,
die die nächste Wiedervorlage **erst anlegt**. Bleibt die Aufgabe offen, entsteht gar
keine Erinnerung.

Wer den Schritt einzeln nachholt (`/nachholen`, `schritt: "notiz"`), muss die richtige
Vorlage wählen: Bei einem übersprungenen Fall gehört dorthin die Überspringen-Notiz, nicht
die Freigabe mitsamt Entwurfstext.

**Der Grund kommt aus der Oberfläche, nicht aus der Auswertung.** `skipBtn` löst den
Skip nicht mehr selbst aus, sondern klappt `#skipBox` auf; erst `#skipGo` (oder die
Eingabetaste im Feld) schickt `POST /api/cases/:id/skip` mit `{reason}`. Vorbelegt ist
`c.skipReason` aus der Auswertung, überschreibbar; ein leeres Feld fällt auf
`c.skipReason` und zuletzt auf `"manuell übersprungen"` zurück. Der Server nimmt den
Text unverändert entgegen und escapet ihn in `renderSkipNote`.

Zwei Fallen dabei:

- Die Karte mit dem Feld darf **nicht** an `rechtsBelegt` hängen. Diese Prüfung
  (`c._resolved || c.draft`) entscheidet nur, welche Spalte den Mailverlauf bekommt.
  Solange sie auch über die Überspringen-Karte entschied, fiel diese bei Fällen ohne
  Entwurf ersatzlos weg — genau bei denen, die nur noch übersprungen werden können.
  Jetzt wandert sie in solchen Fällen in die linke Spalte, der Mailverlauf nach rechts.
- Beim Entwurf steht das Feld unterhalb der Schaltflächen und damit oft außerhalb des
  Sichtfensters. Ohne `scrollIntoView` wirkt der Klick auf „Überspringen" folgenlos.

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
| GET | `/api/health` | Healthcheck; meldet zusätzlich, welche Anbindungen eingerichtet sind (nur Ja/Nein) und ob der Speicher `postgres` oder `datei` ist |
| GET | `/api/diagnose/outlook` | Postfach-Anbindung prüfen (Versand- und Entwurfspostfach) |
| GET | `/api/diagnose/nacharbeiten` | ausstehende Notizen und Aufgabenabschlüsse |
| POST | `/api/cases/:id/volltext` | Notizen und Mailrümpfe auf Anforderung nachladen |
| POST | `/api/cases/:id/nachholen` | einen einzelnen Schritt ausführen (`notiz`/`aufgabe`/`entwurf`) |
| GET | `/api/config` | Betriebsmodus, angemeldeter Nutzer |
| GET | `/api/cases` | Fälle der Warteschlange |
| POST | `/api/refresh` | Lauf sofort erzwingen (`force`) |
| POST | `/api/cases/:id/rewrite` | Entwurf umschreiben `{instruction}` |
| POST | `/api/cases/:id/approve` | freigeben `{draft}` — **kein Auto-Versand** |
| POST | `/api/cases/:id/skip` | überspringen `{reason}` |
| GET | `/api/diagnose/stufen` | alle Pipeline-Phasen mit `wirdAngefragt` |

---

## 11. Fallen, die schon einmal Zeit gekostet haben

- **Der Container läuft in UTC.** `node:20-alpine` bringt keine Zeitzonendaten mit; ein
  gesetztes `TZ` wird ohne `tzdata` stillschweigend ignoriert. `new Date().getHours()`
  liefert dort UTC-Stunden — `LAUF_STUNDE=7` bedeutete dadurch **9 Uhr** deutscher
  Sommerzeit. Betroffen war auch das Tagesdatum: zwischen Mitternacht und 2 Uhr Ortszeit
  ist in UTC noch der Vortag. Zeitpunkte kommen deshalb aus `server/zeit.js`, das die
  Zeitzone ausdrücklich benennt und Node-eigene ICU-Daten nutzt (unabhängig vom
  Betriebssystem). Bitte nicht auf `getHours()` oder `toISOString().slice(0,10)`
  zurückbauen.
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
