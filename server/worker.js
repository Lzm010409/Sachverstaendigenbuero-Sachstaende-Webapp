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
const digest = require("./digest");
const ai = require("./ai");
const store = require("./store");
const zeit = require("./zeit");

const SUBJECT_PREFIX = /^sachstand anfragen/i;
const MAX_CASES = Number(process.env.MAX_CASES_PER_RUN || 40);
const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 4);

/*
 * Welche Phasen der Pipeline überhaupt angefragt werden.
 *
 * Die Aufgabe „Sachstand anfragen" entsteht in Pipedrive automatisch und hängt
 * anschließend am Deal, egal wohin dieser wandert. Ohne Filter landete deshalb
 * auch ein längst bezahlter Fall in der Freigabe — dort ist nichts mehr
 * nachzufragen. Umgekehrt gehören Klage und Teilbezahlt sehr wohl dazu.
 *
 * Konfiguriert wird über PIPEDRIVE_STUFEN, und zwar über die Namen aus
 * Pipedrive (Nummern werden auch akzeptiert). Drei Schreibweisen:
 *   "Versendet, Teilbezahlt, Klage"        — nur diese Phasen (Voreinstellung)
 *   "nicht: Aufgenommen, In Bearbeitung"   — alle außer diesen
 *   "alle"                                 — kein Filter
 */
const STUFEN_EINSTELLUNG = String(process.env.PIPEDRIVE_STUFEN || "Versendet, Teilbezahlt, Klage");

function stufenRegel(roh = STUFEN_EINSTELLUNG) {
  const text = String(roh || "").trim();
  if (!text || /^alle$/i.test(text)) return { art: "alle", namen: [] };
  const ausser = text.match(/^(?:nicht|ausser|außer)\s*:?\s*(.*)$/i);
  const namen = (ausser ? ausser[1] : text).split(",").map(x => x.trim()).filter(Boolean);
  if (!namen.length) return { art: "alle", namen: [] };
  return { art: ausser ? "ausser" : "nur", namen };
}

/**
 * Übersetzt die Namen aus der Einstellung in Phasen-Nummern.
 *
 * Bewusst nachsichtig: Ein Tippfehler in einem Namen darf nicht dazu führen,
 * dass die halbe Warteschlange verschwindet, ohne dass jemand es merkt. Er wird
 * gemeldet (Protokoll und Lauf-Zusammenfassung); lässt sich KEIN einziger Name
 * auflösen, wird gar nicht gefiltert, statt alles auszusperren.
 */
function stufenFilter(regel, stufen) {
  if (regel.art === "alle") return { aktiv: false, art: "alle", ids: new Set(), namen: [], unbekannt: [] };
  const nachName = new Map((stufen || []).map(s => [s.name.trim().toLowerCase(), s.id]));
  const ids = new Set();
  const namen = [];
  const unbekannt = [];
  for (const n of regel.namen) {
    if (/^\d+$/.test(n)) { ids.add(Number(n)); namen.push(n); continue; }
    const id = nachName.get(n.toLowerCase());
    if (id === undefined) unbekannt.push(n);
    else { ids.add(id); namen.push(n); }
  }
  if (unbekannt.length) {
    console.warn(`[worker] PIPEDRIVE_STUFEN: unbekannte Phase(n) ${unbekannt.join(", ")} —`
      + ` vorhanden sind: ${(stufen || []).map(s => s.name).join(", ")}`);
  }
  if (!ids.size) {
    console.error("[worker] PIPEDRIVE_STUFEN ließ sich nicht auflösen — es wird nicht nach Phase gefiltert.");
    return { aktiv: false, art: "alle", ids, namen, unbekannt };
  }
  return { aktiv: true, art: regel.art, ids, namen, unbekannt };
}

/**
 * Phase eines Deals — Nummer und Klartext, so weit bekannt.
 *
 * Fehlt die Angabe, ist das Ergebnis ausdrücklich `null` und NICHT 0:
 * `Number(null)` ist 0, und 0 ist eine gültig aussehende Phasennummer. Ein Deal
 * ohne Phase wäre damit still ausgesperrt worden statt durchgelassen.
 */
function stufeVonDeal(deal, stufen) {
  const roh = deal && typeof deal.stage_id === "object" && deal.stage_id ? deal.stage_id.id : (deal ? deal.stage_id : null);
  const nr = (roh === null || roh === undefined || roh === "" || !Number.isFinite(Number(roh))) ? null : Number(roh);
  const treffer = nr !== null ? (stufen || []).find(s => s.id === nr) : null;
  return { id: nr, name: treffer ? treffer.name : null };
}

function stufeErlaubt(filter, stufeId) {
  if (!filter || !filter.aktiv) return true;
  // Ohne bekannte Phase wird durchgelassen: lieber einmal zu viel vorlegen als
  // einen Fall wegen einer unvollständigen Antwort stillschweigend verlieren.
  if (stufeId === null || stufeId === undefined) return true;
  return filter.art === "ausser" ? !filter.ids.has(stufeId) : filter.ids.has(stufeId);
}

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

/*
 * Notizen und Mailverlauf für die Anzeige aufbereiten.
 *
 * Bewusst hier und nicht doppelt: Der Lauf erzeugt diese Felder, und das
 * Nachladen im Cockpit (/api/cases/:id/volltext) muss dieselbe Form liefern —
 * sonst sieht ein nachgeladener Fall anders aus als ein frisch gelaufener.
 */
const KURZ_LAENGE = 260;
const VOLL_LAENGE = 20000;

function notizenFuerAnsicht(notes) {
  return notesForAi(notes).slice(0, 6).map(n => ({
    when: fmtDE(n.date),
    text: n.text.slice(0, VOLL_LAENGE)
  }));
}

function threadFuerAnsicht(mails) {
  return (mails || []).slice(0, 6).map(m => {
    const voll = (m.body || m.snippet || "").replace(/[ \t]+/g, " ").trim().slice(0, VOLL_LAENGE);
    const kurz = voll.replace(/\s+/g, " ").slice(0, KURZ_LAENGE);
    return {
      id: m.id,
      dir: m.outgoing ? "out" : "in",
      who: m.outgoing ? "Büro Gollenstede" : ((m.from[0] && (m.from[0].name || m.from[0].email)) || "Gegenseite"),
      tag: m.outgoing ? "Gesendet" : "Eingang",
      when: fmtDE(m.time),
      subject: m.subject || "",
      snippet: kurz,
      // Nur mitschicken, wenn es tatsächlich mehr zu sehen gibt — sonst
      // bläht sich die Warteschlange mit Dubletten auf.
      full: voll.length > kurz.length ? voll : null,
      // Ob überhaupt ein Volltext vorliegt. Der Lauf lädt den Rumpf nur für die
      // neuesten Nachrichten; bei den übrigen steht hier false, und das Cockpit
      // weiß, dass Nachladen etwas bringt.
      hatRumpf: Boolean(m.body)
    };
  });
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

/*
 * Freigabe-Notizen nachtragen, die Pipedrive bei der Freigabe abgelehnt hat
 * (praktisch immer: Tageskontingent aufgebraucht).
 *
 * Diese Notiz ist die dauerhafte Spur einer Anfrage — analyze.js liest sie, um
 * die Wiedervorlage-Frist zu bestimmen. Fehlt sie, könnte derselbe Fall erneut
 * angefragt werden.
 *
 * Läuft im Viertelstundentakt, NICHT nur beim Tageslauf. Am Tageslauf
 * aufgehängt hätte eine abends abgelehnte Notiz bis zum nächsten Morgen
 * gewartet, obwohl das Kontingent um Mitternacht zurückgesetzt wird.
 *
 * Wartezeit zwischen den Anläufen: 15 Minuten, dann verdoppelnd bis höchstens
 * sechs Stunden. So kostet ein aufgebrauchtes Kontingent nur eine Handvoll
 * Aufrufe am Tag statt vier pro Stunde. Nach AUFGEBEN_NACH_TAGEN wird
 * aufgegeben — eine dauerhaft unmögliche Notiz (gelöschter Deal) soll nicht
 * endlos Kontingent verbrauchen.
 */
const WARTE_START_MS = 15 * 60 * 1000;
const WARTE_MAX_MS = 6 * 3600 * 1000;
const AUFGEBEN_NACH_TAGEN = 3;

function naechsterVersuchIn(versuche) {
  return Math.min(WARTE_START_MS * Math.pow(2, Math.max(0, versuche - 1)), WARTE_MAX_MS);
}

async function nacharbeiten({ jetzt = Date.now(), sofort = false } = {}) {
  const state = await store.load();
  if (!state.offeneNacharbeiten.length) return { erledigt: 0, offen: 0 };

  const bleibt = [];
  let erledigt = 0, gesperrt = false;
  for (const n of state.offeneNacharbeiten) {
    // Zu früh, oder ein vorheriger Anlauf in diesem Durchgang ist schon
    // gescheitert: dann gar nicht erst versuchen. Ist das Kontingent leer,
    // scheitern auch alle weiteren und verbrennen nur Aufrufe.
    if (gesperrt || (!sofort && n.naechsterVersuch && jetzt < Date.parse(n.naechsterVersuch))) {
      bleibt.push(n);
      continue;
    }
    try {
      // Reihenfolge wie bei der Freigabe: erst die Notiz, dann die Aufgabe.
      // Jeder gelungene Schritt wird sofort abgehakt, damit ein Fehler im
      // zweiten Schritt den ersten nicht wiederholt — sonst entstünden bei
      // jedem Anlauf weitere Notizen am Deal.
      // Der Fall selbst muss mitgeführt werden. Ohne das blieb in der
      // Ergebniskarte für immer „Noch nicht angelegt" stehen, auch wenn die
      // Notiz längst am Deal hing — die Warteschlange wusste Bescheid, der
      // Fall nicht.
      const fall = n.caseId ? state.cases[n.caseId] : null;

      if (n.notizHtml) {
        await pd.addNote(n.dealId, n.notizHtml);
        n.notizHtml = null;
        if (fall) fall.notiz = { ok: true, am: new Date(jetzt).toISOString(), nachgeholt: true };
      }
      if (n.aufgabeOffen && n.taskId) {
        await pd.completeTask(n.taskId);
        n.aufgabeOffen = false;
        if (fall) fall.aufgabe = { ok: true, am: new Date(jetzt).toISOString(), nachgeholt: true };
      }
      erledigt++;
    } catch (err) {
      gesperrt = true;
      n.versuche = (n.versuche || 0) + 1;
      n.letzterFehler = err.message;
      n.naechsterVersuch = new Date(jetzt + naechsterVersuchIn(n.versuche)).toISOString();
      const fall = n.caseId ? state.cases[n.caseId] : null;
      if (fall) {
        if (n.notizHtml) fall.notiz = { ok: false, fehler: err.message, naechsterVersuch: n.naechsterVersuch };
        if (n.aufgabeOffen) fall.aufgabe = { ok: false, fehler: err.message, naechsterVersuch: n.naechsterVersuch };
      }
      const alterTage = (jetzt - Date.parse(n.seit)) / 86400000;
      if (alterTage < AUFGEBEN_NACH_TAGEN) bleibt.push(n);
      else console.error(`[worker] Nacharbeit zu Deal ${n.dealId} nach ${Math.round(alterTage)} Tagen`
        + ` und ${n.versuche} Versuchen aufgegeben:`, err.message);
      continue;
    }
    // Ist nach dem Durchgang noch etwas offen, bleibt der Eintrag stehen.
    if (n.notizHtml || (n.aufgabeOffen && n.taskId)) bleibt.push(n);
  }
  state.offeneNacharbeiten = bleibt;
  await store.save(state);
  if (erledigt) console.log(`[worker] ${erledigt} Nacharbeit(en) erledigt, ${bleibt.length} offen.`);
  return { erledigt, offen: bleibt.length };
}

/** Ein Durchlauf: fällige Tasks → Analyse → Entwürfe → Warteschlange. */
/**
 * Ein Lauf.
 * @param force  true = alle Fälle neu von Pipedrive laden (Knopf „Aktualisieren").
 *               Sonst werden Fälle übersprungen, die kürzlich analysiert wurden —
 *               das spart den größten Teil des Tages-Kontingents der API.
 */
async function runOnce({ today = new Date(), force = false } = {}) {
  if (running) return { skipped: "läuft bereits" };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    // „Aktualisieren" soll auch ausstehende Notizen sofort erneut versuchen,
    // ohne die Wartezeit abzuwarten — der Knopf ist die Handbedienung.
    await nacharbeiten({ sofort: force });
    // Ortszeit, nicht UTC: Zwischen Mitternacht und 2 Uhr wäre in UTC noch der
    // Vortag, und der Fälligkeitsvergleich läge einen Tag daneben.
    const todayISO = zeit.heuteISO(today);
    const tasks = (await pd.getOpenTasks())
      .filter(t => t.type === "task" && SUBJECT_PREFIX.test(String(t.subject || "")))
      .filter(t => t.due_date && t.due_date <= todayISO)
      .filter(t => t.deal_id)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

    // Phasenfilter vorbereiten. Scheitert der Abruf (leeres Kontingent), wird
    // NICHT gefiltert — sonst stünde das Cockpit wegen eines Nebenaufrufs leer.
    let stufen = [];
    let stufenAbrufFehler = null;
    try { stufen = await pd.getStages(); }
    catch (err) {
      stufenAbrufFehler = err.message;
      console.warn("[worker] Phasen nicht abrufbar, es wird nicht nach Phase gefiltert:", err.message);
    }
    const filter = stufenAbrufFehler
      ? { aktiv: false, art: "alle", ids: new Set(), namen: [], unbekannt: [] }
      : stufenFilter(stufenRegel(), stufen);

    const selected = tasks.slice(0, MAX_CASES);

    // Bereits bekannte Fälle nach Aktenzeichen, um unveränderte Entwürfe
    // wiederzuverwenden (siehe Kostenbremse weiter unten).
    const priorByToken = new Map(
      store.listCases(await store.load()).filter(c => c.token).map(c => [c.token, c])
    );

    // Wiedervorlage-Fenster: Ein Fall, der vor weniger als FALL_TTL_STUNDEN
    // analysiert wurde und auf eine Entscheidung wartet, wird unverändert
    // übernommen — ohne einen einzigen Pipedrive-Aufruf. Neue Post fällt beim
    // nächsten Ablauf des Fensters auf; der Knopf „Aktualisieren" erzwingt sofort.
    const FALL_TTL_MS = Number(process.env.FALL_TTL_STUNDEN || 8) * 3600 * 1000;
    let wiederverwendet = 0;

    const results = await mapLimited(selected, CONCURRENCY, async (task) => {
      const tokenVorab = (String(task.subject || "").match(/\d{4}\/\d{3,4}TG/) || [])[0];
      if (!force && tokenVorab) {
        const bekannt = priorByToken.get(tokenVorab);
        const frisch = bekannt && bekannt.analyzedAt
          && (Date.now() - Date.parse(bekannt.analyzedAt)) < FALL_TTL_MS;
        if (bekannt && frisch && !bekannt.decision) {
          /*
           * Auch der übernommene Fall muss in eine erlaubte Phase gehören.
           *
           * Geprüft wird die zuletzt GESPEICHERTE Phase — dieser Zweig holt
           * bewusst nichts von Pipedrive, das ist sein ganzer Sinn. Er greift
           * also, wenn sich die Einstellung geändert hat, nicht wenn der Deal
           * gerade eben umgezogen ist. Ein umgezogener Fall fällt beim nächsten
           * vollen Durchgang heraus (spätestens nach FALL_TTL_STUNDEN) oder
           * sofort über „Aktualisieren".
           *
           * Fälle aus der Zeit vor dem Phasenfilter haben keine gespeicherte
           * Phase; sie werden durchgelassen statt reihenweise entfernt.
           */
          if (!stufeErlaubt(filter, bekannt.stageId === undefined ? null : bekannt.stageId)) {
            return { __gefiltert: { id: bekannt.id, token: bekannt.token, stufe: { id: bekannt.stageId, name: bekannt.stageName } } };
          }
          wiederverwendet++;
          return bekannt;                     // unverändert übernehmen
        }
      }
      // Der Deal kommt zuerst, allein wegen der Phase: Fällt der Fall hier
      // heraus, sparen Notizen und Mailverlauf zwei weitere Aufrufe des
      // Tageskontingents — je Lauf und Fall.
      const deal = await pd.getDeal(task.deal_id);
      const stufe = stufeVonDeal(deal, stufen);
      if (!stufeErlaubt(filter, stufe.id)) {
        return { __gefiltert: { id: `task-${task.id}`, token: tokenVorab || null, stufe } };
      }
      const [notes, mailRes] = await Promise.all([
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

      // Fingerabdruck des Falls — muss VOR der Kostenbremse stehen, die ihn
      // mit dem gespeicherten Stand vergleicht.
      const newestMailTime = mails.length ? mails[0].time : "";
      const fingerprint = [newestMailTime, mails.length, notes.length, task.due_date].join("|");

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

        // Kostenbremse: Der Lauf wiederholt sich alle POLL_MINUTES. Hat sich am Fall
        // nichts geändert (gleicher Fingerprint) und liegt bereits ein geprüfter
        // KI-Entwurf vor, wird er wiederverwendet statt neu erzeugt. Ohne das würde
        // jeder Lauf für jeden Fall erneut beim Modell anfragen.
        const prior = priorByToken.get(token);
        const reusable = prior
          && prior.fingerprint === fingerprint
          && prior.ai && prior.ai.used
          && prior.draft
          && !prior.decision;
        if (reusable) {
          draft = { ...draft, body: prior.draft };
          aiInfo = { ...prior.ai, reused: true };
        } else if (ai.hasKey()) {
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
                hinweisWennUnpassend: out.grund_wenn_unpassend || null,
                usage: out.usage || null
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
        thread: threadFuerAnsicht(mails),
        notizen: notizenFuerAnsicht(notes),
        ai: aiInfo,
        lawyerOrgId: facts.lawyerOrgId || null,
        stageId: stufe.id,
        stageName: stufe.name,
        pipedriveUrl: buildDealUrl(task.deal_id),
        fingerprint,
        analyzedAt: new Date().toISOString(),
        // Kontext nur für den zweiten Durchgang; wird vor dem Speichern entfernt.
        __ctx: { analysis, claimant: analysis.claimant, accidentDate: facts.accidentDate, caseNumber: facts.schadenNr || facts.vertragNr, mails }
      };
    });

    let fresh = results.filter(r => r && !r.__error && !r.__gefiltert);
    const errors = results.filter(r => r && r.__error).map(r => r.__error);
    const gefiltert = results.filter(r => r && r.__gefiltert).map(r => r.__gefiltert);

    // --- Zweiter Durchgang: Adressverzeichnis anwenden -----------------------
    // Erst lernen, welche Adresse zu welcher Kanzlei gehört, dann Fälle ohne
    // eigene Korrespondenz damit auffüllen und deren Entwurf nachziehen.
    const dir = await directory.load();
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
    await directory.save(dir);

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

    const state = await store.load();
    // Tokenverbrauch des Laufs aufsummieren, damit die Kosten nachvollziehbar sind.
    // Preise Sonnet 5 (Einführungspreis): 2 $ / 10 $ je Mio. Token; gecachte
    // Eingabe kostet ein Zehntel.
    const spend = fresh.reduce((acc, c) => {
      const u = c.ai && c.ai.used && !c.ai.reused ? c.ai.usage : null;
      if (!u) return acc;
      acc.inNeu += u.input_tokens || 0;
      acc.inCacheWrite += u.cache_creation_input_tokens || 0;
      acc.inCacheRead += u.cache_read_input_tokens || 0;
      acc.out += u.output_tokens || 0;
      acc.calls += 1;
      return acc;
    }, { inNeu: 0, inCacheWrite: 0, inCacheRead: 0, out: 0, calls: 0 });
    const IN = Number(process.env.PREIS_INPUT_USD_PRO_MIO || 2);
    const OUT = Number(process.env.PREIS_OUTPUT_USD_PRO_MIO || 10);
    spend.usd = Number((
      (spend.inNeu / 1e6) * IN
      + (spend.inCacheWrite / 1e6) * IN * 1.25
      + (spend.inCacheRead / 1e6) * IN * 0.1
      + (spend.out / 1e6) * OUT
    ).toFixed(4));
    if (spend.calls) {
      console.log(`[ai] ${spend.calls} Entwürfe erzeugt, geschätzte Kosten ${spend.usd.toFixed(4)} USD`
        + ` (Cache gelesen: ${spend.inCacheRead} Token)`);
    }

    /*
     * Fälle, die inzwischen in eine ausgeschlossene Phase gewandert sind, aus
     * der Warteschlange nehmen — aber nur unentschiedene.
     *
     * Das ist kein Aufräumen nach Abwesenheit (das wäre gefährlich, siehe
     * store.aufraeumen), sondern nach positiver Feststellung: Wir haben den
     * Deal in diesem Lauf gesehen und seine Phase gelesen. Entschiedene Fälle
     * bleiben stehen, damit die Ergebniskarte ihre Frist ausleben kann.
     */
    let ausgephast = 0;
    for (const g of gefiltert) {
      const vorhanden = g && g.id ? state.cases[g.id] : null;
      if (!vorhanden || vorhanden.decision) continue;
      delete state.cases[g.id];
      ausgephast++;
    }
    if (ausgephast) {
      console.log(`[worker] ${ausgephast} Fall/Fälle aus der Warteschlange genommen`
        + ` — Phase nicht mehr in PIPEDRIVE_STUFEN.`);
    }

    store.mergeCases(state, fresh);
    const pending = store.pendingCount(state);
    state.lastRun = startedAt;
    state.lastRunSummary = {
      dueTasks: tasks.length,
      analyzed: fresh.length,
      drafts: fresh.filter(c => c.needsDraft).length,
      skipped: fresh.filter(c => !c.needsDraft).length,
      mailErrors: fresh.filter(c => c.mailError).length,
      aiSpend: spend,
      apiAufrufe: pd.takeRequestCount(),
      wiederverwendet,
      // Phasenfilter sichtbar machen: Wer einen Fall vermisst, soll hier sehen,
      // ob die Einstellung ihn aussortiert hat — und welche Einstellung gilt.
      stufen: {
        einstellung: STUFEN_EINSTELLUNG,
        aktiv: filter.aktiv,
        art: filter.art,
        erkannt: filter.namen,
        unbekannt: filter.unbekannt,
        abrufFehler: stufenAbrufFehler,
        aussortiert: gefiltert.length,
        phasen: gefiltert.reduce((acc, g) => {
          const n = (g.stufe && (g.stufe.name || g.stufe.id)) || "unbekannt";
          acc[n] = (acc[n] || 0) + 1;
          return acc;
        }, {})
      },
      errors: errors.slice(0, 5),
      pending
    };
    console.log(`[worker] Lauf fertig: ${state.lastRunSummary.analyzed} Fälle`
      + ` (${wiederverwendet} unverändert übernommen), ${state.lastRunSummary.apiAufrufe} Pipedrive-Aufrufe,`
      + ` ${pending} zur Freigabe.`
      + (gefiltert.length ? ` ${gefiltert.length} wegen der Phase aussortiert`
        + ` (${Object.entries(state.lastRunSummary.stufen.phasen).map(([k, v]) => `${k}: ${v}`).join(", ")}).` : ""));
    // Tägliche Übersicht — prüft selbst, ob heute schon eine raus ist.
    try {
      const d = await digest.maybeSendDigest(state, store.listCases(state));
      if (d.gesendet) await store.save(state);          // Stempel festhalten
      else if (d.grund && !/bereits|vor \d+ Uhr/.test(d.grund)) {
        console.log(`[digest] nicht versendet: ${d.grund}`);
      }
    } catch (err) {
      console.warn("[digest] Versand fehlgeschlagen:", err.message);
    }

    await store.save(state);
    lastError = null;

    await maybeNotify(state.lastRunSummary, pending);
    return state.lastRunSummary;
  } catch (err) {
    lastError = err.message;
    const state = await store.load();
    state.lastRun = startedAt;
    state.lastRunSummary = { error: err.message };
    await store.save(state);
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

/**
 * Startet die Zeitsteuerung.
 *
 * Sachstände sind Tagesgeschäft: Ein voller Lauf am Tag genügt und kostet rund
 * 110 Pipedrive-Aufrufe. Ein fester Abstand ab Prozessstart wäre ungeeignet —
 * nach jedem Neustart verschöbe sich die Uhrzeit, im ungünstigen Fall mitten in
 * die Nacht. Stattdessen wird viertelstündlich nur die Uhr geprüft (kostet
 * nichts) und höchstens einmal am Tag ab LAUF_STUNDE wirklich gelaufen.
 *
 * Der Knopf „Aktualisieren" löst jederzeit einen sofortigen Lauf aus.
 */
function start() {
  if (!pd.hasToken()) {
    console.warn("[worker] PIPEDRIVE_API_TOKEN fehlt — Hintergrundlauf deaktiviert.");
    return;
  }
  const laufStunde = Number(process.env.LAUF_STUNDE || 7);
  const taktMinuten = Number(process.env.TAKT_MINUTEN || 15);

  const tick = async () => {
    // Zuerst, und unabhängig vom Tageslauf: ausstehende Freigabe-Notizen.
    // Eigener Fehlerfang, damit ein Problem hier den Takt nicht abbricht.
    try { await nacharbeiten(); }
    catch (err) { console.warn("[worker] Nacharbeiten fehlgeschlagen:", err.message); }

    try {
      const state = await store.load();
      const heute = zeit.heuteISO();
      const stunde = zeit.stunde();

      if (state.laufGemachtAm !== heute && stunde >= laufStunde) {
        await runOnce();
        const nachher = await store.load();
        nachher.laufGemachtAm = heute;
        await store.save(nachher);
      } else {
        // Kein Lauf fällig — die Übersichtsmail hat eine eigene Uhrzeit und
        // wird deshalb trotzdem geprüft. Ohne Versand kostet das nichts.
        //
        // Eigener Fehlerfang: Ist der Mailversand gestört (etwa weil die
        // Graph-Berechtigung noch fehlt), darf das nicht den ganzen Takt
        // abbrechen. Die Übersicht ist Beiwerk, der Lauf ist die Hauptsache.
        try {
          const d = await digest.maybeSendDigest(state, store.listCases(state));
          if (d.gesendet) await store.save(state);
        } catch (err) {
          console.warn("[digest] nicht versendet:", err.message);
        }
      }
    } catch (err) {
      console.error("[worker] Lauf fehlgeschlagen:", err.message);
    }
  };

  setTimeout(tick, 4000);                                   // kurz nach dem Start
  setInterval(tick, Math.max(1, taktMinuten) * 60 * 1000);
  console.log(`[worker] Ein Lauf pro Tag ab ${laufStunde} Uhr;`
    + ` Prüftakt alle ${taktMinuten} Minuten (ohne Abrufe).`);
}

module.exports = {
  stufenRegel, stufenFilter, stufeVonDeal, stufeErlaubt,
  runOnce, start, nacharbeiten,
  notizenFuerAnsicht, threadFuerAnsicht,
  isRunning: () => running, getLastError: () => lastError
};
