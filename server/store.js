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
  return { cases: {}, lastRun: null, lastRunSummary: null, version: 1 };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return emptyState();
  }
}

function save(state) {
  ensureDir();
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
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
      state.cases[fresh.id] = { ...fresh, queuedAt: prev.queuedAt, decision: prev.decision, decidedAt: prev.decidedAt, decisionNote: prev.decisionNote };
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
