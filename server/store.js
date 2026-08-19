"use strict";

/*
 * Persistenter Speicher für die Freigabe-Warteschlange.
 *
 * Der Bestand liegt in einer eigenen Postgres-Datenbank, angesprochen
 * ausschließlich über `DATABASE_URL`. Vorher waren es JSON-Dateien unter
 * DATA_DIR. Der Wechsel hat einen einzigen Grund: Coolify sichert
 * Datenbank-Ressourcen, aber keine Volumes und keine Hostpfade. Ohne
 * eingebundenes Volume war der Bestand nach jedem Deploy ohnehin verloren.
 *
 * Der Dateipfad ist bewusst noch da (`ausDatei`, `inDatei`). Er dient dem
 * Importer und greift, solange `DATABASE_URL` fehlt — im Demo-Modus und in
 * Tests. Sein Ausbau ist ein eigener, späterer Schritt, erst wenn der Import
 * in Produktion nachweislich gelaufen ist.
 *
 * Asynchron sind nur `load` und `save`: Das erzwingt die Datenbank. Alles
 * andere — mergeCases, aufraeumen, setDecision, setEditedBody, listCases,
 * pendingCount — arbeitet unverändert auf dem Zustandsobjekt im Speicher und
 * bleibt synchron. Die Fachlogik ist von diesem Umbau nicht berührt.
 */

const fs = require("fs");
const path = require("path");
const { notInArray, asc, sql } = require("drizzle-orm");
const datenbank = require("./db");
const { fall, nacharbeit, lauf } = require("./db/schema");

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

/** Läuft der Speicher gegen Postgres oder noch gegen die Datei? */
function nutztDatenbank() {
  return datenbank.istEingerichtet();
}

// --- Umrechnung zwischen Zustandsobjekt und Tabellen ------------------------

function zuDatum(wert) {
  if (!wert) return null;
  const t = Date.parse(wert);
  return Number.isFinite(t) ? new Date(t) : null;
}

function zuIso(wert) {
  if (!wert) return null;
  return wert instanceof Date ? wert.toISOString() : String(wert);
}

function zuZahl(wert) {
  const n = Number(wert);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/*
 * Zeichen, die Postgres nicht speichern kann, entfernen.
 *
 * Zwei Sorten brechen jedes `insert`, und zwar hart genug, um einen ganzen
 * Lauf mitsamt aller Freigaben abzubrechen:
 *
 *   - das Nullbyte U+0000 — weder in `text` noch in `jsonb` zulässig
 *   - eine einzelne Ersatzstelle (U+D800–U+DFFF ohne Partner) — kein gültiges
 *     UTF-8, entsteht beim Abschneiden eines Textes mitten in einem Emoji
 *
 * Beides steckt regelmäßig in Mailtexten, die Pipedrive aus Anhängen und
 * älteren Systemen liefert. Die JSON-Datei hat es klaglos geschluckt; deshalb
 * fällt es erst beim Wechsel auf die Datenbank auf, und deshalb muss es hier
 * abgefangen werden statt am Fall.
 *
 * Gültige Zeichenpaare (Emoji) und die übrigen Steuerzeichen bleiben
 * unangetastet — geprüft, nicht vermutet.
 */
const EINZELNE_ERSATZSTELLE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function textBereinigen(text) {
  return text.replace(/\u0000/g, "").replace(EINZELNE_ERSATZSTELLE, "\uFFFD");
}

function bereinigen(wert, bericht) {
  if (typeof wert === "string") {
    const sauber = textBereinigen(wert);
    if (sauber !== wert) bericht.anzahl++;
    return sauber;
  }
  if (Array.isArray(wert)) return wert.map(w => bereinigen(w, bericht));
  if (wert && typeof wert === "object") {
    const neu = {};
    for (const [k, v] of Object.entries(wert)) neu[k] = bereinigen(v, bericht);
    return neu;
  }
  return wert;
}

/*
 * `excluded.<spalte>` in einem ON-CONFLICT-Zweig: der Wert, der eingefügt
 * werden sollte. Drizzle bietet dafür keinen eigenen Ausdruck, deshalb hier
 * einmal von Hand — die Spaltennamen stammen aus dem erzeugten Schema und
 * nicht aus einer Eingabe.
 */
function sqlAusgeschlossen(spalte) {
  return sql.raw(`excluded."${spalte}"`);
}

/*
 * Ein Fall als Tabellenzeile.
 *
 * `daten` ist maßgeblich und enthält den vollständigen Fall; die übrigen
 * Spalten werden bei jedem Schreiben daraus abgeleitet. Sie sind für Indizes,
 * für Auswertungen in SQL und dafür, dass ein Datenbank-Auszug lesbar bleibt —
 * nie für das Zurücklesen. Deshalb können sie auch nicht auseinanderlaufen.
 */
function fallZuZeile(c, bericht = { anzahl: 0 }) {
  // Erst bereinigen, dann die Spalten daraus ableiten — so kann auch keine
  // Textspalte ein Zeichen enthalten, das die Zeile ablehnen ließe.
  c = bereinigen(c, bericht);
  return {
    id: c.id,
    token: c.token || null,
    dealId: zuZahl(c.dealId),
    aufgabeId: zuZahl(c.taskId),
    status: c.status || null,
    entscheidung: c.decision || null,
    entschiedenAm: zuDatum(c.decidedAt),
    eingereihtAm: zuDatum(c.queuedAt),
    analysiertAm: zuDatum(c.analyzedAt),
    brauchtEntwurf: Boolean(c.needsDraft),
    fingerabdruck: c.fingerprint || null,
    phaseId: zuZahl(c.stageId),
    phaseName: c.stageName || null,
    daten: c,
    aktualisiertAm: new Date()
  };
}

function nacharbeitZuZeile(n, reihenfolge, bericht = { anzahl: 0 }) {
  n = bereinigen(n, bericht);
  return {
    reihenfolge,
    fallId: n.caseId || null,
    dealId: zuZahl(n.dealId),
    aufgabeId: zuZahl(n.taskId),
    token: n.token || null,
    notizOffen: Boolean(n.notizHtml),
    aufgabeOffen: Boolean(n.aufgabeOffen),
    versuche: zuZahl(n.versuche) || 0,
    naechsterVersuch: zuDatum(n.naechsterVersuch),
    daten: n
  };
}

// --- Lesen ------------------------------------------------------------------

/** Der alte Lesepfad: der Zustand, wie er in queue.json steht. */
function ausDatei() {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    return emptyState();
  }
}

async function ausDatenbank() {
  const db = datenbank.db();
  const [faelle, nacharbeiten, koepfe] = await Promise.all([
    // Nach id sortiert, damit die Reihenfolge festliegt. Eine Tabelle kennt
    // keine Einfügereihenfolge; ohne Sortierung stünden gleichrangige Fälle
    // (dieselbe Entscheidung, dieselbe Wartezeit) bei jedem Laden anders in
    // der Liste — die Anwendung sortiert zwar, aber stabil.
    db.select().from(fall).orderBy(asc(fall.id)),
    db.select().from(nacharbeit).orderBy(asc(nacharbeit.reihenfolge)),
    db.select().from(lauf)
  ]);

  const state = emptyState();
  for (const zeile of faelle) {
    if (zeile && zeile.daten && zeile.daten.id) state.cases[zeile.daten.id] = zeile.daten;
  }
  state.offeneNacharbeiten = nacharbeiten.map(z => z.daten).filter(Boolean);

  const kopf = koepfe[0];
  if (kopf) {
    state.version = kopf.version || 1;
    state.lastRun = zuIso(kopf.letzterLauf);
    state.lastRunSummary = kopf.zusammenfassung || null;
    // Die beiden Tagesstempel gibt es erst, wenn ein Lauf bzw. eine Übersicht
    // stattgefunden hat. Sie werden mit `!==` gegen den heutigen Tag geprüft —
    // ein gesetztes `null` verhielte sich zwar gleich, aber ein fehlendes Feld
    // entspricht dem bisherigen Zustand genauer.
    if (kopf.laufGemachtAm) state.laufGemachtAm = kopf.laufGemachtAm;
    if (kopf.digestGesendetAm) state.digestGesendetAm = kopf.digestGesendetAm;
  }
  return normalize(state);
}

async function load() {
  return nutztDatenbank() ? ausDatenbank() : ausDatei();
}

/**
 * Bringt einen gelesenen Zustand in die erwartete Form.
 *
 * Hintergrund: `cases` MUSS ein einfaches Objekt sein. Lag dort ein Array,
 * legte mergeCases die Fälle als benannte Eigenschaften darauf ab — im
 * laufenden Prozess sah alles richtig aus, aber JSON.stringify verwirft solche
 * Eigenschaften. Ergebnis: Die Lauf-Zusammenfassung meldete Entwürfe, die
 * gespeicherte Liste blieb leer, und niemand bekam eine Fehlermeldung.
 *
 * Aus der Datenbank kann diese Form nicht mehr kommen — eine Tabelle ist eine
 * Tabelle. Die Prüfung bleibt trotzdem stehen, weil sie auch für den alten
 * Dateipfad und für den Importer gilt, und weil der Grund für sie sonst mit
 * ihr verschwände.
 */
function normalize(raw) {
  const state = Object.assign(emptyState(), raw && typeof raw === "object" ? raw : {});
  const c = state.cases;
  const istEinfachesObjekt = c && typeof c === "object" && !Array.isArray(c);
  if (!istEinfachesObjekt) {
    const gerettet = {};
    // Aus einem Array lassen sich die Einträge mit id noch übernehmen.
    if (Array.isArray(c)) {
      for (const fallEintrag of c) if (fallEintrag && fallEintrag.id) gerettet[fallEintrag.id] = fallEintrag;
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

// --- Schreiben --------------------------------------------------------------

/** Der alte Schreibpfad. Bleibt für den Betrieb ohne DATABASE_URL. */
function inDatei(state) {
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
    return inDatei(state);
  }
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, FILE); // atomar — kein halb geschriebener Zustand
  return state;
}

// Postgres verträgt 65535 Parameter je Anweisung. Bei fünfzehn Spalten wären
// das über viertausend Fälle; in Blöcken zu schreiben kostet nichts und nimmt
// dieser Grenze jede Bedeutung.
const BLOCK = 200;

async function inDatenbank(state) {
  const db = datenbank.db();
  const faelle = Object.values(state.cases || {}).filter(c => c && c.id);
  const ids = faelle.map(c => c.id);
  const nacharbeiten = (state.offeneNacharbeiten || []).filter(Boolean);
  const bericht = { anzahl: 0 };

  await db.transaction(async (tx) => {
    /*
     * Ein `save` schrieb bisher die ganze Datei neu — genau diese Bedeutung
     * behält es hier: Was nicht mehr im Zustand steht, ist gelöscht. Das ist
     * kein Nebeneffekt, sondern der Weg, auf dem `aufraeumen` und der
     * Phasenfilter Fälle wieder loswerden.
     */
    if (ids.length) await tx.delete(fall).where(notInArray(fall.id, ids));
    else await tx.delete(fall);

    for (let i = 0; i < faelle.length; i += BLOCK) {
      const block = faelle.slice(i, i + BLOCK).map(c => fallZuZeile(c, bericht));
      await tx.insert(fall).values(block).onConflictDoUpdate({
        target: fall.id,
        set: {
          token: sqlAusgeschlossen("token"), dealId: sqlAusgeschlossen("deal_id"),
          aufgabeId: sqlAusgeschlossen("aufgabe_id"), status: sqlAusgeschlossen("status"),
          entscheidung: sqlAusgeschlossen("entscheidung"), entschiedenAm: sqlAusgeschlossen("entschieden_am"),
          eingereihtAm: sqlAusgeschlossen("eingereiht_am"), analysiertAm: sqlAusgeschlossen("analysiert_am"),
          brauchtEntwurf: sqlAusgeschlossen("braucht_entwurf"), fingerabdruck: sqlAusgeschlossen("fingerabdruck"),
          phaseId: sqlAusgeschlossen("phase_id"), phaseName: sqlAusgeschlossen("phase_name"),
          daten: sqlAusgeschlossen("daten"), aktualisiertAm: sqlAusgeschlossen("aktualisiert_am")
        }
      });
    }

    // Die Nacharbeiten haben keinen fachlichen Schlüssel — sie sind eine
    // Liste, die als Ganzes fortgeschrieben wird. Sie ist kurz (im Regelfall
    // leer, im Ausnahmefall eine Handvoll), deshalb ist vollständiges
    // Ersetzen hier das Ehrlichste.
    await tx.delete(nacharbeit);
    if (nacharbeiten.length) {
      await tx.insert(nacharbeit).values(nacharbeiten.map((n, i) => nacharbeitZuZeile(n, i, bericht)));
    }

    await tx.insert(lauf).values({
      id: 1,
      version: state.version || 1,
      letzterLauf: zuDatum(state.lastRun),
      zusammenfassung: state.lastRunSummary || null,
      laufGemachtAm: state.laufGemachtAm || null,
      digestGesendetAm: state.digestGesendetAm || null
    }).onConflictDoUpdate({
      target: lauf.id,
      set: {
        version: sqlAusgeschlossen("version"),
        letzterLauf: sqlAusgeschlossen("letzter_lauf"),
        zusammenfassung: sqlAusgeschlossen("zusammenfassung"),
        laufGemachtAm: sqlAusgeschlossen("lauf_gemacht_am"),
        digestGesendetAm: sqlAusgeschlossen("digest_gesendet_am")
      }
    });
  });

  if (bericht.anzahl) {
    console.warn(`[store] ${bericht.anzahl} Textfeld(er) enthielten Zeichen, die Postgres nicht`
      + ` speichern kann (Nullbyte oder einzelne Ersatzstelle). Sie wurden beim Schreiben entfernt.`);
  }
  return state;
}

async function save(state) {
  return nutztDatenbank() ? inDatenbank(state) : inDatei(state);
}

// --- Fachlogik auf dem Zustandsobjekt (unverändert, synchron) ---------------

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
        aufgabe: prev.aufgabe || null, editedBody: prev.editedBody || null
      };
    } else if (prev.decision && changed && fresh.needsDraft) {
      // Neue Korrespondenz nach einer Entscheidung UND es gibt wieder etwas zu
      // entscheiden → erneut vorlegen.
      state.cases[fresh.id] = {
        ...fresh, queuedAt: now, decision: null, decidedAt: null,
        reopenedFrom: prev.decision, reopenedAt: now
      };
    } else if (prev.decision && changed) {
      /*
       * Verändert, aber ohne neuen Entwurf — also nichts zu entscheiden. Die
       * Entscheidung bleibt stehen.
       *
       * Das war ein Fehler mit Ansage: Die Freigabe schreibt selbst eine Notiz
       * an den Deal, und der Fingerabdruck zählt Notizen. Jede Freigabe machte
       * den Fall damit beim nächsten Lauf „verändert", die Entscheidung wurde
       * verworfen, und der Fall stand plötzlich als „Bereits angefragt" statt
       * als „Freigegeben" da — mitsamt verlorenem Link zum Outlook-Entwurf.
       */
      state.cases[fresh.id] = {
        ...fresh, queuedAt: prev.queuedAt,
        decision: prev.decision, decidedAt: prev.decidedAt, decisionNote: prev.decisionNote,
        outlookDraft: prev.outlookDraft || null, notiz: prev.notiz || null,
        aufgabe: prev.aufgabe || null, editedBody: prev.editedBody || null
      };
    } else {
      // Noch offen: Entwurf aktualisieren, aber vom Nutzer editierten Text bewahren.
      state.cases[fresh.id] = { ...fresh, queuedAt: prev.queuedAt, decision: null, decidedAt: null, editedBody: prev.editedBody || null };
    }
  }
  aufraeumen(state);
  return state;
}

/*
 * Alte Entscheidungen aus der Warteschlange nehmen.
 *
 * Vorher wuchs sie unbegrenzt: mergeCases legt an und aktualisiert, entfernt
 * aber nie. Ein freigegebener Fall blieb damit für immer unter „Erledigt" und
 * „Alle" stehen, auch wenn die Aufgabe in Pipedrive längst abgeschlossen war.
 *
 * Entfernt wird ausschließlich nach ALTER einer Entscheidung — NIEMALS deshalb,
 * weil ein Fall im letzten Lauf fehlte. Fehlen kann er auch, weil sein Abruf an
 * einem leeren Pipedrive-Kontingent gescheitert ist; ein Aufräumen nach
 * Abwesenheit hätte genau dann die Freigabe-Spur gelöscht.
 */
function aufraeumen(state, jetzt = Date.now()) {
  const tage = Number(process.env.AUFBEWAHREN_TAGE || 14);
  if (!(tage > 0)) return state;
  const grenze = tage * 86400000;
  let entfernt = 0;
  for (const [id, c] of Object.entries(state.cases)) {
    if (!c || !c.decision) continue;
    const seit = Date.parse(c.decidedAt || c.queuedAt || "");
    if (!seit || (jetzt - seit) < grenze) continue;
    delete state.cases[id];
    entfernt++;
  }
  if (entfernt) console.log(`[store] ${entfernt} entschiedene Fälle nach ${tage} Tagen aus der Warteschlange entfernt.`);
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

module.exports = {
  load, save, mergeCases, aufraeumen, setDecision, setEditedBody, listCases, pendingCount, emptyState,
  FILE, DATA_DIR,
  // Für den Importer und die Selbstauskunft der Anwendung.
  ausDatei, inDatei, normalize, nutztDatenbank, fallZuZeile, nacharbeitZuZeile, textBereinigen
};
