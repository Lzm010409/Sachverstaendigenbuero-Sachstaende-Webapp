"use strict";

/*
 * Microsoft Graph — Outlook-Entwürfe anlegen und Mail versenden.
 *
 * Zweck:
 *   1. Den Anfrage-Entwurf als echten Entwurf ins Postfach legen. Damit
 *      entfällt das Kopieren aus einer Notiz, das beim Einfügen schwarze
 *      Unterstreichungen hinterlässt.
 *   2. Die tägliche Übersicht der offenen Fälle verschicken.
 *
 * Anmeldung über Client Credentials — die App handelt als Anwendung, nicht im
 * Namen eines angemeldeten Nutzers. Mandant, Client-ID und Secret werden mit
 * der Anmeldung geteilt (server/auth.js); zusätzlich braucht die
 * App-Registrierung die Anwendungsberechtigungen Mail.ReadWrite (Entwürfe)
 * und Mail.Send (Versand), jeweils mit Administrator-Zustimmung.
 */

const TENANT = process.env.MS_TENANT_ID || "";
const CLIENT_ID = process.env.MS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || "";
const MAILBOX = process.env.MS_SENDER_UPN || "";

let token = null;   // { value, expiresAt }

function isConfigured() {
  return Boolean(TENANT && CLIENT_ID && CLIENT_SECRET && MAILBOX);
}

/** Fehlende Einstellung benennen, statt nur "geht nicht" zu melden. */
function missingHint() {
  const fehlt = [
    !TENANT && "MS_TENANT_ID", !CLIENT_ID && "MS_CLIENT_ID",
    !CLIENT_SECRET && "MS_CLIENT_SECRET", !MAILBOX && "MS_SENDER_UPN"
  ].filter(Boolean);
  return `Outlook-Anbindung nicht eingerichtet — es fehlt: ${fehlt.join(", ")}.`;
}

async function getToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default"
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Token-Endpunkt: ${res.status}`);
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return token.value;
}

async function graph(path, { method = "GET", body } = {}) {
  const t = await getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const fehler = (json && json.error) || {};
    const msg = fehler.message || `HTTP ${res.status}`;
    // Status und Fehlercode mitgeben: "Access is denied" allein sagt nicht, ob
    // die Berechtigung fehlt, eine Zugriffsrichtlinie sperrt oder das Postfach
    // gar nicht existiert. Erst Code und Status unterscheiden die drei Fälle.
    const err = new Error(`${msg} [HTTP ${res.status}${fehler.code ? ", " + fehler.code : ""}]`);
    err.status = res.status;
    err.code = fehler.code || null;
    throw err;
  }
  return json;
}

/**
 * Prüft die Postfach-Anbindung und benennt die Ursache.
 *
 * Sind Berechtigung und Zustimmung im Portal erteilt und es scheitert trotzdem,
 * bleiben drei Möglichkeiten, die sich von außen nicht unterscheiden lassen.
 * Hier werden sie auseinandergehalten: existiert das Postfach überhaupt, und
 * darf die Anwendung darauf zugreifen?
 */
async function diagnose() {
  const ergebnis = { postfach: MAILBOX || null, eingerichtet: isConfigured(), schritte: [] };
  if (!isConfigured()) { ergebnis.hinweis = missingHint(); return ergebnis; }

  const pruefe = async (name, pfad) => {
    try {
      await graph(pfad);
      ergebnis.schritte.push({ schritt: name, ok: true });
      return true;
    } catch (err) {
      ergebnis.schritte.push({ schritt: name, ok: false, status: err.status || null, code: err.code || null, meldung: err.message });
      return false;
    }
  };

  try { await getToken(); ergebnis.schritte.push({ schritt: "Anmeldung als Anwendung", ok: true }); }
  catch (err) {
    ergebnis.schritte.push({ schritt: "Anmeldung als Anwendung", ok: false, meldung: err.message });
    ergebnis.hinweis = "Mandant, Client-ID oder Secret stimmen nicht.";
    return ergebnis;
  }

  // Maßgeblich ist allein, ob sich der Entwurfsordner öffnen lässt — genau das
  // braucht createDraft. Alles andere ist nur Ursachenforschung, wenn es
  // scheitert.
  const postfachDa = await pruefe("Zugriff auf das Postfach", `/users/${encodeURIComponent(MAILBOX)}/mailFolders/drafts?$select=id`);
  if (postfachDa) {
    ergebnis.hinweis = "Die Postfach-Anbindung funktioniert.";
    return ergebnis;
  }

  // Erst jetzt nachsehen, ob es das Konto überhaupt gibt. Dieser Aufruf ist
  // kein Beweis in beide Richtungen: Er braucht eine Verzeichnisberechtigung
  // (User.Read.All), die für den Mailversand nicht nötig ist. Ein 403 mit
  // Authorization_RequestDenied heißt also „darf ich nicht nachschlagen" und
  // gerade NICHT „Konto existiert nicht" — diese Verwechslung hat hier schon
  // einmal zu einem falschen Hinweis geführt.
  await pruefe("Konto nachschlagen (nur zur Eingrenzung)", `/users/${encodeURIComponent(MAILBOX)}?$select=id`);
  const nachschlag = ergebnis.schritte[ergebnis.schritte.length - 1];
  const unklar = !nachschlag.ok && nachschlag.code === "Authorization_RequestDenied";

  if (!nachschlag.ok && !unklar && nachschlag.status === 404) {
    ergebnis.hinweis = `Unter „${MAILBOX}" findet Microsoft 365 kein Konto.`
      + ` MS_SENDER_UPN muss der vollständige Anmeldename (UPN) sein, kein Alias.`;
  } else {
    ergebnis.hinweis = `Die Anwendung kommt nicht an das Postfach „${MAILBOX}".`
      + ` Wahrscheinlich schließt eine Exchange-Zugriffsrichtlinie (Application Access Policy)`
      + ` dieses Postfach nicht ein, oder das Konto hat kein Exchange-Postfach.`
      + (unklar ? ` Ob das Konto existiert, lässt sich nicht prüfen — dafür fehlt der App die`
        + ` Verzeichnisberechtigung. Das ist in Ordnung und für den Mailversand nicht nötig.` : "");
  }
  return ergebnis;
}

/** Reiner Text zu schlichtem HTML — Absätze bleiben erhalten, sonst nichts. */
function textToHtml(text) {
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const absaetze = String(text || "").split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, "<br>")}</p>`);
  // Bewusst ohne Schriftfamilie und Farbe: So erbt die Mail die Einstellungen
  // aus Outlook und sieht aus wie eine selbst geschriebene Nachricht.
  return `<div>${absaetze.join("")}</div>`;
}

/**
 * Legt einen Entwurf im Postfach an.
 * @returns {Promise<{id: string, webLink: string}>}
 */
async function createDraft({ to, subject, text, html, bcc }) {
  if (!isConfigured()) throw new Error(missingHint());
  if (!to) throw new Error("Kein Empfänger angegeben.");
  const body = {
    subject: subject || "",
    body: { contentType: "HTML", content: html || textToHtml(text) },
    toRecipients: [{ emailAddress: { address: to } }]
  };
  // Blindkopie an die Pipedrive-Dropbox: Erst dadurch legt Pipedrive die
  // gesendete Mail zuverlässig am Vorgang ab. Über die Empfängeradresse
  // allein ordnet Pipedrive nur der Person zu — und eine Kanzlei hängt an
  // vielen Deals gleichzeitig.
  if (bcc) body.bccRecipients = [{ emailAddress: { address: bcc } }];
  const msg = await graph(`/users/${encodeURIComponent(MAILBOX)}/messages`, { method: "POST", body });
  return { id: msg.id, webLink: msg.webLink };
}

/** Verschickt eine Mail direkt (für die tägliche Übersicht). */
async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) throw new Error(missingHint());
  await graph(`/users/${encodeURIComponent(MAILBOX)}/sendMail`, {
    method: "POST",
    body: {
      message: {
        subject: subject || "",
        body: { contentType: "HTML", content: html || textToHtml(text) },
        toRecipients: [{ emailAddress: { address: to } }]
      },
      saveToSentItems: true
    }
  });
  return { ok: true };
}

module.exports = { isConfigured, missingHint, createDraft, sendMail, textToHtml, diagnose, MAILBOX };
