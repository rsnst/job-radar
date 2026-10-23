import test from "node:test";
import assert from "node:assert/strict";
import { matchJob, yearlyFromPay, cleanAutoApply } from "../web/autoapply.js";

const on = { enabled: true, keywords: [".NET", "Backend"], minSalary: 100000, locations: ["Austin"], remoteOk: true };

test("criteria off never matches", () => {
  assert.equal(matchJob({ title: ".NET Developer" }, { enabled: false }).match, false);
});

test("a matching job passes and a non-matching one is explained", () => {
  assert.equal(matchJob({ title: "Senior .NET Developer", loc: "Austin, TX", pay: "$120k" }, on).match, true);
  const r = matchJob({ title: "Sales Manager", loc: "Austin, TX" }, on);
  assert.equal(r.match, false);
  assert.ok(r.reasons.includes("Title doesn't match your keywords."));
});

test("salary floor skips low pay but keeps jobs with no pay listed", () => {
  assert.equal(matchJob({ title: ".NET Developer", loc: "Austin", pay: "$80k" }, on).match, false);
  assert.equal(matchJob({ title: ".NET Developer", loc: "Austin", pay: "" }, on).match, true);
});

test("remote jobs pass the location rule when remote is allowed", () => {
  assert.equal(matchJob({ title: ".NET Developer", loc: "Denver", remote: true }, on).match, true);
  assert.equal(matchJob({ title: ".NET Developer", loc: "Denver", remote: false }, on).match, false);
});

test("yearlyFromPay handles ranges, k suffixes, and hourly rates", () => {
  assert.equal(yearlyFromPay("$90k – $120k / year"), 90000);
  assert.equal(yearlyFromPay("$45/hour"), 93600);
  assert.equal(yearlyFromPay("Not listed"), null);
});

test("cleanAutoApply caps lists and bounds the salary floor", () => {
  const c = cleanAutoApply({ enabled: true, keywords: "a, b", minSalary: 9e9 });
  assert.deepEqual(c.keywords, ["a", "b"]);
  assert.equal(c.minSalary, 1000000);
});
