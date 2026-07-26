"use strict";

/*
 * Hintergrund-Lauf: sammelt fällige Sachstände, analysiert sie und legt fertige
 * Entwürfe in die Freigabe-Warteschlange. Läuft ohne Zutun (Intervall über
 * POLL_MINUTES), damit im Cockpit nur noch zu prüfen ist, was wirklich anliegt.
 *
 * Schreibt NICHTS nach außen: keine Mail, keine Pipedrive-Änderung. Erst die
 * Freigabe im Cockpit löst Aktionen aus.
 */

const pd = require("./pipedrive");
const { analyzeCase, extractToken, fmtDE } = require("./analyze");
const { buildDraft } = require("./draft");
const { getDealFacts } = require("./fields");
const directory = require("./directory");
const ai = require("./ai");
const store = require("./store");

const SUBJECT_PREFIX = /^sachstand anfragen/i;
const MAX_CASES = Number(process.env.MAX_CASES_PER_RUN || 40);
const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 4);

let running = false;
let lastError = null;

/** Notizen für den KI-Kontext: HTML entfernt, eigene Entwurfs-/Freigabenotizen raus. */
function notesForAi(notes) {
  return (notes || [])
    .map(n => ({
      date: n.add_time,
      text: String(n.content || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim()
    }))
    .filter(n => n.text && !/Sachstandsanfrage \(Entwurf|Sachstandsanfrage freigegeben/i.test(n.text))
    .slice(0, 8);
}

async function mapLimited(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (err) { out[idx] = { __error: err.message, item: items[idx] }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Ein Durchlauf: fällige Tasks → Analyse → Entwürfe → Warteschlange. */
async function runOnce({ today = new Date() } = {}) {
  if (running) return { skipped: "läuft bereits" };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const todayISO = today.toISOString().slice(0, 10);
    const tasks = (await pd.getOpenTasks())
      .filter(t => t.type === "task" && SUBJECT_PREFIX.test(String(t.subject || "")))
      .filter(t => t.due_date && t.due_date <= todayISO)
      .filter(t => t.deal_id)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

    const selected = tasks.slice(0, MAX_CASES);

    const results = await mapLimited(selected, CONCURRENCY, async (task) => {
      const [deal, notes, mailRes] = await Promise.all([
        pd.getDeal(task.deal_id),
        pd.getNotes(task.deal_id),
        pd.getDealMails(task.deal_id)
      ]);

      const person = deal && deal.person_id && typeof deal.person_id === "object" ? deal.person_id : null;
      const org = deal && deal.org_id && typeof deal.org_id === "object" ? deal.org_id : null;
      const mails = mailRes.mails || [];

      // Feldwerte über die echten Feldnamen auflösen (nicht raten) und die im
      // Deal hinterlegte Kanzlei nachladen — sie ist der belastbare Empfänger.
      const facts = await getDealFacts(deal);
      const lawyerOrg = facts.lawyerOrgId ? await pd.getOrganization(facts.lawyerOrgId) : null;

      const analysis = analyzeCase({ task, deal, notes, mails, person, org, lawyerOrg, today });
      const token = analysis.token || extractToken(deal && deal.title);

      let draft = null;
      let aiInfo = null;
      if (analysis.needsDraft) {
        // Immer zuerst den deterministischen Entwurf bauen: er dient als Netz und
        // liefert die verbindliche Anrede für das Modell.
        draft = buildDraft({
          analysis, token,
          claimant: analysis.claimant,
          accidentDate: facts.accidentDate,
          insurer: analysis.insurer,
          caseNumber: facts.schadenNr || facts.vertragNr,
          mails
        });

        if (ai.hasKey()) {
          const factSet = {
            claimant: analysis.claimant, token,
            insurer: analysis.insurer, schadenNr: facts.schadenNr, vertragNr: facts.vertragNr,
            kennzeichen: facts.kennzeichen, accidentDate: facts.accidentDate,
            recipPerson: analysis.recipient && analysis.recipient.person,
            recipOrg: analysis.recipient && analysis.recipient.org,
            recipEmail: analysis.recipient && analysis.recipient.email,
            salutation: draft.body.split("\n")[0],
            wait: analysis.overdueDays
          };
          try {
            const out = await ai.generateDraft({
              facts: factSet, analysis,
              notes: notesForAi(notes),
              mails: mails.slice(0, 6).map(m => ({
                date: m.time, dir: m.outgoing ? "AUS" : "EIN", text: m.body || m.snippet
              }))
            });
            const noRequest = require("./rules").NO_REQUEST_IDS.includes(out.kategorie)
              || out.anfrage_sinnvoll === false;
            const check = ai.validateDraft(out.entwurf, factSet);
            if (noRequest) {
              // Sachlage passt nicht zu einer Sachstandsanfrage (z. B. eigene titulierte
              // Forderung, Honorarklärung mit dem Kunden). Kein Entwurf, aber der Fall
              // bleibt sichtbar und wird mit Begründung vorgelegt.
              aiInfo = {
                used: true, model: out.model, kategorie: out.kategorie,
                einschaetzung: out.einschaetzung, schwerpunkt: out.schwerpunkt,
                anfrageSinnvoll: false,
                hinweisWennUnpassend: out.grund_wenn_unpassend || "Sachlage passt nicht zu einer Sachstandsanfrage."
              };
            } else if (check.ok) {
              draft = { ...draft, body: out.entwurf };
              aiInfo = {
                used: true, model: out.model, kategorie: out.kategorie,
                einschaetzung: out.einschaetzung, schwerpunkt: out.schwerpunkt,
                anfrageSinnvoll: out.anfrage_sinnvoll !== false,
                hinweisWennUnpassend: out.grund_wenn_unpassend || null
              };
            } else {
              // Prüfschritt hat angeschlagen: Baukasten behalten, Grund festhalten.
              aiInfo = { used: false, model: out.model, problems: check.problems, kategorie: out.kategorie };
              console.warn(`[ai] Entwurf verworfen (${token}):`, check.problems.join("; "));
            }
          } catch (err) {
            aiInfo = { used: false, error: err.message };
            console.warn(`[ai] nicht verfügbar (${token}):`, err.message);
          }
        }
      }

      // Fingerprint: erkennt neue Korrespondenz/Notizen am Fall.
      const newestMailTime = mails.length ? mails[0].time : "";
      const fingerprint = [newestMailTime, mails.length, notes.length, task.due_date].join("|");

      return {
        id: `task-${task.id}`,
        taskId: task.id,
        dealId: task.deal_id,
        token: token || null,
        name: analysis.claimant || (deal && deal.title) || `Deal ${task.deal_id}`,
        due: task.due_date,
        dueDE: fmtDE(task.due_date),
        wait: analysis.overdueDays,
        status: analysis.status,
        needsDraft: analysis.needsDraft,
        isRueckfrage: analysis.isRueckfrage,
        skipReason: analysis.skipReason,
        calloutType: analysis.calloutType,
        calloutTitle: analysis.calloutTitle,
        calloutBody: analysis.calloutBody,
        recipEmail: analysis.recipient ? analysis.recipient.email : null,
        recipOrg: analysis.recipient ? analysis.recipient.org : null,
        recipPerson: analysis.recipient ? analysis.recipient.person : null,
        recipType: analysis.recipient ? analysis.recipient.type : null,
        recipSource: analysis.recipient ? analysis.recipient.source : null,
        insurer: analysis.insurer,
        accident: facts.accidentDate ? fmtDE(facts.accidentDate) : null,
        schadenNr: facts.schadenNr,
        vertragNr: facts.vertragNr,
        kennzeichen: facts.kennzeichen,
        du: draft ? draft.du : false,
        salutationReason: draft ? draft.salutationReason : null,
        subject: draft ? draft.subject : null,
        draft: draft ? draft.body : null,
        mailError: mailRes.ok ? null : mailRes.error,
        thread: mails.slice(0, 6).map(m => ({
          dir: m.outgoing ? "out" : "in",
          who: m.outgoing ? "Büro Gollenstede" : ((m.from[0] && (m.from[0].name || m.from[0].email)) || "Gegenseite"),
          tag: m.outgoing ? "Gesendet" : "Eingang",
          when: fmtDE(m.time),
          snippet: (m.snippet || m.body || "").replace(/\s+/g, " ").slice(0, 260)
        })),
        ai: aiInfo,
        lawyerOrgId: facts.lawyerOrgId || null,
        pipedriveUrl: buildDealUrl(task.deal_id),
        fingerprint,
        analyzedAt: new Date().toISOString(),
        // Kontext nur für den zweiten Durchgang; wird vor dem Speichern entfernt.
        __ctx: { analysis, claimant: analysis.claimant, accidentDate: facts.accidentDate, caseNumber: facts.schadenNr || facts.vertragNr, mails }
      };
    });

    let fresh = results.filter(r => r && !r.__error);
    const errors = results.filter(r => r && r.__error).map(r => r.__error);

    // --- Zweiter Durchgang: Adressverzeichnis anwenden -----------------------
    // Erst lernen, welche Adresse zu welcher Kanzlei gehört, dann Fälle ohne
    // eigene Korrespondenz damit auffüllen und deren Entwurf nachziehen.
    const dir = directory.load();
    for (const c of fresh) {
      // Nur lernen, wenn die Organisation aus dem Feld „Rechtsanwalt" stammt —
      // aus Mails abgeleitete Namen könnten sonst falsche Adressen verknüpfen.
      if (c.recipEmail && c.recipOrg && c.lawyerOrgId) {
        directory.learn(dir, {
          orgId: c.lawyerOrgId, orgName: c.recipOrg, email: c.recipEmail,
          person: c.recipPerson, seenAt: c.analyzedAt
        });
      }
    }
    directory.save(dir);

    fresh = fresh.map(c => {
      if (c.recipEmail || !c.recipOrg) return c;
      const hit = directory.lookup(dir, { orgId: c.lawyerOrgId, orgName: c.recipOrg });
      if (!hit) return c;
      const filled = {
        ...c,
        recipEmail: hit.email,
        recipPerson: c.recipPerson || hit.person || null,
        recipSource: (c.recipSource || "") + " · Adresse aus Verzeichnis",
        status: c.status === "unklar" ? (c.wait > 0 ? "ueberfaellig" : "faellig") : c.status,
        skipReason: c.skipReason === "Empfänger unklar" ? null : c.skipReason,
        needsDraft: c.skipReason === "Empfänger unklar" ? true : c.needsDraft
      };
      if (filled.needsDraft && !filled.draft && filled.__ctx) {
        const d = buildDraft({
          analysis: { ...filled.__ctx.analysis, recipient: { ...filled.__ctx.analysis.recipient, email: hit.email, person: filled.recipPerson } },
          token: filled.token, claimant: filled.__ctx.claimant,
          accidentDate: filled.__ctx.accidentDate, insurer: filled.insurer,
          caseNumber: filled.__ctx.caseNumber, mails: filled.__ctx.mails
        });
        filled.draft = d.body; filled.subject = d.subject; filled.du = d.du;
        filled.salutationReason = d.salutationReason;
        filled.calloutTitle = filled.__ctx.analysis.calloutTitle;
        filled.calloutBody = filled.__ctx.analysis.calloutBody;
        filled.calloutType = filled.__ctx.analysis.calloutType;
      }
      delete filled.__ctx;
      return filled;
    }).map(c => { const { __ctx, ...rest } = c; return rest; });

    const state = store.load();
    store.mergeCases(state, fresh);
    const pending = store.pendingCount(state);
    state.lastRun = startedAt;
    state.lastRunSummary = {
      dueTasks: tasks.length,
      analyzed: fresh.length,
      drafts: fresh.filter(c => c.needsDraft).length,
      skipped: fresh.filter(c => !c.needsDraft).length,
      mailErrors: fresh.filter(c => c.mailError).length,
      errors: errors.slice(0, 5),
      pending
    };
    store.save(state);
    lastError = null;

    await maybeNotify(state.lastRunSummary, pending);
    return state.lastRunSummary;
  } catch (err) {
    lastError = err.message;
    const state = store.load();
    state.lastRun = startedAt;
    state.lastRunSummary = { error: err.message };
    store.save(state);
    throw err;
  } finally {
    running = false;
  }
}

function buildDealUrl(dealId) {
  const dom = process.env.PIPEDRIVE_COMPANY_DOMAIN || process.env.PIPEDRIVE_DOMAIN;
  return dom ? `https://${dom}.pipedrive.com/deal/${dealId}` : null;
}

/**
 * Benachrichtigung — nur wenn wirklich etwas zu tun ist bzw. ein Fehler auftrat.
 * Nutzt den bestehenden n8n-Benachrichtigungs-Webhook, falls konfiguriert.
 */
let lastNotifiedPending = null;
async function maybeNotify(summary, pending) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const hasError = Boolean(summary.error) || (summary.errors && summary.errors.length);
  if (!hasError && (pending === 0 || pending === lastNotifiedPending)) return;
  lastNotifiedPending = pending;
  const appUrl = process.env.APP_PUBLIC_URL || "";
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "sachstaende-anfrage-entwuerfe",
        status: hasError ? "error" : "ok",
        summary: `${pending} Sachstandsanfrage(n) warten auf Freigabe`,
        details: [
          `${summary.drafts || 0} Entwürfe, ${summary.skipped || 0} übersprungen`,
          summary.mailErrors ? `${summary.mailErrors} Fälle ohne Mailzugriff` : "",
          appUrl ? `Freigeben: ${appUrl}` : ""
        ].filter(Boolean).join(" · ")
      })
    });
  } catch (err) {
    console.error("[worker] Benachrichtigung fehlgeschlagen:", err.message);
  }
}

/** Startet den periodischen Lauf. */
function start() {
  const minutes = Number(process.env.POLL_MINUTES || 30);
  if (!pd.hasToken()) {
    console.warn("[worker] PIPEDRIVE_API_TOKEN fehlt — Hintergrundlauf deaktiviert.");
    return;
  }
  const tick = () => runOnce().catch(err => console.error("[worker] Lauf fehlgeschlagen:", err.message));
  // Erster Lauf kurz nach dem Start, damit die App nicht leer wirkt.
  setTimeout(tick, 4000);
  setInterval(tick, Math.max(5, minutes) * 60 * 1000);
  console.log(`[worker] Hintergrundlauf aktiv, alle ${minutes} Minuten.`);
}

module.exports = { runOnce, start, isRunning: () => running, getLastError: () => lastError };
