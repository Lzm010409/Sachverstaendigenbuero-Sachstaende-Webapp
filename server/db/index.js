"use strict";

/*
 * Verbindung zur Datenbank.
 *
 * Eine einzige Stelle, an der `DATABASE_URL` gelesen wird. Der interne
 * Hostname einer Coolify-Standalone-Datenbank ist ihre UUID und damit von der
 * Umgebung abhängig — die Zeichenkette gehört deshalb in die Coolify-Env und
 * niemals in den Quelltext.
 *
 * `istEingerichtet()` statt eines harten Abbruchs beim Laden: Der Dateipfad
 * bleibt vorerst bestehen (siehe server/store.js), und der Demo-Modus sowie
 * die Tests laufen ohne Datenbank. Wer den Dienst produktiv ohne
 * `DATABASE_URL` startet, bekommt beim Start eine deutliche Warnung.
 */

const { drizzle } = require("drizzle-orm/postgres-js");
const postgres = require("postgres");
const schema = require("./schema");

const URL = process.env.DATABASE_URL || "";

let client = null;
let datenbank = null;

function istEingerichtet() {
  return Boolean(URL);
}

/**
 * Der Verbindungspool, beim ersten Zugriff aufgebaut.
 *
 * Bewusst klein: Der Dienst ist einspurig — ein Hintergrundlauf und ein
 * Benutzer. Ein großer Pool brächte nichts und belegte in der Datenbank nur
 * Verbindungen, die nie gebraucht werden.
 */
function db() {
  if (!istEingerichtet()) {
    throw new Error(
      "DATABASE_URL fehlt. In Coolify als Umgebungsvariable der Anwendung hinterlegen; " +
        "der Hostname der Standalone-Datenbank ist ihre UUID."
    );
  }
  if (!datenbank) {
    client = postgres(URL, { max: 5, onnotice: () => {} });
    datenbank = drizzle(client, { schema, casing: "snake_case" });
  }
  return datenbank;
}

/** Verbindungen schließen — für Tests und einen geordneten Abbruch. */
async function schliessen() {
  if (!client) return;
  const alt = client;
  client = null;
  datenbank = null;
  await alt.end({ timeout: 5 });
}

module.exports = { db, schema, istEingerichtet, schliessen, URL };
