// Tests for the application flow's rules and the demo guarantees. Run: node --test tests/flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as model from "../web/flow-model.js";
import * as store from "../web/store.js";

const { DEMO_JOB, DEMO_PROFILE, FIELDS, STEP_LABEL, applyAnswers, buildDemoDraft, draftSource, getPath, isDemoJob, missingRequired, reviewBlockers, setPath, supportText } = model;

test("setPath returns a new object and leaves the input unchanged", () => {
  const a = { work: { authorizedUS: "yes" } };
  const b = setPath(a, "work.needsSponsorship", "no");
  assert.equal(getPath(b, "work.needsSponsorship"), "no");
  assert.equal(getPath(a, "work.needsSponsorship"), undefined);
  assert.equal(getPath(b, "work.authorizedUS"), "yes");
});

test("missingRequired lists only required blanks, with their labels", () => {
  assert.deepEqual(missingRequired(DEMO_PROFILE), ["Needs visa sponsorship"]);
  const empty = missingRequired({});
  assert.ok(empty.includes("Full legal name") && empty.includes("Email") && empty.includes("Authorized to work in the US"));
  assert.ok(!empty.includes("ZIP code"), "optional fields are not required");
});

test("applyAnswers fills only the answers given and ignores blanks", () => {
  const out = applyAnswers(DEMO_PROFILE, { "work.needsSponsorship": "no", "work.noticePeriod": "   " });
  assert.equal(getPath(out, "work.needsSponsorship"), "no");
  assert.equal(getPath(out, "work.noticePeriod"), "");
  assert.deepEqual(missingRequired(out), []);
});

test("every field in the form has a path that exists in the profile shape", () => {
  for (const f of FIELDS) assert.notEqual(getPath(DEMO_PROFILE, f.path), undefined, f.path);
});

test("demo job is recognised by its demo:// address and can't reach an employer", () => {
  assert.equal(isDemoJob(DEMO_JOB), true);
  assert.ok(DEMO_JOB.url.startsWith("demo://"));
  assert.equal(isDemoJob({ url: "https://boards.greenhouse.io/acme/jobs/1" }), false);
  assert.equal(isDemoJob({ url: "https://example.com/job", demo: true }), true, "a demo flag alone also marks it demo");
});

test("Workday support copy explains the app-owned worker and the demo exercises that guide", () => {
  const copy = supportText("Workday");
  assert.match(copy, /prepares a tailored resume and answer packet/i);
  assert.match(copy, /queue supported application steps in its browser worker/i);
  assert.match(copy, /account sign-in, emailed verification, CAPTCHA/i);
  assert.equal(DEMO_JOB.ats, "Workday-style mock (synthetic)");
  assert.equal(isDemoJob(DEMO_JOB), true, "the Workday-style walkthrough remains an isolated demo");
});

test("demo draft is built from the profile, flags what the profile lacks, and names no real employer", () => {
  const d = buildDemoDraft(DEMO_PROFILE, DEMO_JOB);
  assert.ok(d.resume.includes("Demo Applicant (synthetic)"));
  assert.ok(d.resume.includes("Tailored for: Senior Analyst"));
  assert.ok(d.missing.some((m) => /Tableau/.test(m)), "posting asks for Tableau, which the profile lacks");
  assert.ok(d.flags.length >= 1);
  assert.deepEqual(d.profileGaps, ["Needs visa sponsorship"]);
  assert.ok(!/https?:\/\//.test(d.resume + d.cover), "no real URLs in demo output");
});

test("demo data uses only reserved example domains and fictional phone numbers", () => {
  const text = JSON.stringify(DEMO_PROFILE);
  assert.ok(text.includes("example.invalid"));
  assert.ok(!/@(gmail|yahoo|outlook|hotmail)\./i.test(text));
  assert.ok(DEMO_PROFILE.contact.phone.startsWith("555-01"));
});

// The demo store must never call the network. A fetch that throws makes any leak visible.
test("demo store operations make no network calls and never touch the tracker", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("network call during demo"); };
  try {
    store.resetDemo();
    const p = await store.loadProfile(true);
    assert.equal(p.ok, true);
    await store.saveProfile(applyAnswers(p.profile, { "work.needsSponsorship": "no" }), true);
    assert.deepEqual(missingRequired((await store.loadProfile(true)).profile), []);

    assert.equal((await store.getApplication(DEMO_JOB)).data.application, null);
    await store.saveDoc(DEMO_JOB, "resume", "text", [], "ai");
    await store.saveStatus(DEMO_JOB, "preparing", "");
    await store.saveStatus(DEMO_JOB, "submitted", "", {
      step: "submitted_by_user", receipt: { destination: "demo", resume_version: 1, cover_version: null },
    });
    const app = (await store.getApplication(DEMO_JOB)).data;
    assert.equal(app.application.status, "submitted");
    assert.equal(app.docs.length, 1);
    assert.ok(app.application.history.some((h) => h.receipt), "receipt is kept in demo memory");

    const draft = await store.draftFor(DEMO_JOB, "");
    assert.equal(draft.ok, true);
    assert.equal(await store.postingHtml(DEMO_JOB).then((h) => h.length > 0), true);
    assert.equal(calls, 0, "no network calls were made");
  } finally {
    globalThis.fetch = realFetch;
    store.resetDemo();
  }
});

test("demo state resets so one demo can't leak into the next", async () => {
  store.resetDemo();
  await store.saveDoc(DEMO_JOB, "resume", "old", [], "ai");
  store.resetDemo();
  assert.equal((await store.getApplication(DEMO_JOB)).data.docs.length, 0);
});

test("draft source: the employer's text wins, pasted text is used only without it, and blank means none", () => {
  assert.deepEqual(draftSource({ posting: "Employer text", pasted: "Pasted" }), { text: "Employer text", source: "employer" });
  assert.deepEqual(draftSource({ posting: "", pasted: "<p>Pasted  text</p>" }), { text: "Pasted text", source: "pasted" });
  assert.deepEqual(draftSource({ posting: "  ", pasted: "   " }), { text: "", source: "" });
  assert.deepEqual(draftSource({}), { text: "", source: "" });
});

test("review is blocked until a tailored resume version is saved, and the blocker points to Materials", () => {
  const b = reviewBlockers({ profile: DEMO_PROFILE, resumeSaved: false });
  assert.equal(b.length, 2, "missing answer and missing resume");
  assert.ok(b.some((x) => x.step === "materials" && /resume/i.test(x.text)));
  assert.deepEqual(reviewBlockers({ profile: applyAnswers(DEMO_PROFILE, { "work.needsSponsorship": "no" }), resumeSaved: false })
    .map((x) => x.step), ["materials"]);
});

test("review has no blockers once answers are complete and a resume is saved", () => {
  const ready = applyAnswers(DEMO_PROFILE, { "work.needsSponsorship": "no" });
  assert.deepEqual(reviewBlockers({ profile: ready, resumeSaved: true }), []);
});

test("the cover letter is never a blocker", () => {
  const ready = applyAnswers(DEMO_PROFILE, { "work.needsSponsorship": "no" });
  assert.deepEqual(reviewBlockers({ profile: ready, resumeSaved: true }), [], "no cover letter saved and nothing blocks");
});

test("step labels say the applicant recorded the step, never that the app did it", () => {
  for (const label of Object.values(STEP_LABEL)) {
    assert.ok(label.startsWith("You recorded:"), label);
  }
});

import { addCustomAnswer } from "../web/flow-model.js";

test("custom answers: added, updated in place, never duplicated, never invented", () => {
  const base = { custom: [{ question: "Why us?", answer: "old" }] };
  const upd = addCustomAnswer(base, "  why US? ", "new answer");
  assert.equal(upd.ok, true);
  assert.equal(upd.updated, true);
  assert.deepEqual(upd.profile.custom, [{ question: "Why us?", answer: "new answer" }]);
  assert.equal(base.custom[0].answer, "old", "input is not mutated");
  const add = addCustomAnswer(base, "Favorite tool?", "dbt");
  assert.equal(add.profile.custom.length, 2);
  assert.equal(addCustomAnswer(base, "Question only", "").ok, false);
  assert.equal(addCustomAnswer(base, "", "answer only").ok, false);
});

test("custom answers for one application only carry a local flag, and the 25 cap holds", () => {
  const local = addCustomAnswer({}, "Notice period?", "2 weeks", { local: true });
  assert.deepEqual(local.profile.custom, [{ question: "Notice period?", answer: "2 weeks", local: true }]);
  const full = { custom: Array.from({ length: 25 }, (_, i) => ({ question: `q${i}`, answer: "a" })) };
  assert.equal(addCustomAnswer(full, "one more", "x").ok, false);
  assert.equal(addCustomAnswer(full, "q3", "changed").ok, true, "updating an existing one is still allowed");
});
