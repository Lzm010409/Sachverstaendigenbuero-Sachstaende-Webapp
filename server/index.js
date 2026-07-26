"use strict";

/*
 * Sachstands-Cockpit — Server
 * ---------------------------
 * Liefert das Frontend (public/) aus und stellt die JSON-API bereit.
 *
 * Betriebsmodi:
 *   LIVE  (PIPEDRIVE_API_TOKEN gesetzt und DEMO_MODE != true)
 *         Ein Hintergrundlauf sammelt fällige "Sachstand anfragen"-Aufgaben aus
 *         Pipedrive, wertet Notizen und die am Deal verknüpften Mails aus und legt
 *         fertige Entwürfe in eine Freigabe-Warteschlange.
 *   DEMO  (DEMO_MODE=true oder kein Token)
 *         Beispieldaten aus server/demo-cases.js.
 *
 * Nach außen wird nur bei ausdrücklicher Freigabe geschrieben: die Freigabe legt
 * eine Notiz am Deal an (Protokoll). Der eigentliche Mailversand ist bewusst noch
 * nicht verdrahtet (siehe TODO(send)) — bis dahin wird der Entwurf zum Versand
 * bereitgestellt und die Freigabe dokumentiert.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");

const pd = require("./pipedrive");
const store = require("./store");
const worker = require("./worker");
const { refineDraft } = require("./draft");
const demoCases = require("./demo-cases");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const NACHLEUCHTEN_STUNDEN = Number(process.env.NACHLEUCHTEN_STUNDEN || 6);
const DEMO_MODE = String(process.env.DEMO_MODE || "").toLowerCase() === "true" || !pd.hasToken();

// --- Zugangsschutz --------------------------------------------------------
// Vorrang hat die Anmeldung über Microsoft Entra ID. Ist sie nicht
// konfiguriert, greift Basic-Auth als Notausgang — damit die Anwendung nie
// unbeabsichtigt offen im Netz steht, aber auch nicht aussperrt.
const auth = require("./auth");
const graph = require("./graph");
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;

if (auth.isConfigured()) {
  app.use(auth.install(app));
  console.log("Zugangsschutz: Microsoft Entra ID");
} else if (AUTH_USER && AUTH_PASS) {
  // Anmeldeseite trotzdem erreichbar machen, damit der Hinweis auf die
  // fehlende Entra-Konfiguration sichtbar ist.
  auth.install(app);
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Sachstands-Cockpit"');
    return res.status(401).send("Anmeldung erforderlich.");
  });
  console.log("Zugangsschutz: Basic-Auth (Entra nicht konfiguriert)");
} else {
  console.warn("WARNUNG: Kein Zugangsschutz aktiv — weder Entra noch Basic-Auth konfiguriert.");
}

// --- Fälle laden ----------------------------------------------------------
let demoState = null;
function demoCaseList() {
  if (!demoState) demoState = JSON.parse(JSON.stringify(demoCases));
  return demoState;
}

function currentCases() {
  if (DEMO_MODE) return demoCaseList();
  const state = store.load();
  return store.listCases(state)
    .sort((a, b) => {
      // Offene zuerst, dann nach Wartezeit absteigend.
      if (Boolean(a.decision) !== Boolean(b.decision)) return a.decision ? 1 : -1;
      return (b.wait || 0) - (a.wait || 0);
    });
}

function findCase(id) {
  return currentCases().find(c => c.id === id) || null;
}

// --- API ------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true, mode: DEMO_MODE ? "demo" : "live", time: new Date().toISOString(),
    // Bewusst nur Ja/Nein und niemals Werte: Diese Auskunft ist ohne Anmeldung
    // erreichbar. Sie beantwortet die eine Frage, die man von außen sonst nicht
    // klären kann — ist eine Einstellung im laufenden Container angekommen?
    eingerichtet: {
      outlook: graph.isConfigured(),
      pipedriveDropbox: Boolean(pd.dropboxFuerDeal(1)),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY)
    }
  });
});

/*
 * Postfach-Anbindung prüfen. Hinter der Anmeldung, weil die Antwort den
 * Anmeldenamen des Postfachs enthält.
 */
app.get("/api/diagnose/outlook", async (_req, res, next) => {
  try { res.json(await graph.diagnose()); } catch (err) { next(err); }
});

app.get("/api/config", (req, res) => {
  const state = DEMO_MODE ? null : store.load();
  const sitzung = auth.readSession(req);
  res.json({
    demoMode: DEMO_MODE,
    authEnabled: Boolean(AUTH_USER && AUTH_PASS) || auth.isConfigured(),
    entra: auth.isConfigured(),
    benutzer: sitzung ? { name: sitzung.name, email: sitzung.email } : null,
    pipedrive: pd.hasToken(),
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    lastRun: state ? state.lastRun : null,
    lastRunSummary: state ? state.lastRunSummary : null,
    workerRunning: worker.isRunning(),
    pending: state ? store.pendingCount(state) : (demoCaseList().filter(c => !c._resolved && c.draft).length)
  });
});

app.get("/api/cases", (_req, res, next) => {
  try {
    const cases = currentCases().map(c => ({
      ...c,
      // Vom Nutzer bearbeiteter Text hat Vorrang.
      draft: c.editedBody || c.draft,
      _resolved: c._resolved || (c.decision === "approved" ? "sent" : c.decision === "skipped" ? "skipped" : null),
      // Wie lange eine Entscheidung noch in der Arbeitsliste nachleuchtet.
      nachleuchtenStunden: NACHLEUCHTEN_STUNDEN
    }));
    res.json({ cases, mode: DEMO_MODE ? "demo" : "live" });
  } catch (err) { next(err); }
});

/** Lauf manuell auslösen (der Hintergrundlauf macht das sonst selbst). */
app.post("/api/refresh", async (_req, res, next) => {
  try {
    if (DEMO_MODE) return res.json({ ok: true, demo: true, note: "Demo-Modus — kein Abruf nötig." });
    // Vom Nutzer angefordert: alles frisch laden, Fall-Fenster übergehen.
    const summary = await worker.runOnce({ force: true });
    res.json({ ok: true, summary });
  } catch (err) { next(err); }
});

/** Entwurf umschreiben lassen. */
app.post("/api/cases/:id/rewrite", async (req, res, next) => {
  try {
    const c = findCase(req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const instruction = (req.body && req.body.instruction) || "";
    const current = (req.body && req.body.draft) || c.editedBody || c.draft;
    if (!current) return res.status(400).json({ error: "Für diesen Fall existiert kein Entwurf." });

    if (DEMO_MODE) {
      return res.json({ draft: c.draftAlt || current, instruction, note: "Demo-Modus" });
    }
    const context = [c.token && `Az. ${c.token}`, c.name, c.insurer, c.calloutBody].filter(Boolean).join("; ");
    const out = await refineDraft({ draft: { body: current }, instruction, context });
    const state = store.load();
    store.setEditedBody(state, c.id, out.body);
    store.save(state);
    res.json({ draft: out.body, instruction, model: out.model, note: out.note });
  } catch (err) { next(err); }
});

/** Bearbeiteten Entwurf zwischenspeichern (damit Tippen nicht verloren geht). */
app.put("/api/cases/:id/draft", (req, res, next) => {
  try {
    if (DEMO_MODE) return res.json({ ok: true, demo: true });
    const state = store.load();
    const c = store.setEditedBody(state, req.params.id, (req.body && req.body.draft) || "");
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    store.save(state);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Freigeben. Protokolliert die Freigabe als Notiz am Deal.
 * TODO(send): Sobald Microsoft Graph mit Mail.Send verdrahtet ist, hier zuerst
 *   die Mail versenden und anschließend die Pipedrive-Aufgabe abschließen.
 */
app.post("/api/cases/:id/approve", async (req, res, next) => {
  try {
    const c = findCase(req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const body = (req.body && req.body.draft) || c.editedBody || c.draft;
    if (!body) return res.status(400).json({ error: "Kein Entwurf vorhanden." });

    if (DEMO_MODE) {
      c._resolved = "sent";
      return res.json({ ok: true, message: `Entwurf für ${c.token} freigegeben (Demo — nichts versendet).` });
    }

    const noteHtml = renderApprovalNote(c, body);

    // Reihenfolge ist Absicht: ERST der Entwurf ins Postfach, DANN die Notiz.
    // Andersherum riss ein Fehler der Pipedrive-Notiz — etwa ein aufgebrauchtes
    // Tageskontingent — die ganze Freigabe mit, und der Entwurf entstand nie,
    // obwohl Outlook einwandfrei erreichbar war.
    let outlook = null;
    if (graph.isConfigured() && c.recipEmail) {
      try {
        outlook = await graph.createDraft({
          to: c.recipEmail,
          // Kundenname und Aktenzeichen stehen im Betreff — das hilft beim
          // Suchen und bei Antworten, ordnet aber allein noch keinem Deal zu.
          subject: c.subject || `Sachstandsanfrage · ${c.name || ""} · [Az. ${c.token || ""}]`,
          text: body,
          // Deal-eigene Dropbox-Adresse als Blindkopie: Erst dadurch legt
          // Pipedrive die gesendete Mail genau an diesem Vorgang ab.
          bcc: pd.dropboxFuerDeal(c.dealId)
        });
      } catch (err) {
        console.warn("[graph] Entwurf konnte nicht angelegt werden:", err.message);
        outlook = { error: err.message };
      }
    }

    // Sollte ein Entwurf entstehen und ist er es nicht, wird die Freigabe NICHT
    // vermerkt. Sonst verschwindet der Fall aus der Liste, ohne dass irgendwo
    // eine Mail liegt — der Fehler fiele erst auf, wenn niemand mehr nachfragt.
    if (outlook && outlook.error) {
      return res.status(502).json({
        error: `Der Outlook-Entwurf konnte nicht angelegt werden: ${outlook.error}`
          + ` Die Freigabe wurde nicht vermerkt, der Fall bleibt in der Liste.`
      });
    }

    // Freigabe am Deal protokollieren. Diese Notiz ist die dauerhafte Spur der
    // Anfrage: Kaskadenschritt 4 in analyze.js liest sie, damit nicht doppelt
    // angefragt wird. Sie ist zu wichtig, um sie fallenzulassen — aber auch zu
    // unkritisch, um die Freigabe daran scheitern zu lassen. Also vormerken und
    // beim nächsten Lauf nachtragen.
    const state = store.load();
    let notizFehler = null;
    try {
      await pd.addNote(c.dealId, noteHtml);
    } catch (err) {
      notizFehler = err.message;
    }

    // Weder Entwurf noch Notiz: Dann hinterlässt die Freigabe nirgends eine
    // Spur, die einen Neustart überlebt. Lieber gar nicht vermerken — der Fall
    // bleibt stehen und der Text ist weiter zum Kopieren da.
    if (notizFehler && !(outlook && outlook.id)) {
      return res.status(502).json({
        error: `Pipedrive hat die Notiz nicht angenommen (${notizFehler})`
          + ` und ein Outlook-Entwurf ist nicht eingerichtet — die Freigabe wäre nirgends`
          + ` festgehalten. ${graph.missingHint()} Der Fall bleibt in der Liste.`
      });
    }

    if (notizFehler) {
      state.offeneNotizen.push({
        dealId: c.dealId, token: c.token || null, content: noteHtml,
        // versuche zählt die NACHversuche; der gescheiterte Anlauf von eben
        // steht in letzterFehler. Sonst begänne die Wartezeit eine Stufe zu hoch.
        seit: new Date().toISOString(), versuche: 0, letzterFehler: notizFehler
      });
      console.warn(`[approve] Notiz am Deal ${c.dealId} vorgemerkt:`, notizFehler);
    }

    store.setDecision(state, c.id, "approved",
      (outlook && outlook.id ? "Entwurf in Outlook" : "freigegeben")
      + (notizFehler ? ", Notiz wird nachgetragen" : `, Notiz am Deal ${c.dealId}`));
    // Am Fall festhalten, was tatsächlich passiert ist. Das Cockpit zeigt es
    // später an — sonst bliebe nach der Freigabe offen, ob die Notiz in
    // Pipedrive angekommen ist und wo der Entwurf liegt.
    const gespeichert = state.cases[c.id];
    if (gespeichert) {
      if (outlook && outlook.id) {
        gespeichert.outlookDraft = { id: outlook.id, webLink: outlook.webLink, postfach: outlook.postfach || null };
      }
      gespeichert.notiz = notizFehler
        ? { ok: false, fehler: notizFehler }
        : { ok: true, am: new Date().toISOString() };
    }
    store.save(state);

    const wohin = c.recipEmail || "Empfänger offen";
    let message, hinweis = null;
    if (outlook && outlook.id) {
      message = `Freigegeben. Entwurf liegt in Outlook, Adressat ${wohin}.`;
    } else if (!graph.isConfigured()) {
      message = `Freigegeben. Entwurf als Notiz am Deal hinterlegt (${wohin}).`;
      hinweis = graph.missingHint();
    } else {
      message = `Freigegeben, aber ohne Empfängeradresse — nur als Notiz am Deal.`;
    }
    if (notizFehler) {
      hinweis = `Pipedrive hat die Notiz gerade nicht angenommen (${notizFehler}).`
        + ` Sie wird beim nächsten Lauf nachgetragen — am Entwurf ändert das nichts.`;
    }

    // Beides mitschicken, nicht nur den Link: Das Cockpit zeichnet die
    // Ergebniskarte sofort neu und hatte diese Werte sonst erst nach dem
    // nächsten vollständigen Laden — bis dahin stand dort „nicht angelegt",
    // obwohl der Entwurf längst im Postfach lag.
    res.json({
      ok: true, message, sent: false,
      outlookLink: outlook && outlook.webLink ? outlook.webLink : null,
      outlook: outlook && outlook.id
        ? { id: outlook.id, webLink: outlook.webLink, postfach: outlook.postfach || null }
        : null,
      notiz: notizFehler ? { ok: false, fehler: notizFehler } : { ok: true },
      hinweis
    });
  } catch (err) { next(err); }
});

/*
 * Notizen und Mailverlauf im Volltext nachladen.
 *
 * Warum überhaupt nötig: Der Lauf holt den Rumpf nur für die vier neuesten
 * Nachrichten (`withBody` in pipedrive.js) — das war der größte Posten im
 * Tagesverbrauch der Pipedrive-Schnittstelle. Bei den älteren Nachrichten liegt
 * deshalb nur Pipedrives kurzer Auszug vor, und im Cockpit gab es nichts
 * aufzuklappen. Statt bei jedem Lauf alles zu laden, wird hier auf Anforderung
 * nachgeholt: einmal je Fall, wenn wirklich jemand hineinsehen will.
 *
 * Das Ergebnis landet in der Warteschlange, damit es kein zweites Mal kostet.
 */
app.post("/api/cases/:id/volltext", async (req, res, next) => {
  try {
    const c = findCase(req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    if (DEMO_MODE) return res.json({ notizen: c.notizen || [], thread: c.thread || [], demo: true });

    const [notes, mailRes] = await Promise.all([
      pd.getNotes(c.dealId, 20),
      // Rumpf für alle angezeigten Nachrichten. Sie ändern sich nicht mehr,
      // deshalb bleibt das Ergebnis dauerhaft im Zwischenspeicher.
      pd.getDealMails(c.dealId, { limit: 6, withBody: 6 })
    ]);

    const notizen = worker.notizenFuerAnsicht(notes);
    const thread = worker.threadFuerAnsicht(mailRes.mails || []);

    const state = store.load();
    const g = state.cases[c.id];
    if (g) { g.notizen = notizen; g.thread = thread; g.volltextGeladen = new Date().toISOString(); }
    store.save(state);

    res.json({ notizen, thread, mailFehler: mailRes.ok ? null : mailRes.error });
  } catch (err) { next(err); }
});

/*
 * Ausstehende Freigabe-Notizen einsehen. Rein lokal, kostet keinen Aufruf —
 * beantwortet die Frage „wartet hier noch etwas darauf, nach Pipedrive
 * geschrieben zu werden?".
 */
app.get("/api/diagnose/notizen", (_req, res, next) => {
  try {
    const state = store.load();
    res.json({
      offen: state.offeneNotizen.length,
      notizen: state.offeneNotizen.map(n => ({
        dealId: n.dealId, token: n.token, seit: n.seit,
        versuche: n.versuche || 0, naechsterVersuch: n.naechsterVersuch || null,
        letzterFehler: n.letzterFehler || null
      }))
    });
  } catch (err) { next(err); }
});

/** Überspringen — mit Grund, bleibt nachvollziehbar. */
app.post("/api/cases/:id/skip", (req, res, next) => {
  try {
    const c = findCase(req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const reason = (req.body && req.body.reason) || c.skipReason || "manuell übersprungen";
    if (DEMO_MODE) {
      c._resolved = c.status === "reguliert" ? "sent" : "skipped";
      return res.json({ ok: true, status: c._resolved, reason });
    }
    const state = store.load();
    store.setDecision(state, c.id, "skipped", reason);
    store.save(state);
    res.json({ ok: true, status: "skipped", reason });
  } catch (err) { next(err); }
});

/** Notiz-HTML für das Pipedrive-Protokoll — schlicht und lesbar. */
function renderApprovalNote(c, body) {
  const esc = s => String(s || "").replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  const head = [
    `<b>✅ Sachstandsanfrage freigegeben</b>`,
    c.recipEmail ? `Empfänger: ${esc(c.recipPerson || c.recipOrg || "")} &lt;${esc(c.recipEmail)}&gt;` : "",
    c.subject ? `Betreff: ${esc(c.subject)}` : "",
    `Freigegeben am ${new Date().toLocaleDateString("de-DE")} über das Sachstands-Cockpit.`
  ].filter(Boolean).join("<br>");
  return `${head}<br><br>${esc(body).replace(/\n/g, "<br>")}`;
}

// --- Frontend -------------------------------------------------------------
// Die Startseite wird ausgeliefert, nachdem die Skript-Adresse mit einer
// Version versehen wurde (Änderungszeit von app.js). Nach jedem Deployment
// ändert sich damit die Adresse, und kein Browser kann eine alte Fassung
// weiterverwenden — genau das hatte die Aufteilung zerrissen.
const INDEX = path.join(__dirname, "..", "public", "index.html");
function buildStempel() {
  try {
    const js = fs.statSync(path.join(__dirname, "..", "public", "app.js")).mtimeMs;
    return String(Math.floor(js));
  } catch { return String(Date.now()); }
}
app.get("/", (req, res, next) => {
  try {
    const html = fs.readFileSync(INDEX, "utf8")
      .replace('src="/app.js"', `src="/app.js?v=${buildStempel()}"`);
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch (err) { next(err); }
});

// Seite und Skript dürfen nicht im Browser-Cache festhängen: Nach einem
// Deployment traf sonst altes app.js auf neues CSS, was die Aufteilung
// zerriss (Blöcke ohne ihre Wrapper flossen wild ins Raster). "no-cache"
// heißt nicht "nie zwischenspeichern", sondern "vor Benutzung nachfragen" —
// unveränderte Dateien werden mit 304 beantwortet, kosten also kaum etwas.
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

app.use((err, _req, res, _next) => {
  console.error("[cockpit]", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Sachstands-Cockpit läuft auf Port ${PORT} (Modus: ${DEMO_MODE ? "DEMO" : "LIVE"})`);
  if (!DEMO_MODE) worker.start();
});
