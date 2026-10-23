import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { useQuota, refundQuota } from "../lib/quota.js";

const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const headers = Object.fromEntries(vercel.headers.find((h) => h.source === "/(.*)").headers.map((h) => [h.key, h.value]));

test("every page ships a strict CSP and the standard security headers", () => {
  const csp = headers["Content-Security-Policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/(?<!wasm-)unsafe-eval/.test(csp), "no unsafe-eval (wasm-unsafe-eval is needed for sql.js)");
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "no inline scripts");
  assert.ok(!/cdnjs/.test(csp), "resume readers are self-hosted");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.ok(headers["Referrer-Policy"] && headers["Permissions-Policy"]);
});

test("the page has no inline script or inline event handler the CSP would block", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc=/, "inline <script> found");
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), "inline event handler found");
});

test("pdf.js and mammoth are vendored locally and PDF reading disables eval", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  execFileSync("node", ["scripts/vendor.mjs", out], { stdio: "ignore" });
  for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs", "mammoth.browser.min.js"]) assert.ok(fs.statSync(`${out}/vendor/${f}`).size > 10000, f);
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.ok(!/cdnjs\.cloudflare\.com/.test(app));
  assert.match(app, /isEvalSupported: false/);
  const pdfjs = JSON.parse(fs.readFileSync("node_modules/pdfjs-dist/package.json", "utf8")).version;
  const [maj, min, pat] = pdfjs.split(".").map(Number);
  assert.ok(maj > 4 || (maj === 4 && (min > 2 || (min === 2 && pat >= 67))), `pdfjs-dist ${pdfjs} must include the CVE-2024-4367 fix (4.2.67+)`);
});

test("daily limits are counted by the database, not read-then-written by the API", async () => {
  const calls = [];
  globalThis.fetch = async (url, o) => { calls.push([url, JSON.parse(o.body)]); return { ok: true, json: async () => calls.length < 3 }; };
  const ctx = { url: "https://x.supabase.co", token: "t", key: "k" };
  assert.deepEqual(await useQuota(ctx, "chat", 30), { ok: true, allowed: true });
  assert.deepEqual(calls[0], ["https://x.supabase.co/rest/v1/rpc/use_quota", { kind: "chat", daily: 30 }]);
  await refundQuota(ctx, "chat");
  assert.match(calls[1][0], /rpc\/refund_quota$/);
  assert.deepEqual(await useQuota(ctx, "fit", 5), { ok: true, allowed: false });
  globalThis.fetch = async () => ({ ok: false });
  assert.deepEqual(await useQuota(ctx, "fit", 5), { ok: false, allowed: false });
  for (const f of ["api/chat.js", "api/fit.js", "api/tailor.js"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /useQuota\(/, f);
    assert.ok(!/_usage\?select/.test(src), `${f} must not read the counter table`);
  }
});

test("the detail proxy refuses redirects and the worker image does not run as root", () => {
  assert.ok((fs.readFileSync("api/detail.js", "utf8").match(/redirect: "error"/g) || []).length >= 2);
  assert.match(fs.readFileSync("worker/Dockerfile", "utf8"), /^USER pwuser$/m);
});

test("hardening.sql closes the direct-write holes", () => {
  const sql = fs.readFileSync("supabase/hardening.sql", "utf8");
  assert.match(sql, /revoke insert, update, delete on public\.chat_usage/);
  assert.match(sql, /user_decision = 'pending' and result = '\{\}'::jsonb/);
  assert.match(sql, /autoSubmit/);
  assert.match(sql, /runs_last_day\(\) < 50/);
});
