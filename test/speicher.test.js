"use strict";

/*
 * Die Zugriffsschicht gegen eine echte Postgres.
 *
 * Ohne `TEST_DATABASE_URL` werden diese Prüfungen übersprungen statt zu
 * scheitern: Eine Datenbank ist nicht überall vorhanden, und ein Testlauf, der
 * ohne sie rot wird, wird bald gar nicht mehr ausgeführt.
 *
 *   TEST_DATABASE_URL=postgres://…/sachstaende_test npm test
 *
 * Die Datenbank wird vor jedem Test geleert. Sie muss deshalb eine eigene
 * sein — niemals die der Produktion. Das Schema legen die Tests selbst an,
 * über dieselben Migrationsdateien wie der Container.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const WURZEL = join(__dirname, "..");
const ZIEL = process.env.TEST_DATABASE_URL || "";

// Muss VOR dem Laden der Module stehen: server/db liest DATABASE_URL beim Laden.
if (ZIEL) process.env.DATABASE_URL = ZIEL;

const beschreibung = ZIEL
  ? "Speicher gegen Postgres"
  : "Speicher gegen Postgres (übersprungen — TEST_DATABASE_URL nicht gesetzt)";

test(beschreibung, { skip: !ZIEL }, async (t) => {
  const postgres = require("postgres");
  const store = require("../server/store");
  const directory = require("../server/directory");
  const datenbank = require("../server/db");

  const sql = postgres(ZIEL, { max: 2, onnotice: () => {} });

  async function schemaAnlegen() {
    const verzeichnis = join(WURZEL, "drizzle");
    if (!existsSync(verzeichnis)) throw new Error("drizzle/ fehlt — erst `npm run db:generate`.");
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
    for (const datei of readdirSync(verzeichnis).filter(d => d.endsWith(".sql")).sort()) {
      const inhalt = readFileSync(join(verzeichnis, datei), "utf8");
      for (const anweisung of inhalt.split("--> statement-breakpoint").map(a => a.trim()).filter(Boolean)) {
        await sql.unsafe(anweisung);
      }
    }
  }

  t.after(async () => {
    await datenbank.schliessen();
    await sql.end({ timeout: 5 });
  });

  const beispielFall = (id, extra = {}) => ({
    id, taskId: Number(id.replace(/\D/g, "")) || 1, dealId: 311, token: `0126/${id}TG`,
    name: "Muster", status: "faellig", needsDraft: true, draft: "Guten Tag,\n\n…",
    due: "2026-08-01", fingerprint: "a|1|2|2026-08-01",
    analyzedAt: "2026-08-18T06:00:00.000Z", queuedAt: "2026-08-18T06:00:00.000Z",
    decision: null, decidedAt: null,
    thread: [{ time: "2026-08-01T10:00:00.000Z", body: "Text mit Umlauten: äöüß" }],
    ...extra
  });

  await t.test("leere Datenbank ergibt den leeren Zustand", async () => {
    await schemaAnlegen();
    const state = await store.load();
    assert.deepEqual(state.cases, {});
    assert.deepEqual(state.offeneNacharbeiten, []);
    assert.equal(state.lastRun, null);
    assert.equal(state.version, 1);
  });

  await t.test("ein Fall überlebt Schreiben und Lesen unverändert", async () => {
    await schemaAnlegen();
    const state = store.emptyState();
    state.cases["task-1"] = beispielFall("task-1");
    state.lastRun = "2026-08-18T05:00:00.000Z";
    state.lastRunSummary = { analyzed: 1, stufen: { aussortiert: 0 } };
    state.laufGemachtAm = "2026-08-18";
    await store.save(state);

    const gelesen = await store.load();
    assert.deepEqual(gelesen.cases["task-1"], state.cases["task-1"]);
    assert.equal(gelesen.lastRun, "2026-08-18T05:00:00.000Z");
    assert.deepEqual(gelesen.lastRunSummary, { analyzed: 1, stufen: { aussortiert: 0 } });
    assert.equal(gelesen.laufGemachtAm, "2026-08-18");
  });

  await t.test("die abgeleiteten Spalten stimmen mit den Daten überein", async () => {
    await schemaAnlegen();
    const state = store.emptyState();
    state.cases["task-7"] = beispielFall("task-7", {
      decision: "approved", decidedAt: "2026-08-18T09:00:00.000Z",
      stageId: 8, stageName: "Versendet", needsDraft: true
    });
    await store.save(state);
    const [z] = await sql`select * from fall where id = 'task-7'`;
    assert.equal(z.token, "0126/task-7TG");
    assert.equal(z.deal_id, 311);
    assert.equal(z.aufgabe_id, 7);
    assert.equal(z.entscheidung, "approved");
    assert.equal(z.braucht_entwurf, true);
    assert.equal(z.phase_id, 8);
    assert.equal(z.phase_name, "Versendet");
    assert.equal(z.daten.id, "task-7");
  });

  await t.test("save entfernt, was nicht mehr im Zustand steht", async () => {
    await schemaAnlegen();
    const state = store.emptyState();
    state.cases["task-1"] = beispielFall("task-1");
    state.cases["task-2"] = beispielFall("task-2");
    await store.save(state);
    assert.equal((await store.load()) && Object.keys((await store.load()).cases).length, 2);

    // Genau das macht aufraeumen und der Phasenfilter: ein Fall verschwindet
    // aus dem Zustand und muss dann auch aus der Tabelle verschwinden.
    delete state.cases["task-2"];
    await store.save(state);
    const nachher = await store.load();
    assert.deepEqual(Object.keys(nachher.cases), ["task-1"]);
  });

  await t.test("zweimal speichern erzeugt keine zweite Zeile", async () => {
    await schemaAnlegen();
    const state = store.emptyState();
    state.cases["task-1"] = beispielFall("task-1");
    state.offeneNacharbeiten = [{
      caseId: "task-1", dealId: 311, taskId: 1, token: "0126/1TG",
      notizHtml: "<b>Notiz</b>", aufgabeOffen: true, versuche: 2,
      seit: "2026-08-18T06:00:00.000Z", naechsterVersuch: "2026-08-18T07:00:00.000Z"
    }];
    await store.save(state);
    await store.save(state);
    const [{ count: faelle }] = await sql`select count(*)::int as count from fall`;
    const [{ count: nach }] = await sql`select count(*)::int as count from nacharbeit`;
    const [{ count: koepfe }] = await sql`select count(*)::int as count from lauf`;
    assert.equal(faelle, 1);
    assert.equal(nach, 1);
    assert.equal(koepfe, 1);
  });

  await t.test("die Reihenfolge der Nacharbeiten bleibt erhalten", async () => {
    await schemaAnlegen();
    const state = store.emptyState();
    state.offeneNacharbeiten = ["a", "b", "c"].map((t2, i) => ({
      caseId: `task-${i}`, dealId: 300 + i, taskId: i, token: t2,
      notizHtml: `<p>${t2}</p>`, aufgabeOffen: false, versuche: 0
    }));
    await store.save(state);
    const gelesen = await store.load();
    assert.deepEqual(gelesen.offeneNacharbeiten.map(n => n.token), ["a", "b", "c"]);
  });

  await t.test("das Verzeichnis überlebt Schreiben und Lesen", async () => {
    await schemaAnlegen();
    const dir = { orgs: {} };
    directory.learn(dir, {
      orgId: 42, orgName: "Kanzlei Müller", email: "Kanzlei@Example.DE",
      person: "RA Müller", seenAt: "2026-08-18T06:00:00.000Z"
    });
    directory.learn(dir, {
      orgId: 42, orgName: "Kanzlei Müller", email: "Kanzlei@Example.DE",
      person: null, seenAt: "2026-08-18T08:00:00.000Z"
    });
    directory.learn(dir, {
      orgId: null, orgName: "Kanzlei Schmidt", email: "info@schmidt.de",
      person: null, seenAt: "2026-08-17T06:00:00.000Z"
    });
    await directory.save(dir);

    const gelesen = await directory.load();
    assert.deepEqual(Object.keys(gelesen.orgs).sort(), ["id:42", "name:kanzlei schmidt"]);
    const eintrag = gelesen.orgs["id:42"];
    assert.equal(eintrag.orgName, "Kanzlei Müller");
    assert.deepEqual(eintrag.addresses["kanzlei@example.de"], {
      count: 2, person: "RA Müller", lastSeen: "2026-08-18T08:00:00.000Z"
    });
    // Beide Schlüsselarten müssen erhalten bleiben — die Suche fragt über beide.
    const [{ arten }] = await sql`select array_agg(distinct schluessel_art order by schluessel_art) as arten
                                  from verzeichnis_organisation`;
    assert.deepEqual(arten, ["id", "name"]);
    assert.deepEqual(directory.lookup(gelesen, { orgId: 42, orgName: "Kanzlei Müller" }),
      { email: "kanzlei@example.de", person: "RA Müller" });
  });

  await t.test("eine gelöschte Organisation nimmt ihre Adressen mit", async () => {
    await schemaAnlegen();
    const dir = { orgs: {} };
    directory.learn(dir, { orgId: 1, orgName: "A", email: "a@a.de", seenAt: "2026-08-18T06:00:00.000Z" });
    directory.learn(dir, { orgId: 2, orgName: "B", email: "b@b.de", seenAt: "2026-08-18T06:00:00.000Z" });
    await directory.save(dir);
    delete dir.orgs["id:2"];
    await directory.save(dir);
    const [{ count }] = await sql`select count(*)::int as count from verzeichnis_adresse`;
    assert.equal(count, 1);
  });

  await t.test("mergeCases arbeitet auf dem Zustand wie zuvor", async () => {
    // Die Kernlogik des Sachstands-Trackings darf der Speicherwechsel nicht
    // berührt haben: gleicher Fingerabdruck → Entscheidung bleibt, neuer
    // Fingerabdruck mit Entwurfsbedarf → der Fall wird erneut vorgelegt.
    await schemaAnlegen();
    const state = store.emptyState();
    state.cases["task-1"] = beispielFall("task-1", {
      decision: "approved", decidedAt: new Date().toISOString(),
      outlookDraft: { id: "AAA" }
    });
    await store.save(state);

    let geladen = await store.load();
    store.mergeCases(geladen, [beispielFall("task-1")]);       // gleicher Fingerabdruck
    assert.equal(geladen.cases["task-1"].decision, "approved");
    assert.deepEqual(geladen.cases["task-1"].outlookDraft, { id: "AAA" });
    await store.save(geladen);

    geladen = await store.load();
    store.mergeCases(geladen, [beispielFall("task-1", { fingerprint: "NEU" })]);
    assert.equal(geladen.cases["task-1"].decision, null);
    assert.equal(geladen.cases["task-1"].reopenedFrom, "approved");
  });
});

/*
 * Eigener Testblock: Zeichen, die Postgres nicht speichern kann.
 *
 * Der Anlass ist ein echter Befund beim Umstieg — ein Nullbyte in einem
 * Mailtext ließ `save()` scheitern und hätte damit einen ganzen Lauf samt
 * aller Freigaben abgebrochen. In der JSON-Datei war das nie aufgefallen.
 */
test(ZIEL ? "unzulässige Zeichen" : "unzulässige Zeichen (übersprungen)", { skip: !ZIEL }, async (t) => {
  const postgres = require("postgres");
  const store = require("../server/store");
  const datenbank = require("../server/db");
  const sql = postgres(ZIEL, { max: 2, onnotice: () => {} });

  t.after(async () => {
    await datenbank.schliessen();
    await sql.end({ timeout: 5 });
  });

  await t.test("Nullbyte und einzelne Ersatzstelle brechen das Speichern nicht", async () => {
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
    for (const datei of readdirSync(join(WURZEL, "drizzle")).filter(d => d.endsWith(".sql")).sort()) {
      for (const a of readFileSync(join(WURZEL, "drizzle", datei), "utf8")
        .split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean)) await sql.unsafe(a);
    }

    const state = store.emptyState();
    state.cases["task-1"] = {
      id: "task-1", token: "0126/1TG",
      thread: [
        { body: "vor" + String.fromCharCode(0) + "nach" },
        { body: "a" + String.fromCharCode(0xd800) + "b" },
        { body: "gültig: äöüß \u{1F600}" }
      ]
    };
    await store.save(state);
    const zurueck = await store.load();
    const texte = zurueck.cases["task-1"].thread.map(m => m.body);
    assert.equal(texte[0], "vornach", "das Nullbyte wird entfernt");
    assert.equal(texte[1], "a�b", "die einzelne Ersatzstelle wird ersetzt");
    assert.equal(texte[2], "gültig: äöüß \u{1F600}", "gültiger Text bleibt unangetastet");
  });

  await t.test("textBereinigen lässt gültigen Text unverändert", () => {
    const gut = "Kanzlei Müller & Partner \u{1F600} — Az. 0126/1TG\nZeile 2\tTab";
    assert.equal(store.textBereinigen(gut), gut);
  });
});
