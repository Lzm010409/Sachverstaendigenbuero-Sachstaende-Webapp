"use strict";

/*
 * Fall-Analyse: leitet aus Pipedrive-Notizen und -Mails den Sachstand ab.
 *
 * Bewusst regelbasiert (keine KI nötig): nachvollziehbar, kostenlos, und jede
 * Einschätzung trägt ihre Quelle mit sich ("Mail der Kanzlei vom …"), damit im
 * Cockpit sichtbar ist, WARUM ein Fall übersprungen oder angefragt wird.
 */

const TOKEN_RE = /(\d{4}\/\d{3,4}TG)/;

// Signalwörter. Reihenfolge = Priorität: erledigt > abwarten > Rückfrage.
const RE_ERLEDIGT = /\b(reguliert|ausgeglichen|vollständig bezahlt|zahlung (?:ist )?(?:angewiesen|erfolgt|veranlasst)|überwiesen|erledigt|abgeschlossen|beglichen|zahlungseingang)\b/i;
const RE_ABWARTEN = /\b(abwarten|noch nicht absehbar|dauert\s+(?:\w+\s+){0,2}(?:noch|länger)|gerichtstermin|termin ist angesetzt|verlegung|in prüfung|wird geprüft|prüfung läuft|klage (?:ist )?anhängig|gerichtlich|verfahren läuft|anfangsstadium)\b/i;
const RE_FRAGE_AN_UNS = /(können sie|könnten sie|bitte (?:senden|übersenden|teilen|mitteilen|um)|benötigen wir|benötige ich|wir bitten um|senden sie|reichen sie|liegt (?:uns|mir) .{0,30}nicht vor|fehlt(?:en)? (?:noch|uns)|rückfrage|\?$)/im;
const RE_UNSER_ENTWURF = /Sachstandsanfrage \(Entwurf/i;
// Vom Cockpit geschriebene Freigabe-Notiz. Damit bleibt Pipedrive die Wahrheit:
// auch nach einem Neustart/Redeploy gilt ein Fall als erledigt.
const RE_FREIGABE_NOTIZ = /Sachstandsanfrage freigegeben/i;

/** Aktenzeichen aus einem Text (Task-Betreff, Deal-Titel) ziehen. */
function extractToken(text) {
  const m = TOKEN_RE.exec(String(text || ""));
  return m ? m[1] : null;
}

function toDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : ""));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDE(s) {
  const d = toDate(s);
  if (!d) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

function daysBetween(a, b) {
  const da = toDate(a), db = toDate(b);
  if (!da || !db) return null;
  return Math.round((db - da) / 86400000);
}

/** Text einer Mail für die Auswertung: Body wenn vorhanden, sonst Snippet. */
function mailText(m) {
  const t = (m.body && m.body.length > 40) ? m.body : m.snippet;
  // Zitierten Verlauf abschneiden — nur der neue Teil ist für die Einschätzung relevant.
  return String(t || "")
    .split(/\n\s*(?:Von:|From:|-{2,}\s*Urspr|Am .{0,40}schrieb)/)[0]
    .slice(0, 2500);
}

/**
 * Hauptanalyse.
 * @returns {object} Bewertung mit status, lastStatus, Quelle, Empfänger und Kontext für den Entwurf.
 */
function analyzeCase({ task, deal, notes, mails, person, org, lawyerOrg, today = new Date() }) {
  const todayISO = today.toISOString().slice(0, 10);
  const token = extractToken(task.subject) || extractToken(deal && deal.title) || null;

  const sortedMails = (mails || []).slice().sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const incoming = sortedMails.filter(m => !m.outgoing);
  const outgoing = sortedMails.filter(m => m.outgoing);
  const newest = sortedMails[0] || null;
  const newestIncoming = incoming[0] || null;

  // Notizen ohne unsere eigenen Entwurfs-Notizen (die sind kein Sachstand).
  const humanNotes = (notes || []).filter(n => {
    const t = stripTags(n.content);
    return !RE_UNSER_ENTWURF.test(t) && !RE_FREIGABE_NOTIZ.test(t);
  });

  // --- Empfänger bestimmen -------------------------------------------------
  // Reihenfolge: (1) hinterlegte Kanzlei, (2) Korrespondenz mit der Gegenseite,
  // (3) Versicherung am Deal. Der Anspruchsteller ist NIE Empfänger einer
  // Sachstandsanfrage — seine Adressen werden ausgeschlossen.
  const claimantMails = collectEmails(person);
  const isClaimant = (email) => claimantMails.includes(String(email).toLowerCase());

  let recipient = null;
  if (lawyerOrg && (firstEmail(lawyerOrg) || lawyerOrg.name)) {
    recipient = {
      email: firstEmail(lawyerOrg) || null,
      person: null,
      org: lawyerOrg.name || null,
      type: "Kanzlei",
      source: "Feld „Rechtsanwalt“ am Deal"
    };
  }

  // Konkrete Ansprechperson aus der Korrespondenz — ergänzt bzw. ersetzt die Adresse.
  const counterpart = incoming.find(m => m.from[0] && !isClaimant(m.from[0].email));
  if (counterpart && counterpart.from[0]) {
    const p = counterpart.from[0];
    const lawyerLike = looksLikeLawyer(p.email, counterpart.subject);
    if (!recipient) {
      recipient = {
        email: p.email,
        person: personName(p.name),
        org: guessOrgFromMail(counterpart, p) || (lawyerLike ? null : (org && org.name)) || null,
        type: lawyerLike ? "Kanzlei" : ((org && org.name) ? "Versicherung" : "Empfänger"),
        source: `Mailverkehr vom ${fmtDE(counterpart.time)}`
      };
    } else if (!recipient.email || sameDomain(recipient.email, p.email)) {
      recipient.email = p.email;
      recipient.person = personName(p.name) || recipient.person;
      recipient.source += ` · Adresse aus Mail vom ${fmtDE(counterpart.time)}`;
    }
  }

  if (!recipient && org && org.name) {
    recipient = {
      email: firstEmail(org) || null, person: null, org: org.name,
      type: "Versicherung", source: "Organisation am Deal"
    };
  }
  if (recipient && recipient.email && isClaimant(recipient.email)) {
    // Sicherheitsnetz: niemals an den Anspruchsteller.
    recipient = { ...recipient, email: null, source: recipient.source + " (Adresse verworfen: Anspruchsteller)" };
  }

  // --- Unsere letzte Anfrage ----------------------------------------------
  const lastOwnMail = outgoing.find(m => /sachstand/i.test(m.subject)) || outgoing[0] || null;
  const lastOwnRequest = lastOwnMail ? lastOwnMail.time : null;

  // --- Letzte inhaltliche Aussage der Gegenseite --------------------------
  // Mails UND Notizen berücksichtigen — die eigenen Aktennotizen enthalten oft
  // den aktuelleren Stand ("wie letztes Mal, abwarten").
  let lastStatement = null;
  if (newestIncoming) {
    lastStatement = {
      date: newestIncoming.time,
      who: (recipient && recipient.org) || (newestIncoming.from[0] && newestIncoming.from[0].email) || "Gegenseite",
      text: condense(mailText(newestIncoming)),
      source: "mail"
    };
  }
  const newestNote = humanNotes
    .slice().sort((a, b) => String(b.add_time).localeCompare(String(a.add_time)))[0];
  if (newestNote && (!lastStatement || String(newestNote.add_time) > String(lastStatement.date))) {
    lastStatement = {
      date: newestNote.add_time,
      who: "interne Notiz",
      text: condense(stripTags(newestNote.content)),
      source: "note"
    };
  }

  // Nur wenn unsere Anfrage NEUER ist als die letzte Rückmeldung, ist sie unbeantwortet.
  const ownRequestUnanswered = Boolean(
    lastOwnRequest && (
      !newestIncoming ||
      (daysBetween(newestIncoming.time, lastOwnRequest) || 0) >= 1
    )
  );

  // --- Status klassifizieren ----------------------------------------------
  let status = "faellig";
  let calloutType = "info";
  let calloutTitle = null;
  let calloutBody = null;
  let skipReason = null;
  let requestText = null;   // konkrete Bitte der Gegenseite, falls vorhanden

  const overdueDays = daysBetween(task.due_date, todayISO);
  if (overdueDays !== null && overdueDays > 0) status = "ueberfaellig";

  // 1) Erledigt/reguliert — aus Mail oder Notiz
  const doneHit = findSignal(RE_ERLEDIGT, sortedMails, humanNotes);
  if (doneHit) {
    status = "reguliert";
    calloutType = "ok";
    calloutTitle = "Bereits reguliert";
    calloutBody = `${doneHit.label}: „${doneHit.quote}“ — kein Entwurf nötig, Aufgabe kann abgeschlossen werden.`;
    skipReason = `reguliert (${doneHit.label})`;
  }

  // 2) Offene Rückfrage AN UNS: neueste Nachricht kommt von der Gegenseite,
  //    ist an uns adressiert und enthält eine echte Bitte/Frage.
  if (!skipReason && newest && !newest.outgoing) {
    const t = mailText(newest);
    const addressedToUs = require("./pipedrive").isOurs(newest.to || []);
    const question = extractRequest(t);
    if (addressedToUs && question) {
      status = "rueckfrage";
      calloutType = "warn";
      calloutTitle = "Rückfrage offen";
      calloutBody = `Mail vom ${fmtDE(newest.time)}: „${question}“ — zuerst beantworten, dann Sachstand erfragen.`;
      requestText = question;
    }
  }

  // 3) Frisches „abwarten" (Notiz/Mail jünger als ABWARTEN_TAGE)
  const waitDays = Number(process.env.ABWARTEN_TAGE || 45);
  if (!skipReason && status !== "rueckfrage") {
    const waitHit = findSignal(RE_ABWARTEN, sortedMails, humanNotes);
    if (waitHit) {
      const age = daysBetween(waitHit.date, todayISO);
      if (age !== null && age <= waitDays) {
        status = "abwarten";
        calloutType = "warn";
        calloutTitle = "Abwarten vermerkt";
        calloutBody = `${waitHit.label}: „${waitHit.quote}“ — vor ${age} Tagen, daher keine neue Anfrage.`;
        skipReason = `abwarten vermerkt (${waitHit.label}, vor ${age} Tagen)`;
      }
    }
  }

  // 4a) Dedup über die Freigabe-Notiz am Deal (überlebt Neustarts).
  if (!skipReason) {
    const freigabe = (notes || [])
      .filter(n => RE_FREIGABE_NOTIZ.test(stripTags(n.content)))
      .sort((a, b) => String(b.add_time).localeCompare(String(a.add_time)))[0];
    if (freigabe && (daysBetween(task.due_date, freigabe.add_time) || 0) >= 0) {
      status = "bereits_angefragt";
      calloutType = "ok";
      calloutTitle = "Bereits freigegeben";
      calloutBody = `Am ${fmtDE(freigabe.add_time)} wurde bereits eine Sachstandsanfrage freigegeben (Notiz am Deal).`;
      skipReason = `bereits freigegeben am ${fmtDE(freigabe.add_time)}`;
    }
  }

  // 4b) Dedup: haben wir nach dem Fälligkeitsdatum schon per Mail angefragt?
  if (!skipReason && lastOwnRequest && daysBetween(task.due_date, lastOwnRequest) >= 0) {
    status = "bereits_angefragt";
    calloutType = "ok";
    calloutTitle = "Bereits angefragt";
    calloutBody = `Unsere Sachstandsanfrage vom ${fmtDE(lastOwnRequest)} liegt nach dem Fälligkeitsdatum — keine erneute Anfrage.`;
    skipReason = `bereits angefragt am ${fmtDE(lastOwnRequest)}`;
  }

  // 5) Empfänger unklar
  if (!skipReason && (!recipient || !recipient.email)) {
    status = "unklar";
    calloutType = "warn";
    calloutTitle = "Empfänger unklar";
    calloutBody = "Am Deal ist keine Mailadresse der Gegenseite auffindbar (keine Korrespondenz, keine Organisation). Bitte in Pipedrive ergänzen.";
    skipReason = "Empfänger unklar";
  }

  // Standard-Beschreibung des letzten Stands
  if (!calloutBody) {
    const parts = [];
    if (lastStatement) {
      const label = lastStatement.source === "note" ? "Letzte Notiz" : "Letzte Rückmeldung";
      parts.push(`${label} ${fmtDE(lastStatement.date)}: „${condense(lastStatement.text, 200)}“`);
    }
    if (ownRequestUnanswered) parts.push(`unsere Anfrage vom ${fmtDE(lastOwnRequest)} ist unbeantwortet`);
    if (!parts.length) parts.push("Keine Korrespondenz am Deal — Erst-Sachstandsanfrage.");
    calloutBody = parts.join(" · ");
    calloutTitle = "Letzter Stand";
  }

  return {
    token,
    status,
    needsDraft: !skipReason,
    isRueckfrage: status === "rueckfrage",
    requestText,
    skipReason,
    calloutType, calloutTitle, calloutBody,
    recipient,
    lastOwnRequest,
    ownRequestUnanswered,
    lastStatement,
    overdueDays: overdueDays === null ? 0 : Math.max(0, overdueDays),
    mailCount: sortedMails.length,
    claimant: (person && person.name) || (deal && deal.person_id && deal.person_id.name) || null,
    insurer: (org && org.name) || (deal && deal.org_id && deal.org_id.name) || null
  };
}

/** Generische Postfachnamen sind keine Personen ("Service", "Info", "Kanzlei"). */
const GENERIC_NAMES = /^(info|service|kontakt|kanzlei|mail|office|sekretariat|buchhaltung|schaden|zentrale|noreply|no-reply|team|support|post|empfang)$/i;
function personName(name) {
  const n = String(name || "").trim();
  if (!n || GENERIC_NAMES.test(n)) return null;
  if (n.includes("@")) return null;   // Mailadresse ist kein Personenname
  // Mindestens ein Vor- und Nachname, oder ein klar personenhafter Einzelname
  return n.length > 2 ? n : null;
}

/** Alle Mailadressen einer Person/Organisation sammeln (Anspruchsteller-Abgleich). */
function collectEmails(entity) {
  const e = entity && entity.email;
  if (Array.isArray(e)) return e.map(x => String(x.value || "").toLowerCase()).filter(Boolean);
  if (typeof e === "string" && e) return [e.toLowerCase()];
  return [];
}

function sameDomain(a, b) {
  const da = String(a || "").split("@")[1], db = String(b || "").split("@")[1];
  return Boolean(da && db && da.toLowerCase() === db.toLowerCase());
}

/**
 * Zieht eine konkrete Bitte/Frage an uns aus dem Mailtext.
 * Nur echte Aufforderungen zählen — ein bloßes Fragezeichen im Zitat genügt nicht.
 */
function extractRequest(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const re = /(können sie|könnten sie|dürfen wir sie bitten|wir bitten (?:sie )?um|bitte (?:senden|übersenden|übermitteln|teilen|mitteilen|prüfen|um)|benötigen wir (?:noch|von)|benötige ich (?:noch|von)|senden sie (?:uns|mir)|übersenden sie|reichen sie|liegt (?:uns|mir) [^.]{0,40}nicht vor|fehlt(?:en)? (?:uns|mir|noch))/i;
  for (const s of sentences) {
    if (s.length < 15 || s.length > 320) continue;
    if (re.test(s)) return condense(s, 240);
  }
  return null;
}

// --- Helfer ---------------------------------------------------------------

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

/** Sucht ein Signal in Mails und Notizen; liefert Quelle, Datum und Zitat. */
function findSignal(re, mails, notes) {
  for (const m of mails) {
    const t = mailText(m);
    const hit = re.exec(t);
    if (hit) {
      return {
        label: `${m.outgoing ? "Unsere Mail" : "Mail der Gegenseite"} vom ${fmtDE(m.time)}`,
        date: m.time,
        quote: quoteAround(t, hit.index)
      };
    }
  }
  for (const n of notes) {
    const t = stripTags(n.content);
    const hit = re.exec(t);
    if (hit) {
      return { label: `Notiz vom ${fmtDE(n.add_time)}`, date: n.add_time, quote: quoteAround(t, hit.index) };
    }
  }
  return null;
}

function quoteAround(text, idx, len = 150) {
  const start = Math.max(0, idx - 40);
  return condense(text.slice(start, start + len));
}

function condense(t, max = 260) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function looksLikeLawyer(email, subject) {
  return /(kanzlei|anwalt|recht|ra-|rae|legal|advocat)/i.test(email + " " + (subject || ""));
}

function guessOrgFromMail(mail, party) {
  const nm = personName(party.name);
  if (nm) return nm;
  const host = (party.email.split("@")[1] || "").replace(/\.(de|com|net|eu|org)$/i, "");
  if (!host) return null;
  return host.split(/[.-]/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function firstEmail(entity) {
  const e = entity && entity.email;
  if (Array.isArray(e)) return (e.find(x => x.primary) || e[0] || {}).value || null;
  return typeof e === "string" ? e : null;
}

module.exports = { analyzeCase, extractToken, fmtDE, daysBetween, htmlStrip: stripTags, TOKEN_RE };
