"use strict";

/*
 * KI-Schicht für Sachstandsanfragen.
 *
 * Arbeitsteilung (bewusst so gezogen):
 *   Regelbasiert bleiben alle FAKTEN und die Skip-Entscheidung — Empfänger,
 *   Aktenzeichen, Schaden-/Vertragsnummer, Anrede, Fristen. Dort wäre ein
 *   Sprachmodell gefährlich: es formuliert eine falsche Nummer flüssig und
 *   damit unauffällig.
 *   Das Modell übernimmt FORMULIERUNG und SCHWERPUNKT: Es liest Notizen und
 *   Mailverlauf, erkennt die Sachlage und schreibt den Text passend dazu.
 *
 * Die Einschätzung der Sachlage ist ein VORSCHLAG (aiAssessment) und wird nicht
 * automatisch zum Überspringen verwendet — sonst könnten Fälle still verschwinden.
 *
 * Jede Antwort durchläuft validateDraft(): stehen im Text Zahlen oder
 * Aktenzeichen, die nicht aus den Fakten stammen, wird der Entwurf verworfen
 * und der deterministische Baukasten greift.
 */

const { CATEGORIES, GENERAL_RULES, categoryById } = require("./rules");

const API = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

function hasKey() { return Boolean(process.env.ANTHROPIC_API_KEY); }

/** Kompakter Fall-Kontext für das Modell. Nur belegte Angaben, klar getrennt. */
function buildContext({ facts, analysis, notes, mails }) {
  const lines = [];
  lines.push("## Belegte Falldaten (nur diese Angaben dürfen im Text vorkommen)");
  const f = [
    ["Anspruchsteller", facts.claimant],
    ["Aktenzeichen", facts.token],
    ["Versicherung", facts.insurer],
    ["Schaden-Nr.", facts.schadenNr],
    ["Vertrags-Nr.", facts.vertragNr],
    ["Unfalldatum", facts.accidentDate],
    ["Empfänger", [facts.recipPerson, facts.recipOrg, facts.recipEmail].filter(Boolean).join(", ")],
    ["Anrede (vorgegeben)", facts.salutation],
    ["Fällig seit", facts.wait ? `${facts.wait} Tagen` : "heute"]
  ].filter(([, v]) => v);
  f.forEach(([k, v]) => lines.push(`- ${k}: ${v}`));

  if (analysis && analysis.lastOwnRequest) {
    lines.push(`- Unsere letzte Anfrage: ${analysis.lastOwnRequest.slice(0, 10)}`
      + (analysis.ownRequestUnanswered ? " (bislang unbeantwortet)" : " (danach kam eine Antwort)"));
  }

  if (notes && notes.length) {
    lines.push("", "## Interne Aktennotizen (NICHT zitieren — der Empfänger kennt sie nicht)");
    notes.slice(0, 8).forEach(n => lines.push(`- ${String(n.date || "").slice(0, 10)}: ${clip(n.text, 400)}`));
  }

  if (mails && mails.length) {
    lines.push("", "## Mailverlauf, neueste zuerst (EIN = von der Gegenseite, AUS = von uns)");
    mails.slice(0, 6).forEach(m => lines.push(
      `- ${String(m.date || "").slice(0, 10)} ${m.dir}: „${clip(m.text, 600)}“`
    ));
  }
  return lines.join("\n");
}

function clip(t, n) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function systemPrompt() {
  return [
    "Du schreibst Sachstandsanfragen für ein deutsches Kfz-Sachverständigenbüro (Gollenstede) an",
    "Rechtsanwaltskanzleien und Versicherungen. Gefragt wird, ob die Regulierung des Gutachtens bzw.",
    "der Sachverständigen-Kostenrechnung veranlasst wurde.",
    "",
    "HARTE REGELN:",
    "1. Erfinde NIEMALS Zahlen, Daten, Aktenzeichen, Schaden- oder Vertragsnummern. Verwende ausschließlich",
    "   Angaben aus dem Abschnitt „Belegte Falldaten“. Fehlt eine Angabe, lasse sie weg.",
    "2. Keine rechtliche Bewertung, Beratung oder Auslegung (RDG). Keine Haftungsquoten bewerten,",
    "   keine Ansprüche beurteilen, keine Fristen setzen, nicht mahnen, keine Konsequenzen androhen.",
    "3. Übernimm die vorgegebene Anrede und die Grußformel wörtlich:",
    "   Schluss immer „Viele Grüße“ + neue Zeile + „Kfz-Sachverständigenbüro Gollenstede“.",
    "4. Interne Aktennotizen sind Hintergrundwissen — niemals zitieren und nicht erkennbar machen.",
    "   Aus dem Mailverlauf darf zitiert werden, wenn es den Bezug klarer macht.",
    "5. Sachlich, freundlich, knapp: 5 bis 12 Zeilen. Keine Floskelketten, keine Betreffzeile im Text.",
    "",
    GENERAL_RULES,
    "",
    "FALL-KATEGORIEN mit jeweiligem Schwerpunkt:",
    ...CATEGORIES.map(c => `- ${c.id} (${c.label}): ${c.focus}`)
  ].join("\n");
}

const SCHEMA = {
  name: "sachstandsentwurf",
  description: "Einschätzung der Sachlage und fertiger Entwurfstext.",
  input_schema: {
    type: "object",
    properties: {
      kategorie: { type: "string", enum: CATEGORIES.map(c => c.id), description: "Zutreffende Fall-Kategorie." },
      einschaetzung: { type: "string", description: "Der aktuelle Sachstand in einem Satz, mit Datum und Quelle." },
      schwerpunkt: { type: "string", description: "Worauf diese Anfrage den Schwerpunkt legt, in einem Halbsatz." },
      anfrage_sinnvoll: { type: "boolean", description: "false, wenn eine Sachstandsanfrage hier unpassend wäre (z. B. bereits reguliert)." },
      grund_wenn_unpassend: { type: "string", description: "Nur füllen, wenn anfrage_sinnvoll false ist." },
      entwurf: { type: "string", description: "Der vollständige Mailtext inklusive vorgegebener Anrede und Grußformel." }
    },
    required: ["kategorie", "einschaetzung", "schwerpunkt", "anfrage_sinnvoll", "entwurf"]
  }
};

/**
 * Erzeugt einen Entwurf per Modell.
 * @returns {Promise<object>} { entwurf, kategorie, einschaetzung, schwerpunkt, anfrage_sinnvoll, ... }
 */
async function generateDraft({ facts, analysis, notes, mails, instruction, previousDraft }) {
  if (!hasKey()) throw new Error("ANTHROPIC_API_KEY ist nicht gesetzt.");

  const context = buildContext({ facts, analysis, notes, mails });
  const userParts = [context];
  if (previousDraft) {
    userParts.push("", "## Bisheriger Entwurf", previousDraft);
    userParts.push("", `## Änderungswunsch`, instruction || "Fasse den Text knapper.");
  } else {
    userParts.push("", "Erstelle den Entwurf. Bestimme zuerst die Kategorie und den Schwerpunkt, dann den Text.");
  }

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      // Der Systemprompt ist über alle Fälle hinweg byte-identisch. Als
      // Cache-Block markiert kostet er ab dem zweiten Fall im Lauf nur noch
      // ein Zehntel. Der fallspezifische Kontext steht danach und bleibt
      // ungecacht — genau die richtige Reihenfolge.
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: [SCHEMA],
      tool_choice: { type: "tool", name: "sachstandsentwurf" },
      messages: [{ role: "user", content: userParts.join("\n") }]
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${clip(t, 200)}`);
  }
  const json = await res.json();
  const block = (json.content || []).find(c => c.type === "tool_use");
  if (!block || !block.input) throw new Error("Modellantwort ohne strukturierte Ausgabe.");
  return { ...block.input, model: MODEL, usage: json.usage || null };
}

/**
 * Prüft den Entwurf gegen die belegten Fakten.
 * Verhindert das eigentliche Risiko: eine flüssig formulierte, aber falsche Nummer.
 * @returns {{ok: boolean, problems: string[]}}
 */
function validateDraft(text, facts) {
  const problems = [];
  const t = String(text || "");
  if (!t.trim()) return { ok: false, problems: ["leerer Text"] };

  // Erlaubte Zeichenketten: alle belegten Werte plus Datumsangaben aus dem Verlauf.
  const allowed = [facts.token, facts.schadenNr, facts.vertragNr, facts.kennzeichen, facts.accidentDate]
    .filter(Boolean).map(v => String(v).toLowerCase());

  // a) Aktenzeichen-Muster: darf nur das eigene sein.
  for (const m of t.matchAll(/\d{4}\/\d{3,4}\s?TG/gi)) {
    const found = m[0].replace(/\s/g, "").toLowerCase();
    if (!allowed.some(a => a.replace(/\s/g, "").toLowerCase() === found)) {
      problems.push(`fremdes Aktenzeichen im Text: ${m[0]}`);
    }
  }

  // b) Nummern-artige Angaben (Schaden-/Vertragsnummern, Kennzeichen).
  for (const m of t.matchAll(/\b(?:schaden|vertrag|kennzeichen|az)[a-zäöüß.\- ]{0,10}(?:nr\.?|nummer|zeichen)[:\s]+([A-Z0-9][A-Z0-9\-/.]{3,})/gi)) {
    const val = String(m[1]).toLowerCase();
    if (!allowed.some(a => a.includes(val) || val.includes(a))) {
      problems.push(`nicht belegte Nummer im Text: ${m[1]}`);
    }
  }

  // c) Grußformel und Anrede müssen erhalten sein.
  if (!/Kfz-Sachverständigenbüro Gollenstede\s*$/.test(t.trim())) problems.push("Grußformel fehlt oder wurde geändert");
  if (facts.salutation && !t.trim().toLowerCase().startsWith(String(facts.salutation).trim().toLowerCase().slice(0, 12))) {
    problems.push("vorgegebene Anrede nicht übernommen");
  }

  // d) Verbotene Register: Mahnung, Frist, rechtliche Wertung.
  const verboten = /(\bmahn(?:ung|en|wesen)\b|letzte frist|fristsetzung|\bin verzug\b|klage\s+(?:erheben|einreichen|androhen)|gerichtlich vorgehen|rechtliche schritte|rechtsanwalt einschalten|\binkasso\b|schadensersatz verlangen|andernfalls werden wir)/i;
  const hit = verboten.exec(t);
  if (hit) problems.push(`unzulässige Formulierung: „${hit[0]}“`);

  return { ok: problems.length === 0, problems };
}

module.exports = { generateDraft, validateDraft, buildContext, hasKey, systemPrompt, CATEGORIES, categoryById };
