"use strict";

/*
 * Ortszeit — bewusst NICHT die Zeitzone des Containers.
 *
 * `node:20-alpine` läuft in UTC und bringt keine Zeitzonendaten des
 * Betriebssystems mit. `new Date().getHours()` liefert dort UTC-Stunden. Damit
 * bedeutete `LAUF_STUNDE=7` in Wahrheit 9 Uhr deutscher Sommerzeit (und 8 Uhr
 * im Winter) — der Tageslauf kam jeden Tag zwei Stunden zu spät, ohne dass es
 * irgendwo auffiel.
 *
 * Auch das Tagesdatum war betroffen: Zwischen Mitternacht und 2 Uhr Ortszeit
 * ist in UTC noch der Vortag. `laufGemachtAm` und der Fälligkeitsvergleich
 * lagen in diesem Fenster einen Tag daneben.
 *
 * Intl greift auf die in Node eingebaute ICU-Datenbank zu und braucht dafür
 * nichts vom Betriebssystem; Sommer- und Winterzeit sind darin enthalten. Das
 * ist deshalb der verlässliche Weg — verlässlicher als ein TZ in der
 * Umgebung, das ohne `tzdata` im Abbild stillschweigend ignoriert wird.
 */

const ZEITZONE = process.env.ZEITZONE || "Europe/Berlin";

// en-CA liefert Jahr-Monat-Tag; hourCycle h23 verhindert die 24 um Mitternacht.
const FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZEITZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23"
});

function teile(now) {
  const out = {};
  for (const p of FORMAT.formatToParts(now)) out[p.type] = p.value;
  return out;
}

/** Datum in Ortszeit als JJJJ-MM-TT. */
function heuteISO(now = new Date()) {
  const t = teile(now);
  return `${t.year}-${t.month}-${t.day}`;
}

/** Stunde in Ortszeit, 0–23. */
function stunde(now = new Date()) {
  return Number(teile(now).hour);
}

module.exports = { heuteISO, stunde, ZEITZONE };
