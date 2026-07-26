"use strict";

/*
 * Auflösung der Pipedrive-Custom-Felder über ihren ANZEIGENAMEN.
 *
 * Grund: Die Feld-Keys sind 40-stellige Hashes und pro Konto unterschiedlich.
 * Raten anhand des Wertformats führt zu falschen Angaben in Kundenmails
 * (z. B. wird "Erste Zulassung" als Unfalldatum und das "Kennzeichen" als
 * Schadennummer gelesen). Deshalb: Feldliste einmal laden, Namen → Key mappen
 * und nur ausdrücklich benannte Felder verwenden.
 */

const BASE = "https://api.pipedrive.com/v1";

let cache = null;      // { byName: Map<string, key>, loadedAt: number }
// Vier Fälle werden parallel verarbeitet und liefen beim Start alle in den
// leeren Cache — also vier identische Abrufe. Ein gemeinsames Versprechen
// sorgt dafür, dass nur der erste wirklich lädt.
let inFlight = null;
const TTL_MS = 60 * 60 * 1000;

function norm(s) {
  return String(s || "").toLowerCase().replace(/ß/g, "ss").replace(/[^a-z0-9]/g, "");
}

async function loadFields() {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;                 // ein laufender Abruf genügt
  inFlight = (async () => {
    const token = process.env.PIPEDRIVE_API_TOKEN;
    if (!token) return { byName: new Map(), loadedAt: Date.now() };

    const res = await fetch(`${BASE}/dealFields?limit=500&api_token=${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => null);
    const list = (json && json.data) || [];
    const byName = new Map();
    for (const f of list) {
      if (f && f.key && f.name) byName.set(norm(f.name), { key: f.key, type: f.field_type });
    }
    cache = { byName, loadedAt: Date.now() };
    return cache;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Wert eines Feldes anhand seines Anzeigenamens (mehrere Schreibweisen möglich). */
function pick(deal, fields, names) {
  for (const n of names) {
    const def = fields.byName.get(norm(n));
    if (!def) continue;
    const v = deal[def.key];
    if (v === null || v === undefined || v === "") continue;
    return { value: v, type: def.type, name: n };
  }
  return null;
}

/**
 * Liefert die für eine Sachstandsanfrage relevanten Fakten eines Deals.
 * Nur ausdrücklich vorhandene Felder — fehlt etwas, bleibt es leer (und wird
 * im Entwurf weggelassen), statt geraten zu werden.
 */
async function getDealFacts(deal) {
  const fields = await loadFields();
  const out = {
    schadenNr: null, vertragNr: null, kennzeichen: null,
    lawyerOrgId: null, accidentDate: null
  };
  if (!deal) return out;

  const sn = pick(deal, fields, ["Schadennummer", "Schaden-Nr.", "Schadennr"]);
  if (sn) out.schadenNr = String(sn.value);

  const vn = pick(deal, fields, ["Vertragsnummer", "Vertrags-Nr."]);
  if (vn) out.vertragNr = String(vn.value);

  const kz = pick(deal, fields, ["Kennzeichen", "Amtliches Kennzeichen"]);
  if (kz) out.kennzeichen = String(kz.value);

  // Rechtsanwalt ist ein Organisationsfeld → Wert ist eine Org-ID.
  const ra = pick(deal, fields, ["Rechtsanwalt", "Anwalt", "Kanzlei"]);
  if (ra) {
    const v = ra.value;
    out.lawyerOrgId = typeof v === "object" ? (v.value || v.id || null) : v;
  }

  // Unfalldatum existiert in diesem Konto NICHT als Feld. Nur übernehmen, wenn
  // ein so benanntes Feld tatsächlich vorhanden ist — niemals ersatzweise ein
  // anderes Datumsfeld (z. B. "Erste Zulassung") verwenden.
  const ud = pick(deal, fields, ["Unfalldatum", "Unfalltag", "Datum des Unfalls", "Schadendatum", "Schadentag"]);
  if (ud && /^\d{4}-\d{2}-\d{2}/.test(String(ud.value))) out.accidentDate = String(ud.value).slice(0, 10);

  return out;
}

module.exports = { getDealFacts, loadFields, _norm: norm };
