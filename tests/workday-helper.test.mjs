import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/workday-helper/content.js", import.meta.url), "utf8");
const sandbox = {
  location: { hostname: "acme.wd5.myworkdayjobs.com" },
  document: { readyState: "loading", addEventListener() {} },
  chrome: { runtime: { onMessage: { addListener() {} } } },
};
vm.runInNewContext(source, sandbox);
const helper = sandbox.JobCompassWorkday;
const profile = {
  format: "job-compass-workday-profile", version: 1,
  profile: {
    contact: { fullName: "Demo Applicant", email: "demo.applicant@example.invalid", phone: "555-0100" },
    address: { street: "100 Example Way", city: "Demo City", state: "ST", zip: "00000", country: "United States" },
    work: { authorizedUS: "yes", needsSponsorship: "no" },
    experience: [{ company: "Synthetic Analytics", title: "Data Analyst" }, { company: "Synthetic Research", title: "Research Analyst" }],
    education: [{ school: "Demo University", degree: "B.S.", field: "Statistics", year: "2020" }],
  },
};
class FakeInput {
  constructor(label, type = "text") { this.labels = [{ textContent: label }]; this.type = type; this.id = ""; this.name = ""; this.disabled = false; this.readOnly = false; this.events = []; this._value = ""; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  getAttribute() { return null; }
  getClientRects() { return [{}]; }
  dispatchEvent(event) { this.events.push(event.type); }
}
const field = (label, extra = {}) => ({
  labels: [{ textContent: label }], id: "", name: "", getAttribute: () => null, ...extra,
});

test("Workday helper maps clear contact and address labels", () => {
  assert.equal(helper.matchValue(field("First Name"), profile), "Demo");
  assert.equal(helper.matchValue(field("Last Name"), profile), "Applicant");
  assert.equal(helper.matchValue(field("Email Address"), profile), "demo.applicant@example.invalid");
  assert.equal(helper.matchValue(field("Address Line 1"), profile), "100 Example Way");
  assert.equal(helper.matchValue(field("Postal Code"), profile), "00000");
  assert.equal(helper.matchValue(field("Legally authorized to work in the United States?"), profile), "yes");
  assert.equal(helper.matchValue(field("Will you require visa sponsorship?"), profile), "no");
});

test("Workday helper maps repeated experience rows in profile order", () => {
  const used = {};
  assert.equal(helper.matchValue(field("Company"), profile, used), "Synthetic Analytics");
  assert.equal(helper.matchValue(field("Company"), profile, used), "Synthetic Research");
});

test("Workday helper leaves passwords, protected disclosures, checkboxes, and ambiguous fields alone", () => {
  assert.equal(helper.matchValue(field("Password"), profile), null);
  assert.equal(helper.matchValue(field("Gender"), profile), null);
  assert.equal(helper.matchValue(field("Veteran Status"), profile), null);
  assert.equal(helper.matchValue(field("Resume Upload"), profile), null);
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/workday-helper/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["https://*.myworkdayjobs.com/*", "https://*.myworkday.com/*"]);
  assert.ok(!manifest.permissions.includes("identity"));
});

test("Fill changes only matched text inputs and dispatches framework input events", () => {
  const name = new FakeInput("First Name");
  const email = new FakeInput("Email Address", "email");
  const password = new FakeInput("Password", "password");
  const gender = new FakeInput("Gender");
  const checkbox = new FakeInput("I agree", "checkbox");
  const fields = [name, email, password, gender, checkbox];
  const doc = { readyState: "loading", addEventListener() {},
    querySelectorAll: () => fields.filter((el) => !["checkbox", "radio", "password", "file", "hidden"].includes(el.type)) };
  const context = {
    location: { hostname: "acme.myworkdayjobs.com" }, document: doc,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    HTMLInputElement: FakeInput, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(source, context);
  const result = context.JobCompassWorkday.fill(profile);
  assert.equal(result.filled, 2);
  assert.equal(name.value, "Demo");
  assert.equal(email.value, "demo.applicant@example.invalid");
  assert.deepEqual(name.events, ["input", "change"]);
  assert.equal(password.value, "");
  assert.equal(gender.value, "");
  assert.equal(checkbox.value, "");
});
