"use strict";

/*
 * Anmeldung über Microsoft Entra ID (früher Azure AD).
 *
 * Ablauf: Authorization Code Flow mit PKCE. Die App ist ein vertraulicher
 * Client — der Code wird serverseitig gegen Tokens getauscht, das Client-Secret
 * verlässt den Server nie.
 *
 * Bewusst ohne Fremdbibliotheken: nur Node-Bordmittel (crypto, fetch). Das hält
 * das Image klein und die Abhängigkeitskette kurz.
 *
 * Zur Prüfung des ID-Tokens: Es wird direkt vom Token-Endpunkt über TLS
 * abgeholt, nicht über den Browser umgeleitet. Microsoft weist ausdrücklich
 * darauf hin, dass die Signaturprüfung in diesem Fall entfallen kann — der
 * Übertragungsweg selbst bürgt für die Herkunft. Geprüft werden dennoch
 * Zielgruppe (aud), Mandant (tid), Aussteller (iss) und Gültigkeit (exp).
 *
 * Die Sitzung steckt in einem signierten Cookie (HMAC-SHA256). Kein
 * Sitzungsspeicher nötig, damit übersteht die Anmeldung auch einen Neustart.
 */

const crypto = require("crypto");

const TENANT = process.env.MS_TENANT_ID || "";
const CLIENT_ID = process.env.MS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.ENTRA_REDIRECT_URI
  || ((process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "") + "/auth/callback");
const SESSION_HOURS = Number(process.env.SESSION_STUNDEN || 12);

/** Nur diese Konten dürfen herein (Mailadressen, Komma getrennt). Leer = alle im Mandanten. */
const ALLOWED = (process.env.ENTRA_ERLAUBTE_NUTZER || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const COOKIE = "sachstand_sitzung";
const STATE_COOKIE = "sachstand_anmeldung";

/** Konfiguriert und damit einsatzbereit? */
function isConfigured() {
  return Boolean(TENANT && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function secret() {
  // Ohne eigenes Geheimnis wird vom Client-Secret abgeleitet — dann sind die
  // Sitzungen an dessen Rotation gekoppelt, was akzeptabel ist.
  return process.env.SESSION_SECRET || CLIENT_SECRET || "unsicher-nur-fuer-lokale-tests";
}

// --- Signierte Cookies -----------------------------------------------------

function sign(value) {
  const mac = crypto.createHmac("sha256", secret()).update(value).digest("base64url");
  return `${value}.${mac}`;
}

function unsign(signed) {
  const i = String(signed || "").lastIndexOf(".");
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret()).update(value).digest("base64url");
  // Zeitkonstanter Vergleich — sonst wäre die Signatur über Laufzeitmessung angreifbar.
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setCookie(res, name, value, maxAgeSec, secure) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${maxAgeSec}`
  ];
  if (secure) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isSecureRequest(req) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
}

// --- Sitzung ---------------------------------------------------------------

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    email: user.email, name: user.name,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000
  })).toString("base64url");
  return sign(payload);
}

function readSession(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const payload = unsign(raw);
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

// --- Entra-Endpunkte -------------------------------------------------------

function authorizeUrl({ state, codeChallenge }) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${p}`;
}

async function exchangeCode({ code, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    code_verifier: codeVerifier
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `Token-Endpunkt antwortete ${res.status}`);
  }
  return json;
}

/** Prüft die Angaben im ID-Token und liefert den Nutzer. */
function verifyIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("ID-Token hat kein gültiges Format.");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());

  if (claims.aud !== CLIENT_ID) throw new Error("ID-Token gehört zu einer anderen Anwendung.");
  if (claims.tid !== TENANT) throw new Error("Anmeldung aus einem fremden Mandanten.");
  if (!String(claims.iss || "").includes(claims.tid)) throw new Error("Aussteller passt nicht zum Mandanten.");
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now - 60) throw new Error("ID-Token ist abgelaufen.");

  const email = String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase();
  if (!email) throw new Error("Im ID-Token fehlt eine Mailadresse.");
  if (ALLOWED.length && !ALLOWED.includes(email)) {
    throw new Error(`Das Konto ${email} ist für diese Anwendung nicht freigegeben.`);
  }
  return { email, name: claims.name || email };
}

// --- Anmeldeseite ----------------------------------------------------------

function loginPage({ error, ready }) {
  const meldung = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : "";
  const knopf = ready
    ? `<a class="btn" href="/auth/login">Mit Microsoft anmelden</a>`
    : `<p class="err">Die Anmeldung ist noch nicht konfiguriert. Es fehlen
        <code>MS_TENANT_ID</code>, <code>MS_CLIENT_ID</code>, <code>MS_CLIENT_SECRET</code>
        oder <code>APP_PUBLIC_URL</code>.</p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Anmeldung · Sachstands-Cockpit</title>
<style>
  :root { --bg:#F5F7FA; --surface:#fff; --text:#1A2028; --muted:#5C6673; --border:#DCE2EA; --accent:#2F6DB3; --crit:#BC4630; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#10141A; --surface:#191F27; --text:#E7ECF2; --muted:#9AA5B3; --border:#2B333F; --accent:#5E9BE0; --crit:#E07A5F; }
  }
  * { box-sizing:border-box }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
    background:var(--bg); color:var(--text);
    font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,Arial,sans-serif; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:14px;
    padding:30px 28px; width:100%; max-width:390px;
    box-shadow:0 1px 2px rgba(20,30,45,.04), 0 10px 30px rgba(20,30,45,.07); }
  .mark { width:44px; height:44px; border-radius:10px; background:var(--accent); color:#fff;
    display:grid; place-items:center; font-weight:700; font-size:16px; letter-spacing:.5px; }
  h1 { font-size:19px; margin:16px 0 4px; letter-spacing:-.2px }
  p.sub { margin:0 0 22px; color:var(--muted); font-size:13.5px; line-height:1.5 }
  .btn { display:flex; align-items:center; justify-content:center; gap:10px;
    background:var(--accent); color:#fff; text-decoration:none; font-weight:600; font-size:15px;
    padding:14px 18px; border-radius:9px; min-height:48px; }
  .btn:hover { filter:brightness(1.07) }
  .err { color:var(--crit); font-size:13.5px; line-height:1.5; margin:0 0 16px }
  code { font-family:Consolas,ui-monospace,monospace; font-size:12.5px }
  .foot { margin-top:20px; font-size:12px; color:var(--muted) }
</style></head><body>
<div class="card">
  <div class="mark">GS</div>
  <h1>Sachstands-Cockpit</h1>
  <p class="sub">Anmeldung mit dem Microsoft-Konto des Büros.</p>
  ${meldung}${knopf}
  <p class="foot">Kfz-Sachverständigenbüro Gollenstede</p>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// --- Einhängen in Express --------------------------------------------------

/**
 * Registriert die Anmelderouten und liefert eine Middleware, die alles
 * dahinter schützt.
 */
function install(app) {
  const secure = () => String(process.env.COOKIE_SECURE || "auto");

  app.get("/login", (req, res) => {
    if (readSession(req)) return res.redirect("/");
    const err = req.query.fehler ? String(req.query.fehler) : null;
    res.type("html").send(loginPage({ error: err, ready: isConfigured() }));
  });

  app.get("/auth/login", (req, res) => {
    if (!isConfigured()) return res.redirect("/login");
    // PKCE: Verifier bleibt beim Server (im signierten Cookie), nur der
    // Hash geht über den Browser zu Entra.
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ verifier, state })).toString("base64url");
    setCookie(res, STATE_COOKIE, sign(payload), 600,
      secure() === "auto" ? isSecureRequest(req) : secure() === "true");
    res.redirect(authorizeUrl({ state, codeChallenge: challenge }));
  });

  app.get("/auth/callback", async (req, res) => {
    const fail = (msg) => res.redirect("/login?fehler=" + encodeURIComponent(msg));
    try {
      if (req.query.error) {
        return fail(String(req.query.error_description || req.query.error));
      }
      const raw = readCookie(req, STATE_COOKIE);
      const payload = raw ? unsign(raw) : null;
      if (!payload) return fail("Die Anmeldung ist abgelaufen. Bitte erneut versuchen.");
      const { verifier, state } = JSON.parse(Buffer.from(payload, "base64url").toString());
      // Schutz gegen untergeschobene Anmeldungen (CSRF).
      if (!req.query.state || req.query.state !== state) {
        return fail("Die Anmeldung konnte nicht zugeordnet werden. Bitte erneut versuchen.");
      }
      const tokens = await exchangeCode({ code: String(req.query.code || ""), codeVerifier: verifier });
      const user = verifyIdToken(tokens.id_token);

      clearCookie(res, STATE_COOKIE);
      setCookie(res, COOKIE, makeSession(user), SESSION_HOURS * 3600,
        secure() === "auto" ? isSecureRequest(req) : secure() === "true");
      console.log(`[auth] Anmeldung: ${user.email}`);
      res.redirect("/");
    } catch (err) {
      console.warn("[auth] Anmeldung fehlgeschlagen:", err.message);
      fail(err.message);
    }
  });

  app.get("/auth/logout", (req, res) => {
    clearCookie(res, COOKIE);
    // Auch bei Microsoft abmelden, sonst genügt ein Klick für den Wiedereintritt.
    const back = encodeURIComponent((process.env.APP_PUBLIC_URL || "") + "/login");
    if (isConfigured()) {
      return res.redirect(
        `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${back}`);
    }
    res.redirect("/login");
  });

  app.get("/api/me", (req, res) => {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "nicht angemeldet" });
    res.json({ email: s.email, name: s.name, expiresAt: new Date(s.exp).toISOString() });
  });

  /** Alles dahinter erfordert eine Sitzung. */
  return function requireLogin(req, res, next) {
    if (req.path === "/api/health") return next();
    if (req.path === "/login" || req.path.startsWith("/auth/")) return next();
    if (readSession(req)) return next();
    // API-Aufrufe bekommen 401, damit das Frontend reagieren kann;
    // Seitenaufrufe werden zur Anmeldung geschickt.
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "nicht angemeldet", login: "/login" });
    }
    res.redirect("/login");
  };
}

module.exports = { install, isConfigured, readSession, COOKIE };
