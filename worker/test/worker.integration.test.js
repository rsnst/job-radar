import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const userId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

test("worker completes a synthetic local Workday flow and records the receipt", async (t) => {
  const state = { run: { id: runId, user_id: userId, job_key: "", user_decision: "pending" }, tracker: null, uploadedResume: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/workday") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Sample Workday Application</title>
        <button type="button">Apply</button>
        <form id="application">
          <label>First name <input required name="firstName"></label>
          <label>Last name <input required name="lastName"></label>
          <label>Email <input required type="email" name="email"></label>
          <label>City <input name="city"></label>
          <fieldset><legend>Are you legally authorized to work in the United States?</legend>
            <label><input required type="radio" name="authorized" value="yes"> Yes</label>
            <label><input type="radio" name="authorized" value="no"> No</label>
          </fieldset>
          <fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
            <label><input required type="radio" name="sponsorship" value="yes"> Yes</label>
            <label><input type="radio" name="sponsorship" value="no"> No</label>
          </fieldset>
          <label>Resume <input type="file" name="resume" aria-label="Resume upload"></label>
          <button type="submit">Submit Application</button>
        </form>
        <script>document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); document.body.innerHTML = '<h1>Thank you for applying. Your application has been submitted.</h1>'; });</script>`);
      return;
    }
    if (url.pathname === "/rest/v1/profile_details") return send([{ data: {
      contact: { fullName: "Jordan Example", email: "jordan@example.test", phone: "5550100" },
      address: { city: "Testville" }, work: { authorizedUS: "yes", needsSponsorship: "no" }, links: {}, experience: [], education: [], autoApply: { autoSubmit: true },
    } }]);
    if (url.pathname === "/rest/v1/profiles") return send([{ text: "Jordan Example\nSample resume" }]);
    if (url.pathname === "/rest/v1/application_docs") return send([{ body: "Jordan Example\nProduct engineer with test experience.", version: 7, kind: "resume" }]);
    if (url.pathname === "/rest/v1/application_runs" && req.method === "GET") return send([{ status: "running", user_decision: "pending" }]);
    if (url.pathname === "/rest/v1/application_runs" && req.method === "PATCH") {
      let body = ""; for await (const chunk of req) body += chunk;
      state.run = { ...state.run, ...JSON.parse(body) };
      res.writeHead(204); res.end(); return;
    }
    if (url.pathname === "/rest/v1/applications" && req.method === "GET") return send([]);
    if (url.pathname === "/rest/v1/applications" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      state.tracker = JSON.parse(body); res.writeHead(204); res.end(); return;
    }
    send({ error: `Unexpected route: ${req.method} ${url.pathname}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.run.job_key = `${base}/workday`;
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-test-key";
  process.env.NODE_ENV = "test";
  process.env.WORKER_TEST_ALLOW_LOCAL = "1";
  const { processRun } = await import(`../src/index.js?integration=${Date.now()}`);

  await processRun({ ...state.run, job: { title: "Synthetic Product Engineer" }, auto_submit: true });

  assert.equal(state.run.status, "submitted", JSON.stringify(state.run));
  assert.equal(state.run.stage, "complete");
  assert.deepEqual(state.tracker?.status, "submitted");
  assert.equal(state.tracker?.history?.at(-1)?.receipt?.resume_version, 7);
  assert.equal(state.tracker?.history?.at(-1)?.receipt?.confirmed_by_worker, true);
  assert.equal(state.tracker?.job?.title, "Synthetic Product Engineer");
  assert.match(state.run.result?.confirmation_text || "", /Thank you for applying/);
  assert.ok(state.run.result?.filled_fields?.some((x) => x.value === "Jordan"));
  assert.ok(state.run.result?.filled_fields?.some((x) => x.value === "tailored-resume.pdf"));
  assert.deepEqual(state.run.result?.missing_fields, []);
});
