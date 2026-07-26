"use strict";

/*
 * Entwurfs-Erzeugung.
 *
 * Standard ist ein deterministischer Textbaukasten: gleiche Struktur, immer
 * saubere Formatierung, RDG-konform (rein sachliche Bitte um Sachstand, keine
 * rechtliche Wertung). Das löst zugleich das Formatierungsproblem der bisherigen
 * HTML-Notizen.
 *
 * Ist ANTHROPIC_API_KEY gesetzt, kann der Entwurf zusätzlich durch das Modell
 * verfeinert bzw. nach Anweisung umgeschrieben werden (siehe refineDraft).
 */

const { fmtDE } = require("./analyze");

// Personen, die geduzt werden. Kommagetrennt über Env erweiterbar.
const DUZEN = (process.env.DUZEN_LISTE || "Claudia Busch,Philipp Nadler,Jens Schlossmacher")
  .split(",").map(s => s.trim()).filter(Boolean);

function firstName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : null;
}

/** Schreibweisen-tolerant vergleichen: "Schloßmacher" == "Schlossmacher". */
function normName(s) {
  return String(s || "").toLowerCase().replace(/ß/g, "ss")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/[^a-z ]/g, "").trim();
}

/** Ermittelt die Anrede: Du-Form für hinterlegte Personen bzw. bei Du-Korrespondenz. */
function salutation({ recipient, mails }) {
  // Auch der Organisationsname trägt oft die Person ("Rechtsanwältin Claudia Busch").
  const titles = /\b(rechtsanw[äa]lt(?:in)?|ra|rain|kanzlei|anwaltskanzlei|dr\.?|prof\.?)\b/gi;
  const fromOrg = String((recipient && recipient.org) || "").replace(titles, " ").replace(/\s+/g, " ").trim();
  const person = (recipient && recipient.person) || (/^[A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+/.test(fromOrg) ? fromOrg : "");
  const pn = normName(person);
  const match = pn && DUZEN.find(n => {
    const nn = normName(n);
    const last = nn.split(" ").slice(-1)[0];
    // Nachname muss vorkommen — ein bloßer Vornamens-Treffer wäre zu unsicher.
    return pn.includes(nn) || (last && last.length > 3 && pn.includes(last));
  });
  if (match) return { text: `Hallo ${firstName(match)},`, du: true, reason: "Duzen-Liste" };

  // Du-Ansprache aus der Korrespondenz erkennen (Gegenseite spricht uns mit Du an).
  const incoming = (mails || []).filter(m => !m.outgoing);
  const duHit = incoming.some(m => /\b(hallo\s+\w+,|\bdu\b|\bdir\b|\bdein(?:e|em|en)?\b)/i.test(
    (m.body || m.snippet || "").slice(0, 400)
  ));
  if (duHit && person) return { text: `Hallo ${firstName(person)},`, du: true, reason: "Du-Ansprache in der Korrespondenz" };

  return { text: "Sehr geehrte Damen und Herren,", du: false, reason: "Standard" };
}

/** Betreff mit Aktenzeichen — macht die Zuordnung eingehender Antworten eindeutig. */
function buildSubject({ token, claimant }) {
  const parts = ["Sachstandsanfrage"];
  if (claimant) parts.push(claimant);
  const head = parts.join(" · ");
  return token ? `${head} · [Az. ${token}]` : head;
}

/**
 * Baut den Mailtext. Fehlende Angaben werden weggelassen (keine Platzhalter).
 */
function buildDraft({ analysis, token, claimant, accidentDate, insurer, caseNumber, mails }) {
  const sal = salutation({ recipient: analysis.recipient, mails });
  const duzen = sal.du;
  // Wir-/Ich-Form konsistent durchhalten (sonst entstehen Sätze wie „möchte wir").
  const wir = duzen ? "ich" : "wir";
  const moechte = duzen ? "möchte ich" : "möchten wir";
  const unser = duzen ? "meiner" : "unserer";
  const kuemmern = duzen ? "Ich kümmere mich" : "Wir kümmern uns";
  const reichen = duzen ? "reiche sie nach" : "reichen sie nach";

  // Bezugszeile
  const bezug = [];
  if (claimant) bezug.push(`Schadensache ${claimant}`);
  if (token) bezug.push(`unser Az. ${token}`);
  if (accidentDate) bezug.push(`Unfall vom ${fmtDE(accidentDate)}`);
  if (insurer) bezug.push(caseNumber ? `${insurer}, Schaden-Nr. ${caseNumber}` : insurer);
  const bezugStr = bezug.length ? ` (${bezug.join(", ")})` : "";

  const lines = [sal.text, ""];

  if (analysis.isRueckfrage && analysis.requestText) {
    // Konkrete Bitte der Gegenseite zuerst aufgreifen — mit Zitat, damit klar ist, worum es geht.
    lines.push(`vielen Dank für die Nachricht vom ${fmtDE(analysis.lastStatement && analysis.lastStatement.date)}${bezugStr}.`);
    lines.push("");
    lines.push(`Zu ${duzen ? "deiner" : "Ihrer"} Rückfrage („${trimQuote(analysis.requestText, 160)}“): ${kuemmern} darum und ${reichen}.`);
    lines.push("");
    lines.push("Bei dieser Gelegenheit: Gibt es zum Regulierungsstand bereits eine Rückmeldung?");
  } else {
    lines.push(`in der oben genannten Angelegenheit${bezugStr} ${moechte} ${duzen ? "dich" : "Sie"} um eine kurze Rückmeldung zum aktuellen Sachstand bitten.`);
    lines.push("");

    // Bezug auf die letzte inhaltliche Aussage der Gegenseite (nur echte Mails zitieren,
    // keine internen Notizen — die kennt der Empfänger nicht).
    if (analysis.lastStatement && analysis.lastStatement.source === "mail" && analysis.lastStatement.text) {
      lines.push(
        `${duzen ? "Du teiltest" : "Sie teilten"} am ${fmtDE(analysis.lastStatement.date)} mit: ` +
        `„${trimQuote(analysis.lastStatement.text)}“`
      );
      lines.push("");
    }

    // Nur behaupten, es fehle eine Antwort, wenn unsere Anfrage tatsächlich die
    // jüngere Nachricht ist.
    if (analysis.ownRequestUnanswered && analysis.lastOwnRequest) {
      lines.push(`Auf ${duzen ? "meine" : "unsere"} Anfrage vom ${fmtDE(analysis.lastOwnRequest)} liegt bislang keine Rückmeldung vor.`);
      lines.push("");
    }

    lines.push(
      `Konkret: Wurde die Regulierung des Gutachtens bzw. ${unser} Kostenrechnung inzwischen veranlasst, ` +
      `oder liegt eine Rückmeldung der Versicherung vor?`
    );
  }

  lines.push("");
  lines.push(`Sofern noch Unterlagen benötigt werden, ${duzen ? "sag bitte kurz Bescheid" : "teilen Sie uns dies bitte mit"}.`);
  lines.push("");
  lines.push("Viele Grüße");
  lines.push("Kfz-Sachverständigenbüro Gollenstede");

  return {
    subject: buildSubject({ token, claimant }),
    body: lines.join("\n"),
    du: duzen,
    salutationReason: sal.reason
  };
}

function trimQuote(t, max = 180) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/**
 * Optionale Verfeinerung/Umschreibung per Anthropic-Modell.
 * Ohne API-Key wird deterministisch variiert (kürzere Fassung), damit die
 * Funktion "Ändern lassen" auch ohne Modell nutzbar bleibt.
 */
async function refineDraft({ draft, instruction, context }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { body: shorten(draft.body), model: null, note: "ohne KI gekürzt (ANTHROPIC_API_KEY nicht gesetzt)" };

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const sys = [
    "Du formulierst E-Mails für ein deutsches Kfz-Sachverständigenbüro an Rechtsanwälte und Versicherungen.",
    "Regeln: sachlich und knapp; keine rechtliche Bewertung oder Beratung (RDG); keine Drohungen, Fristen oder Mahnungen;",
    "Anrede und Grußformel des Ausgangsentwurfs beibehalten; Aktenzeichen und Zahlen unverändert übernehmen;",
    "Ausgabe ist ausschließlich der reine Mailtext ohne Betreff und ohne Kommentare."
  ].join(" ");

  const user = [
    "Hier der bisherige Entwurf:", "---", draft.body, "---",
    context ? `Kontext zum Fall: ${context}` : "",
    `Änderungswunsch: ${instruction || "Fasse den Text etwas knapper."}`
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model, max_tokens: 1200, system: sys,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
  if (!text) throw new Error("Anthropic lieferte keinen Text.");
  return { body: text, model, note: null };
}

/** Deterministischer Rückfall: Nebensätze/Zusatzabsätze entfernen. */
function shorten(body) {
  const lines = String(body).split("\n");
  const keep = [];
  let dropped = 0;
  for (const l of lines) {
    if (/^(Sofern noch Unterlagen|Auf (?:unsere|meine) Anfrage)/.test(l.trim()) && dropped < 2) { dropped++; continue; }
    keep.push(l);
  }
  return keep.join("\n").replace(/\n{3,}/g, "\n\n");
}

module.exports = { buildDraft, refineDraft, salutation, buildSubject, DUZEN };
