import test from "node:test";
import assert from "node:assert/strict";
import { verifyAgainst, lineDiff, parseMaterials } from "../lib/tailor.js";

const source = "Jane Smith. Built .NET APIs at Acme for 5 years. Azure, SQL Server.";
const job = { title: "Backend Engineer", company: "Initech", text: "We want Kubernetes and 3+ years of Go." };

test("numbers not in the source or posting are flagged", () => {
  const flags = verifyAgainst({ source, job, output: "Led a team of 12 engineers." });
  assert.ok(flags.some((f) => f.kind === "number" && f.text === "12"));
});

test("numbers present in the source are not flagged", () => {
  const flags = verifyAgainst({ source, job, output: "Built APIs for 5 years." });
  assert.equal(flags.filter((f) => f.kind === "number").length, 0);
});

test("capitalised terms not in source or posting are flagged, known ones are not", () => {
  const flags = verifyAgainst({ source, job, output: "Used .NET, Azure and Terraform daily." });
  const terms = flags.filter((f) => f.kind === "term").map((f) => f.text);
  assert.deepEqual(terms, ["Terraform"]);
});

test("line diff marks additions and removals", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d.map((x) => x.type), ["same", "del", "add", "same"]);
});

test("parseMaterials rejects non-JSON and empty resumes", () => {
  assert.equal(parseMaterials("not json"), null);
  assert.equal(parseMaterials(JSON.stringify({ resume: "  " })), null);
  const ok = parseMaterials(JSON.stringify({ resume: "Jane", cover_letter: "Hi", missing: ["Go"], notes: [] }));
  assert.equal(ok.resume, "Jane");
  assert.deepEqual(ok.missing, ["Go"]);
});

import { profileGaps, minimalProfile } from "../lib/tailor.js";

test("profileGaps reports what is missing and never fills it", () => {
  const g = profileGaps({ contact: { fullName: "Jane" } }, "");
  assert.ok(g.includes("Email") && g.includes("A resume (upload or paste it in My profile)"));
  assert.ok(!g.includes("Full legal name"));
});

test("minimalProfile drops street address, references and EEO answers", () => {
  const m = minimalProfile({ address: { street: "1 Main", city: "Austin", state: "TX" }, eeo: { gender: "female" }, references: [{ name: "X" }] });
  assert.equal(JSON.stringify(m).includes("1 Main"), false);
  assert.equal(JSON.stringify(m).includes("female"), false);
  assert.equal(JSON.stringify(m).includes('"X"'), false);
  assert.equal(m.location.city, "Austin");
});
