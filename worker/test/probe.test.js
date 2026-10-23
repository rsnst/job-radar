import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { interpret, isProbeUrl, probe } from "../src/probe.js";

const base = { buttons: [], headings: [], captcha: false, passwordFields: 0, emailFields: 0, codeFields: 0, checkboxes: [], fileInputs: [], mentionsVerification: false };

test("probe URL check accepts only Workday hosts", () => {
  assert.ok(isProbeUrl("https://acme.wd5.myworkdayjobs.com/en-US/x/job/y"));
  assert.ok(!isProbeUrl("https://myworkdayjobs.com.evil.example/x"));
  assert.ok(!isProbeUrl("http://acme.myworkdayjobs.com/x"));
  assert.ok(!isProbeUrl("https://example.com"));
});

test("interpret describes what the worker would do", () => {
  assert.equal(interpret({ ...base, buttons: ["Apply", "Sign In"] }).stage, "job-page");
  assert.match(interpret({ ...base, buttons: ["Apply"] }).notes.join(" "), /would click it/);
  assert.equal(interpret({ ...base, passwordFields: 2, emailFields: 1 }).stage, "create-account");
  assert.equal(interpret({ ...base, passwordFields: 1 }).stage, "sign-in");
  assert.equal(interpret({ ...base, captcha: true, passwordFields: 2 }).stage, "security-check");
  const r = interpret({ ...base, passwordFields: 2, emailFields: 1, checkboxes: ["I agree to the terms and privacy notice", "Show password", "I certify the answers are true"] });
  assert.deepEqual(r.checkboxes.map((c) => c.verdict), ["terms", "legal"]);
  assert.match(interpret({ ...base, passwordFields: 2 }).notes.join(" "), /no visible email field/);
});

test("deep probe reaches the sign-up screen on a mock page and changes nothing", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Mock</title><button id=a>Apply</button><div id=m hidden><button id=b>Apply Manually</button></div>
      <div id=c hidden><input type=email aria-label=Email><input type=password aria-label=Password><input type=password aria-label="Verify New Password">
      <label><input type=checkbox> I agree to the terms and privacy notice</label><label><input type=checkbox> I certify this is true</label><button id=mk>Create Account</button></div>
      <script>a.onclick=()=>{a.hidden=true;m.hidden=false};b.onclick=()=>{m.hidden=true;c.hidden=false};mk.onclick=()=>fetch('/created',{method:'POST'})</script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  Object.assign(process.env, { NODE_ENV: "test", WORKER_TEST_ALLOW_LOCAL: "1" });
  const report = await probe(`http://127.0.0.1:${server.address().port}/job`, { deep: true });
  assert.deepEqual(report.steps.map((s) => s.step), ["loaded", "after Apply", "after Apply Manually"]);
  assert.equal(report.steps.at(-1).stage, "create-account");
  assert.deepEqual(report.steps.at(-1).checkboxes.map((c) => c.verdict), ["terms", "legal"]);
  assert.deepEqual(report.nonGetRequests, []);
  assert.ok(seen.every((s) => s.startsWith("GET")), seen.join(","));
  const shallow = await probe(`http://127.0.0.1:${server.address().port}/job`);
  assert.deepEqual(shallow.steps.map((s) => s.step), ["loaded"]);
});
