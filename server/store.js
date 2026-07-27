"use strict";

/*
 * Persistenter Speicher für die Freigabe-Warteschlange.
 *
 * Eine JSON-Datei genügt hier (wenige hundert Fälle, ein Nutzer) und hält den
 * Betrieb einfach: kein Datenbank-Container, ein Volume reicht.
 * Pfad über DATA_DIR steuerbar — in Coolify auf ein persistentes Volume legen,
 * sonst ist die Warteschlange nach jedem Deploy leer.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "queue.json");

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* existiert bereits */ }
}

function emptyState() {
  // offeneNacharbeiten: Schritte nach der Freigabe, die Pipedrive gerade nicht
  // angenommen hat (typisch: Tageskontingent aufgebraucht) — die Notiz am Deal
  // und das Abschließen der Aufgabe. Beide werden selbsttätig nachgeholt.
  return { cases: {}, offeneNacharbeiten: [], lastRun: null, lastRunSummary: null, version: 1 };
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return emptyState();
  }
  return normalize(raw);
}

/**
 * Bringt einen gelesenen Zustand in die erwartete Form.
 *
 * Hintergrund: `cases` MUSS ein einfaches Objekt sein. Lag dort ein Array,
 * legte mergeCases die Fälle als benannte Eigenschaften darauf ab — im
 * laufenden Prozess sah alles richtig aus, aber JSON.stringify verwirft solche
 * Eigenschaften. Ergebnis: Die Lauf-Zusammenfassung meldete Entwürfe, die
 * gespeicherte Liste blieb leer, und niemand bekam eine Fehlermeldung.
 * Deshalb wird die Form hier einmal geradegezogen statt blind vertraut.
 */
function normalize(raw) {
  const state = Object.assign(emptyState(), raw && typeof raw === "object" ? raw : {});
  const c = state.cases;
  const istEinfachesObjekt = c && typeof c === "object" && !Array.isArray(c);
  if (!istEinfachesObjekt) {
    const gerettet = {};
    // Aus einem Array lassen sich die Einträge mit id noch übernehmen.
    if (Array.isArray(c)) {
      for (const fall of c) if (fall && fall.id) gerettet[fall.id] = fall;
    }
    console.warn(`[store] Feld "cases" hatte die Form ${Array.isArray(c) ? "Array" : typeof c}`
      + ` statt Objekt und wurde repariert (${Object.keys(gerettet).length} Fälle übernommen).`);
    state.cases = gerettet;
  }
  if (!Array.isArray(state.offeneNacharbeiten)) state.offeneNacharbeiten = [];
  // Übernahme aus der Vorgängerfassung, die nur Notizen kannte. Ohne diesen
  // Schritt gingen vorgemerkte Notizen beim Deployment verloren.
  if (Array.isArray(state.offeneNotizen) && state.offeneNotizen.length) {
    for (const alt of state.offeneNotizen) {
      state.offeneNacharbeiten.push({
        dealId: alt.dealId, taskId: alt.taskId || null, token: alt.token || null,
        notizHtml: alt.content || null, aufgabeOffen: false,
        seit: alt.seit, versuche: alt.versuche || 0,
        naechsterVersuch: alt.naechsterVersuch || null, letzterFehler: alt.letzterFehler || null
      });
    }
    console.log(`[store] ${state.offeneNotizen.length} vorgemerkte Notiz(en) in die neue Form übernommen.`);
  }
  delete state.offeneNotizen;
  return state;
}

function save(state) {
  ensureDir();
  // Sicherung gegen stillen Datenverlust: Nach dem Serialisieren muss die
  // Anzahl der Fälle noch stimmen. Weicht sie ab, ist die Form des Zustands
  // kaputt — dann soll es im Log stehen und nicht unbemerkt bleiben.
  const erwartet = state.cases && typeof state.cases === "object" ? Object.keys(state.cases).length : 0;
  const json = JSON.stringify(state, null, 2);
  const tatsaechlich = Object.keys(JSON.parse(json).cases || {}).length;
  if (tatsaechlich !== erwartet) {
    console.error(`[store] FEHLER: ${erwartet} Fälle im Speicher, aber nur ${tatsaechlich}`
      + ` im JSON. Der Zustand wird repariert und erneut gespeichert.`);
    state.cases = Object.assign({}, state.cases);   // Array → einfaches Objekt
    return save(state);
  }
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, FILE); // atomar — kein halb geschriebener Zustand
  return state;
}

/**
 * Führt neu analysierte Fälle mit dem bestehenden Zustand zusammen.
 * Bereits freigegebene/übersprungene Fälle behalten ihren Zustand, solange sich
 * am Fall nichts Neues ergeben hat (fingerprint = neueste Mail + Notizanzahl).
 * Kommt neue Korrespondenz herein, wird der Fall reaktiviert — genau das ist
 * "Sachstände tracken".
 */
function mergeCases(state, freshCases) {
  const now = new Date().toISOString();
  for (const fresh of freshCases) {
    const prev = state.cases[fresh.id];
    if (!prev) {
      state.cases[fresh.id] = { ...fresh, queuedAt: now, decision: null, decidedAt: null };
      continue;
    }
    const changed = prev.fingerprint !== fresh.fingerprint;
    if (prev.decision && !changed) {
      // Entschieden und unverändert: Zustand beibehalten, nur Stammdaten aktualisieren.
      // outlookDraft und notiz müssen ausdrücklich mitgenommen werden — sie
      // stehen nicht in `fresh`, und ohne sie verlöre die Ergebniskarte nach
      // dem nächsten Lauf den Link zum Entwurf und den Zustand der Notiz.
      state.cases[fresh.id] = {
        ...fresh, queuedAt: prev.queuedAt,
        decision: prev.decision, decidedAt: prev.decidedAt, decisionNote: prev.decisionNote,
        outlookDraft: prev.outlookDraft || null, notiz: prev.notiz || null,
        editedBody: prev.editedBody || null
      };
    } else if (prev.decision && changed) {
      // Neue Korrespondenz nach einer Entscheidung → erneut vorlegen.
      state.cases[fresh.id] = {
        ...fresh, queuedAt: now, decision: null, decidedAt: null,
        reopenedFrom: prev.decision, reopenedAt: now
      };
    } else {
      // Noch offen: Entwurf aktualisieren, aber vom Nutzer editierten Text bewahren.
      state.cases[fresh.id] = { ...fresh, queuedAt: prev.queuedAt, decision: null, decidedAt: null, editedBody: prev.editedBody || null };
    }
  }
  return state;
}

function setDecision(state, id, decision, note) {
  const c = state.cases[id];
  if (!c) return null;
  c.decision = decision;              // "approved" | "skipped"
  c.decidedAt = new Date().toISOString();
  if (note) c.decisionNote = note;
  return c;
}

function setEditedBody(state, id, body) {
  const c = state.cases[id];
  if (!c) return null;
  c.editedBody = body;
  return c;
}

function listCases(state) {
  return Object.values(state.cases);
}

function pendingCount(state) {
  return listCases(state).filter(c => !c.decision && c.needsDraft).length;
}

module.exports = { load, save, mergeCases, setDecision, setEditedBody, listCases, pendingCount, emptyState, FILE, DATA_DIR };
