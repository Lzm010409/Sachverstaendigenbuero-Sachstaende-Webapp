"use strict";

/*
 * Datenbankschema der Warteschlange.
 *
 * Bis hierher lagen beide Bestände als JSON-Dateien unter DATA_DIR. Das hatte
 * einen Grund (kein zweiter Dienst, ein Volume genügt) und eine harte Folge:
 * Coolify sichert Datenbank-Ressourcen, aber keine Volumes — und ohne
 * eingebundenes Volume war der Bestand nach jedem Deploy ohnehin weg. Eine
 * eigene Postgres macht den Bestand sicherungsfähig und den Serverumzug zu
 * einem einzigen `pg_dump`.
 *
 * Warum Spalten UND ein `daten`-Feld je Fall:
 * Ein Fall ist im Kern ein Abbild dessen, was Pipedrive gerade hergibt — rund
 * vierzig Felder, die sich mit der Fachlogik weiterentwickeln (zuletzt kamen
 * `stageId`/`stageName` für den Phasenfilter dazu). Für jedes davon eine
 * Spalte zu führen hieße: eine Migration für jede Anzeigeänderung. Deshalb
 * steht der vollständige Fall in `daten` (jsonb, maßgeblich), und die Felder,
 * nach denen die Anwendung wirklich sucht, sortiert und aufräumt, stehen
 * zusätzlich als Spalten. Sie werden bei jedem Schreiben aus `daten`
 * abgeleitet und können deshalb nicht auseinanderlaufen.
 */

const { pgTable, text, integer, boolean, jsonb, timestamp, uuid, index, uniqueIndex } =
  require("drizzle-orm/pg-core");

/*
 * Ein Fall der Freigabe-Warteschlange, Schlüssel wie bisher `task-<Aufgaben-ID>`.
 *
 * Der Bestand kannte `cases` als Objekt, nicht als Liste — und enthielt eine
 * eigene Reparaturroutine dafür, weil ein versehentliches Array dazu führte,
 * dass `JSON.stringify` die Fälle stillschweigend verwarf. In einer Tabelle
 * kann dieser Fehler nicht mehr entstehen; die Reparatur bleibt trotzdem im
 * Lesepfad der alten Datei stehen, solange dieser gebraucht wird.
 */
const fall = pgTable(
  "fall",
  {
    id: text().primaryKey(),
    token: text(),
    dealId: integer(),
    aufgabeId: integer(),
    status: text(),
    // "approved" | "skipped" | null — null heißt: wartet auf eine Entscheidung.
    entscheidung: text(),
    entschiedenAm: timestamp({ withTimezone: true }),
    eingereihtAm: timestamp({ withTimezone: true }),
    analysiertAm: timestamp({ withTimezone: true }),
    brauchtEntwurf: boolean().notNull().default(false),
    // Neueste Mail + Anzahl Notizen + Fälligkeit. Entscheidet in mergeCases,
    // ob ein bereits entschiedener Fall erneut vorgelegt wird — die Kernlogik
    // des Sachstands-Trackings.
    fingerabdruck: text(),
    phaseId: integer(),
    phaseName: text(),
    daten: jsonb().notNull(),
    aktualisiertAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Der Lauf sucht bekannte Fälle über das Aktenzeichen (priorByToken).
    index("fall_token_idx").on(t.token),
    // pendingCount und aufraeumen fragen beide über die Entscheidung.
    index("fall_entscheidung_idx").on(t.entscheidung),
    index("fall_entschieden_am_idx").on(t.entschiedenAm),
  ],
);

/*
 * Schritte nach einer Freigabe, die Pipedrive gerade nicht angenommen hat —
 * typisch das aufgebrauchte Tageskontingent. Die Notiz am Deal ist die
 * dauerhafte Spur einer Anfrage; fehlt sie, würde derselbe Fall erneut
 * angefragt. Deshalb ist das eine echte Warteschlange und kein Beiwerk.
 *
 * `reihenfolge` hält die Position aus der bisherigen Liste fest: Die
 * Nacharbeit arbeitet sie der Reihe nach ab, und ohne festen Rang wäre die
 * Reihenfolge nach einem Neustart zufällig.
 */
const nacharbeit = pgTable(
  "nacharbeit",
  {
    id: uuid().primaryKey().defaultRandom(),
    reihenfolge: integer().notNull().default(0),
    fallId: text(),
    dealId: integer(),
    aufgabeId: integer(),
    token: text(),
    notizOffen: boolean().notNull().default(false),
    aufgabeOffen: boolean().notNull().default(false),
    versuche: integer().notNull().default(0),
    naechsterVersuch: timestamp({ withTimezone: true }),
    daten: jsonb().notNull(),
  },
  (t) => [index("nacharbeit_reihenfolge_idx").on(t.reihenfolge)],
);

/*
 * Der Kopf des Zustands: was früher neben `cases` in derselben JSON-Datei
 * stand. Genau eine Zeile, festgenagelt über `id = 1` — ein Kopf ohne
 * eindeutigen Schlüssel wäre bei einem misslungenen Schreibvorgang doppelt
 * vorhanden, und dann wäre nicht mehr entscheidbar, welcher gilt.
 */
const lauf = pgTable("lauf", {
  id: integer().primaryKey().default(1),
  version: integer().notNull().default(1),
  letzterLauf: timestamp({ withTimezone: true }),
  zusammenfassung: jsonb(),
  // Tagesstempel im Format YYYY-MM-DD, in Ortszeit gebildet (server/zeit.js).
  // Bewusst Text und kein Datum: Der Vergleich ist ein Zeichenkettenvergleich
  // gegen zeit.heuteISO(), und eine Umrechnung in UTC würde ihn verschieben.
  laufGemachtAm: text(),
  digestGesendetAm: text(),
});

/*
 * Adressverzeichnis: welche Mailadresse gehört zu welcher Kanzlei?
 *
 * Am Deal steht die Kanzlei als Organisation, aber häufig ohne Adresse; die
 * Adresse ist nur aus der Korrespondenz anderer Fälle derselben Kanzlei
 * bekannt. Der Schlüssel ist deshalb zweierlei Art: `id:<orgId>`, wenn
 * Pipedrive eine Organisations-ID liefert, sonst ersatzweise
 * `name:<kleingeschrieben>`. Beide Arten bleiben erhalten — die Suche fragt
 * absichtlich über beide, weil ein Fall mal nur die eine, mal nur die andere
 * Angabe kennt.
 */
const verzeichnisOrganisation = pgTable("verzeichnis_organisation", {
  schluessel: text().primaryKey(),
  // "id" oder "name" — abgeleitet aus dem Schlüssel, damit sich in SQL
  // erkennen lässt, welcher Teil des Verzeichnisses auf Namen beruht.
  schluesselArt: text().notNull(),
  orgId: integer(),
  orgName: text(),
});

const verzeichnisAdresse = pgTable(
  "verzeichnis_adresse",
  {
    id: uuid().primaryKey().defaultRandom(),
    organisationSchluessel: text()
      .notNull()
      .references(() => verzeichnisOrganisation.schluessel, { onDelete: "cascade" }),
    email: text().notNull(),
    person: text(),
    // Wie oft diese Adresse für diese Organisation beobachtet wurde. Die
    // häufigste gewinnt, bei Gleichstand die zuletzt gesehene.
    anzahl: integer().notNull().default(0),
    zuletztGesehen: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("verzeichnis_adresse_org_idx").on(t.organisationSchluessel),
    uniqueIndex("verzeichnis_adresse_org_email_idx").on(t.organisationSchluessel, t.email),
  ],
);

module.exports = {
  fall,
  nacharbeit,
  lauf,
  verzeichnisOrganisation,
  verzeichnisAdresse,
};
