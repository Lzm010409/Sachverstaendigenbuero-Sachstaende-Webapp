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
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./store");

const FILE = path.join(DATA_DIR, "directory.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { orgs: {} }; }
}

function save(dir) {
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

module.exports = { load, save, learn, lookup, FILE };
