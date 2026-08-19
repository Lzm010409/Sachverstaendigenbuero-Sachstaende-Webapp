/**
 * Startvorgang des Containers.
 *
 *   1. Datenbankschema anlegen bzw. fortschreiben
 *   2. Den Express-Server starten
 *
 * Bewusst reines JavaScript ohne Werkzeugkette: Im Laufzeit-Abbild liegen nur
 * die Produktionsabhängigkeiten. Verwendet wird ausschließlich `postgres`, das
 * die Anwendung ohnehin mitbringt — drizzle-kit ist eine Entwicklungs-
 * abhängigkeit und im Abbild nicht vorhanden.
 *
 * Der Ablauf ist wiederholbar: Bereits angewandte Migrationen werden
 * übersprungen. Ein zweiter Start ändert also nichts.
 *
 * Der Import des Altbestands läuft hier ABSICHTLICH nicht mit. Ein Import ist
 * ein einmaliger, überwachter Vorgang mit Zählwerten davor und danach; er
 * gehört nicht in einen Startvorgang, der bei jedem Neustart und bei jedem
 * Deploy erneut abläuft. Siehe scripts/import-altbestand.js.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import postgres from "postgres";

const WURZEL = process.cwd();
const MIGRATIONEN = join(WURZEL, "drizzle");

function melde(text) {
  console.log(`[start] ${text}`);
}

async function wendeMigrationenAn(sql) {
  if (!existsSync(MIGRATIONEN)) {
    melde("Kein Migrationsverzeichnis gefunden — übersprungen.");
    return;
  }

  await sql`
    create table if not exists __migrationen (
      name text primary key,
      pruefsumme text not null,
      angewandt_am timestamptz not null default now()
    )
  `;

  const angewandt = new Map(
    (await sql`select name, pruefsumme from __migrationen`).map((z) => [z.name, z.pruefsumme])
  );

  const dateien = readdirSync(MIGRATIONEN)
    .filter((d) => d.endsWith(".sql"))
    .sort();

  for (const datei of dateien) {
    const inhalt = readFileSync(join(MIGRATIONEN, datei), "utf8");
    const pruefsumme = createHash("sha256").update(inhalt).digest("hex").slice(0, 16);

    const bekannt = angewandt.get(datei);
    if (bekannt) {
      if (bekannt !== pruefsumme) {
        // Eine nachträglich geänderte Migration ist ein Fehler in der
        // Entwicklung, kein Zustand, den der Start stillschweigend heilt.
        melde(`WARNUNG: ${datei} wurde nach dem Anwenden verändert.`);
      }
      continue;
    }

    melde(`Migration ${datei} …`);
    // Drizzle trennt Anweisungen mit diesem Marker.
    const anweisungen = inhalt
      .split("--> statement-breakpoint")
      .map((a) => a.trim())
      .filter(Boolean);

    await sql.begin(async (tx) => {
      for (const anweisung of anweisungen) {
        await tx.unsafe(anweisung);
      }
      await tx`insert into __migrationen (name, pruefsumme) values (${datei}, ${pruefsumme})`;
    });
  }

  melde(`Schema aktuell (${dateien.length} Migration${dateien.length === 1 ? "" : "en"}).`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    /*
     * Kein harter Abbruch, sondern eine deutliche Warnung: Der Dateipfad ist
     * noch im Code und trägt den Betrieb notdürftig weiter. Er überlebt aber
     * keinen Deploy, solange kein Volume eingebunden ist — genau der Zustand,
     * den diese Umstellung beendet. Wer die Warnung sieht, hat die
     * Umgebungsvariable vergessen.
     */
    console.warn(
      "[start] WARNUNG: DATABASE_URL fehlt. Die Anwendung läuft auf dem alten " +
        "Dateispeicher unter DATA_DIR — ohne Sicherung und ohne Bestand über einen Deploy hinaus."
    );
  } else {
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    try {
      await wendeMigrationenAn(sql);
    } catch (fehler) {
      console.error("[start] Einrichtung der Datenbank fehlgeschlagen:", fehler);
      process.exit(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  // Der Server liegt im Abbild unter server/index.js. Die Auflösung geht über
  // das Arbeitsverzeichnis und nicht relativ zu diesem Modul, damit der
  // Ablageort des Startskripts frei bleibt.
  const server = join(WURZEL, "server", "index.js");
  if (!existsSync(server)) {
    console.error(`[start] server/index.js nicht gefunden unter ${server}.`);
    process.exit(1);
  }

  melde("Server wird gestartet.");
  await import(pathToFileURL(server).href);
}

main();
