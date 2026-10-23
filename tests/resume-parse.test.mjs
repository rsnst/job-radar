import test from "node:test";
import assert from "node:assert/strict";
import { parseResume, mergeImported } from "../web/resume-parse.js";

// Synthetic resume: every name, address and employer is fake.
const RESUME = `Jordan Sample
Austin, TX 78701 | jordan.sample@example.invalid | (555) 010-0199
linkedin.com/in/jordan-sample-synthetic | github.com/jordansample-synthetic

SUMMARY
Data engineer with 8 years building batch and streaming pipelines.

EXPERIENCE
Senior Data Engineer | Example Analytics Co | Mar 2021 - Present
- Built Python and SQL pipelines for finance reporting
- Cut nightly load time by 40%

Data Analyst, Sample Retail Inc.   06/2017 – 02/2021
• Wrote weekly dashboards for store operations

EDUCATION
Example State University
Bachelor of Science in Computer Science, 2017  GPA: 3.6

SKILLS
Languages: Python, SQL, C#
Cloud: AWS, Azure; Tools: Airflow, dbt

CERTIFICATIONS
- AWS Certified Data Analytics (synthetic)
`;

test("contact details and links", () => {
  const { data } = parseResume(RESUME);
  assert.equal(data.contact.fullName, "Jordan Sample");
  assert.equal(data.contact.email, "jordan.sample@example.invalid");
  assert.match(data.contact.phone, /555/);
  assert.equal(data.address.city, "Austin");
  assert.equal(data.address.state, "TX");
  assert.equal(data.address.zip, "78701");
  assert.equal(data.links.linkedin, "https://linkedin.com/in/jordan-sample-synthetic");
  assert.equal(data.links.github, "https://github.com/jordansample-synthetic");
});

test("experience with dates, current role and bullets", () => {
  const { data } = parseResume(RESUME);
  assert.equal(data.experience.length, 2);
  const [a, b] = data.experience;
  assert.deepEqual([a.title, a.company, a.start, a.end, a.current], ["Senior Data Engineer", "Example Analytics Co", "2021-03", "", true]);
  assert.match(a.summary, /finance reporting/);
  assert.equal(b.title, "Data Analyst");
  assert.equal(b.company, "Sample Retail Inc.");
  assert.deepEqual([b.start, b.end, b.current], ["2017-06", "2021-02", false]);
});

test("education, skills, certifications, summary", () => {
  const { data } = parseResume(RESUME);
  assert.deepEqual(data.education, [{ school: "Example State University", degree: "Bachelor of Science", field: "Computer Science", gpa: "3.6", year: "2017" }]);
  assert.deepEqual(data.skills, ["Python", "SQL", "C#", "AWS", "Azure", "Airflow", "dbt"]);
  assert.equal(data.certifications.length, 1);
  assert.match(data.summary, /Data engineer/);
});

test("nothing is invented: work authorization, EEO and salary are never produced", () => {
  const { data } = parseResume(RESUME);
  assert.equal(data.work, undefined);
  assert.equal(data.eeo, undefined);
  assert.equal(JSON.stringify(data).includes("salary"), false);
});

test("sparse or empty text yields only what is there", () => {
  assert.deepEqual(parseResume("").data, {});
  const { data, found } = parseResume("just some words about me");
  assert.equal(data.contact, undefined);
  assert.deepEqual(found, []);
});

test("merge fills blanks only and never overwrites", () => {
  const { data } = parseResume(RESUME);
  const current = { contact: { fullName: "Typed By User", email: "", phone: "" }, skills: ["python", "Go"], experience: [{ company: "Mine", title: "T" }] };
  const { profile, filled } = mergeImported(current, data);
  assert.equal(profile.contact.fullName, "Typed By User");
  assert.equal(profile.contact.email, "jordan.sample@example.invalid");
  assert.deepEqual(profile.skills.slice(0, 2), ["python", "Go"]);
  assert.equal(profile.skills.filter((s) => s.toLowerCase() === "python").length, 1);
  assert.equal(profile.experience.length, 1, "existing jobs are kept, not duplicated");
  assert.equal(profile.education.length, 1);
  assert.ok(filled.includes("contact.email") && !filled.includes("contact.fullName") && !filled.includes("experience"));
  assert.equal(current.contact.email, "", "input is not mutated");
});
