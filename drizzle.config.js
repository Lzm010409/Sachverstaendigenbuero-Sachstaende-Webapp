/*
 * Einstellungen für drizzle-kit.
 *
 * `casing: "snake_case"` übersetzt die Bezeichner aus dem Schema automatisch:
 * `aufgabeId` wird zu `aufgabe_id`. Im Programm bleibt damit die Schreibweise
 * des Bestands, in der Datenbank die dort übliche.
 *
 * Die Zeichenkette hier dient nur `drizzle-kit push` in der Entwicklung.
 * `drizzle-kit generate` braucht keine laufende Datenbank, und der Container
 * wendet die erzeugten Dateien selbst an (scripts/starten.mjs).
 */
module.exports = {
  schema: "./server/db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://localhost:5432/sachstaende",
  },
  casing: "snake_case",
};
