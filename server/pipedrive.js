"use strict";

/*
 * Pipedrive-API-Client.
 *
 * Bewusst direkt gegen die Pipedrive-REST-API (kein n8n-Zwischenschritt):
 * Die am Deal verknüpften Mails liefert Pipedrive selbst über
 *   GET /deals/{id}/mailMessages
 * Das ist die verlässliche Quelle — die Betreffs-Textsuche über
 * /mailbox/mailThreads?folder=inbox&subject=… (wie im n8n-Workflow aktiv)
 * findet nur Posteingangs-Treffer und verfehlt Verläufe regelmäßig.
 */

const BASE = "https://api.pipedrive.com/v1";
const TOKEN = process.env.PIPEDRIVE_API_TOKEN || "";

// Unsere eigenen Absenderdomains — um "von uns" von "von der Gegenseite" zu unterscheiden.
const OWN_DOMAINS = (process.env.OWN_MAIL_DOMAINS || "gollenstede-sachverstand.de")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// --- Sparmaßnahmen für das Tages-Kontingent der Pipedrive-API -------------
// Ein Lauf holte zuvor für jeden Fall alles neu. Drei Dinge lassen sich
// gefahrlos zwischenspeichern:
//   Organisationen  — ändern sich selten, und viele Fälle teilen dieselbe Kanzlei
//   Mail-Volltexte  — eine gesendete Nachricht ändert sich nie mehr
// Das Zählwerk macht den Verbrauch im Lauf-Protokoll sichtbar.
const ORG_TTL_MS = Number(process.env.ORG_CACHE_STUNDEN || 24) * 3600 * 1000;
const orgCache = new Map();     // orgId -> { org, at }
const mailBodyCache = new Map(); // messageId -> body (unveränderlich)
let requestCount = 0;

/** Zähler für ein Lauf-Protokoll: liefert den Verbrauch und setzt zurück. */
function takeRequestCount() { const n = requestCount; requestCount = 0; return n; }
function cacheStats() { return { organisationen: orgCache.size, mailtexte: mailBodyCache.size }; }

function assertToken() {
  if (!TOKEN) throw new Error("PIPEDRIVE_API_TOKEN ist nicht gesetzt.");
}

async function pd(path, { method = "GET", body, query } = {}) {
  assertToken();
  const url = new URL(BASE + path);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  url.searchParams.set("api_token", TOKEN);

  requestCount++;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(`Pipedrive ${method} ${path}: ${msg}`);
  }
  return json ? json.data : null;
}

/** Offene Aufgaben (Typ task). Paginiert bis alle geladen sind. */
async function getOpenTasks({ limit = 500 } = {}) {
  const out = [];
  let start = 0;
  for (let page = 0; page < 10; page++) {
    const data = await pd("/activities", { query: { done: 0, type: "task", start, limit: 100 } });
    if (!data || !data.length) break;
    out.push(...data);
    if (out.length >= limit || data.length < 100) break;
    start += 100;
  }
  return out;
}

/** Erledigte Aufgaben eines Deals — für "unsere letzte Anfrage vom …". */
async function getDealTasks(dealId) {
  const data = await pd("/activities", { query: { deal_id: dealId, limit: 100 } });
  return data || [];
}

async function getDeal(dealId) {
  return pd(`/deals/${dealId}`);
}

async function getNotes(dealId, limit = 20) {
  const data = await pd("/notes", { query: { deal_id: dealId, limit, sort: "add_time DESC" } });
  return data || [];
}

async function getPerson(personId) {
  try { return await pd(`/persons/${personId}`); } catch { return null; }
}

async function getOrganization(orgId) {
  // Viele Fälle verweisen auf dieselbe Kanzlei — ohne Cache wurde sie je Fall
  // erneut geladen.
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < ORG_TTL_MS) return hit.org;
  let org = null;
  try { org = await pd(`/organizations/${orgId}`); } catch { org = null; }
  // Auch ein Fehlschlag wird vermerkt, sonst wird es in jedem Lauf erneut versucht.
  orgCache.set(orgId, { org, at: Date.now() });
  return org;
}

/**
 * Am Deal verknüpfte Mails, neueste zuerst.
 * Für die neuesten `withBody` Nachrichten wird der Volltext nachgeladen.
 */
async function getDealMails(dealId, { limit = 15, withBody = 4 } = {}) {
  let raw;
  try {
    raw = await pd(`/deals/${dealId}/mailMessages`, { query: { start: 0, limit: 100 } });
  } catch (err) {
    return { ok: false, error: err.message, mails: [] };
  }
  const list = (raw || [])
    .map(x => (x && x.data ? x.data : x))
    .filter(m => m && m.id && !m.draft_flag && !m.deleted_flag)
    .sort((a, b) => String(b.message_time || "").localeCompare(String(a.message_time || "")))
    .slice(0, limit);

  const mails = list.map(m => ({
    id: m.id,
    threadId: m.mail_thread_id,
    time: m.message_time || m.add_time || "",
    subject: m.subject || "",
    snippet: (m.snippet || "").trim(),
    from: parties(m.from),
    to: parties(m.to),
    outgoing: isOurs(parties(m.from)),
    body: ""
  }));

  // Volltext nur für die neuesten Nachrichten — hält die Laufzeit klein.
  // Eine bereits gesendete oder empfangene Nachricht ändert sich nicht mehr.
  // Ihr Volltext wird deshalb dauerhaft behalten — das war der größte Posten
  // im Tagesverbrauch (45 von 127 Aufrufen je Lauf).
  await Promise.all(mails.slice(0, withBody).map(async (mail) => {
    const cached = mailBodyCache.get(mail.id);
    if (cached !== undefined) { mail.body = cached; return; }
    try {
      const full = await pd(`/mailbox/mailMessages/${mail.id}`, { query: { include_body: 1 } });
      const d = full && full.data ? full.data : full;
      mail.body = htmlToText((d && d.body) || "");
      mailBodyCache.set(mail.id, mail.body);
    } catch { /* Body ist optional — snippet genügt als Rückfall */ }
  }));

  return { ok: true, mails };
}

/** Personen einer Organisation — liefert die Mailadresse der Kanzlei, wenn an der
 *  Organisation selbst keine hinterlegt ist. */
async function getOrgPersons(orgId) {
  try {
    const data = await pd("/persons", { query: { org_id: orgId, limit: 50 } });
    return data || [];
  } catch { return []; }
}

async function addNote(dealId, content) {
  return pd("/notes", { method: "POST", body: { deal_id: Number(dealId), content } });
}

// --- Helfer ---------------------------------------------------------------

function parties(arr) {
  return (arr || []).map(p => ({
    email: String(p.email_address || "").toLowerCase(),
    name: p.name || p.linked_person_name || ""
  })).filter(p => p.email);
}

function isOurs(list) {
  return (list || []).some(p => OWN_DOMAINS.some(d => p.email.endsWith("@" + d) || p.email.endsWith("." + d)));
}

/** HTML → lesbarer Text. Entfernt style/script inklusive Inhalt (Pipedrive-Mails
 *  liefern umfangreiche CSS-Blöcke, die sonst im Text landen). */
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
 * Blindkopie-Adresse ("Smart BCC") für einen einzelnen Deal.
 *
 * Pipedrive vergibt je Vorgang eine eigene Adresse nach dem Muster
 *   <konto>+deal<ID>@pipedrivemail.com
 * Erst sie legt die gesendete Mail am richtigen Deal ab. Über die
 * Empfängeradresse allein ordnet Pipedrive nur der Person zu — und eine
 * Kanzlei hängt an vielen Deals gleichzeitig.
 *
 * PIPEDRIVE_BCC_DROPBOX darf mit oder ohne +deal-Zusatz hinterlegt sein; die
 * Deal-Nummer wird in jedem Fall neu gesetzt.
 */
function dropboxFuerDeal(dealId) {
  const muster = String(process.env.PIPEDRIVE_BCC_DROPBOX || "").trim();
  if (!muster) return null;
  if (!/^\d+$/.test(String(dealId || ""))) return null;
  const at = muster.lastIndexOf("@");
  if (at < 1 || at === muster.length - 1) return null;
  const konto = muster.slice(0, at).split("+")[0];
  const domain = muster.slice(at + 1);
  if (!konto) return null;
  return `${konto}+deal${dealId}@${domain}`;
}

module.exports = {
  takeRequestCount, cacheStats,
  getOpenTasks, getDealTasks, getDeal, getNotes, getPerson, getOrganization,
  getDealMails, addNote, getOrgPersons, htmlToText, isOurs, OWN_DOMAINS,
  dropboxFuerDeal,
  hasToken: () => Boolean(TOKEN)
};
