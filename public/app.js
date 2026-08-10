/* Sachstands-Cockpit — Frontend-Logik.
 * Holt Fälle aus /api/cases und verdrahtet Freigeben / Ändern lassen / Überspringen
 * gegen die API-Endpunkte. Läuft ohne Framework, reines DOM. */
(function () {
  "use strict";

  const STATUS_LABEL = {
    faellig: "Fällig", ueberfaellig: "Überfällig", rueckfrage: "Rückfrage offen",
    reguliert: "Reguliert", unklar: "Empfänger unklar", sent: "Freigegeben", skipped: "Übersprungen",
    abwarten: "Abwarten", bereits_angefragt: "Bereits angefragt"
  };
  const STRIPE = {
    faellig: "var(--accent)", ueberfaellig: "var(--critical)", rueckfrage: "var(--warn)",
    reguliert: "var(--ok)", unklar: "var(--border-strong)",
    abwarten: "var(--warn)", bereits_angefragt: "var(--ok)"
  };

  const listEl = document.getElementById("list");
  const detailEl = document.getElementById("detail");
  const kpisEl = document.getElementById("kpis");
  const toastsEl = document.getElementById("toasts");
  const demoBadge = document.getElementById("demoBadge");

  let CASES = [];
  let activeId = null;
  let filter = "offen";

  document.getElementById("today").textContent = new Date().toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit", year: "numeric"
  });

  const CAT_LABELS = {
    neu_ohne_reaktion: "Frische Akte", honorarkuerzung_rueckabtretung: "SVK gekürzt / Abtretung",
    teilzahlung_restbetrag: "Teilzahlung, Rest offen", klage_anhaengig: "Verfahren läuft",
    quote_strittig: "Quote strittig", akteneinsicht_offen: "Akteneinsicht offen",
    kanzlei_ausgefallen: "Kanzlei ausgefallen", rueckfrage_offen: "Rückfrage bei uns",
    mandat_beendet_honorarklaerung: "Honorarklärung Kunde", titulierte_eigenforderung: "Eigene Forderung tituliert"
  };
  function catLabel(id) { return CAT_LABELS[id] || id; }

  // --- Ansichtssteuerung (nur am Handy wirksam; am Desktop stehen beide Spalten) ---
  const appEl = document.querySelector(".app");
  const mobileQuery = window.matchMedia("(max-width: 860px)");
  function isMobile() { return mobileQuery.matches; }
  function setView(view) {
    appEl.setAttribute("data-view", view);
    // Beim Wechsel oben beginnen, sonst erbt die neue Ansicht die alte Scrollposition.
    const target = view === "detail" ? detailEl : listEl;
    if (target) target.scrollTop = 0;
  }
  // Wird das Fenster breit (Tablet gedreht), ist die Aufteilung wieder zweispaltig.
  mobileQuery.addEventListener("change", e => { if (!e.matches) setView("list"); });

  function esc(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (res.status === 401) {
      // Sitzung abgelaufen — zur Anmeldung, sonst laufen alle weiteren Aufrufe ins Leere.
      window.location.href = "/login";
      throw new Error("Sitzung abgelaufen, Weiterleitung zur Anmeldung.");
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ("HTTP " + res.status));
    return res.json();
  }

  /** Braucht dieser Fall eine Entscheidung von mir? */
  function isPending(c) {
    return !c._resolved && Boolean(c.draft);
  }

  /**
   * Frisch entschieden — bleibt noch eine Weile in der Arbeitsliste stehen,
   * damit nach der Freigabe nachvollziehbar ist, was gerade erledigt wurde.
   * Danach wandert der Fall in den Filter „Erledigt".
   */
  function istFrischEntschieden(c) {
    if (!c._resolved) return false;
    const stunden = Number(c.nachleuchtenStunden || 6);
    const seit = c.decidedAt ? Date.parse(c.decidedAt) : (c._decidedLocal || 0);
    if (!seit) return Boolean(c._decidedLocal);      // gerade in dieser Sitzung entschieden
    return (Date.now() - seit) < stunden * 3600 * 1000;
  }

  /** Was in der Arbeitsliste erscheint: offene Fälle plus frisch entschiedene. */
  function inArbeitsliste(c) {
    return isPending(c) || istFrischEntschieden(c);
  }

  function visible(c) {
    if (filter === "alle") return true;
    // „Erledigt" heißt entschieden — freigegeben oder übersprungen. Vorher stand
    // hier !isPending(c); damit galt jeder Fall ohne Entwurf als erledigt, auch
    // „Empfänger unklar" und „Bereits angefragt". Die sind aber nicht erledigt,
    // sondern nur nicht zu entscheiden — „Empfänger unklar" verlangt sogar eine
    // Ergänzung in Pipedrive. Sie stehen jetzt unter „Alle".
    if (filter === "erledigt") return Boolean(c._resolved);
    if (!inArbeitsliste(c)) return false;
    if (filter === "ueberfaellig") return isPending(c) && c.status === "ueberfaellig";
    if (filter === "rueckfrage") return isPending(c) && c.status === "rueckfrage";
    return true;                                             // "offen"
  }

  function renderKpis() {
    const pending = CASES.filter(isPending);
    const ueber = pending.filter(c => c.status === "ueberfaellig").length;
    const rueck = pending.filter(c => c.status === "rueckfrage").length;
    // Muss zum Filter „Erledigt" passen: entschieden, nicht bloß „ohne Entwurf".
    const done = CASES.filter(c => c._resolved).length;
    const compact = document.getElementById("kpisCompact");
    if (compact) {
      compact.textContent = [
        `${pending.length} zu prüfen`,
        ueber ? `${ueber} überfällig` : "",
        rueck ? `${rueck} Rückfrage${rueck === 1 ? "" : "n"}` : "",
        done ? `${done} erledigt` : ""
      ].filter(Boolean).join(" · ");
    }
    kpisEl.innerHTML =
      `<div class="kpi"><b>${pending.length}</b><span>zu prüfen</span></div>` +
      `<div class="kpi crit"><b>${ueber}</b><span>überfällig</span></div>` +
      `<div class="kpi warn"><b>${rueck}</b><span>Rückfragen</span></div>` +
      `<div class="kpi"><b>${done}</b><span>erledigt</span></div>`;
  }

  function renderList() {
    listEl.innerHTML = "";
    const shown = CASES.filter(visible);
    if (!shown.length) {
      listEl.innerHTML = `<div class="empty" style="height:auto;padding:30px 16px;font-size:13px;">${
        filter === "offen" ? "Nichts zu prüfen — alles erledigt. 🎉" : "Keine Fälle in diesem Filter."}</div>`;
      return;
    }
    shown.forEach(c => {
      const st = c._resolved || c.status;
      const btn = document.createElement("button");
      btn.className = "case" + (c.id === activeId ? " active" : "") + (c._resolved ? " done" : "");
      btn.style.setProperty("--stripe", STRIPE[c.status] || "var(--border-strong)");
      const recip = c.recipOrg ? esc(c.recipOrg) : "— kein Empfänger —";
      const waitTxt = c._resolved
        ? STATUS_LABEL[c._resolved]
        : (c.wait === 0 ? "heute fällig" : "wartet seit " + c.wait + " Tg.");
      btn.innerHTML =
        `<div class="row1"><span class="az mono">${esc(c.token)}</span>` +
        `<span class="chip ${st}">${STATUS_LABEL[st]}</span></div>` +
        `<div class="name">${esc(c.name)}</div>` +
        `<div class="recip">${recip}</div>` +
        `<div class="row3"><span class="wait">${waitTxt}</span>` +
        `<span class="wait">fällig ${esc(c.dueDE || c.due)}</span></div>`;
      btn.addEventListener("click", () => selectCase(c.id));
      listEl.appendChild(btn);
    });
  }

  function metaCells(c) {
    const cells = [["Anspruchsteller", esc(c.name)], ["Unfalltag", esc(c.accident)]];
    if (c.insurer) cells.push(["Versicherung", esc(c.insurer)]);
    if (c.schadenNr) cells.push(["Schaden-Nr.", `<span class="mono">${esc(c.schadenNr)}</span>`]);
    if (c.vertragNr) cells.push(["Vertrags-Nr.", `<span class="mono">${esc(c.vertragNr)}</span>`]);
    if (c.kennzeichen) cells.push(["Kennzeichen", `<span class="mono">${esc(c.kennzeichen)}</span>`]);
    cells.push(["Fällig am", esc(c.dueDE || c.due)]);
    if (c.pipedriveUrl) cells.push(["Pipedrive", `<a href="${esc(c.pipedriveUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">Deal öffnen ↗</a>`]);
    return cells.map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  }

  /**
   * Gekürzter Text plus Aufklapper, wenn es mehr zu lesen gibt.
   * <details> statt eigener Klick-Logik: funktioniert ohne Verdrahtung, bleibt
   * beim Neuzeichnen erhalten und lässt sich auf dem Handy bedienen.
   */
  function langtext(voll, label) {
    if (!voll) return "";
    return `<details class="mehr"><summary>${esc(label)}</summary>` +
      `<div class="volltext">${esc(voll)}</div></details>`;
  }

  // --- Leseansicht ---------------------------------------------------------
  // Der Verlauf bleibt als Übersicht kurz; wer einen Text ganz lesen will,
  // bekommt ihn groß darüber. Vorher steckte der Volltext in einem schmalen
  // Kästchen in der Spalte — für eine ganze Anwaltsmail unbrauchbar.
  const leser = document.getElementById("leser");

  function leserAuf({ titel, sub, text, fuss }) {
    document.getElementById("leserTitel").textContent = titel || "";
    document.getElementById("leserSub").textContent = sub || "";
    document.getElementById("leserRumpf").textContent = text || "";
    document.getElementById("leserFuss").textContent = fuss || "";
    leser.classList.add("auf");
    document.body.style.overflow = "hidden";
    document.getElementById("leserRumpf").scrollTop = 0;
    document.getElementById("leserRumpf").focus();
  }

  function leserZu() {
    leser.classList.remove("auf");
    document.body.style.overflow = "";
  }

  leser.addEventListener("click", (e) => { if (e.target.dataset.zu) leserZu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && leser.classList.contains("auf")) leserZu();
  });

  /**
   * Fehlt der Volltext, wird er beim ersten Öffnen aus Pipedrive nachgeholt.
   *
   * Der Lauf lädt den Rumpf nur für die neuesten Nachrichten — das spart den
   * größten Posten im Tageskontingent. Hier wird gezielt nachgeladen, wenn
   * wirklich jemand hineinsieht, und das Ergebnis bleibt dauerhaft gespeichert.
   */
  let ladeLaeuft = null;
  async function volltextSichern(c) {
    if (c.volltextGeladen || c._volltextVersucht) return;
    if (ladeLaeuft) return ladeLaeuft;
    c._volltextVersucht = true;
    ladeLaeuft = (async () => {
      try {
        const r = await api(`/api/cases/${c.id}/volltext`, { method: "POST" });
        if (r.notizen) c.notizen = r.notizen;
        if (r.thread) c.thread = r.thread;
        c.volltextGeladen = true;
        if (r.mailFehler) toast("warn", "Mailverlauf unvollständig", esc(r.mailFehler));
      } catch (e) {
        toast("warn", "Volltext nicht geladen", esc(e.message));
      } finally { ladeLaeuft = null; }
    })();
    return ladeLaeuft;
  }

  function threadHtml(c) {
    if (!c.thread || !c.thread.length) return `<div class="thread"><div class="msg"><div></div><div class="snippet">Noch keine Korrespondenz im Postfach gefunden.</div></div></div>`;
    return `<div class="thread">` + c.thread.map((m, i) =>
      `<div class="msg ${m.dir} oeffnen" data-mail="${i}" role="button" tabindex="0">` +
      `<div class="rail"><div class="dot"></div></div>` +
      `<div><div class="who">${esc(m.who)}<span class="tag">${esc(m.tag)}</span><span class="when">${esc(m.when)}</span></div>` +
      `<div class="snippet">${esc(m.snippet)}</div>` +
      `<div class="mehrHinweis">Ganze Nachricht lesen ›</div></div></div>`
    ).join("") + `</div>`;
  }

  function mailkarte(c) {
    const n = (c.thread || []).length;
    return `<div class="card"><div class="card-head"><span class="h">Mailverlauf</span>` +
      `<span class="badge">${n} Nachricht${n === 1 ? "" : "en"}</span></div>` +
      threadHtml(c) + `</div>`;
  }

  /**
   * Was nach der Entscheidung passiert ist — eine Zeile je Schritt.
   *
   * Tritt an die Stelle des Entwurfs, sobald ein Fall entschieden ist. Vorher
   * ersetzte eine grüne Meldung die ganze Fallansicht; Akte, Notizen und
   * Mailverlauf waren damit weg, und ob die Pipedrive-Notiz angekommen ist,
   * stand nirgends.
   */
  function ergebnisHtml(c) {
    /**
     * Eine Zeile der Ergebniskarte.
     * @param schritt  Ist er gesetzt, bekommt die Zeile einen eigenen Knopf, der
     *   genau diesen Schritt nachholt. „Aktualisieren" wäre dafür unpassend: Es
     *   zieht alle Fälle neu und kostet rund 110 Pipedrive-Aufrufe, ein
     *   einzelner Schritt kostet einen.
     */
    const zeile = (zustand, titel, text, link, linkText, schritt, knopfText) =>
      `<div class="erg ${zustand}"><span class="mark">${zustand === "ok" ? "✓" : zustand === "warn" ? "!" : "–"}</span>` +
      `<div style="min-width:0"><div class="et">${esc(titel)}</div><div class="eb">${esc(text)}` +
      (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">${esc(linkText)} ↗</a>` : "") +
      `</div>` +
      (schritt ? `<button class="btn subtle nachholen" data-schritt="${esc(schritt)}">${esc(knopfText)}</button>` : "") +
      `</div></div>`;

    const zeilen = [];
    if (c._resolved === "skipped") {
      zeilen.push(zeile("neutral", "Übersprungen", c.decisionNote || c._resolvedMsg || "Ohne Anfrage abgelegt."));
    } else {
      const d = c.outlookDraft;
      zeilen.push(d && d.id
        ? zeile("ok", "Outlook-Entwurf", `Liegt im Postfach${d.postfach ? " " + d.postfach : ""} — noch nicht versendet.`,
          d.webLink, "In Outlook öffnen")
        : zeile("warn", "Outlook-Entwurf", "Wurde nicht angelegt. Der Text unten lässt sich von Hand übernehmen.",
          null, null, "entwurf", "Entwurf jetzt anlegen"));

      if (c.recipEmail) zeilen.push(zeile("ok", "Adressat", c.recipEmail + (c.recipOrg ? ` · ${c.recipOrg}` : "")));
    }

    // Die Notiz — genau die Frage, die man sich nach dem Freigeben stellt.
    if (c.notiz && c.notiz.ok) {
      zeilen.push(zeile("ok", "Notiz in Pipedrive", "Am Deal hinterlegt."));
    } else if (c.notiz && c.notiz.ok === false) {
      zeilen.push(zeile("warn", "Notiz in Pipedrive",
        `Noch nicht angelegt (${c.notiz.fehler || "Grund unbekannt"}).`
        + ` Die App versucht es von allein weiter, in wachsenden Abständen.`
        + ` Am Entwurf ändert das nichts.`,
        null, null, "notiz", "Notiz jetzt anlegen"));
    } else if (c._resolved === "sent") {
      zeilen.push(zeile("neutral", "Notiz in Pipedrive",
        "Ob sie angelegt wurde, ist nicht festgehalten — diese Freigabe stammt aus einer Fassung,"
        + " die das noch nicht mitgeschrieben hat. Am Deal nachsehen.",
        null, null, "notiz", "Notiz anlegen"));
    }

    // Der Abschluss der Aufgabe ist der Auslöser für die Wiedervorlage in
    // Pipedrive — bleibt er aus, entsteht dort keine Erinnerung.
    if (c.aufgabe && c.aufgabe.ok) {
      zeilen.push(zeile("ok", "Aufgabe in Pipedrive", "Abgeschlossen — die Wiedervorlage dort ist damit angestoßen."));
    } else if (c.aufgabe && c.aufgabe.ok === false) {
      zeilen.push(zeile("warn", "Aufgabe in Pipedrive",
        `Noch offen (${c.aufgabe.fehler || "Grund unbekannt"}). Wird selbsttätig nachgeholt;`
        + ` bis dahin läuft die Wiedervorlage in Pipedrive nicht an.`,
        null, null, "aufgabe", "Aufgabe jetzt abschließen"));
    } else if (c._resolved === "sent" && c.taskId) {
      zeilen.push(zeile("neutral", "Aufgabe in Pipedrive",
        "Ob sie abgeschlossen wurde, ist nicht festgehalten — diese Freigabe stammt aus einer"
        + " früheren Fassung.", null, null, "aufgabe", "Aufgabe abschließen"));
    }

    const text = c.editedBody || c.draft;
    // Weitergehen ist ein Knopf, kein Automatismus: Wer freigibt, soll erst
    // sehen, was passiert ist, und dann selbst entscheiden weiterzugehen.
    const next = naechsterOffener(c.id);
    return `<div class="card"><div class="card-head"><span class="h">Ergebnis</span>` +
      `<span class="badge">${esc(STATUS_LABEL[c._resolved] || "Erledigt")}</span></div>` +
      `<div class="ergListe">${zeilen.join("")}` +
      (text ? `<div class="erg neutral"><span class="mark">✎</span><div style="min-width:0">` +
        `<div class="et">Freigegebener Text</div>${langtext(text, "Anzeigen")}</div></div>` : "") +
      `</div>` +
      `<div class="actions">` +
      (next
        ? `<button class="btn primary weiter" data-next="${esc(next.id)}">Nächster offener Fall →</button>`
          + `<span class="note">${esc(next.token || "")} · ${esc(next.name || "")}</span>`
        : `<span class="note">Kein weiterer Fall in diesem Filter.</span>`) +
      `</div></div>`;
  }

  function notizenHtml(c) {
    const n = c.notizen || [];
    if (!n.length) return "";
    return `<div class="card"><div class="card-head"><span class="h">Notizen in Pipedrive</span>` +
      `<span class="badge">${n.length} Notiz${n.length === 1 ? "" : "en"}</span></div>` +
      n.map((x, i) => {
        const lang = x.text.length > 260;
        const kurz = lang ? x.text.slice(0, 260).trimEnd() + " …" : x.text;
        return `<div class="notiz${lang ? " oeffnen" : ""}"${lang ? ` data-notiz="${i}" role="button" tabindex="0"` : ""}>` +
          `<div class="when">${esc(x.when)}</div>` +
          `<div class="snippet">${esc(kurz)}</div>` +
          (lang ? `<div class="mehrHinweis">Ganze Notiz lesen ›</div>` : "") + `</div>`;
      }).join("") + `</div>`;
  }

  function selectCase(id, opts) {
    activeId = id;
    if (isMobile() && !(opts && opts.keepView)) setView("detail");
    const c = CASES.find(x => x.id === id);
    renderList();
    if (!c) return;


    const co = c.calloutType || "info";
    const cTitle = c.calloutTitle || (co === "info" ? "Letzter Stand" : "Hinweis");
    const cBody = c.calloutBody || c.lastStatus;
    const coIc = co === "ok" ? "✓" : co === "warn" ? "!" : "»";

    // Einschätzung der KI: Kategorie + Schwerpunkt, damit nachvollziehbar ist,
    // warum der Text so formuliert ist.
    let aiBlock = "";
    if (c.ai && c.ai.used) {
      aiBlock =
        `<div class="callout info" style="background:var(--surface-2);"><div class="ic">✎</div><div>` +
        `<div class="t">Einschätzung${c.ai.kategorie ? " · " + esc(catLabel(c.ai.kategorie)) : ""}</div>` +
        `<div class="b">${esc(c.ai.einschaetzung || "")}` +
        (c.ai.schwerpunkt ? `<br><span style="color:var(--text-muted);font-size:12.5px;">Schwerpunkt: ${esc(c.ai.schwerpunkt)}</span>` : "") +
        (c.ai.anfrageSinnvoll === false ? `<br><b style="color:var(--warn)">Anfrage hier unpassend:</b> ${esc(c.ai.hinweisWennUnpassend || "")}` : "") +
        // Drei schließende Tags: .b, der Textrahmen und .callout selbst. Fehlte
        // das letzte, zog der Flex-Container alle folgenden Karten in sich
        // hinein — sie standen dann neben der Einschätzung statt darunter.
        `</div></div></div>`;
    } else if (c.ai && c.ai.problems && c.ai.problems.length) {
      aiBlock =
        `<div class="callout warn"><div class="ic">!</div><div><div class="t">KI-Entwurf verworfen</div>` +
        `<div class="b">${esc(c.ai.problems.join("; "))} — es wird der geprüfte Standardtext gezeigt.</div></div></div>`;
    }

    /*
     * Eingabe für den Grund beim Überspringen.
     *
     * Der Grund landet in der Notiz am Deal — ohne Eingabe stünde dort nur die
     * maschinelle Einschätzung, und wer den Vorgang später liest, erfährt nicht,
     * was tatsächlich abgewartet wird. Vorbelegt ist der erkannte Grund; er ist
     * überschreibbar.
     */
    const skipVorschlaege = [
      "Rückmeldung der Kanzlei abwarten",
      "Verfahren läuft, Termin abwarten",
      "Akteneinsicht abwarten",
      "Unterlagen liegen noch nicht vor"
    ];
    const skipBox = (bestaetigen) =>
      `<div class="rewrite" id="skipBox"><label for="skipInput">Warum wird übersprungen? Der Grund steht später in der Notiz am Deal.</label>` +
      `<div class="inrow"><input id="skipInput" value="${esc(c.skipReason || "")}" ` +
      `placeholder="z. B. Rückmeldung der Kanzlei abwarten"/>` +
      `<button class="btn primary" id="skipGo">${esc(bestaetigen)}</button></div>` +
      `<div class="hints">` +
      skipVorschlaege.map(v => `<button data-s="${esc(v)}">${esc(v)}</button>`).join("") +
      `</div></div>`;

    // Entschiedene Fälle behalten ihre volle Ansicht — Akte, Notizen und
    // Mailverlauf bleiben stehen. Nur an der Stelle des Entwurfs steht dann,
    // was aus der Entscheidung geworden ist.
    let draftSection = "";
    if (c._resolved) {
      draftSection = ergebnisHtml(c);
    } else if (c.draft) {
      const toLine = `<div class="draft-to"><span class="lbl">An</span>` +
        `<span class="addr mono">${esc(c.recipEmail)}</span>` +
        (c.recipPerson ? `<span class="pill">${esc(c.recipPerson)}</span>` : "") +
        `<span class="pill">${esc(c.recipOrg)}</span>` +
        (c.recipSource ? `<span class="pill" title="Woher die Adresse stammt">${esc(c.recipSource)}</span>` : "") + `</div>`;
      const subj = `<div class="draft-to"><span class="lbl">Betreff</span>` +
        `<span class="addr">${esc(c.subject || ("Sachstandsanfrage · " + (c.name || "") + (c.token ? " · [Az. " + c.token + "]" : "")))}</span></div>`;
      draftSection =
        `<div class="card"><div class="card-head"><span class="h">${c.isRueckfrage ? "Antwort-Entwurf" : "Anfrage-Entwurf"}</span>` +
        `<span class="badge">${c.du ? "Neutrale Anrede" : "Förmliche Anrede"}</span></div>` +
        `<div class="draft-wrap">${toLine}${subj}` +
        `<textarea class="editor" id="editor" spellcheck="false">${esc(c.draft)}</textarea>` +
        `<div class="rewrite" id="rewrite"><label>Was soll der Agent ändern?</label>` +
        `<div class="inrow"><input id="rewriteInput" placeholder="z. B. kürzer fassen, förmlicher, konkret nach Rechnung fragen…"/>` +
        `<button class="btn primary" id="rewriteGo">Umschreiben</button></div>` +
        `<div class="hints"><button data-h="Fasse es kürzer">kürzer</button>` +
        `<button data-h="Formuliere es förmlicher">förmlicher</button>` +
        `<button data-h="Frag konkret nach der Kostenrechnung">nach Rechnung fragen</button></div></div>` +
        `</div>` +
        `<div class="actions">` +
        `<button class="btn primary" id="sendBtn">✓ Freigeben &amp; senden</button>` +
        `<button class="btn ghost" id="reviseBtn">✎ Ändern lassen</button>` +
        `<div class="spacer"></div>` +
        `<button class="btn subtle" id="skipBtn">Überspringen</button>` +
        `</div>` +
        `<div class="card" style="border-top:none;padding:0 16px 14px;">${skipBox("Überspringen")}</div>`;
    } else {
      draftSection =
        `<div class="card"><div class="actions" style="border-top:none;">` +
        `<span class="note">Kein Entwurf erzeugt — ${esc(c.skipReason || "")}.</span>` +
        `<div class="spacer"></div>` +
        (c.status === "reguliert"
          ? `<button class="btn ghost" id="skipBtn">Aufgabe abschließen</button>`
          : `<button class="btn subtle" id="skipBtn">Übersprungen markieren</button>`) +
        `</div>` +
        `<div style="padding:0 16px 14px;">${skipBox(c.status === "reguliert" ? "Abschließen" : "Übersprungen markieren")}</div>` +
        `</div>`;
    }

    // Steht rechts etwas Eigenes — Entwurf oder Ergebnis —, bleibt der
    // Mailverlauf links. Sonst wandert er nach rechts, statt die Spalte
    // leer stehen zu lassen; die schmale Überspringen-Karte rutscht dann
    // nach links. Sie darf nicht wegfallen: ohne sie ließe sich ein Fall
    // ohne Entwurf gar nicht abschließen.
    const rechtsBelegt = Boolean(c._resolved || c.draft);

    detailEl.innerHTML =
      `<div class="detail-inner">` +
      `<div class="dhead"><div class="toprow"><h2>${esc(c.name)}</h2>` +
      `<span class="chip ${c._resolved ? "sent" : c.status}">` +
      `${STATUS_LABEL[c._resolved || c.status]}</span>` +
      `<span style="margin-left:auto" class="date mono">${esc(c.token)}</span></div>` +
      `<div class="meta-grid">${metaCells(c)}</div></div>` +
      `<div class="ctx">` +
      `<div class="callout ${co}"><div class="ic">${coIc}</div><div>` +
      `<div class="t">${esc(cTitle)}</div><div class="b">${esc(cBody)}</div></div></div>` +
      aiBlock +
      notizenHtml(c) +
      (rechtsBelegt ? mailkarte(c) : draftSection) +
      `</div>` +                       /* .ctx zu */
      `<div class="draftCol${rechtsBelegt ? "" : " frei"}">` +
      (rechtsBelegt ? draftSection : mailkarte(c)) + `</div>` +
      `</div>`;

    wireDetail(c);
  }

  /*
   * Klicks auf Notizen und Nachrichten öffnen die Leseansicht.
   *
   * Einmalig auf dem Detailbereich, nicht je Zeile und nicht bei jedem
   * Neuzeichnen: detailEl bleibt bestehen, nur sein Inhalt wird ersetzt. Wer
   * hier bei jeder Auswahl erneut anhängt, sammelt Zuhörer an, und ein Klick
   * öffnet die Ansicht irgendwann mehrfach.
   */
  async function leseZeileOeffnen(el) {
    const c = CASES.find(x => x.id === activeId);
    if (!c) return;
    const mailIdx = el.dataset.mail, notizIdx = el.dataset.notiz;

    if (notizIdx !== undefined) {
      const n = (c.notizen || [])[Number(notizIdx)];
      if (n) leserAuf({ titel: "Notiz in Pipedrive", sub: n.when, text: n.text });
      return;
    }
    if (mailIdx === undefined) return;

    let m = (c.thread || [])[Number(mailIdx)];
    if (!m) return;
    // Liegt kein Rumpf vor, wird er jetzt aus Pipedrive nachgeholt. Der Lauf
    // lädt ihn nur für die neuesten Nachrichten, um Aufrufe zu sparen.
    if (!m.full && !m.hatRumpf && !c.volltextGeladen) {
      leserAuf({ titel: m.who, sub: `${m.tag} · ${m.when}`, text: "Volltext wird aus Pipedrive geladen …" });
      await volltextSichern(c);
      m = (c.thread || [])[Number(mailIdx)] || m;
      if (activeId === c.id) selectCase(c.id, { keepView: true });
    }
    leserAuf({
      titel: m.subject || m.who,
      sub: `${m.who} · ${m.tag} · ${m.when}`,
      text: m.full || m.snippet || "",
      fuss: (!m.full && !m.hatRumpf)
        ? "Nur der Auszug aus Pipedrive verfügbar — für diese Nachricht liegt kein Volltext vor."
        : ""
    });
  }

  /*
   * Einen einzelnen Schritt nachholen. Kostet einen Pipedrive-Aufruf statt der
   * rund 110 eines vollen Laufs — deshalb hängt der Knopf an der Zeile und
   * nicht am „Aktualisieren" oben.
   */
  async function schrittNachholen(btn) {
    const c = CASES.find(x => x.id === activeId);
    if (!c) return;
    const schritt = btn.dataset.schritt;
    const alt = btn.textContent;
    btn.disabled = true; btn.textContent = "läuft …";
    try {
      const r = await api(`/api/cases/${c.id}/nachholen`, {
        method: "POST", body: JSON.stringify({ schritt })
      });
      if (r.notiz) c.notiz = r.notiz;
      if (r.aufgabe) c.aufgabe = r.aufgabe;
      if (r.outlook) c.outlookDraft = r.outlook;
      toast("ok", "Erledigt", {
        notiz: "Notiz am Deal angelegt.",
        aufgabe: "Aufgabe in Pipedrive abgeschlossen.",
        entwurf: "Entwurf im Postfach angelegt."
      }[schritt] || "Schritt ausgeführt.");
      selectCase(c.id, { keepView: true });
    } catch (e) {
      btn.disabled = false; btn.textContent = alt;
      toast("err", "Nicht möglich", esc(e.message));
    }
  }

  detailEl.addEventListener("click", (e) => {
    const weiter = e.target.closest(".weiter");
    if (weiter) { selectCase(weiter.dataset.next); return; }
    const knopf = e.target.closest(".nachholen");
    if (knopf) { schrittNachholen(knopf); return; }
    const el = e.target.closest(".oeffnen");
    if (el) leseZeileOeffnen(el);
  });
  detailEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".oeffnen");
    if (el) { e.preventDefault(); leseZeileOeffnen(el); }
  });

  function wireDetail(c) {
    const sendBtn = document.getElementById("sendBtn");
    const skipBtn = document.getElementById("skipBtn");
    const reviseBtn = document.getElementById("reviseBtn");
    const rewrite = document.getElementById("rewrite");

    if (sendBtn) sendBtn.addEventListener("click", async () => {
      sendBtn.disabled = true;
      const editor = document.getElementById("editor");
      try {
        const gesendet = editor ? editor.value : (c.editedBody || c.draft);
        const r = await api(`/api/cases/${c.id}/approve`, { method: "POST", body: JSON.stringify({ draft: gesendet }) });
        // Genau den Text festhalten, der herausgegangen ist — auch von Hand
        // getippte Änderungen landen so in der Ergebniskarte.
        c.editedBody = gesendet;
        c._resolved = "sent";
        c._decidedLocal = Date.now();
        c._resolvedMsg = r.message || `Entwurf an ${c.recipOrg} (${c.recipEmail}) freigegeben.`;
        // Aus der Antwort übernehmen, sonst zeigt die Ergebniskarte bis zum
        // nächsten vollständigen Laden „nicht angelegt" an.
        c.outlookDraft = r.outlook || null;
        c.notiz = r.notiz || null;
        c.aufgabe = r.aufgabe || null;
        if (r.outlookLink) {
          // Direkt zum Entwurf springen — dort nur noch prüfen und senden.
          toastLink("ok", "Freigegeben", `${c.token}: ${esc(r.message)}`, r.outlookLink, "In Outlook öffnen");
          window.open(r.outlookLink, "_blank", "noopener");
        } else {
          toast(r.hinweis ? "warn" : "ok", "Freigegeben",
            esc(r.message) + (r.hinweis ? `<br><span style="opacity:.8">${esc(r.hinweis)}</span>` : ""));
        }
        afterResolve(c);
      } catch (e) { sendBtn.disabled = false; toast("err", "Fehler", esc(e.message)); }
    });

    if (reviseBtn) reviseBtn.addEventListener("click", () => {
      rewrite.classList.toggle("open");
      if (rewrite.classList.contains("open")) document.getElementById("rewriteInput").focus();
    });

    if (rewrite) {
      const go = document.getElementById("rewriteGo");
      const inp = document.getElementById("rewriteInput");
      const doRewrite = async () => {
        const instr = inp.value.trim();
        go.disabled = true; go.textContent = "Agent schreibt…";
        try {
          const r = await api(`/api/cases/${c.id}/rewrite`, { method: "POST", body: JSON.stringify({ instruction: instr }) });
          const ed = document.getElementById("editor");
          if (ed && r.draft) ed.value = r.draft;
          // Auch am Fall festhalten. Vorher stand die neue Fassung nur im
          // Textfeld; die Ergebniskarte las danach weiter c.editedBody ||
          // c.draft und zeigte unter „Freigegebener Text" die alte Fassung.
          // Verschickt wurde immer der richtige Text — die Anzeige log.
          if (r.draft) c.editedBody = r.draft;
          rewrite.classList.remove("open");
          inp.value = "";
          toast("info", "Entwurf überarbeitet", instr ? `Berücksichtigt: „${esc(instr)}“` : "Neue Fassung erstellt.");
        } catch (e) { toast("err", "Fehler", esc(e.message)); }
        finally { go.disabled = false; go.textContent = "Umschreiben"; }
      };
      go.addEventListener("click", doRewrite);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") doRewrite(); });
      rewrite.querySelectorAll(".hints button").forEach(b =>
        b.addEventListener("click", () => { inp.value = b.dataset.h; doRewrite(); }));
    }

    /*
     * Überspringen fragt zuerst nach dem Grund. Der landet in der Notiz am
     * Deal — ohne Nachfrage stünde dort nur die maschinelle Einschätzung, und
     * beim späteren Lesen des Vorgangs fehlte die eigentliche Begründung.
     */
    const skipBox = document.getElementById("skipBox");
    const skipInput = document.getElementById("skipInput");
    const skipGo = document.getElementById("skipGo");

    if (skipBtn && skipBox) skipBtn.addEventListener("click", () => {
      skipBox.classList.toggle("open");
      if (!skipBox.classList.contains("open")) return;
      // Beim Entwurf steht das Feld unterhalb der Schaltflächen und damit oft
      // außerhalb des Sichtfensters — sonst wirkt der Klick folgenlos.
      skipBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      skipInput.focus(); skipInput.select();
    });
    if (skipBox) skipBox.querySelectorAll(".hints button").forEach(b =>
      b.addEventListener("click", () => { skipInput.value = b.dataset.s; skipInput.focus(); }));
    if (skipInput) skipInput.addEventListener("keydown", e => { if (e.key === "Enter") skipGo.click(); });

    if (skipGo) skipGo.addEventListener("click", async () => {
      skipGo.disabled = true;
      try {
        const grund = (skipInput.value || "").trim() || c.skipReason || "manuell übersprungen";
        const r = await api(`/api/cases/${c.id}/skip`, { method: "POST", body: JSON.stringify({ reason: grund }) });
        const done = c.status === "reguliert";
        c._resolved = r.status || (done ? "sent" : "skipped");
        c._decidedLocal = Date.now();
        c._resolvedMsg = done
          ? `Als reguliert abgeschlossen — Grund: ${grund}.`
          : `Übersprungen — Grund: ${grund}.`;
        c.decisionNote = grund;
        c.notiz = r.notiz || null;
        c.aufgabe = r.aufgabe || null;
        toast(done ? "ok" : "warn", done ? "Abgeschlossen" : "Übersprungen",
          `${c.token}: ${esc(r.reason || grund)}`
          + (r.hinweis ? `<br><span style="opacity:.85">${esc(r.hinweis)}</span>` : ""));
        afterResolve(c);
      } catch (e) { skipGo.disabled = false; toast("err", "Fehler", esc(e.message)); }
    });
  }

  /** Der nächste Fall, der noch eine Entscheidung braucht. */
  function naechsterOffener(ausser) {
    return CASES.find(x => x.id !== ausser && isPending(x) && visible(x)) || null;
  }

  /*
   * Nach einer Entscheidung bleibt die Ansicht auf dem Fall stehen.
   *
   * Vorher sprang sie sofort zum nächsten offenen Fall. Das war verwirrend:
   * Man drückt „Freigeben" und sieht unvermittelt eine fremde Akte, ohne zu
   * erfahren, was mit der eigenen passiert ist. Weitergehen ist jetzt ein
   * eigener Knopf in der Ergebniskarte.
   */
  function afterResolve(c) {
    renderKpis();
    renderList();
    selectCase(c.id, { keepView: true });
  }

  /** Hinweis mit Link — für den frisch angelegten Outlook-Entwurf. */
  function toastLink(kind, title, body, href, linkText) {
    toast(kind, title, `${body}<br><a href="${href}" target="_blank" rel="noopener"
      style="color:var(--accent);font-weight:600">${esc(linkText)} ↗</a>`);
  }

  function toast(kind, title, body) {
    const el = document.createElement("div");
    el.className = "toast " + (kind === "ok" ? "" : kind);
    const ic = kind === "ok" ? "✓" : kind === "warn" ? "⤳" : kind === "err" ? "✕" : "✎";
    el.innerHTML = `<div class="ic">${ic}</div><div><div class="tt">${esc(title)}</div><div class="tb">${body}</div></div>`;
    toastsEl.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .3s, transform .3s"; el.style.opacity = "0"; el.style.transform = "translateY(6px)"; setTimeout(() => el.remove(), 320); }, 3600);
  }

  const backBtn = document.getElementById("backBtn");
  if (backBtn) backBtn.addEventListener("click", () => setView("list"));

  document.getElementById("filters").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    filter = b.dataset.f;
    document.querySelectorAll("#filters button").forEach(x => x.classList.toggle("active", x === b));
    renderList();
  });

  const themeBtn = document.getElementById("themeBtn");
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", isDark ? "light" : "dark");
  });

  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true; refreshBtn.textContent = "…";
    try {
      const r = await api("/api/refresh", { method: "POST" });
      toast("info", "Aktualisiert", r.summary
        ? `${r.summary.drafts || 0} Entwürfe, ${r.summary.skipped || 0} übersprungen (${r.summary.dueTasks || 0} fällig)`
        : "Neu geladen.");
      await init();
    } catch (e) { toast("err", "Aktualisieren fehlgeschlagen", esc(e.message)); }
    finally { refreshBtn.disabled = false; refreshBtn.textContent = "⟳"; }
  });

  function showRunInfo(cfg) {
    const el = document.getElementById("runInfo");
    if (!el) return;
    if (cfg.demoMode) { el.textContent = "Demo-Modus"; return; }
    const t = cfg.lastRun ? new Date(cfg.lastRun).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—";
    const s = cfg.lastRunSummary || {};
    el.textContent = `Letzter Lauf ${t} · ${s.drafts || 0} Entwürfe · ${s.skipped || 0} übersprungen`;

    // Nicht jeder fällige Fall kommt durch: Bricht ein Abruf ab — meist, weil
    // das Tageskontingent der Pipedrive-Schnittstelle erschöpft ist —, fehlt
    // der Fall in der Liste. Vorher stand das nur in den Serverprotokollen,
    // und die Zusammenfassung sah aus, als wäre alles erledigt.
    const faellig = Number(s.dueTasks || 0);
    const bearbeitet = Number(s.analyzed || 0);
    const fehlend = Math.max(0, faellig - bearbeitet);
    const el2 = document.getElementById("runWarn");
    if (!el2) return;
    if (!fehlend) { el2.hidden = true; return; }
    el2.hidden = false;
    el2.textContent = `⚠ ${fehlend} von ${faellig} fälligen Fällen nicht abgerufen`
      + ((s.errors && s.errors[0]) ? ` — ${s.errors[0]}` : "")
      + `. Mit ⟳ erneut versuchen.`;
    el2.title = (s.errors || []).join("\n");
  }

  async function init() {
    try {
      const cfg = await api("/api/config").catch(() => ({ demoMode: true }));
      demoBadge.hidden = !cfg.demoMode;
      showRunInfo(cfg);
      const data = await api("/api/cases");
      CASES = data.cases || [];
      renderKpis();
      renderList();
      setView(isMobile() ? "list" : "detail");
      // Aus der Übersichtsmail kommt ein Link mit ?fall=<Aktenzeichen>.
      const gesucht = new URLSearchParams(location.search).get("fall");
      const ausLink = gesucht
        ? CASES.find(c => String(c.token) === gesucht || String(c.id) === gesucht)
        : null;
      if (ausLink && !visible(ausLink)) {
        // Der verlinkte Fall steckt in einem anderen Filter — Filter umstellen,
        // sonst zeigt der Link ins Leere.
        filter = "alle";
        document.querySelectorAll("#filters button").forEach(x =>
          x.classList.toggle("active", x.dataset.f === "alle"));
      }
      const first = ausLink || CASES.find(isPending) || CASES.find(c => visible(c));
      if (first) selectCase(first.id, { keepView: !ausLink });
      else detailEl.innerHTML = `<div class="empty">Nichts zu prüfen. 🎉<br><span style="font-size:12px;">Erledigte Fälle über den Filter „Erledigt".</span></div>`;
    } catch (e) {
      detailEl.innerHTML = `<div class="empty">Fehler beim Laden: ${esc(e.message)}</div>`;
    }
  }

  init();
})();
