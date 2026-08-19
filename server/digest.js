"use strict";

/*
 * Tägliche Übersicht der offenen Fälle per Mail.
 *
 * Einmal am Tag (DIGEST_STUNDE, Ortszeit) geht eine Mail mit allen Fällen
 * raus, die noch auf eine Entscheidung warten — mit einem Link je Fall direkt
 * in das Cockpit.
 *
 * Der Versandzeitpunkt wird im Speicher vermerkt (digestGesendetAm). Ein
 * Neustart oder ein zusätzlicher Lauf löst deshalb keine zweite Mail aus.
 */

const graph = require("./graph");

const STUNDE = Number(process.env.DIGEST_STUNDE || 8);
const EMPFAENGER = process.env.DIGEST_EMPFAENGER || process.env.MS_SENDER_UPN || "";
const APP_URL = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");

/*
 * Datum und Stunde kommen aus server/zeit.js — dort wird die Zeitzone
 * ausdrücklich benannt. Die frühere Fassung rechnete über
 * getTimezoneOffset(), was im Container (UTC, ohne Zeitzonendaten) schlicht 0
 * ist: Der Stichtag war damit UTC und die Stunde ebenfalls.
 */
const { heuteISO, stunde } = require("./zeit");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * Baut die Mail. Getrennt vom Versand, damit sie prüfbar bleibt.
 *
 * @param faelle    Fälle mit Entwurf — sie warten auf eine Freigabe.
 * @param zuKlaeren Fälle ohne Empfänger. Sie haben keinen Entwurf und standen
 *                  deshalb bisher in keiner Übersicht — obwohl gerade sie eine
 *                  Eingabe in Pipedrive verlangen und sonst liegenbleiben.
 */
function buildDigest(faelle, zuKlaeren = []) {
  const zeilen = faelle.map(c => {
    const wartet = c.wait === 0 ? "heute fällig" : `${c.wait} Tage`;
    const link = APP_URL ? `${APP_URL}/?fall=${encodeURIComponent(c.token || c.id)}` : "";
    const name = esc(c.name || "—");
    const farbe = c.lage === "rueckfrage" ? "#9C6A12"
      : (c.wait || 0) > 0 ? "#BC4630" : "#5C6673";
    return `<tr>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;white-space:nowrap;font-family:Consolas,monospace;font-size:13px;color:#5C6673">${esc(c.token || "")}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;font-weight:600">${
        link ? `<a href="${link}" style="color:#2F6DB3;text-decoration:none">${name}</a>` : name}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;color:#5C6673">${esc(c.recipOrg || "—")}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;color:${farbe};white-space:nowrap">${esc(wartet)}</td>
    </tr>`;
  }).join("");

  const ueber = faelle.filter(c => (c.wait || 0) > 0).length;
  const rueck = faelle.filter(c => c.lage === "rueckfrage" || c.status === "rueckfrage").length;

  const klaerZeilen = zuKlaeren.map(c => {
    const link = APP_URL ? `${APP_URL}/?fall=${encodeURIComponent(c.token || c.id)}` : "";
    const name = esc(c.name || "—");
    return `<tr>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;white-space:nowrap;font-family:Consolas,monospace;font-size:13px;color:#5C6673">${esc(c.token || "")}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;font-weight:600">${
        link ? `<a href="${link}" style="color:#2F6DB3;text-decoration:none">${name}</a>` : name}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #E5EAF1;color:#5C6673">${esc(c.recipOrg || "keine Kanzlei hinterlegt")}</td>
    </tr>`;
  }).join("");

  const teile = [];
  if (faelle.length) teile.push(`${faelle.length} zur Freigabe`);
  if (zuKlaeren.length) teile.push(`${zuKlaeren.length} ohne Empfänger`);
  const betreff = `Sachstände: ${teile.join(", ")}`;

  const html = `<div style="font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#1A2028;max-width:720px">
  <p style="font-size:15px;margin:0 0 6px">Guten Morgen,</p>
  ${faelle.length ? `<p style="font-size:15px;margin:0 0 18px;line-height:1.5">
    ${faelle.length === 1 ? "ein Fall wartet" : `${faelle.length} Fälle warten`} auf deine Freigabe${
      ueber ? `, davon ${ueber} überfällig` : ""}${rueck ? `; ${rueck} mit offener Rückfrage` : ""}.
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead><tr style="text-align:left;color:#8A94A2;font-size:11px;letter-spacing:.06em;text-transform:uppercase">
      <th style="padding:0 12px 6px">Az.</th><th style="padding:0 12px 6px">Anspruchsteller</th>
      <th style="padding:0 12px 6px">Empfänger</th><th style="padding:0 12px 6px">Wartet</th>
    </tr></thead>
    <tbody>${zeilen}</tbody>
  </table>` : ""}
  ${zuKlaeren.length ? `<p style="font-size:15px;margin:${faelle.length ? "26px" : "0"} 0 8px;line-height:1.5">
    <b>${zuKlaeren.length === 1 ? "Ein Fall kommt" : `${zuKlaeren.length} Fälle kommen`} nicht weiter:</b>
    Es fehlt eine Mailadresse der Kanzlei. Sobald sie in Pipedrive steht, entsteht der Entwurf beim nächsten Lauf.
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead><tr style="text-align:left;color:#8A94A2;font-size:11px;letter-spacing:.06em;text-transform:uppercase">
      <th style="padding:0 12px 6px">Az.</th><th style="padding:0 12px 6px">Anspruchsteller</th>
      <th style="padding:0 12px 6px">Kanzlei</th>
    </tr></thead>
    <tbody>${klaerZeilen}</tbody>
  </table>` : ""}
  ${APP_URL ? `<p style="margin:22px 0 0">
    <a href="${APP_URL}" style="background:#2F6DB3;color:#fff;text-decoration:none;
       padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Alle Fälle im Cockpit öffnen</a>
  </p>` : ""}
  <p style="color:#8A94A2;font-size:12px;margin:26px 0 0">
    Kfz-Sachverständigenbüro Gollenstede · automatische Übersicht
  </p>
</div>`;
  return { betreff, html };
}

/**
 * Verschickt die Übersicht, wenn sie heute noch nicht raus ist und die
 * eingestellte Stunde erreicht wurde.
 * @returns {Promise<{gesendet: boolean, grund?: string, anzahl?: number}>}
 */
async function maybeSendDigest(state, faelle, now = new Date()) {
  if (!EMPFAENGER) return { gesendet: false, grund: "kein Empfänger eingestellt" };
  if (!graph.isConfigured()) return { gesendet: false, grund: graph.missingHint() };

  const heute = heuteISO(now);
  if (state.digestGesendetAm === heute) return { gesendet: false, grund: "heute bereits versendet" };
  if (stunde(now) < STUNDE) return { gesendet: false, grund: `vor ${STUNDE} Uhr` };

  const offen = faelle.filter(c => !c.decision && c.needsDraft);
  // Fälle ohne Empfänger gehören mit in die Übersicht: Sie erzeugen keinen
  // Entwurf und blieben deshalb bisher unerwähnt — dabei sind sie die
  // einzigen, die ohne eine Eingabe in Pipedrive für immer liegenbleiben.
  const zuKlaeren = faelle.filter(c => !c.decision && c.aufgabe === "klaeren");
  if (!offen.length && !zuKlaeren.length) {
    // Nichts zu tun ist eine gute Nachricht — aber keine Mail wert.
    state.digestGesendetAm = heute;
    return { gesendet: false, grund: "keine offenen Fälle" };
  }

  const { betreff, html } = buildDigest(offen, zuKlaeren);
  await graph.sendMail({ to: EMPFAENGER, subject: betreff, html });
  state.digestGesendetAm = heute;
  console.log(`[digest] Übersicht mit ${offen.length} Fällen zur Freigabe`
    + `${zuKlaeren.length ? ` und ${zuKlaeren.length} ohne Empfänger` : ""} an ${EMPFAENGER} versendet.`);
  return { gesendet: true, anzahl: offen.length, zuKlaeren: zuKlaeren.length };
}

module.exports = { maybeSendDigest, buildDigest, heuteISO };
