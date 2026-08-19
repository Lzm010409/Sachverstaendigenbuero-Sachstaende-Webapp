"use strict";

/*
 * Adressverzeichnis für Kanzleien/Versicherungen.
 *
 * Hintergrund: Am Deal steht die Kanzlei als Organisation ("Rechtsanwältin
 * Claudia Busch"), aber häufig ohne Mailadresse. Die Adresse ist jedoch aus der
 * Korrespondenz ANDERER Fälle derselben Kanzlei bekannt.
 * (Der Umweg über /persons?org_id=… funktioniert nicht — Pipedrive ignoriert den
 * Filter und liefert alle Personen zurück.)
 *
 * Deshalb: Aus jedem Lauf lernen, welche Adresse zu welcher Organisation gehört,
 * und das Wissen dauerhaft ablegen. Fälle ohne eigene Korrespondenz erben die
 * Adresse dann aus dem Verzeichnis.
 *
 * Der Bestand liegt seit der Datenbankumstellung in zwei Tabellen. Nach außen
 * bleibt die bisherige Form `{ orgs: { <schlüssel>: { orgName, addresses } } }`
 * bestehen: `learn` und `lookup` arbeiten unverändert darauf, nur `load` und
 * `save` sind asynchron geworden. Der Dateipfad bleibt für den Importer und
 * für den Betrieb ohne DATABASE_URL erhalten.
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, nutztDatenbank, textBereinigen } = require("./store");
const datenbank = require("./db");
const { verzeichnisOrganisation, verzeichnisAdresse } = require("./db/schema");

const FILE = path.join(DATA_DIR, "directory.json");

/** Der alte Lesepfad: das Verzeichnis, wie es in directory.json steht. */
function ausDatei() {
  try {
    const roh = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return roh && typeof roh.orgs === "object" && roh.orgs ? roh : { orgs: {} };
  } catch {
    return { orgs: {} };
  }
}

function inDatei(dir) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(dir, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error("[directory] Speichern fehlgeschlagen:", err.message);
  }
  return dir;
}

async function ausDatenbank() {
  const db = datenbank.db();
  const [organisationen, adressen] = await Promise.all([
    db.select().from(verzeichnisOrganisation),
    db.select().from(verzeichnisAdresse)
  ]);

  const dir = { orgs: {} };
  for (const o of organisationen) {
    dir.orgs[o.schluessel] = { orgName: o.orgName || null, addresses: {} };
  }
  for (const a of adressen) {
    const eintrag = dir.orgs[a.organisationSchluessel];
    // Der Fremdschlüssel schließt das aus; die Prüfung kostet nichts und
    // verhindert, dass ein Handeingriff in der Datenbank den Lauf abbricht.
    if (!eintrag) continue;
    eintrag.addresses[a.email] = {
      count: a.anzahl || 0,
      person: a.person || null,
      // Die Suche vergleicht diesen Wert als Zeichenkette (neuester gewinnt bei
      // Gleichstand). Deshalb wieder als ISO-Zeitstempel zurück und nicht als
      // Date — sonst verglichen sich plötzlich Objekte.
      lastSeen: a.zuletztGesehen ? a.zuletztGesehen.toISOString() : null
    };
  }
  return dir;
}

async function inDatenbank(dir) {
  const db = datenbank.db();
  const orgs = dir && dir.orgs && typeof dir.orgs === "object" ? dir.orgs : {};

  const orgZeilen = [];
  const adressZeilen = [];
  for (const [schluessel, eintrag] of Object.entries(orgs)) {
    if (!schluessel || !eintrag) continue;
    const artUndWert = schluessel.split(":");
    const art = artUndWert[0] === "id" ? "id" : "name";
    const rest = artUndWert.slice(1).join(":");
    // Auch hier gilt, was in store.js steht: Ein Nullbyte oder eine einzelne
    // Ersatzstelle im Kanzleinamen ließe die ganze Zeile abprallen.
    orgZeilen.push({
      schluessel: textBereinigen(schluessel),
      schluesselArt: art,
      orgId: art === "id" && /^\d+$/.test(rest) ? Number(rest) : null,
      orgName: eintrag.orgName ? textBereinigen(eintrag.orgName) : null
    });
    for (const [email, a] of Object.entries(eintrag.addresses || {})) {
      if (!email) continue;
      adressZeilen.push({
        organisationSchluessel: textBereinigen(schluessel),
        email: textBereinigen(email),
        person: a && a.person ? textBereinigen(a.person) : null,
        anzahl: (a && Number(a.count)) || 0,
        zuletztGesehen: a && a.lastSeen && Number.isFinite(Date.parse(a.lastSeen))
          ? new Date(a.lastSeen) : null
      });
    }
  }

  /*
   * Vollständig ersetzen statt fortschreiben. Das Verzeichnis ist klein
   * (Dutzende Kanzleien), wird immer als Ganzes gehalten und einmal je Lauf
   * geschrieben — ein Abgleich Zeile für Zeile brächte hier nichts außer
   * Gelegenheiten für Abweichungen. Die Adressen hängen über den Fremdschlüssel
   * an den Organisationen und verschwinden mit ihnen.
   */
  await db.transaction(async (tx) => {
    await tx.delete(verzeichnisAdresse);
    await tx.delete(verzeichnisOrganisation);
    if (orgZeilen.length) await tx.insert(verzeichnisOrganisation).values(orgZeilen);
    for (let i = 0; i < adressZeilen.length; i += 200) {
      await tx.insert(verzeichnisAdresse).values(adressZeilen.slice(i, i + 200));
    }
  });
  return dir;
}

async function load() {
  return nutztDatenbank() ? ausDatenbank() : ausDatei();
}

async function save(dir) {
  if (!nutztDatenbank()) return inDatei(dir);
  try {
    return await inDatenbank(dir);
  } catch (err) {
    // Wie bisher: Ein misslungenes Speichern des Verzeichnisses darf den Lauf
    // nicht abbrechen. Es ist gelerntes Wissen, keine Entscheidung — beim
    // nächsten Lauf wird es erneut gelernt.
    console.error("[directory] Speichern fehlgeschlagen:", err.message);
    return dir;
  }
}

function key(orgId, orgName) {
  return orgId ? `id:${orgId}` : (orgName ? `name:${String(orgName).toLowerCase().trim()}` : null);
}

/** Beobachtung eintragen: zu dieser Organisation gehört diese Adresse. */
function learn(dir, { orgId, orgName, email, person, seenAt }) {
  const k = key(orgId, orgName);
  if (!k || !email) return dir;
  const entry = dir.orgs[k] || { orgName: orgName || null, addresses: {} };
  const a = entry.addresses[email.toLowerCase()] || { count: 0, person: null, lastSeen: null };
  a.count += 1;
  if (person && !a.person) a.person = person;
  if (seenAt && (!a.lastSeen || seenAt > a.lastSeen)) a.lastSeen = seenAt;
  entry.addresses[email.toLowerCase()] = a;
  if (orgName) entry.orgName = orgName;
  dir.orgs[k] = entry;
  return dir;
}

/** Beste bekannte Adresse zu einer Organisation (häufigste, bei Gleichstand neueste). */
function lookup(dir, { orgId, orgName }) {
  const candidates = [];
  const direct = dir.orgs[key(orgId, orgName)];
  if (direct) candidates.push(direct);
  // Auch über den Namen suchen, falls der Fall nur die ID kennt (und umgekehrt).
  if (orgName) {
    const byName = dir.orgs[key(null, orgName)];
    if (byName && byName !== direct) candidates.push(byName);
  }
  if (orgId && orgName) {
    for (const [k, v] of Object.entries(dir.orgs)) {
      if (k.startsWith("name:") && v.orgName && v.orgName.toLowerCase() === String(orgName).toLowerCase() && !candidates.includes(v)) {
        candidates.push(v);
      }
    }
  }
  let best = null;
  for (const entry of candidates) {
    for (const [email, a] of Object.entries(entry.addresses || {})) {
      const score = [a.count, a.lastSeen || ""];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
        best = { email, person: a.person, score };
      }
    }
  }
  return best ? { email: best.email, person: best.person } : null;
}

module.exports = { load, save, learn, lookup, FILE, ausDatei, inDatei };
