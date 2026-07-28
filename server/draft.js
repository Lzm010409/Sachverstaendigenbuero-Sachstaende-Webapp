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

/*
 * Vertraute Kontakte: Personen, mit denen laufend zusammengearbeitet wird.
 *
 * Sie bekommen „Guten Tag," statt „Sehr geehrte Damen und Herren," — bewusst
 * NICHT mehr „Hallo <Vorname>,". Auch wo geduzt wird, soll die Anfrage die
 * neutrale Form wahren; sie geht an einen Vorgang, nicht an eine Person.
 *
 * DUZEN_LISTE wird weiter gelesen, damit bestehende Einstellungen nicht brechen.
 */
const VERTRAUT = (process.env.VERTRAUTE_KONTAKTE || process.env.DUZEN_LISTE
  || "Claudia Busch,Philipp Nadler,Jens Schlossmacher")
  .split(",").map(s => s.trim()).filter(Boolean);

/** Schreibweisen-tolerant vergleichen: "Schloßmacher" == "Schlossmacher". */
function normName(s) {
  return String(s || "").toLowerCase().replace(/ß/g, "ss")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/[^a-z ]/g, "").trim();
}

/**
 * Ermittelt die Anrede. Zwei Fassungen, beide in der Sie-Form:
 *   „Guten Tag,"                    für vertraute Kontakte
 *   „Sehr geehrte Damen und Herren," sonst
 * Der Rückgabewert `du` bleibt erhalten, weil er im Cockpit angezeigt wird —
 * er bedeutet jetzt „vertrauter Kontakt", nicht mehr „wird geduzt".
 */
function salutation({ recipient, mails }) {
  // Auch der Organisationsname trägt oft die Person ("Rechtsanwältin Claudia Busch").
  const titles = /\b(rechtsanw[äa]lt(?:in)?|ra|rain|kanzlei|anwaltskanzlei|dr\.?|prof\.?)\b/gi;
  const fromOrg = String((recipient && recipient.org) || "").replace(titles, " ").replace(/\s+/g, " ").trim();
  const person = (recipient && recipient.person) || (/^[A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+/.test(fromOrg) ? fromOrg : "");
  const pn = normName(person);
  const match = pn && VERTRAUT.find(n => {
    const nn = normName(n);
    const last = nn.split(" ").slice(-1)[0];
    // Nachname muss vorkommen — ein bloßer Vornamens-Treffer wäre zu unsicher.
    return pn.includes(nn) || (last && last.length > 3 && pn.includes(last));
  });
  if (match) return { text: "Guten Tag,", du: true, reason: "vertrauter Kontakt (Liste)" };

  // Du-Ansprache aus der Korrespondenz erkennen (Gegenseite spricht uns mit Du an).
  const incoming = (mails || []).filter(m => !m.outgoing);
  const duHit = incoming.some(m => /\b(hallo\s+\w+,|\bdu\b|\bdir\b|\bdein(?:e|em|en)?\b)/i.test(
    (m.body || m.snippet || "").slice(0, 400)
  ));
  if (duHit && person) return { text: "Guten Tag,", du: true, reason: "vertraute Ansprache in der Korrespondenz" };

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
  /*
   * Durchgehend Wir-Form und Sie-Ansprache. Früher schaltete der ganze Text bei
   * vertrauten Kontakten auf „ich / meiner / dich" um; zur neutralen Anrede
   * „Guten Tag," passt das nicht, und die doppelte Formenlogik war eine
   * ständige Fehlerquelle („möchte wir").
   */

  // Bezugszeile
  const bezug = [];
  if (claimant) bezug.push(`Schadensache ${claimant}`);
  if (token) bezug.push(`unser Az. ${token}`);
  if (accidentDate) bezug.push(`Unfall vom ${fmtDE(accidentDate)}`);
  if (insurer) bezug.push(caseNumber ? `${insurer}, Schaden-Nr. ${caseNumber}` : insurer);
  const bezugStr = bezug.length ? ` (${bezug.join(", ")})` : "";

  const lines = [sal.text, ""];

  /*
   * Der Text spricht über den Vorgang, nicht die Person an. Also Feststellungen
   * und Fragen zur Sache statt Aufforderungen („Können Sie uns mitteilen…",
   * „möchten wir Sie bitten…"). Und keine Klausel, die ein Problem vorwegnimmt,
   * das es noch nicht gibt — das frühere „Sofern noch Unterlagen benötigt
   * werden, teilen Sie uns dies bitte mit." ist deshalb entfallen.
   */
  if (analysis.isRueckfrage && analysis.requestText) {
    // Konkrete Bitte der Gegenseite zuerst aufgreifen — mit Zitat, damit klar ist, worum es geht.
    lines.push(`vielen Dank für die Nachricht vom ${fmtDE(analysis.lastStatement && analysis.lastStatement.date)}${bezugStr}.`);
    lines.push("");
    lines.push(`Die Rückfrage („${trimQuote(analysis.requestText, 160)}“) nehmen wir auf und reichen die Angaben nach.`);
    lines.push("");
    lines.push("Gibt es zum Regulierungsstand inzwischen eine Rückmeldung?");
  } else {
    lines.push(`zum Sachstand in der oben genannten Angelegenheit${bezugStr}:`);
    lines.push("");

    // Bezug auf die letzte inhaltliche Aussage der Gegenseite (nur echte Mails zitieren,
    // keine internen Notizen — die kennt der Empfänger nicht).
    if (analysis.lastStatement && analysis.lastStatement.source === "mail" && analysis.lastStatement.text) {
      lines.push(
        `Zuletzt lag am ${fmtDE(analysis.lastStatement.date)} folgende Rückmeldung vor: ` +
        `„${trimQuote(analysis.lastStatement.text)}“`
      );
      lines.push("");
    }

    // Nur behaupten, es fehle eine Antwort, wenn unsere Anfrage tatsächlich die
    // jüngere Nachricht ist.
    if (analysis.ownRequestUnanswered && analysis.lastOwnRequest) {
      lines.push(`Zur Anfrage vom ${fmtDE(analysis.lastOwnRequest)} liegt bislang keine Rückmeldung vor.`);
      lines.push("");
    }

    lines.push(
      "Wurde die Regulierung des Gutachtens bzw. unserer Kostenrechnung inzwischen veranlasst, " +
      "oder gibt es dazu eine Rückmeldung der Versicherung?"
    );
  }

  lines.push("");
  lines.push("Über eine kurze Rückmeldung würden wir uns freuen.");
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
  // Dieselben Stilregeln wie beim Erzeugen. Ohne sie holt das Umschreiben genau
  // die Formeln zurück, die dort ausgeschlossen sind — „kürzer" endete dann
  // regelmäßig bei „Für Rückfragen stehen wir gerne zur Verfügung".
  const sys = [
    "Du formulierst E-Mails für ein deutsches Kfz-Sachverständigenbüro an Rechtsanwälte und Versicherungen.",
    "Regeln: sachlich und knapp; keine rechtliche Bewertung oder Beratung (RDG); keine Drohungen, Fristen oder Mahnungen;",
    "Anrede und Grußformel des Ausgangsentwurfs beibehalten; Aktenzeichen und Zahlen unverändert übernehmen;",
    "Ausgabe ist ausschließlich der reine Mailtext ohne Betreff und ohne Kommentare.",
    "SPRACHFORM: über den Vorgang schreiben, nicht den Empfänger ansprechen. Feststellungen und Fragen zur",
    "Sache statt Aufforderungen. Verboten: „Können Sie uns …“, „Uns interessiert …“, „möchten wir Sie bitten …“,",
    "„Bitte teilen Sie uns mit …“.",
    "KEINE VORAUSEILENDEN KLAUSELN: nichts wie „Sollten Sie Rückfragen haben …“, „Für Rückfragen stehen wir",
    "gerne zur Verfügung“, „erläutern wir gerne“, „Sofern noch Unterlagen benötigt werden …“. Als Abschluss",
    "ist genau ein neutraler Satz zulässig: „Über eine kurze Rückmeldung würden wir uns freuen.“"
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

module.exports = { buildDraft, refineDraft, salutation, buildSubject, VERTRAUT };
