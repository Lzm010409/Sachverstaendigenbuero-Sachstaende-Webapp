"use strict";

/*
 * Sachstands-Cockpit — Server
 * ---------------------------
 * Ein einzelner Node/Express-Dienst, der das Cockpit-Frontend (public/) ausliefert
 * und eine kleine JSON-API bereitstellt.
 *
 * Betriebsmodi:
 *   DEMO_MODE=true  (Standard, solange keine Zugangsdaten gesetzt sind)
 *       -> arbeitet mit Beispieldaten aus server/demo-cases.js.
 *          Die App startet und ist sofort bedienbar, ganz ohne externe Systeme.
 *   DEMO_MODE=false
 *       -> hier docken später die echten Provider an (Pipedrive, Microsoft 365 Graph,
 *          Anthropic für die Entwurfserzeugung). Diese Stellen sind unten mit TODO markiert.
 *
 * Es wird bewusst NICHTS automatisch versendet. Der "approve"-Endpunkt protokolliert
 * die Freigabe; der tatsächliche Mailversand ist ein separater, noch zu verdrahtender
 * Schritt (Microsoft Graph mit Schreibrechten).
 */

const path = require("path");
const express = require("express");
const demoCases = require("./demo-cases");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const DEMO_MODE = String(process.env.DEMO_MODE || "true").toLowerCase() !== "false";

// ---------------------------------------------------------------------------
// Optionaler Basic-Auth-Schutz (empfohlen fürs öffentliche Deployment).
// Setze BASIC_AUTH_USER und BASIC_AUTH_PASS als Env-Variablen in Coolify.
// Ohne diese Variablen läuft die App offen (nur für lokale Tests gedacht).
// ---------------------------------------------------------------------------
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    const hdr = req.headers.authorization || "";
    const [scheme, encoded] = hdr.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Sachstands-Cockpit"');
    return res.status(401).send("Anmeldung erforderlich.");
  });
}

// ---------------------------------------------------------------------------
// Datenzugriff — Provider-Abstraktion.
// Im Demo-Modus aus dem Speicher; im Echtbetrieb aus Pipedrive + M365.
// ---------------------------------------------------------------------------
let cases = JSON.parse(JSON.stringify(demoCases)); // veränderbare Arbeitskopie (Demo)

async function loadCases() {
  if (DEMO_MODE) return cases;
  // TODO(live): Fällige "Sachstand anfragen"-Tasks aus Pipedrive holen (getActivities),
  //   je Fall Deal + Vault-Fallnotiz + Mailverlauf (Microsoft Graph / Outlook) zusammenführen
  //   und in dieselbe Objektstruktur wie server/demo-cases.js bringen.
  throw new Error("Live-Modus noch nicht verdrahtet — bitte DEMO_MODE=true lassen.");
}

async function generateDraft(caseObj, instruction) {
  if (DEMO_MODE) {
    // Im Demo-Modus liefern wir die vorbereitete Alternativfassung zurück.
    return caseObj.draftAlt || caseObj.draft;
  }
  // TODO(live): Anthropic API mit Fall-Kontext + Anweisung aufrufen und Entwurf zurückgeben.
  throw new Error("Live-Entwurfserzeugung noch nicht verdrahtet.");
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: DEMO_MODE ? "demo" : "live", time: new Date().toISOString() });
});

app.get("/api/config", (_req, res) => {
  res.json({ demoMode: DEMO_MODE, authEnabled: Boolean(AUTH_USER && AUTH_PASS) });
});

app.get("/api/cases", async (_req, res, next) => {
  try {
    const data = await loadCases();
    res.json({ cases: data });
  } catch (err) { next(err); }
});

// Entwurf umschreiben lassen ("Ändern lassen")
app.post("/api/cases/:id/rewrite", async (req, res, next) => {
  try {
    const c = cases.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const instruction = (req.body && req.body.instruction) || "";
    const draft = await generateDraft(c, instruction);
    res.json({ draft, instruction });
  } catch (err) { next(err); }
});

// Freigeben — protokolliert die Freigabe. KEIN automatischer Versand.
app.post("/api/cases/:id/approve", async (req, res, next) => {
  try {
    const c = cases.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const finalDraft = (req.body && req.body.draft) || c.draft;

    if (DEMO_MODE) {
      c._resolved = "sent";
      return res.json({
        ok: true,
        status: "freigegeben",
        message: `Entwurf für ${c.token} freigegeben (Demo — nichts versendet).`
      });
    }
    // TODO(live): Reihenfolge im Echtbetrieb:
    //   1) Mail via Microsoft Graph senden (sendMail, Schreibrechte nötig)
    //   2) Notiz/Aktivität in Pipedrive protokollieren (addNote)
    //   3) Vault-Fallnotiz aktualisieren (Sachstand-Log + Frontmatter)
    //   4) Pipedrive-Task erst nach Versand als erledigt markieren
    void finalDraft;
    throw new Error("Live-Versand noch nicht verdrahtet.");
  } catch (err) { next(err); }
});

// Überspringen — mit Grund, wird im Bericht vermerkt.
app.post("/api/cases/:id/skip", async (req, res, next) => {
  try {
    const c = cases.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Fall nicht gefunden." });
    const reason = (req.body && req.body.reason) || c.skipReason || "manuell übersprungen";
    if (DEMO_MODE) {
      c._resolved = c.status === "reguliert" ? "sent" : "skipped";
      return res.json({ ok: true, status: c._resolved, reason });
    }
    // TODO(live): Übersprungen im Vault/Bericht vermerken. Pipedrive-Task NICHT ändern.
    throw new Error("Live-Modus noch nicht verdrahtet.");
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Frontend (statisch)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "..", "public")));

// Fehlerbehandlung
app.use((err, _req, res, _next) => {
  console.error("[cockpit]", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Sachstands-Cockpit läuft auf Port ${PORT} (Modus: ${DEMO_MODE ? "DEMO" : "LIVE"})`);
});
