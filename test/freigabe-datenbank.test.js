"use strict";

/*
 * Ende zu Ende gegen Postgres: Eine Freigabe über die HTTP-Schnittstelle muss
 * in der Datenbank landen — und dort auch nach dem nächsten Laden noch stehen.
 *
 * Der Speicherwechsel betrifft genau diesen Weg: `load` und `save` sind
 * asynchron geworden, und jede Route musste das nachziehen. Ein vergessenes
 * `await` fällt in der Unit-Prüfung der Zugriffsschicht NICHT auf, wohl aber
 * hier — die Entscheidung wäre dann nicht gespeichert.
 *
 * Pipedrive und Microsoft Graph sind ersetzt. Der Test schreibt nichts nach
 * außen und braucht keine Zugangsdaten.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

const WURZEL = join(__dirname, "..");
const ZIEL = process.env.TEST_DATABASE_URL || "";

test(ZIEL ? "Freigabe gegen Postgres" : "Freigabe gegen Postgres (übersprungen)", { skip: !ZIEL }, async (t) => {
  // Alles vor dem Laden der Anwendung: server/db und server/store lesen ihre
  // Umgebung beim Laden.
  process.env.DATABASE_URL = ZIEL;
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "e2e-"));
  process.env.DEMO_MODE = "false";
  process.env.PORT = "39168";
  process.env.PIPEDRIVE_API_TOKEN = "dummy";
  delete process.env.MS_TENANT_ID;
  delete process.env.BASIC_AUTH_USER;

  const postgres = require("postgres");
  const store = require("../server/store");
  const datenbank = require("../server/db");
  const pd = require("../server/pipedrive");
  const graph = require("../server/graph");
  const worker = require("../server/worker");

  const sql = postgres(ZIEL, { max: 2, onnotice: () => {} });
  await sql`drop schema if exists public cascade`;
  await sql`create schema public`;
  for (const datei of readdirSync(join(WURZEL, "drizzle")).filter(d => d.endsWith(".sql")).sort()) {
    for (const a of readFileSync(join(WURZEL, "drizzle", datei), "utf8")
      .split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean)) {
      await sql.unsafe(a);
    }
  }

  // Kein Hintergrundlauf und keine echten Fremdsysteme.
  worker.start = () => {};
  pd.getOpenTasks = async () => [];
  const notizen = [];
  pd.addNote = async (deal, html) => { notizen.push({ deal, html }); return { id: 1 }; };
  pd.completeTask = async (id) => ({ id });
  graph.isConfigured = () => true;
  graph.createDraft = async () => ({ id: "AAA", webLink: "https://outlook.example/AAA" });

  const state = store.emptyState();
  state.cases["task-1"] = {
    id: "task-1", taskId: 1, dealId: 311, token: "0126/1001TG", name: "Muster",
    status: "faellig", needsDraft: true, draft: "Guten Tag,\n\nwie ist der Stand?",
    subject: "Sachstandsanfrage", recipEmail: "kanzlei@example.de", recipOrg: "Kanzlei",
    due: "2026-08-01", fingerprint: "a|1|2|2026-08-01"
  };
  await store.save(state);

  const { server } = require("../server/index");
  await new Promise(r => setTimeout(r, 600));
  const basis = "http://127.0.0.1:39168";

  t.after(async () => {
    await new Promise(r => server.close(r));
    await datenbank.schliessen();
    await sql.end({ timeout: 5 });
  });

  await t.test("die Liste kommt aus der Datenbank", async () => {
    const antwort = await (await fetch(`${basis}/api/cases`)).json();
    assert.equal(antwort.cases.length, 1);
    assert.equal(antwort.cases[0].token, "0126/1001TG");
  });

  await t.test("eine Freigabe wird dauerhaft gespeichert", async () => {
    const antwort = await fetch(`${basis}/api/cases/task-1/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Guten Tag,\n\nwie ist der Stand?" })
    });
    assert.equal(antwort.status, 200);

    // Direkt in der Tabelle nachsehen, nicht über die Anwendung: Nur so ist
    // belegt, dass wirklich geschrieben wurde und nicht bloß der Speicher im
    // Prozess stimmt.
    const [zeile] = await sql`select entscheidung, entschieden_am, daten from fall where id = 'task-1'`;
    assert.equal(zeile.entscheidung, "approved");
    assert.ok(zeile.entschieden_am instanceof Date);
    assert.equal(zeile.daten.outlookDraft.id, "AAA");
    assert.equal(notizen.length, 1);
  });

  await t.test("ein erneutes Laden liefert die Entscheidung zurück", async () => {
    const frisch = await store.load();
    assert.equal(frisch.cases["task-1"].decision, "approved");
    assert.equal(frisch.cases["task-1"].outlookDraft.webLink, "https://outlook.example/AAA");
  });

  await t.test("der bearbeitete Entwurf überlebt den Speicherweg", async () => {
    const antwort = await fetch(`${basis}/api/cases/task-1/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Neuer Text mit Umlauten äöüß" })
    });
    assert.equal(antwort.status, 200);
    const frisch = await store.load();
    assert.equal(frisch.cases["task-1"].editedBody, "Neuer Text mit Umlauten äöüß");
  });
});
