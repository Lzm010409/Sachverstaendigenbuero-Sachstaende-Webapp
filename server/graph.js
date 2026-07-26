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
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    // Der häufigste Stolperstein ist die fehlende Zustimmung des Administrators.
    if (res.status === 403) {
      throw new Error(`${msg} — fehlt der App-Registrierung die Berechtigung`
        + ` (Mail.ReadWrite bzw. Mail.Send als Anwendungsberechtigung mit Administrator-Zustimmung)?`);
    }
    throw new Error(msg);
  }
  return json;
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
async function createDraft({ to, subject, text, html }) {
  if (!isConfigured()) throw new Error(missingHint());
  if (!to) throw new Error("Kein Empfänger angegeben.");
  const msg = await graph(`/users/${encodeURIComponent(MAILBOX)}/messages`, {
    method: "POST",
    body: {
      subject: subject || "",
      body: { contentType: "HTML", content: html || textToHtml(text) },
      toRecipients: [{ emailAddress: { address: to } }]
    }
  });
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

module.exports = { isConfigured, missingHint, createDraft, sendMail, textToHtml, MAILBOX };
