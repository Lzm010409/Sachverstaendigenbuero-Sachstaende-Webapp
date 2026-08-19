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
const RE_ERLEDIGT = /\b(reguliert|ausgeglichen|vollständig (?:bezahlt|beglichen)|zahlung (?:ist )?(?:angewiesen|erfolgt|veranlasst)|überwiesen|beglichen|zahlungseingang|vorgang (?:ist )?(?:erledigt|abgeschlossen)|sache (?:ist )?erledigt)\b/i;
// Begriffe, die eine Zahlung nur vortäuschen: Gerichtskostenvorschuss, Teilzahlungen,
// Vorschüsse an die Kanzlei. Trifft eines davon im selben Satz zu, gilt es nicht als reguliert.
const RE_KEINE_REGULIERUNG = /\b(vorschuss|vorschüsse|gerichtskosten|gerichtskostenvorschuss|teilzahlung|teilbetrag|abschlag|akontozahlung|anzahlung|klage)\b/i;
// Laufendes Gerichtsverfahren — hier dauert es naturgemäß länger (GERICHT_TAGE).
const RE_GERICHT = /\b(gerichtstermin|termin ist angesetzt|verhandlungstermin|klage (?:ist )?(?:anhängig|eingereicht|erhoben)|klageverfahren|verfahren läuft|rechtshängig|gericht|verlegung|beweisaufnahme|gutachterauftrag des gerichts|sachverständigenbeweis)\b/i;
// Allgemeines "abwarten" ohne Gerichtsbezug (ABWARTEN_TAGE).
const RE_ABWARTEN = /\b(abwarten|noch nicht absehbar|dauert\s+(?:\w+\s+){0,2}(?:noch|länger)|in prüfung|wird geprüft|prüfung läuft|anfangsstadium|melde[nt] (?:sich|uns)|rückmeldung (?:steht|folgt) (?:noch )?aus)\b/i;
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

  // Für die Wiedervorlage-Frist zählt NUR eine echte Sachstandsanfrage:
  // eine ausgehende Mail mit „Sachstand" im Betreff oder eine Freigabe-Notiz
  // am Deal. Der Gutachtenversand ist keine Nachfrage und darf die nächste
  // nicht unterdrücken.
  const ownSachstandMail = outgoing.find(m => /sachstand/i.test(m.subject)) || null;
  const freigabeNotiz = (notes || [])
    .filter(n => RE_FREIGABE_NOTIZ.test(stripTags(n.content)))
    .sort((a, b) => String(b.add_time).localeCompare(String(a.add_time)))[0] || null;
  const lastRequestCandidates = [
    ownSachstandMail && { date: ownSachstandMail.time, label: `Mail vom ${fmtDE(ownSachstandMail.time)}` },
    freigabeNotiz && { date: freigabeNotiz.add_time, label: `Freigabe vom ${fmtDE(freigabeNotiz.add_time)}` }
  ].filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lastRequest = lastRequestCandidates[0] || null;

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

  /*
   * --- Einordnung ----------------------------------------------------------
   *
   * Zwei Angaben statt einer:
   *
   *   `aufgabe` — was ist zu TUN? Das ist die Hauptachse der Oberfläche.
   *   `lage`    — worum geht es fachlich? Erklärt die Aufgabe, entscheidet aber
   *               nicht über Liste, Filter oder Farbe.
   *
   * Vorher trug `status` beides zugleich, und das ging schief: „Empfänger
   * unklar" stand gleichrangig neben „Überfällig", obwohl das eine ein
   * Hindernis im Datenbestand ist und das andere eine Zeitangabe. Fälle ohne
   * Empfänger haben keinen Entwurf und tauchten deshalb in der Arbeitsliste
   * gar nicht auf — dabei sind sie die einzigen, die eine Eingabe in Pipedrive
   * verlangen. `status` bleibt unverändert bestehen: Der Rest der Anwendung
   * (Digest, Freigabe-Pfad, gespeicherte Fälle) hängt daran.
   */
  let status = "faellig";
  let aufgabe = "pruefen";   // pruefen | klaeren | abschliessen | ruht
  let lage = "erstanfrage";
  let calloutType = "info";
  let calloutTitle = null;
  let calloutBody = null;
  let skipReason = null;
  let requestText = null;   // konkrete Bitte der Gegenseite, falls vorhanden
  let isCourtCase = false;  // laufendes Gerichtsverfahren erkannt

  const overdueDays = daysBetween(task.due_date, todayISO);
  if (overdueDays !== null && overdueDays > 0) status = "ueberfaellig";

  // 1) Erledigt/reguliert — aus Mail oder Notiz
  // Nur Signale ab Anlage der Aufgabe zählen: Wurde die Aufgabe später erstellt,
  // war ein früherer "reguliert"-Vermerk bereits bekannt und ist kein Grund,
  // die Nachfrage zu unterlassen.
  const signalCutoff = task.add_time || null;
  const doneHit = findSignal(RE_ERLEDIGT, sortedMails, humanNotes, {
    notBefore: signalCutoff, exclude: RE_KEINE_REGULIERUNG
  });
  if (doneHit) {
    status = "reguliert";
    // Nichts anzufragen, aber sehr wohl etwas zu tun: Die Aufgabe in Pipedrive
    // gehört geschlossen, damit die dortige Automatisierung weiterläuft.
    aufgabe = "abschliessen";
    lage = "reguliert";
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
      aufgabe = "pruefen";
      lage = "rueckfrage";
      calloutType = "warn";
      calloutTitle = "Rückfrage offen";
      calloutBody = `Mail vom ${fmtDE(newest.time)}: „${question}“ — zuerst beantworten, dann Sachstand erfragen.`;
      requestText = question;
    }
  }

  // 3) Frisches „abwarten": Gerichtsverfahren mit längerer, sonst kurzer Frist.
  //    Bei laufendem Verfahren dauert es erfahrungsgemäß Monate, im Normalfall
  //    wird nach 30 Tagen erneut nachgefragt.
  const gerichtDays = Number(process.env.GERICHT_TAGE || 60);
  const waitDays = Number(process.env.ABWARTEN_TAGE || 30);
  if (!skipReason && status !== "rueckfrage") {
    const gerichtHit = findSignal(RE_GERICHT, sortedMails, humanNotes, { notBefore: signalCutoff });
    const waitHit = findSignal(RE_ABWARTEN, sortedMails, humanNotes, { notBefore: signalCutoff });
    // Die jeweils zutreffende Frist gegen das Alter des Signals prüfen.
    const candidates = [
      gerichtHit && { hit: gerichtHit, limit: gerichtDays, kind: "Gerichtsverfahren" },
      waitHit && { hit: waitHit, limit: waitDays, kind: "abwarten" }
    ].filter(Boolean);

    for (const cand of candidates) {
      const age = daysBetween(cand.hit.date, todayISO);
      if (age === null || age > cand.limit) continue;
      status = "abwarten";
      aufgabe = "ruht";
      lage = cand.kind === "Gerichtsverfahren" ? "verfahren" : "abwarten";
      calloutType = "warn";
      calloutTitle = cand.kind === "Gerichtsverfahren" ? "Verfahren läuft" : "Abwarten vermerkt";
      calloutBody = `${cand.hit.label}: „${cand.hit.quote}“ — vor ${age} Tagen. `
        + `Nächste Nachfrage nach ${cand.limit} Tagen (${cand.kind}).`;
      skipReason = `${cand.kind} (${cand.hit.label}, vor ${age} von ${cand.limit} Tagen)`;
      isCourtCase = cand.kind === "Gerichtsverfahren";
      break;
    }
  }

  // 4a) WIEDERVORLAGE-FRIST — die eigentliche Doppel-Sperre.
  //
  // Maßgeblich ist das ALTER unserer letzten Sachstandsanfrage, nicht das
  // Fälligkeitsdatum der Aufgabe. Am Fälligkeitsdatum aufgehängt war die Regel
  // in beide Richtungen falsch: eine Anfrage kurz VOR dem Termin unterdrückte
  // nichts (neuer Entwurf nach wenigen Tagen), eine Anfrage kurz NACH einem
  // alten Termin unterdrückte dauerhaft (der Fall kam nie wieder).
  //
  // Als Anfrage zählt nur eine ausgehende Mail mit „Sachstand" im Betreff oder
  // eine Freigabe-Notiz am Deal — Letztere überlebt Neustarts und ist damit die
  // verlässliche Quelle, auch wenn die lokale Warteschlange verloren geht.
  if (!skipReason && lastRequest) {
    const age = daysBetween(lastRequest.date, todayISO);
    const frist = isCourtCase ? gerichtDays : waitDays;
    if (age !== null && age < frist) {
      const restTage = frist - age;
      const naechste = new Date(Date.parse(lastRequest.date) + frist * 86400000);
      status = "bereits_angefragt";
      aufgabe = "ruht";
      lage = "frist";
      calloutType = "ok";
      calloutTitle = "Frist läuft noch";
      calloutBody = `Unsere letzte Sachstandsanfrage: ${lastRequest.label} — vor ${age} von ${frist} Tagen. `
        + `Nächste Nachfrage ab ${fmtDE(naechste.toISOString())} (in ${restTage} Tagen).`;
      skipReason = `Frist läuft (${lastRequest.label}, vor ${age} von ${frist} Tagen)`;
    }
  }

  // 5) Empfänger unklar
  if (!skipReason && (!recipient || !recipient.email)) {
    status = "unklar";
    // Das Einzige, was ohne Zutun des Menschen nicht weitergeht.
    aufgabe = "klaeren";
    lage = "kein_empfaenger";
    calloutType = "warn";
    calloutTitle = "Empfänger fehlt";
    calloutBody = recipient && recipient.org
      ? `Für „${recipient.org}“ ist nirgends eine Mailadresse hinterlegt — weder am Deal, `
        + `noch in der Korrespondenz, noch aus anderen Fällen derselben Kanzlei. `
        + `Adresse in Pipedrive ergänzen, dann entsteht der Entwurf beim nächsten Lauf von selbst.`
      : "Am Deal ist weder eine Kanzlei hinterlegt noch Korrespondenz mit der Gegenseite vorhanden. "
        + "Bitte in Pipedrive das Feld „Rechtsanwalt“ setzen.";
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

  // Der Regelfall hat noch keine Lage bekommen: Er unterscheidet sich danach,
  // ob wir schon einmal geschrieben haben und ob darauf geantwortet wurde.
  if (aufgabe === "pruefen" && lage === "erstanfrage") {
    if (ownRequestUnanswered) lage = "unbeantwortet";
    else if (sortedMails.length || humanNotes.length) lage = "nachfassen";
  }

  return {
    token,
    status,
    aufgabe,
    lage,
    needsDraft: !skipReason,
    isRueckfrage: status === "rueckfrage",
    requestText,
    isCourtCase,
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

/**
 * Sucht ein Signal in Mails UND Notizen und liefert den NEUESTEN Treffer.
 * @param notBefore  Signale vor diesem Zeitpunkt werden ignoriert (z. B. alles,
 *                   was älter ist als die Aufgabe selbst — das war beim Anlegen
 *                   der Aufgabe bereits bekannt).
 * @param exclude    Regex; trifft sie im gefundenen Satz zu, gilt der Treffer nicht.
 */
function findSignal(re, mails, notes, { notBefore = null, exclude = null } = {}) {
  const entries = [
    ...(mails || []).map(m => ({
      date: m.time,
      text: mailText(m),
      label: `${m.outgoing ? "Unsere Mail" : "Mail der Gegenseite"} vom ${fmtDE(m.time)}`
    })),
    ...(notes || []).map(n => ({
      date: n.add_time,
      text: stripTags(n.content),
      label: `Notiz vom ${fmtDE(n.add_time)}`
    }))
  ]
    .filter(e => e.date && e.text)
    .filter(e => !notBefore || String(e.date) >= String(notBefore).slice(0, 10))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));   // neueste zuerst

  for (const e of entries) {
    re.lastIndex = 0;
    const hit = re.exec(e.text);
    if (!hit) continue;
    const sentence = sentenceAround(e.text, hit.index);
    if (exclude && exclude.test(sentence)) continue;   // z. B. „Vorschuss bezahlt"
    return { label: e.label, date: e.date, quote: condense(sentence, 150) };
  }
  return null;
}

/** Der Satz, in dem ein Treffer steht — Grundlage für Zitat und Ausschlussprüfung. */
function sentenceAround(text, idx) {
  const s = String(text || "");
  let start = s.lastIndexOf(".", idx);
  const nl = s.lastIndexOf("\n", idx);
  start = Math.max(start, nl, idx - 200);
  let end = s.indexOf(".", idx);
  if (end === -1 || end > idx + 220) end = Math.min(s.length, idx + 220);
  return s.slice(start + 1, end + 1).replace(/\s+/g, " ").trim();
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

module.exports = { analyzeCase, extractToken, fmtDE, daysBetween, htmlStrip: stripTags, TOKEN_RE, looksLikeLawyer };
