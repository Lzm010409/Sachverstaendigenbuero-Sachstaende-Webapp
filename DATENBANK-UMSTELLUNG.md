# Umstellung auf eine eigene Postgres-Datenbank

Diese Anleitung beschreibt, **wie die Umstellung ausgerollt wird** — welche Ressource in
Coolify anzulegen ist, welche Umgebungsvariablen zu setzen sind, in welcher Reihenfolge
deployed wird, wie der Import läuft und wie man zurückkommt.

Technischer Hintergrund: **[ARCHITEKTUR.md](ARCHITEKTUR.md)**, Abschnitt „Speicher".

---

## 1. Warum

Der Bestand lag bisher in zwei JSON-Dateien unter `DATA_DIR`:

| Datei | Inhalt |
|---|---|
| `queue.json` | Freigabe-Warteschlange, Nacharbeiten, Zeitstempel des letzten Laufs |
| `directory.json` | gelernte Mailadressen je Kanzlei |

Drei Gründe sprechen dagegen:

1. **Coolify sichert keine Volumes.** Gesichert werden Datenbank-Ressourcen. Für Dateien
   in einem Volume oder auf einem Hostpfad gibt es kein Backup.
2. **In dieser Anwendung war ohnehin kein Volume eingebunden** (siehe `STATUS.md`). Der
   Bestand war also bei jedem Deploy weg. Verkraftbar war das nur, weil Pipedrive die
   Wahrheit hält und Freigaben über die Notiz am Deal erkannt werden — ein Zustand, auf
   den man sich nicht verlassen sollte.
3. **Der Serverumzug** ist mit einem `pg_dump` ein Vorgang statt dreier.

---

## 2. Was in Coolify anzulegen ist

### 2.1 Die Datenbank

Projekt der Anwendung → **+ New** → **Database** → **PostgreSQL**.

- Sie bekommt eine eigene UUID. **Der interne Hostname ist genau diese UUID.**
- Sie muss im selben **Destination-Netz** liegen wie die Anwendung (in aller Regel
  `coolify`). Andernfalls scheitert die Namensauflösung mit `EAI_AGAIN`.
- Datenbankname, Benutzer und Passwort vergibt Coolify; sie lassen sich beim Anlegen
  ändern. Vorschlag: Benutzer und Datenbank jeweils `sachstaende`.
- **Backups** am Datenbank-Objekt einschalten. Das ist der ganze Zweck dieser Umstellung.

### 2.2 Die Umgebungsvariable der Anwendung

Anwendung → **Environment Variables** → neu:

```
DATABASE_URL = postgresql://sachstaende:<passwort>@<uuid-der-datenbank>:5432/sachstaende
```

Das Passwort steht in der Datenbank-Ressource unter *Configuration*. Es gehört **nicht**
ins Repository — weder in `.env.example` noch in eine Compose-Datei.

Optional, jeweils mit brauchbarer Voreinstellung:

| Variable | Voreinstellung | Bedeutung |
|---|---|---|
| `DATA_DIR` | `/data` | Nur noch für den Import des Altbestands nötig |

### 2.3 Ein Volume — nur, wenn eines existiert

Wenn ein Volume mit den alten JSON-Dateien vorhanden ist, muss es für den Import noch
einmal eingehängt sein. Ist keines vorhanden, ist auch nichts zu importieren; das ist
der erwartete Fall.

---

## 3. Reihenfolge des Ausrollens

1. **Datenbank anlegen** (Abschnitt 2.1), Zustand abwarten bis *running*.
2. **`DATABASE_URL` an der Anwendung setzen** (Abschnitt 2.2). Noch nicht deployen.
3. **Deployen.** Der Container legt beim Start das Schema selbst an — `starten.mjs`
   wendet die Dateien aus `drizzle/` an, bevor der Server lauscht. Ein zweiter Start
   ändert nichts; bereits angewandte Migrationen werden übersprungen.
4. **Prüfen:** `GET /api/health` muss `"speicher": "postgres"` und
   `eingerichtet.datenbank: true` melden. Steht dort `"datei"`, ist `DATABASE_URL` nicht
   im Container angekommen.
5. **Import** — nur wenn ein Altbestand existiert (Abschnitt 4).
6. **Fachlich prüfen:** Die Liste im Cockpit füllt sich beim nächsten Lauf ohnehin neu
   aus Pipedrive. Eine Freigabe durchführen und danach `⟳` drücken — der Fall muss als
   „Freigegeben" stehen bleiben.

Im Protokoll des Containers steht nach einem gelungenen Start:

```
[start] Schema aktuell (1 Migration).
[start] Server wird gestartet.
```

Fehlt `DATABASE_URL`, steht dort stattdessen eine Warnung, und die Anwendung läuft
weiter auf dem Dateispeicher. Das ist Absicht: ein vergessener Eintrag soll den Dienst
nicht ausfallen lassen, aber auch nicht unbemerkt bleiben.

---

## 4. Import des Altbestands

Der Import läuft **nicht** beim Start mit. Er ist ein einmaliger, überwachter Vorgang.

Im Container (Coolify → Anwendung → *Terminal*):

```bash
# 1. Erst ansehen, was passieren würde. Schreibt nichts.
node scripts/import-altbestand.js --trockenlauf

# 2. Wenn die Zählwerte stimmen: übernehmen.
node scripts/import-altbestand.js
```

Der Importer gibt vorher und nachher die Zählwerte je Tabelle aus und bricht ab, wenn
sie nicht zusammenpassen.

**Er ist wiederholbar.** Ein zweiter Lauf legt nichts doppelt an:

- Fälle werden über ihre ID angelegt; vorhandene bleiben unangetastet.
- Nacharbeiten werden nur übernommen, wenn die Tabelle leer ist. Eine doppelte
  Nacharbeit hieße eine zweite Notiz am selben Deal.
- Verzeichniseinträge werden über Schlüssel und Adresse zusammengeführt; beim
  Zählerstand gewinnt der höhere Wert.

Mit `--ueberschreiben` werden vorhandene Zeilen ausdrücklich durch den Dateistand
ersetzt. Das ist nur sinnvoll, wenn der Import wiederholt wird, **bevor** die Anwendung
in die Datenbank geschrieben hat — sonst gehen neuere Entscheidungen verloren.

Nach erfolgreichem Import kann das Volume abgehängt werden. Der Lesepfad auf die
Dateien bleibt vorerst im Code; sein Ausbau ist ein eigener, späterer Pull Request.

---

## 5. Zurück auf den alten Stand

Der Rückweg ist absichtlich einfach gehalten, weil der Lesepfad auf die Dateien noch
vorhanden ist.

**Sofort, ohne Deploy:** `DATABASE_URL` an der Anwendung löschen und neu starten. Die
Anwendung greift wieder auf `DATA_DIR` zu. Was seit der Umstellung entschieden wurde,
steht dann nur noch in der Datenbank — und in Pipedrive, wo die Notiz am Deal die
Freigabe ohnehin festhält. Der nächste Lauf baut die Liste neu auf.

**Vollständig:** Den Commit dieses Pull Requests zurücknehmen und deployen. Die
Datenbank kann stehen bleiben; sie stört nicht.

**Sicherung ziehen, bevor irgendetwas zurückgedreht wird:**

```bash
pg_dump "postgresql://sachstaende:<passwort>@<uuid>:5432/sachstaende" > sachstaende.sql
```

---

## 6. Entwicklung auf dem eigenen Rechner

```bash
# Ohne Datenbank: die Anwendung läuft weiter auf JSON-Dateien unter ./data
npm run dev

# Mit Datenbank
export DATABASE_URL=postgres://localhost:5432/sachstaende
npm start                    # legt das Schema beim Start selbst an

# Schema geändert? Migration erzeugen (keine laufende Datenbank nötig)
npm run db:generate

# Tests. Ohne TEST_DATABASE_URL werden die Datenbankprüfungen übersprungen.
npm test
TEST_DATABASE_URL=postgres://localhost:5432/sachstaende_test npm test
```

`TEST_DATABASE_URL` muss auf eine **eigene** Datenbank zeigen: Die Tests legen das
Schema `public` vor jeder Prüfung neu an.

---

## 7. Das Schema

| Tabelle | Inhalt |
|---|---|
| `fall` | ein Fall der Warteschlange, Schlüssel `task-<Aufgaben-ID>` |
| `nacharbeit` | Notizen und Aufgabenabschlüsse, die Pipedrive abgelehnt hat |
| `lauf` | genau eine Zeile: letzter Lauf, Zusammenfassung, Tagesstempel |
| `verzeichnis_organisation` | Kanzlei bzw. Versicherung, Schlüssel `id:<n>` oder `name:<…>` |
| `verzeichnis_adresse` | gelernte Mailadressen dazu, per Fremdschlüssel angehängt |
| `__migrationen` | welche Migrationsdatei wann angewandt wurde (legt `starten.mjs` an) |

Ein Fall steht vollständig in der Spalte `daten` (`jsonb`); die übrigen Spalten sind
daraus abgeleitet und dienen Indizes und Auswertungen. Der Grund steht in
`server/db/schema.js`.

Nützliche Abfragen:

```sql
-- Was wartet auf eine Entscheidung?
select token, status, phase_name, eingereiht_am
from fall where entscheidung is null and braucht_entwurf order by eingereiht_am;

-- Was hängt in der Nacharbeit fest?
select token, notiz_offen, aufgabe_offen, versuche, naechster_versuch
from nacharbeit order by reihenfolge;

-- Welche Adresse hat die Anwendung zu einer Kanzlei gelernt?
select o.org_name, a.email, a.anzahl, a.zuletzt_gesehen
from verzeichnis_adresse a join verzeichnis_organisation o
  on o.schluessel = a.organisation_schluessel
order by o.org_name, a.anzahl desc;
```
