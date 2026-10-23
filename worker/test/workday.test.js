import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fillWorkdayPage } from "../src/workday.js";

const profile = {
  contact: { fullName: "Jordan Example", email: "jordan@example.test", phone: "5550100" },
  address: { street: "10 Sample Road", apt: "", city: "Testville", state: "CA", zip: "90000", country: "United States" },
  work: { authorizedUS: "yes", needsSponsorship: "no" },
  links: { linkedin: "", github: "", portfolio: "" },
  experience: [], education: [],
};

test("fills clear profile fields and supported work authorization radios in a local mock ATS page", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
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
    <label><input type="checkbox" name="terms"> I agree to the terms</label>
  `);
  const result = await fillWorkdayPage(page, profile);
  assert.equal(await page.locator('[name="firstName"]').inputValue(), "Jordan");
  assert.equal(await page.locator('[name="lastName"]').inputValue(), "Example");
  assert.equal(await page.locator('[name="email"]').inputValue(), "jordan@example.test");
  assert.equal(await page.locator('[name="city"]').inputValue(), "Testville");
  assert.equal(await page.locator('[name="authorized"][value="yes"]').isChecked(), true);
  assert.equal(await page.locator('[name="sponsorship"][value="no"]').isChecked(), true);
  assert.equal(await page.locator('[name="terms"]').isChecked(), false, "legal checkbox must remain untouched");
  assert.equal(result.missing.length, 0);
  assert.ok(result.filled.some((field) => field.label.includes("authorized to work")));
});

test("reports a required question it cannot safely answer", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<label>Do you have a security clearance? <input required name="clearance"></label>');
  const result = await fillWorkdayPage(page, profile);
  assert.deepEqual(result.missing, ["clearance do you have a security clearance"]);
  assert.equal(await page.locator('[name="clearance"]').inputValue(), "");
});
