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
    if (filter === "erledigt") return !isPending(c);          // übersprungen + freigegeben
    if (!inArbeitsliste(c)) return false;
    if (filter === "ueberfaellig") return isPending(c) && c.status === "ueberfaellig";
    if (filter === "rueckfrage") return isPending(c) && c.status === "rueckfrage";
    return true;                                             // "offen"
  }

  function renderKpis() {
    const pending = CASES.filter(isPending);
    const ueber = pending.filter(c => c.status === "ueberfaellig").length;
    const rueck = pending.filter(c => c.status === "rueckfrage").length;
    const done = CASES.length - pending.length;
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

  function threadHtml(c) {
    if (!c.thread || !c.thread.length) return `<div class="thread"><div class="msg"><div></div><div class="snippet">Noch keine Korrespondenz im Postfach gefunden.</div></div></div>`;
    return `<div class="thread">` + c.thread.map(m =>
      `<div class="msg ${m.dir}"><div class="rail"><div class="dot"></div></div>` +
      `<div><div class="who">${esc(m.who)}<span class="tag">${esc(m.tag)}</span><span class="when">${esc(m.when)}</span></div>` +
      `<div class="snippet">${esc(m.snippet)}</div>` +
      langtext(m.full, "Ganze Nachricht") + `</div></div>`
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
    const zeile = (zustand, titel, text, link, linkText) =>
      `<div class="erg ${zustand}"><span class="mark">${zustand === "ok" ? "✓" : zustand === "warn" ? "!" : "–"}</span>` +
      `<div><div class="et">${esc(titel)}</div><div class="eb">${esc(text)}` +
      (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">${esc(linkText)} ↗</a>` : "") +
      `</div></div></div>`;

    const zeilen = [];
    if (c._resolved === "skipped") {
      zeilen.push(zeile("neutral", "Übersprungen", c.decisionNote || c._resolvedMsg || "Ohne Anfrage abgelegt."));
    } else {
      const d = c.outlookDraft;
      zeilen.push(d && d.id
        ? zeile("ok", "Outlook-Entwurf", `Liegt im Postfach${d.postfach ? " " + d.postfach : ""} — noch nicht versendet.`,
          d.webLink, "In Outlook öffnen")
        : zeile("warn", "Outlook-Entwurf", "Wurde nicht angelegt. Der Text unten lässt sich von Hand übernehmen."));

      if (c.recipEmail) zeilen.push(zeile("ok", "Adressat", c.recipEmail + (c.recipOrg ? ` · ${c.recipOrg}` : "")));
    }

    // Die Notiz — genau die Frage, die man sich nach dem Freigeben stellt.
    if (c.notiz && c.notiz.ok) {
      zeilen.push(zeile("ok", "Notiz in Pipedrive", "Am Deal hinterlegt."));
    } else if (c.notiz && c.notiz.ok === false) {
      zeilen.push(zeile("warn", "Notiz in Pipedrive",
        `Noch nicht angelegt (${c.notiz.fehler || "Grund unbekannt"}). Wird beim nächsten Lauf nachgetragen.`));
    } else if (c._resolved === "sent") {
      zeilen.push(zeile("neutral", "Notiz in Pipedrive", "Nicht festgehalten — die Freigabe stammt aus einer früheren Fassung."));
    }

    const text = c.editedBody || c.draft;
    return `<div class="card"><div class="card-head"><span class="h">Ergebnis</span>` +
      `<span class="badge">${esc(STATUS_LABEL[c._resolved] || "Erledigt")}</span></div>` +
      `<div class="ergListe">${zeilen.join("")}` +
      (text ? `<div class="erg neutral"><span class="mark">✎</span><div style="min-width:0">` +
        `<div class="et">Freigegebener Text</div>${langtext(text, "Anzeigen")}</div></div>` : "") +
      `</div></div>`;
  }

  function notizenHtml(c) {
    const n = c.notizen || [];
    if (!n.length) return "";
    return `<div class="card"><div class="card-head"><span class="h">Notizen in Pipedrive</span>` +
      `<span class="badge">${n.length} Notiz${n.length === 1 ? "" : "en"}</span></div>` +
      n.map(x => {
        const kurz = x.text.length > 260 ? x.text.slice(0, 260).trimEnd() + " …" : x.text;
        return `<div class="notiz"><div class="when">${esc(x.when)}</div>` +
          `<div class="snippet">${esc(kurz)}</div>` +
          (x.text.length > 260 ? langtext(x.text, "Ganze Notiz") : "") + `</div>`;
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
        `<span class="badge">${c.du ? "Du-Anrede (Anrede-Regeln)" : "Sie-Anrede"}</span></div>` +
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
        `</div>`;
    } else {
      draftSection =
        `<div class="card"><div class="actions" style="border-top:none;">` +
        `<span class="note">Kein Entwurf erzeugt — ${esc(c.skipReason || "")}.</span>` +
        `<div class="spacer"></div>` +
        (c.status === "reguliert"
          ? `<button class="btn ghost" id="skipBtn">Aufgabe abschließen</button>`
          : `<button class="btn subtle" id="skipBtn">Übersprungen markieren</button>`) +
        `</div></div>`;
    }

    // Steht rechts etwas Eigenes — Entwurf oder Ergebnis —, bleibt der
    // Mailverlauf links. Sonst wandert er nach rechts, statt die Spalte
    // leer stehen zu lassen.
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
      (rechtsBelegt ? mailkarte(c) : "") +
      `</div>` +                       /* .ctx zu */
      `<div class="draftCol${rechtsBelegt ? "" : " frei"}">` +
      (rechtsBelegt ? draftSection : mailkarte(c)) + `</div>` +
      `</div>`;

    wireDetail(c);
  }

  function wireDetail(c) {
    const sendBtn = document.getElementById("sendBtn");
    const skipBtn = document.getElementById("skipBtn");
    const reviseBtn = document.getElementById("reviseBtn");
    const rewrite = document.getElementById("rewrite");

    if (sendBtn) sendBtn.addEventListener("click", async () => {
      sendBtn.disabled = true;
      const editor = document.getElementById("editor");
      try {
        const r = await api(`/api/cases/${c.id}/approve`, { method: "POST", body: JSON.stringify({ draft: editor ? editor.value : c.draft }) });
        c._resolved = "sent";
        c._decidedLocal = Date.now();
        c._resolvedMsg = r.message || `Entwurf an ${c.recipOrg} (${c.recipEmail}) freigegeben.`;
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

    if (skipBtn) skipBtn.addEventListener("click", async () => {
      skipBtn.disabled = true;
      try {
        const r = await api(`/api/cases/${c.id}/skip`, { method: "POST", body: JSON.stringify({ reason: c.skipReason }) });
        const done = c.status === "reguliert";
        c._resolved = r.status || (done ? "sent" : "skipped");
        c._decidedLocal = Date.now();
        c._resolvedMsg = done
          ? `Als reguliert abgeschlossen.`
          : `Übersprungen — Grund: ${c.skipReason || "manuell übersprungen"}.`;
        toast(done ? "ok" : "warn", done ? "Abgeschlossen" : "Übersprungen", `${c.token}: ${esc(r.reason || c.skipReason || "")}`);
        afterResolve(c);
      } catch (e) { skipBtn.disabled = false; toast("err", "Fehler", esc(e.message)); }
    });
  }

  function afterResolve(c) {
    renderKpis();
    const next = CASES.find(x => x.id !== c.id && isPending(x) && visible(x));
    if (next) selectCase(next.id);
    else if (isMobile()) { activeId = null; renderList(); setView("list"); }
    else { activeId = null; renderList(); detailEl.innerHTML = `<div class="empty">Alle Fälle in diesem Filter bearbeitet. 🎉<br><span style="font-size:12px;">Wechsle den Filter oben oder starte den nächsten Lauf.</span></div>`; }
    renderList();
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
