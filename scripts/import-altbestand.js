#!/usr/bin/env node
"use strict";

/*
 * Übernimmt den Altbestand aus den JSON-Dateien unter DATA_DIR in die
 * Datenbank: queue.json (Warteschlange) und directory.json (Adressverzeichnis).
 *
 * Aufruf:
 *   node scripts/import-altbestand.js --trockenlauf
 *   node scripts/import-altbestand.js
 *
 * Läuft NICHT beim Start des Containers mit. Ein Import ist ein einmaliger,
 * überwachter Vorgang; ein Startvorgang läuft bei jedem Deploy erneut ab.
 *
 * Wiederholbar: Der Import legt Fälle und Verzeichniseinträge über ihren
 * fachlichen Schlüssel an (Fall-ID, Verzeichnis-Schlüssel + Adresse). Ein
 * zweiter Lauf schreibt dieselben Zeilen erneut und erzeugt keine Dubletten.
 *
 * Was er bewusst NICHT tut: bereits vorhandene Zeilen überschreiben. Die
 * Anwendung schreibt ab dem ersten Deploy in die Datenbank; wäre der Import
 * überschreibend, würde ein versehentlicher zweiter Lauf neuere Entscheidungen
 * durch den alten Dateistand ersetzen. Mit `--ueberschreiben` lässt sich das
 * ausdrücklich verlangen.
 */

const store = require("../server/store");
const directory = require("../server/directory");
const datenbank = require("../server/db");
const schema = require("../server/db/schema");
const { sql, inArray } = require("drizzle-orm");

const argumente = process.argv.slice(2);
const TROCKEN = argumente.includes("--trockenlauf");
const UEBERSCHREIBEN = argumente.includes("--ueberschreiben");

function melde(text) { console.log(`[import] ${text}`); }

async function zaehle(db) {
  const [f, n, l, vo, va] = await Promise.all([
    db.select({ n: sql`count(*)::int` }).from(schema.fall),
    db.select({ n: sql`count(*)::int` }).from(schema.nacharbeit),
    db.select({ n: sql`count(*)::int` }).from(schema.lauf),
    db.select({ n: sql`count(*)::int` }).from(schema.verzeichnisOrganisation),
    db.select({ n: sql`count(*)::int` }).from(schema.verzeichnisAdresse)
  ]);
  return {
    fall: f[0].n, nacharbeit: n[0].n, lauf: l[0].n,
    verzeichnis_organisation: vo[0].n, verzeichnis_adresse: va[0].n
  };
}

function tabelle(titel, werte) {
  melde(titel);
  for (const [name, wert] of Object.entries(werte)) {
    console.log(`         ${name.padEnd(26)} ${String(wert).padStart(6)}`);
  }
}

async function main() {
  if (!datenbank.istEingerichtet()) {
    console.error("[import] DATABASE_URL fehlt. Ohne Ziel gibt es nichts zu importieren.");
    process.exit(1);
  }
  const db = datenbank.db();

  // --- Altbestand lesen -----------------------------------------------------
  const alt = store.ausDatei();
  const altVerzeichnis = directory.ausDatei();
  const faelle = Object.values(alt.cases || {}).filter(c => c && c.id);
  const nacharbeiten = (alt.offeneNacharbeiten || []).filter(Boolean);
  const orgs = Object.entries((altVerzeichnis && altVerzeichnis.orgs) || {});
  const adressenGesamt = orgs.reduce((s, [, e]) => s + Object.keys((e && e.addresses) || {}).length, 0);

  tabelle(`Altbestand aus ${store.FILE} und ${directory.FILE}:`, {
    faelle: faelle.length,
    nacharbeiten: nacharbeiten.length,
    "kopf (lastRun)": alt.lastRun ? 1 : 0,
    verzeichnis_organisationen: orgs.length,
    verzeichnis_adressen: adressenGesamt
  });

  if (!faelle.length && !nacharbeiten.length && !orgs.length && !alt.lastRun) {
    melde("Nichts zu übernehmen — die Dateien sind leer oder nicht vorhanden.");
    melde("Das ist der erwartete Fall, wenn in Coolify nie ein Volume eingebunden war.");
    await datenbank.schliessen();
    return;
  }

  const vorher = await zaehle(db);
  tabelle("Zählwerte in der Datenbank VORHER:", vorher);

  // --- Was würde neu angelegt? ---------------------------------------------
  const vorhandeneIds = faelle.length
    ? new Set((await db.select({ id: schema.fall.id }).from(schema.fall)
        .where(inArray(schema.fall.id, faelle.map(c => c.id)))).map(z => z.id))
    : new Set();
  const neueFaelle = faelle.filter(c => !vorhandeneIds.has(c.id));
  const bekannteFaelle = faelle.length - neueFaelle.length;

  melde(`Fälle: ${neueFaelle.length} neu, ${bekannteFaelle} bereits vorhanden`
    + (bekannteFaelle && !UEBERSCHREIBEN ? " (werden übersprungen)" : "")
    + (bekannteFaelle && UEBERSCHREIBEN ? " (werden überschrieben)" : ""));

  if (TROCKEN) {
    melde("Trockenlauf — es wurde nichts geschrieben.");
    tabelle("Zählwerte NACHHER wären:", {
      ...vorher,
      fall: vorher.fall + neueFaelle.length,
      nacharbeit: nacharbeiten.length ? nacharbeiten.length : vorher.nacharbeit,
      lauf: Math.max(vorher.lauf, alt.lastRun ? 1 : 0),
      verzeichnis_organisation: Math.max(vorher.verzeichnis_organisation, orgs.length),
      verzeichnis_adresse: Math.max(vorher.verzeichnis_adresse, adressenGesamt)
    });
    await datenbank.schliessen();
    return;
  }

  // --- Schreiben ------------------------------------------------------------
  await db.transaction(async (tx) => {
    const zuSchreiben = UEBERSCHREIBEN ? faelle : neueFaelle;
    for (let i = 0; i < zuSchreiben.length; i += 200) {
      const block = zuSchreiben.slice(i, i + 200).map(store.fallZuZeile);
      const einfuegen = tx.insert(schema.fall).values(block);
      await (UEBERSCHREIBEN
        ? einfuegen.onConflictDoUpdate({
            target: schema.fall.id,
            set: {
              token: sql`excluded."token"`, dealId: sql`excluded."deal_id"`,
              aufgabeId: sql`excluded."aufgabe_id"`, status: sql`excluded."status"`,
              entscheidung: sql`excluded."entscheidung"`, entschiedenAm: sql`excluded."entschieden_am"`,
              eingereihtAm: sql`excluded."eingereiht_am"`, analysiertAm: sql`excluded."analysiert_am"`,
              brauchtEntwurf: sql`excluded."braucht_entwurf"`, fingerabdruck: sql`excluded."fingerabdruck"`,
              phaseId: sql`excluded."phase_id"`, phaseName: sql`excluded."phase_name"`,
              daten: sql`excluded."daten"`, aktualisiertAm: sql`excluded."aktualisiert_am"`
            }
          })
        : einfuegen.onConflictDoNothing({ target: schema.fall.id }));
    }

    /*
     * Nacharbeiten haben keinen fachlichen Schlüssel. Sie werden nur
     * übernommen, wenn die Tabelle leer ist — sonst entstünden bei einem
     * zweiten Lauf Dubletten, und eine doppelte Nacharbeit hieße: eine zweite
     * Notiz am selben Deal. Steht dort schon etwas, hat die Anwendung
     * inzwischen selbst geschrieben und ist die neuere Quelle.
     */
    const vorhandeneNacharbeiten = (await tx.select({ n: sql`count(*)::int` }).from(schema.nacharbeit))[0].n;
    if (nacharbeiten.length && vorhandeneNacharbeiten === 0) {
      await tx.insert(schema.nacharbeit).values(nacharbeiten.map(store.nacharbeitZuZeile));
    } else if (nacharbeiten.length) {
      melde(`${nacharbeiten.length} Nacharbeit(en) NICHT übernommen — die Tabelle ist nicht leer.`);
    }

    // Der Kopf: nur anlegen, nicht überschreiben. Ein neuerer Lauf in der
    // Datenbank darf nicht durch einen älteren Dateistand zurückgesetzt werden.
    const kopfZeile = {
      id: 1,
      version: alt.version || 1,
      letzterLauf: alt.lastRun && Number.isFinite(Date.parse(alt.lastRun)) ? new Date(alt.lastRun) : null,
      zusammenfassung: alt.lastRunSummary || null,
      laufGemachtAm: alt.laufGemachtAm || null,
      digestGesendetAm: alt.digestGesendetAm || null
    };
    const kopfEinfuegen = tx.insert(schema.lauf).values(kopfZeile);
    await (UEBERSCHREIBEN
      ? kopfEinfuegen.onConflictDoUpdate({
          target: schema.lauf.id,
          set: {
            version: sql`excluded."version"`, letzterLauf: sql`excluded."letzter_lauf"`,
            zusammenfassung: sql`excluded."zusammenfassung"`,
            laufGemachtAm: sql`excluded."lauf_gemacht_am"`,
            digestGesendetAm: sql`excluded."digest_gesendet_am"`
          }
        })
      : kopfEinfuegen.onConflictDoNothing({ target: schema.lauf.id }));

    // --- Verzeichnis --------------------------------------------------------
    for (const [schluessel, eintrag] of orgs) {
      if (!schluessel || !eintrag) continue;
      const teile = schluessel.split(":");
      const art = teile[0] === "id" ? "id" : "name";
      const rest = teile.slice(1).join(":");
      await tx.insert(schema.verzeichnisOrganisation).values({
        schluessel, schluesselArt: art,
        orgId: art === "id" && /^\d+$/.test(rest) ? Number(rest) : null,
        orgName: eintrag.orgName || null
      }).onConflictDoUpdate({
        target: schema.verzeichnisOrganisation.schluessel,
        set: { orgName: sql`coalesce(excluded."org_name", "verzeichnis_organisation"."org_name")` }
      });

      for (const [email, a] of Object.entries(eintrag.addresses || {})) {
        if (!email) continue;
        await tx.insert(schema.verzeichnisAdresse).values({
          organisationSchluessel: schluessel,
          email,
          person: (a && a.person) || null,
          anzahl: (a && Number(a.count)) || 0,
          zuletztGesehen: a && a.lastSeen && Number.isFinite(Date.parse(a.lastSeen)) ? new Date(a.lastSeen) : null
        }).onConflictDoUpdate({
          // Beobachtungen sind Zählwerte. Beim erneuten Import gewinnt der
          // höhere Zählerstand, damit ein zweiter Lauf weder addiert noch
          // gelerntes Wissen zurücksetzt.
          target: [schema.verzeichnisAdresse.organisationSchluessel, schema.verzeichnisAdresse.email],
          set: {
            anzahl: sql`greatest(excluded."anzahl", "verzeichnis_adresse"."anzahl")`,
            person: sql`coalesce("verzeichnis_adresse"."person", excluded."person")`,
            zuletztGesehen: sql`greatest(excluded."zuletzt_gesehen", "verzeichnis_adresse"."zuletzt_gesehen")`
          }
        });
      }
    }
  });

  const nachher = await zaehle(db);
  tabelle("Zählwerte in der Datenbank NACHHER:", nachher);

  // Auch `--ueberschreiben` legt keine Zeilen zusätzlich an, es aktualisiert nur.
  const erwartet = vorher.fall + neueFaelle.length;
  if (nachher.fall !== erwartet) {
    console.error(`[import] FEHLER: ${erwartet} Fälle erwartet, ${nachher.fall} gezählt.`);
    await datenbank.schliessen();
    process.exit(1);
  }
  melde("Fertig. Zählwerte stimmen überein.");
  await datenbank.schliessen();
}

main().catch(async (err) => {
  console.error("[import] fehlgeschlagen:", err);
  await datenbank.schliessen().catch(() => {});
  process.exit(1);
});
