"use strict";

/*
 * Die Einordnung eines Falls: Handlung („was ist zu tun?") und Lage („worum
 * geht es?"). Reine Funktionsprüfung, ohne Pipedrive und ohne Datenbank —
 * deshalb läuft sie immer mit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeCase } = require("../server/analyze");
const { adresseAusMails } = require("../server/worker");

const HEUTE = new Date("2026-08-19T09:00:00Z");
const AUFGABE = { deal_id: 311, subject: "Sachstand anfragen zu: 0126/1001TG",
  due_date: "2026-08-10", add_time: "2026-07-01 08:00:00", type: "task", id: 1 };
const DEAL = { id: 311, title: "0126/1001TG", person_id: { name: "Muster", email: [{ value: "kunde@example.de" }] } };
const KANZLEI = { id: 7, name: "Rechtsanwalt Muster", email: [{ value: "ra@kanzlei-muster.de" }] };

function einordnen({ notes = [], mails = [], lawyerOrg = KANZLEI, org = null } = {}) {
  return analyzeCase({ task: AUFGABE, deal: DEAL, notes, mails, person: DEAL.person_id, org, lawyerOrg, today: HEUTE });
}
const notiz = (text, datum) => ({ content: text, add_time: datum });

test("Einordnung: Handlung und Lage", async (t) => {
  await t.test("Regelfall ohne Vorgeschichte: prüfen, Erstanfrage", () => {
    const a = einordnen();
    assert.equal(a.aufgabe, "pruefen");
    assert.equal(a.lage, "erstanfrage");
    assert.equal(a.needsDraft, true);
  });

  await t.test("reguliert heißt abschließen, nicht überspringen", () => {
    const a = einordnen({ notes: [notiz("Der Schaden ist vollständig bezahlt.", "2026-08-01 10:00:00")] });
    assert.equal(a.aufgabe, "abschliessen");
    assert.equal(a.lage, "reguliert");
    assert.equal(a.status, "reguliert");
  });

  await t.test("laufendes Verfahren ruht", () => {
    const a = einordnen({ notes: [notiz("Klage ist eingereicht, Verfahren läuft.", "2026-08-05 10:00:00")] });
    assert.equal(a.aufgabe, "ruht");
    assert.equal(a.lage, "verfahren");
  });

  await t.test("laufende Frist ruht", () => {
    const a = einordnen({
      mails: [{ time: "2026-08-05T10:00:00Z", outgoing: true, subject: "Sachstandsanfrage 0126/1001TG",
        from: [{ email: "info@gollenstede-sachverstand.de" }], to: [{ email: "ra@kanzlei-muster.de" }], body: "…" }]
    });
    assert.equal(a.aufgabe, "ruht");
    assert.equal(a.lage, "frist");
  });

  await t.test("ohne Adresse ist zu klären, nicht zu prüfen", () => {
    const a = einordnen({ lawyerOrg: { id: 7, name: "Rechtsanwalt Muster", email: [] } });
    assert.equal(a.aufgabe, "klaeren");
    assert.equal(a.lage, "kein_empfaenger");
    assert.equal(a.needsDraft, false);
    // Der Hinweis muss sagen, WAS zu tun ist, und die Kanzlei benennen.
    assert.match(a.calloutBody, /Rechtsanwalt Muster/);
    assert.match(a.calloutBody, /Pipedrive ergänzen/);
  });

  await t.test("ohne Kanzlei nennt der Hinweis das Feld", () => {
    const a = einordnen({ lawyerOrg: null });
    assert.equal(a.aufgabe, "klaeren");
    assert.match(a.calloutBody, /Feld „Rechtsanwalt/);
  });

  await t.test("unbeantwortete eigene Anfrage außerhalb der Frist", () => {
    const a = einordnen({
      mails: [{ time: "2026-06-01T10:00:00Z", outgoing: true, subject: "Sachstandsanfrage 0126/1001TG",
        from: [{ email: "info@gollenstede-sachverstand.de" }], to: [{ email: "ra@kanzlei-muster.de" }], body: "…" }]
    });
    assert.equal(a.aufgabe, "pruefen");
    assert.equal(a.lage, "unbeantwortet");
  });
});

test("Adresse aus dem Schriftwechsel einer anderen Akte", async (t) => {
  const deal = { id: 9, person_id: { email: [{ value: "kunde@example.de" }] } };

  await t.test("eingehende Post der Kanzlei wird übernommen", () => {
    const treffer = adresseAusMails([
      { time: "2026-05-01T10:00:00Z", outgoing: false, from: [{ email: "kanzlei@ra-schmidt.de", name: "RA Schmidt" }], to: [] }
    ], deal, "Rechtsanwalt Schmidt");
    assert.equal(treffer.email, "kanzlei@ra-schmidt.de");
  });

  await t.test("die Versicherung wird NICHT als Kanzlei gelernt", () => {
    // Der gefährlichste Fehlgriff: An denselben Akten hängt die Versicherung.
    const treffer = adresseAusMails([
      { time: "2026-05-01T10:00:00Z", outgoing: false, from: [{ email: "schaden@huk-coburg.de" }], to: [] }
    ], deal, "Rechtsanwalt Schmidt");
    assert.equal(treffer, null);
  });

  await t.test("der Anspruchsteller wird nicht als Kanzlei gelernt", () => {
    const treffer = adresseAusMails([
      { time: "2026-05-01T10:00:00Z", outgoing: false, from: [{ email: "kunde@example.de" }], to: [] }
    ], deal, "Rechtsanwalt Schmidt");
    assert.equal(treffer, null);
  });

  await t.test("eigene ausgehende Post an die Kanzlei zählt auch", () => {
    const treffer = adresseAusMails([
      { time: "2026-05-01T10:00:00Z", outgoing: true, from: [{ email: "info@gollenstede-sachverstand.de" }],
        to: [{ email: "post@ra-schmidt.de" }] }
    ], deal, "Rechtsanwalt Schmidt");
    assert.equal(treffer.email, "post@ra-schmidt.de");
  });

  await t.test("eingehende Post schlägt ausgehende", () => {
    const treffer = adresseAusMails([
      { time: "2026-06-01T10:00:00Z", outgoing: true, from: [{ email: "info@gollenstede-sachverstand.de" }],
        to: [{ email: "post@ra-schmidt.de" }] },
      { time: "2026-05-01T10:00:00Z", outgoing: false, from: [{ email: "kanzlei@ra-schmidt.de" }], to: [] }
    ], deal, "Rechtsanwalt Schmidt");
    assert.equal(treffer.email, "kanzlei@ra-schmidt.de");
  });

  await t.test("Domain mit dem Kanzleinamen genügt als Beleg", () => {
    const treffer = adresseAusMails([
      { time: "2026-05-01T10:00:00Z", outgoing: false, from: [{ email: "buero@schlossmacher.de" }], to: [] }
    ], deal, "Rechtsanwalt Jens Schlossmacher");
    assert.equal(treffer.email, "buero@schlossmacher.de");
  });
});
