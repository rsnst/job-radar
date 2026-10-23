// Read-only probe: shows what the worker would see and do on a real Workday page, without typing anything,
// creating an account, signing in, or submitting. Shallow mode only loads the page. --deep also clicks
// "Apply" and then "Apply Manually" (plain navigation) to reach the sign-up screen, and stops there.
//   node src/probe.js <workday-job-url> [--deep]
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { classifyCheckbox } from "./accounts.js";

export function isProbeUrl(value) {
  try {
    const u = new URL(value);
    if (process.env.NODE_ENV === "test" && process.env.WORKER_TEST_ALLOW_LOCAL === "1" && ["localhost", "127.0.0.1"].includes(u.hostname)) return true;
    return u.protocol === "https:" && (/(^|\.)myworkdayjobs\.com$/.test(u.hostname) || /(^|\.)myworkday\.com$/.test(u.hostname));
  } catch { return false; }
}

// Runs inside the page (also pasteable into a browser console). Reads only; never changes the page.
export function inspectPage() {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const txt = (e) => (e.innerText || e.textContent || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const labelOf = (el) => ([...(el.labels || [])].map(txt).join(" ") + " " + (el.getAttribute("aria-label") || "")).replace(/\s+/g, " ").trim();
  const buttons = [...document.querySelectorAll("button,a[role=button],a")].filter(vis).map(txt).filter((t) => t && t.length < 60);
  return {
    title: document.title,
    buttons: [...new Set(buttons)].slice(0, 40),
    headings: [...document.querySelectorAll("h1,h2,h3")].filter(vis).map(txt).filter(Boolean).slice(0, 10),
    captcha: !!document.querySelector('iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]'),
    passwordFields: [...document.querySelectorAll('input[type="password"]')].filter(vis).length,
    emailFields: [...document.querySelectorAll('input[type="email"], input[name*="email" i]')].filter(vis).length,
    codeFields: [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code" i], input[aria-label*="code" i]')].filter(vis).length,
    checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].filter(vis).map(labelOf),
    fileInputs: [...document.querySelectorAll('input[type="file"]')].map((e) => labelOf(e) || e.name || "file"),
    mentionsVerification: /verif(y|ication)|check your email|enter the code/i.test(document.body?.innerText || ""),
  };
}

// What the worker would do with those facts. Pure, so it can be tested.
export function interpret(f) {
  const has = (re) => f.buttons.some((b) => re.test(b));
  const notes = [];
  const checks = f.checkboxes.map((label) => ({ label, verdict: classifyCheckbox(label) })).filter((c) => c.verdict !== "ignore");
  let stage = "job-page";
  if (f.captcha) { stage = "security-check"; notes.push("A CAPTCHA/security check is present: the worker stops and hands the run to you."); }
  else if (f.passwordFields >= 2) { stage = "create-account"; notes.push("Create-account form (two password fields)."); }
  else if (f.passwordFields === 1) { stage = "sign-in"; notes.push("Sign-in form (one password field). The worker signs in only with an account it saved earlier."); }
  else if (f.mentionsVerification && f.codeFields) { stage = "verification-code"; }
  else if (has(/^apply( now| for this job)?$/i)) { notes.push('"Apply" button found: the worker would click it.'); }
  else notes.push("No Apply button and no account form recognised on this page.");
  if (has(/^apply manually$/i)) notes.push('"Apply Manually" found.');
  for (const c of checks) notes.push(c.verdict === "terms"
    ? `Terms box "${c.label}": ticked only if you turned on the separate terms opt-in; otherwise the run stops.`
    : `Legal box "${c.label}": the worker always stops here for you.`);
  if (stage === "create-account" && !f.emailFields) notes.push("Warning: no visible email field on the create-account form; the worker's selector would fail.");
  return { stage, notes, checkboxes: checks };
}

export async function probe(url, { deep = false } = {}) {
  if (!isProbeUrl(url)) throw new Error("Probe only opens Workday job links (*.myworkdayjobs.com / *.myworkday.com).");
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const requests = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("request", (r) => { if (r.method() !== "GET") requests.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const steps = [{ step: "loaded", ...(await page.evaluate(inspectPage)) }];
    if (deep) {
      const apply = page.getByRole("button", { name: /^(apply|apply now|apply for this job)$/i }).or(page.getByRole("link", { name: /^(apply|apply now|apply for this job)$/i })).first();
      if (await apply.count()) { await apply.click().catch(() => {}); await page.waitForTimeout(1500); steps.push({ step: "after Apply", ...(await page.evaluate(inspectPage)) }); }
      const manual = page.getByRole("button", { name: /^apply manually$/i }).or(page.getByRole("link", { name: /^apply manually$/i })).first();
      if (await manual.count()) { await manual.click().catch(() => {}); await page.waitForTimeout(1500); steps.push({ step: "after Apply Manually", ...(await page.evaluate(inspectPage)) }); }
    }
    return { url, deep, steps: steps.map((s) => ({ ...s, ...interpret(s) })), nonGetRequests: requests };
  } finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  const report = await probe(url, { deep: process.argv.includes("--deep") });
  for (const s of report.steps) console.log(`\n[${s.step}] stage=${s.stage}\n  buttons: ${s.buttons.slice(0, 12).join(" | ")}\n${s.notes.map((n) => `  - ${n}`).join("\n")}`);
  console.log(`\nNon-GET requests made by the page: ${report.nonGetRequests.length ? report.nonGetRequests.join(", ") : "none"}\nNothing was typed, created or submitted.`);
}
