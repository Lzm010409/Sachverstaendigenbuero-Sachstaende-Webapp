/* Sachstands-Cockpit — Frontend-Logik.
 * Holt Fälle aus /api/cases und verdrahtet Freigeben / Ändern lassen / Überspringen
 * gegen die API-Endpunkte. Läuft ohne Framework, reines DOM. */
(function () {
  "use strict";

  const STATUS_LABEL = {
    faellig: "Fällig", ueberfaellig: "Überfällig", rueckfrage: "Rückfrage offen",
    reguliert: "Reguliert", unklar: "Empfänger unklar", sent: "Gesendet", skipped: "Übersprungen"
  };
  const STRIPE = {
    faellig: "var(--accent)", ueberfaellig: "var(--critical)", rueckfrage: "var(--warn)",
    reguliert: "var(--ok)", unklar: "var(--border-strong)"
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

  function esc(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ("HTTP " + res.status));
    return res.json();
  }

  function visible(c) {
    if (c._resolved) return filter === "alle";
    if (filter === "alle" || filter === "offen") return true;
    if (filter === "ueberfaellig") return c.status === "ueberfaellig";
    if (filter === "rueckfrage") return c.status === "rueckfrage";
    return true;
  }

  function renderKpis() {
    const open = CASES.filter(c => !c._resolved);
    const ueber = open.filter(c => c.status === "ueberfaellig").length;
    const rueck = open.filter(c => c.status === "rueckfrage").length;
    kpisEl.innerHTML =
      `<div class="kpi"><b>${open.length}</b><span>offen</span></div>` +
      `<div class="kpi crit"><b>${ueber}</b><span>überfällig</span></div>` +
      `<div class="kpi warn"><b>${rueck}</b><span>Rückfragen</span></div>`;
  }

  function renderList() {
    listEl.innerHTML = "";
    const shown = CASES.filter(visible);
    if (!shown.length) {
      listEl.innerHTML = `<div class="empty" style="height:auto;padding:30px 16px;font-size:13px;">Keine Fälle in diesem Filter.</div>`;
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
        `<span class="wait">fällig ${esc(c.due)}</span></div>`;
      btn.addEventListener("click", () => selectCase(c.id));
      listEl.appendChild(btn);
    });
  }

  function metaCells(c) {
    const cells = [["Anspruchsteller", esc(c.name)], ["Unfalltag", esc(c.accident)]];
    if (c.insurer) cells.push(["Versicherung", esc(c.insurer)]);
    if (c.schadenNr) cells.push(["Schaden-Nr.", `<span class="mono">${esc(c.schadenNr)}</span>`]);
    if (c.vertragNr) cells.push(["Vertrags-Nr.", `<span class="mono">${esc(c.vertragNr)}</span>`]);
    cells.push(["Fällig am", esc(c.due)]);
    return cells.map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  }

  function threadHtml(c) {
    if (!c.thread || !c.thread.length) return `<div class="thread"><div class="msg"><div></div><div class="snippet">Noch keine Korrespondenz im Postfach gefunden.</div></div></div>`;
    return `<div class="thread">` + c.thread.map(m =>
      `<div class="msg ${m.dir}"><div class="rail"><div class="dot"></div></div>` +
      `<div><div class="who">${esc(m.who)}<span class="tag">${esc(m.tag)}</span><span class="when">${esc(m.when)}</span></div>` +
      `<div class="snippet">${esc(m.snippet)}</div></div></div>`
    ).join("") + `</div>`;
  }

  function selectCase(id) {
    activeId = id;
    const c = CASES.find(x => x.id === id);
    renderList();
    if (!c) return;

    if (c._resolved) {
      detailEl.innerHTML =
        `<div class="detail-inner"><div class="dhead"><div class="toprow">` +
        `<h2>${esc(c.name)}</h2><span class="chip sent">${STATUS_LABEL[c._resolved]}</span></div>` +
        `<span class="date mono">${esc(c.token)}</span></div>` +
        `<div class="callout ok"><div class="ic">✓</div><div><div class="t">Erledigt</div>` +
        `<div class="b">${esc(c._resolvedMsg || "")}</div></div></div></div>`;
      return;
    }

    const co = c.calloutType || "info";
    const cTitle = c.calloutTitle || (co === "info" ? "Letzter Stand" : "Hinweis");
    const cBody = c.calloutBody || c.lastStatus;
    const coIc = co === "ok" ? "✓" : co === "warn" ? "!" : "»";

    let draftSection = "";
    if (c.draft) {
      const toLine = `<div class="draft-to"><span class="lbl">An</span>` +
        `<span class="addr mono">${esc(c.recipEmail)}</span>` +
        (c.recipPerson ? `<span class="pill">${esc(c.recipPerson)}</span>` : "") +
        `<span class="pill">${esc(c.recipOrg)}</span></div>`;
      const subj = `<div class="draft-to"><span class="lbl">Betreff</span>` +
        `<span class="addr">Sachstand ${esc(c.name)} · [Az. ${esc(c.token)}]</span></div>`;
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

    detailEl.innerHTML =
      `<div class="detail-inner">` +
      `<div class="dhead"><div class="toprow"><h2>${esc(c.name)}</h2>` +
      `<span class="chip ${c.status}">${STATUS_LABEL[c.status]}</span>` +
      `<span style="margin-left:auto" class="date mono">${esc(c.token)}</span></div>` +
      `<div class="meta-grid">${metaCells(c)}</div></div>` +
      `<div class="callout ${co}"><div class="ic">${coIc}</div><div>` +
      `<div class="t">${esc(cTitle)}</div><div class="b">${esc(cBody)}</div></div></div>` +
      `<div class="card"><div class="card-head"><span class="h">Mailverlauf (Outlook)</span>` +
      `<span class="badge">${(c.thread || []).length} Nachricht${(c.thread || []).length === 1 ? "" : "en"}</span></div>` +
      threadHtml(c) + `</div>` +
      draftSection +
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
        c._resolvedMsg = r.message || `Entwurf an ${c.recipOrg} (${c.recipEmail}) freigegeben.`;
        toast("ok", "Freigegeben", `${c.token}: ${r.message || "erledigt."}`);
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
    const next = CASES.find(x => !x._resolved && x.id !== c.id && visible(x));
    if (next) selectCase(next.id);
    else { activeId = null; renderList(); detailEl.innerHTML = `<div class="empty">Alle Fälle in diesem Filter bearbeitet. 🎉<br><span style="font-size:12px;">Wechsle den Filter oben oder starte den nächsten Lauf.</span></div>`; }
    renderList();
  }

  function toast(kind, title, body) {
    const el = document.createElement("div");
    el.className = "toast " + (kind === "ok" ? "" : kind);
    const ic = kind === "ok" ? "✓" : kind === "warn" ? "⤳" : kind === "err" ? "✕" : "✎";
    el.innerHTML = `<div class="ic">${ic}</div><div><div class="tt">${esc(title)}</div><div class="tb">${body}</div></div>`;
    toastsEl.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .3s, transform .3s"; el.style.opacity = "0"; el.style.transform = "translateY(6px)"; setTimeout(() => el.remove(), 320); }, 3600);
  }

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

  async function init() {
    try {
      const cfg = await api("/api/config").catch(() => ({ demoMode: true }));
      if (cfg.demoMode) demoBadge.hidden = false;
      const data = await api("/api/cases");
      CASES = data.cases || [];
      renderKpis();
      renderList();
      const first = CASES.find(c => !c._resolved) || CASES[0];
      if (first) selectCase(first.id);
      else detailEl.innerHTML = `<div class="empty">Keine fälligen Sachstände. 🎉</div>`;
    } catch (e) {
      detailEl.innerHTML = `<div class="empty">Fehler beim Laden: ${esc(e.message)}</div>`;
    }
  }

  init();
})();
