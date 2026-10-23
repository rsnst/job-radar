// Mock Workday + mock Supabase on localhost only. No real employer site, account, or mailbox is involved.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, generatePassword, loadKey } from "../src/vault.js";
import { aliasToken, extractVerification, linkAllowed, senderAllowed } from "../src/mail.js";
import { authorized, startInboundServer } from "../src/inbound.js";

const userId = "00000000-0000-4000-8000-000000000001";
const KEY = randomBytes(32).toString("base64");
const SECRET = "synthetic-inbound-secret";
const DOMAIN = "inbox.test";

test("vault round-trips, rejects tampering, and generates policy-friendly passwords", () => {
  const key = loadKey(KEY);
  const token = encryptSecret("hunter2-synthetic", key);
  assert.match(token, /^v1\./);
  assert.ok(!token.includes("hunter2"));
  assert.equal(decryptSecret(token, key), "hunter2-synthetic");
  assert.throws(() => decryptSecret(token.slice(0, -2) + "AA", key));
  assert.throws(() => decryptSecret(token, loadKey(randomBytes(32).toString("base64"))));
  assert.equal(loadKey("short"), null);
  const p = generatePassword();
  assert.ok(p.length >= 20 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p));
  assert.notEqual(p, generatePassword());
});

test("mail parsing only trusts Workday senders and keeps just a code or link", () => {
  assert.ok(senderAllowed("Workday <no-reply@myworkday.com>"));
  assert.ok(!senderAllowed("Workday <no-reply@myworkday.com.evil.example>"));
  assert.ok(!senderAllowed("x@gmail.com"));
  assert.deepEqual(extractVerification("Verify your email", "Your verification code is 483920. It expires soon."), { code: "483920", link: "" });
  const r = extractVerification("Confirm", "Click https://acme.wd5.myworkdayjobs.com/verify?t=abc to confirm.");
  assert.equal(r.link, "https://acme.wd5.myworkdayjobs.com/verify?t=abc");
  assert.equal(extractVerification("Hi", "Visit https://evil.example/verify?t=1"), null);
  assert.ok(linkAllowed("https://x.myworkday.com/a") && !linkAllowed("http://x.myworkday.com/a") && !linkAllowed("https://myworkday.com.evil.example/a"));
  assert.equal(aliasToken(["Jo <jc-abcdef123456@inbox.test>"], DOMAIN), "abcdef123456");
  assert.equal(aliasToken("jc-abcdef123456@other.test", DOMAIN), "");
  assert.ok(authorized("Bearer s3", "s3") && authorized(`Basic ${Buffer.from("u:s3").toString("base64")}`, "s3"));
  assert.ok(!authorized("Bearer nope", "s3") && !authorized("", "s3") && !authorized("Bearer s3", ""));
});

// ---- mock Supabase (generic eq-filter tables) -----------------------------------------------------------
function mockSupabase(seed = {}) {
  const tables = { employer_accounts: [], mail_aliases: [], inbound_mail: [], ...seed };
  const rows = (t, url) => {
    const filters = [...url.searchParams].filter(([, v]) => v.startsWith("eq.")).map(([k, v]) => [k, v.slice(3)]);
    return (tables[t] ||= []).filter((r) => filters.every(([k, v]) => String(r[k]) === v && true)
      && (t !== "inbound_mail" || !url.searchParams.has("expires_at") || true));
  };
  return { tables, rows };
}

async function body(req) { let b = ""; for await (const c of req) b += c; return b ? JSON.parse(b) : null; }

function workdayHtml({ mode, captcha, accountTerms }) {
  return `<!doctype html><title>Sample Workday</title>
  ${captcha ? '<div class="captcha-box"></div>' : ""}
  <button id="apply" type="button">Apply</button>
  <div id="create" hidden>
    <label>Email <input type="email" name="email" aria-label="Email"></label>
    <label>Password <input type="password" aria-label="Password"></label>
    <label>Verify New Password <input type="password" aria-label="Verify New Password"></label>
    ${accountTerms ? `<label><input type="checkbox" id="terms"> ${accountTerms === true ? "I agree to the terms and privacy notice" : accountTerms}</label>` : ""}
    <button type="button" id="mk">Create Account</button>
  </div>
  <div id="verify" hidden><p>Enter the verification code we emailed you.</p>
    <input name="code" aria-label="Verification code"><button type="button" id="vf">Verify</button><p id="err"></p></div>
  <div id="signin" hidden>
    <label>Email <input type="email" name="email" aria-label="Email"></label>
    <label>Password <input type="password" aria-label="Password"></label>
    <button type="button" id="si">Sign In</button><p id="err2"></p></div>
  <form id="application" hidden>
    <label>First name <input required name="firstName"></label>
    <label>Last name <input required name="lastName"></label>
    <label>Email <input required type="email" name="email"></label>
    <button type="submit">Submit Application</button>
  </form>
  <script>
  const $ = (id) => document.getElementById(id);
  const show = (id) => { for (const v of ["create","verify","signin","application"]) $(v).hidden = v !== id; $("apply").hidden = true; };
  $("apply").onclick = () => show("${mode === "signin" ? "signin" : "create"}");
  $("mk").onclick = async () => {
    const pw = [...document.querySelectorAll("#create input[type=password]")].map((i) => i.value);
    if (pw[0] !== pw[1] || ($("terms") && !$("terms").checked)) return;
    await fetch("/created?email=" + encodeURIComponent(document.querySelector("#create input[type=email]").value) + "&pw=" + encodeURIComponent(pw[0]));
    show("verify");
  };
  $("vf").onclick = async () => {
    const r = await fetch("/check?code=" + encodeURIComponent(document.querySelector("#verify input").value));
    if (r.ok) show("application"); else $("err").textContent = "Wrong code";
  };
  $("si").onclick = async () => {
    const r = await fetch("/signin?email=" + encodeURIComponent(document.querySelector("#signin input[type=email]").value) + "&pw=" + encodeURIComponent(document.querySelector("#signin input[type=password]").value));
    if (r.ok) show("application"); else $("err2").textContent = "Invalid credentials";
  };
  $("application").addEventListener("submit", (e) => { e.preventDefault(); document.body.innerHTML = "<h1>Thank you for applying. Your application has been submitted.</h1>"; });
  </script>`;
}

async function harness(t, { autoApply = { createAccounts: true }, seed, sendMail = true, mailCode = "483920", mailFrom = "Workday <no-reply@myworkday.com>", accountTerms = true } = {}) {
  const db = mockSupabase(seed);
  const seen = { created: null, signins: [], runs: [] };
  const state = { run: { id: "r1", user_id: userId, job_key: "", user_decision: "pending" }, tracker: null };
  let inboundUrl = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (v, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/workday") { res.writeHead(200, { "content-type": "text/html" }); return res.end(workdayHtml({ mode: url.searchParams.get("mode"), captcha: url.searchParams.get("captcha") === "1", accountTerms })); }
    if (url.pathname === "/created") {
      seen.created = { email: url.searchParams.get("email"), pw: url.searchParams.get("pw") };
      res.writeHead(204); res.end();
      if (sendMail) await fetch(inboundUrl, { method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ to: seen.created.email, from: mailFrom, subject: "Verify your email", text: `Your verification code is ${mailCode}.` }) });
      return;
    }
    if (url.pathname === "/check") { res.writeHead(url.searchParams.get("code") === "483920" ? 204 : 400); return res.end(); }
    if (url.pathname === "/signin") {
      seen.signins.push({ email: url.searchParams.get("email"), pw: url.searchParams.get("pw") });
      res.writeHead(url.searchParams.get("pw") === "stored-synthetic-pw" ? 204 : 401); return res.end();
    }
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (!m) return send({ error: "no route" }, 404);
    const t = m[1];
    if (t === "profile_details") return send([{ data: { contact: { fullName: "Jordan Example", email: "jordan@example.test", phone: "5550100" }, address: {}, work: {}, links: {}, autoApply } }]);
    if (t === "profiles") return send([{ text: "Jordan Example\nSample resume" }]);
    if (t === "application_docs") return send([{ body: "Jordan Example\nProduct engineer.", version: 3, kind: "resume" }]);
    if (t === "applications") { if (req.method === "POST") { state.tracker = await body(req); res.writeHead(204); return res.end(); } return send([]); }
    if (t === "application_runs") {
      if (req.method === "PATCH") { state.run = { ...state.run, ...(await body(req)) }; seen.runs.push(state.run.stage); res.writeHead(204); return res.end(); }
      return send([{ status: "running", user_decision: "pending" }]);
    }
    if (req.method === "GET") return send(db.rows(t, url));
    if (req.method === "POST") {
      const row = await body(req); const key = url.searchParams.get("on_conflict");
      const list = (db.tables[t] ||= []);
      const cols = key ? key.split(",") : [];
      const at = cols.length ? list.findIndex((r) => cols.every((c) => r[c] === row[c])) : -1;
      if (at >= 0) { if (!/ignore-duplicates/.test(req.headers.prefer || "")) list[at] = { ...list[at], ...row }; }
      else list.push({ id: list.length + 1, consumed: false, created_at: new Date().toISOString(), ...row });
      res.writeHead(204); return res.end();
    }
    if (req.method === "PATCH") { const patch = await body(req); db.rows(t, url).forEach((r) => Object.assign(r, patch)); res.writeHead(204); return res.end(); }
    if (req.method === "DELETE") { db.tables[t] = db.tables[t].filter((r) => !db.rows(t, url).includes(r)); res.writeHead(204); return res.end(); }
    send({}, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rest = async (path, o = {}) => {
    const r = await fetch(`${base}/rest/v1/${path}`, { ...o, headers: { "Content-Type": "application/json", ...(o.headers || {}) } });
    return r.status === 204 ? null : r.json();
  };
  const inbound = startInboundServer({ rest, secret: SECRET, domain: DOMAIN, port: 0 });
  await new Promise((r) => inbound.listening ? r() : inbound.once("listening", r));
  inboundUrl = `http://127.0.0.1:${inbound.address().port}/inbound`;
  t.after(() => { server.close(); inbound.close(); });
  Object.assign(process.env, { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: "synthetic", NODE_ENV: "test", WORKER_TEST_ALLOW_LOCAL: "1",
    CREDENTIAL_KEY: KEY, INBOX_DOMAIN: DOMAIN, VERIFY_WAIT_MS: "6000", VERIFY_POLL_MS: "300" });
  const { processRun } = await import(`../src/index.js?accounts=${Math.random()}`);
  const go = (query, extra = {}) => { state.run.job_key = `${base}/workday${query}`; return processRun({ ...state.run, job: { title: "Synthetic Role" }, ...extra }); };
  return { db, seen, state, go, inboundUrl: () => inboundUrl };
}

test("opt-in: creates an alias account, stores the password encrypted, verifies by code, submits unattended", async (t) => {
  const h = await harness(t, { accountTerms: false });
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.status, "submitted", JSON.stringify(h.state.run));
  const [acct] = h.db.tables.employer_accounts;
  assert.ok(acct && acct.host === "127.0.0.1" && /^jc-[0-9a-f]{18}@inbox\.test$/.test(acct.email));
  assert.equal(h.seen.created.email, acct.email);
  assert.equal(decryptSecret(acct.password_enc, loadKey(KEY)), h.seen.created.pw);
  const everything = JSON.stringify([h.state.run, h.state.tracker, h.db.tables.inbound_mail, h.db.tables.mail_aliases]);
  assert.ok(!everything.includes(h.seen.created.pw), "password must not appear in run results, tracker, or mail rows");
  const [mail] = h.db.tables.inbound_mail;
  assert.equal(mail.consumed, true); assert.equal(mail.code, "");
  assert.ok(h.state.run.result.filled_fields.some((x) => x.value === "Jordan"));
});

test("employer terms are not accepted without the separate opt-in", async (t) => {
  const h = await harness(t);
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.status, "needs_user");
  assert.equal(h.state.run.stage, "account-terms");
  assert.match(h.state.run.message, /requires accepting the employer's terms/);
  assert.deepEqual(h.db.tables.employer_accounts, []);
  assert.deepEqual(h.db.tables.mail_aliases, []);
  assert.equal(h.seen.created, null);
});

test("without the opt-in the worker stops at the account page and creates nothing", async (t) => {
  const h = await harness(t, { autoApply: { createAccounts: false } });
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.status, "needs_user");
  assert.equal(h.state.run.stage, "account");
  assert.deepEqual(h.db.tables.employer_accounts, []);
  assert.equal(h.seen.created, null);
});

test("a stored employer account signs in without creating a new one", async (t) => {
  const key = loadKey(KEY);
  const seed = { employer_accounts: [{ user_id: userId, host: "127.0.0.1", email: "jc-existing000000@inbox.test", password_enc: encryptSecret("stored-synthetic-pw", key) }] };
  const h = await harness(t, { autoApply: {}, seed });
  await h.go("?mode=signin", { auto_submit: true });
  assert.equal(h.state.run.status, "submitted", JSON.stringify(h.state.run));
  assert.deepEqual(h.seen.signins, [{ email: "jc-existing000000@inbox.test", pw: "stored-synthetic-pw" }]);
  assert.equal(h.seen.created, null);
  assert.equal(h.db.tables.employer_accounts.length, 1);
});

test("a CAPTCHA stops the run for the user and nothing is attempted", async (t) => {
  const h = await harness(t);
  await h.go("?captcha=1", { auto_submit: true });
  assert.equal(h.state.run.status, "needs_user");
  assert.equal(h.state.run.stage, "security-check");
  assert.deepEqual(h.db.tables.employer_accounts, []);
});

test("verification mail that never arrives hands the run back instead of guessing", async (t) => {
  const h = await harness(t, { sendMail: false, accountTerms: false });
  process.env.VERIFY_WAIT_MS = "1200";
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.status, "needs_user");
  assert.equal(h.state.run.stage, "email-verification");
});

test("mail from a non-Workday sender is ignored", async (t) => {
  const h = await harness(t, { mailFrom: "Phisher <x@evil.example>", accountTerms: false });
  process.env.VERIFY_WAIT_MS = "1200";
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.stage, "email-verification");
  assert.deepEqual(h.db.tables.inbound_mail, []);
});

test("with the separate opt-in the plain terms box is ticked, and the acceptance is listed on the run", async (t) => {
  const h = await harness(t, { autoApply: { createAccounts: true, acceptAccountTerms: true } });
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.status, "submitted", JSON.stringify(h.state.run));
  assert.match(h.state.run.result.accepted_terms?.[0] || "", /terms and privacy notice/);
  assert.equal(h.db.tables.employer_accounts.length, 1);
});

test("acceptAccountTerms alone (without createAccounts) does nothing", async (t) => {
  const h = await harness(t, { autoApply: { createAccounts: false, acceptAccountTerms: true } });
  await h.go("", { auto_submit: true });
  assert.equal(h.state.run.stage, "account");
  assert.deepEqual(h.db.tables.employer_accounts, []);
});

test("even when opted in, certifications, declarations and marketing consent always stop for the user", async (t) => {
  for (const label of ["I certify that the information I provide is true", "I authorize a background check", "I agree to the terms and also consent to marketing emails", "I declare I am not a veteran"]) {
    const h = await harness(t, { autoApply: { createAccounts: true, acceptAccountTerms: true }, accountTerms: label });
    await h.go("", { auto_submit: true });
    assert.equal(h.state.run.status, "needs_user", label);
    assert.equal(h.state.run.stage, "account-legal", label);
    assert.deepEqual(h.db.tables.employer_accounts, [], label);
  }
});
