import { chromium } from "playwright";
import { resumeToPdf } from "../../web/resume-pdf.js";
import { fillWorkdayPage } from "./workday.js";
import { pathToFileURL } from "node:url";
import { handleAccount } from "./accounts.js";
import { loadKey } from "./vault.js";
import { startInboundServer } from "./inbound.js";

const supaUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const pollMs = Math.max(1500, Number(process.env.WORKER_POLL_MS) || 5000);
const reviewMs = Math.max(60_000, Number(process.env.APPLICATION_REVIEW_TIMEOUT_MS) || 900_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!supaUrl || !serviceKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the private worker.");

async function rest(path, options = {}) {
  const response = await fetch(`${supaUrl}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase worker request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

function isWorkdayUrl(value) {
  try {
    const u = new URL(value);
    if (process.env.NODE_ENV === "test" && process.env.WORKER_TEST_ALLOW_LOCAL === "1" && ["localhost", "127.0.0.1"].includes(u.hostname)) return true;
    return u.protocol === "https:" && (u.hostname === "myworkdayjobs.com" || u.hostname.endsWith(".myworkdayjobs.com")
      || u.hostname === "myworkday.com" || u.hostname.endsWith(".myworkday.com"));
  } catch { return false; }
}

function cleanProfile(data) {
  const c = data?.contact || {}, a = data?.address || {}, w = data?.work || {}, links = data?.links || {};
  return {
    contact: { fullName: c.fullName || "", email: c.email || "", phone: c.phone || "" },
    address: { street: a.street || "", apt: a.apt || "", city: a.city || "", state: a.state || "", zip: a.zip || "", country: a.country || "" },
    work: { authorizedUS: w.authorizedUS || "", needsSponsorship: w.needsSponsorship || "" },
    links: { linkedin: links.linkedin || "", github: links.github || "", portfolio: links.portfolio || "" },
    experience: Array.isArray(data?.experience) ? data.experience : [],
    education: Array.isArray(data?.education) ? data.education : [],
  };
}

async function setRun(run, patch) {
  await rest(`application_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(run.user_id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function userData(run) {
  const uid = encodeURIComponent(run.user_id), key = encodeURIComponent(run.job_key);
  const [profiles, resumes, docs] = await Promise.all([
    rest(`profile_details?select=data&user_id=eq.${uid}&limit=1`),
    rest(`profiles?select=text&user_id=eq.${uid}&limit=1`),
    rest(`application_docs?select=body,version,kind&user_id=eq.${uid}&job_key=eq.${key}&kind=eq.resume&order=version.desc&limit=1`),
  ]);
  return { profile: cleanProfile(profiles[0]?.data), settings: { createAccounts: profiles[0]?.data?.autoApply?.createAccounts === true, acceptAccountTerms: profiles[0]?.data?.autoApply?.createAccounts === true && profiles[0]?.data?.autoApply?.acceptAccountTerms === true }, sourceResume: resumes[0]?.text || "", resume: docs[0]?.body || "", resumeVersion: docs[0]?.version || null };
}

async function waitForDecision(run, page) {
  const until = Date.now() + reviewMs;
  while (Date.now() < until) {
    const [row] = await rest(`application_runs?select=status,user_decision&user_id=eq.${encodeURIComponent(run.user_id)}&id=eq.${encodeURIComponent(run.id)}&limit=1`);
    if (!row || row.status === "cancelled" || row.user_decision === "cancel" || row.user_decision === "reject") return "reject";
    if (row.user_decision === "approve") return "approve";
    await sleep(2500);
  }
  await setRun(run, { status: "needs_user", stage: "review-timeout", message: "Review timed out. Start a new run when you are ready." });
  await page.context().close();
  return "timeout";
}

async function shouldCancel(run) {
  const [row] = await rest(`application_runs?select=user_decision,status&user_id=eq.${encodeURIComponent(run.user_id)}&id=eq.${encodeURIComponent(run.id)}&limit=1`);
  return !row || row.status === "cancelled" || row.user_decision === "cancel" || row.user_decision === "reject";
}

async function handsFreeStillEnabled(run) {
  if (run.auto_submit !== true) return false;
  const uid = encodeURIComponent(run.user_id);
  const [row] = await rest(`profile_details?select=data&user_id=eq.${uid}&limit=1`);
  return row?.data?.autoApply?.autoSubmit === true;
}

async function accountCreationStillEnabled(run) {
  const uid = encodeURIComponent(run.user_id);
  const [row] = await rest(`profile_details?select=data&user_id=eq.${uid}&limit=1`);
  return row?.data?.autoApply?.createAccounts === true;
}

async function visibleFormFields(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el.getClientRects().length;
    const labelOf = (el) => String([
      ...(el.labels ? [...el.labels].map((x) => x.innerText || x.textContent || "") : []),
      el.getAttribute("aria-label"), el.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "),
      el.getAttribute("placeholder"), el.getAttribute("name"), el.id,
      el.closest("fieldset")?.querySelector("legend")?.textContent,
    ].filter(Boolean).join(" · ")).replace(/\s+/g, " ").trim().slice(0, 120) || "Unlabeled field";
    const controls = [...document.querySelectorAll("input,textarea,select")]
      .filter((el) => visible(el) && !["hidden", "submit", "button", "reset"].includes(el.type));
    const custom = [...document.querySelectorAll('[role="combobox"],[role="checkbox"],[role="radio"],[role="textbox"],[contenteditable="true"]')]
      .filter((el) => visible(el) && !el.querySelector("input,textarea,select"));
    const describe = (el, isCustom = false) => {
      const type = String(el.type || el.tagName.toLowerCase()).slice(0, 20);
      const value = el.type === "password" ? (el.value ? "[entered; hidden]" : "")
        : el.type === "checkbox" || el.type === "radio" ? (el.checked ? (el.value || "Selected") : "Not selected")
          : el.type === "file" ? (el.files?.length ? el.files[0].name : "")
            : isCustom ? (el.getAttribute("aria-checked") || el.getAttribute("aria-selected") || el.getAttribute("aria-valuetext") || el.innerText || el.textContent || "")
              : String(el.value || "");
      return { label: labelOf(el).slice(0, 80), type: isCustom ? `custom:${el.getAttribute("role") || "editable"}` : type, value: String(value).replace(/\s+/g, " ").slice(0, 100), required: !!(el.required || el.getAttribute("aria-required") === "true") };
    };
    return { overflow: controls.length + custom.length > 40, customCount: custom.length, fields: [...controls.map((el) => describe(el)), ...custom.map((el) => describe(el, true))].slice(0, 40) };
  });
}

function runReviewResult(filled, missing, fields, overflow, resumeVersion, acceptedTerms = []) {
  return {
    filled_fields: filled.slice(-10).map((x) => ({ label: String(x.label || "Field").slice(0, 80), value: String(x.value || "").slice(0, 100) })),
    missing_fields: [...new Set(missing)].slice(0, 10).map((x) => String(x).slice(0, 120)),
    review_fields: fields.slice(-40),
    review_overflow: overflow || fields.length > 40,
    resume_version: resumeVersion,
    ...(acceptedTerms.length ? { accepted_terms: acceptedTerms } : {}),
  };
}

export async function processRun(run) {
  if (!isWorkdayUrl(run.job_key)) {
    await setRun(run, { status: "failed", stage: "unsupported", message: "The first worker release supports Workday application links only." });
    return;
  }
  const data = await userData(run);
  if (!data.resume) {
    await setRun(run, { status: "needs_user", stage: "materials", message: "Save a tailored resume in Job Compass before starting the application." });
    return;
  }
  await setRun(run, { status: "running", stage: "opening", message: "Opening the Workday application in the Job Compass worker." });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(run.job_key, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!isWorkdayUrl(page.url())) {
      await setRun(run, { status: "failed", stage: "redirect-blocked", message: "The job link redirected outside Workday; the worker stopped." });
      return;
    }
    await page.waitForTimeout(1000);
    if (await page.locator('iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]').count()) {
      await setRun(run, { status: "needs_user", stage: "security-check", message: "Workday presented a CAPTCHA or security check. Complete it manually and start a new run." });
      return;
    }
    const acctCtx = { run, rest, key: loadKey(), domain: process.env.INBOX_DOMAIN || "", settings: data.settings,
      cancelled: () => shouldCancel(run),
      canCreateAccounts: () => accountCreationStillEnabled(run), acceptedTerms: [],
      verifyMs: Number(process.env.VERIFY_WAIT_MS) || 120_000, verifyPollMs: Number(process.env.VERIFY_POLL_MS) || 3000 };
    if (await shouldCancel(run)) { await setRun(run, { status: "cancelled", stage: "cancelled", message: "Application run cancelled." }); return; }
    const acct0 = await handleAccount(page, acctCtx);
    if (acct0) { await setRun(run, acct0.stop); return; }
    const apply = page.getByRole("button", { name: /^(apply|apply now|apply for this job)$/i }).first();
    const applyLink = page.getByRole("link", { name: /^(apply|apply now|apply for this job)$/i }).first();
    if (await apply.count()) await apply.click().catch(() => {});
    else if (await applyLink.count()) await applyLink.click().catch(() => {});
    await page.waitForTimeout(1200);
    let allFilled = [];
    let allMissing = [];
    let allReviewFields = [];
    let reviewOverflow = false;
    let customFields = 0;
    for (let step = 0; step < 8; step++) {
      if (await shouldCancel(run)) { await setRun(run, { status: "cancelled", stage: "cancelled", message: "Application run cancelled." }); return; }
      if (await page.locator('iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]').count()) {
        await setRun(run, { status: "needs_user", stage: "security-check", message: "A CAPTCHA or security check appeared. Complete it manually; Job Compass will not attempt to bypass it.", result: runReviewResult(allFilled, allMissing, allReviewFields, reviewOverflow, data.resumeVersion, acctCtx.acceptedTerms) });
        return;
      }
      if (await shouldCancel(run)) { await setRun(run, { status: "cancelled", stage: "cancelled", message: "Application run cancelled." }); return; }
      const acct = await handleAccount(page, acctCtx);
      if (acct) { await setRun(run, { ...acct.stop, result: runReviewResult(allFilled, allMissing, allReviewFields, reviewOverflow, data.resumeVersion, acctCtx.acceptedTerms) }); return; }
      const result = await fillWorkdayPage(page, data.profile);
      allFilled = [...new Map([...allFilled, ...result.filled].map((x) => [x.label, x])).values()];
      allMissing = [...new Set([...allMissing, ...result.missing.map((x) => String(x).slice(0, 180))])].slice(-40);
      const uploads = page.locator('input[type="file"]');
      for (let i = 0; i < await uploads.count(); i++) {
        const input = uploads.nth(i);
        const info = await input.evaluate((el) => ({
          label: [el.getAttribute("aria-label"), el.getAttribute("name"), el.id, ...(el.labels ? [...el.labels].map((x) => x.innerText || x.textContent || "") : [])].filter(Boolean).join(" "),
          required: el.required || el.getAttribute("aria-required") === "true",
        }));
        if (/resume|curriculum vitae|\bcv\b/i.test(info.label)) {
          await input.setInputFiles({ name: "tailored-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from(resumeToPdf(data.resume), "binary") }).catch(() => {});
          allFilled.push({ label: info.label || "Resume upload", value: "tailored-resume.pdf" });
        } else if (info.required) allMissing.push(info.label || "Required upload");
      }
      const pageFields = await visibleFormFields(page);
      reviewOverflow = reviewOverflow || pageFields.overflow;
      customFields += pageFields.customCount;
      const stepFields = pageFields.fields.map((field) => ({ ...field, step: step + 1 }));
      const fieldMap = new Map(allReviewFields.map((field) => [`${field.step}\u0000${field.label}\u0000${field.type}`, field]));
      for (const field of stepFields) fieldMap.set(`${field.step}\u0000${field.label}\u0000${field.type}`, field);
      allReviewFields = [...fieldMap.values()];
      const submit = page.getByRole("button", { name: /^(submit|submit application|send application)$/i }).last();
      if (await submit.count()) {
        const blockers = [...allMissing];
        if (reviewOverflow || allReviewFields.length > 40) blockers.push("This application has more visible fields than Job Compass can safely preview. Review and submit it yourself on Workday.");
        if (customFields) blockers.push("This application contains custom fields that Job Compass cannot verify. Review and submit it yourself on Workday.");
        const checkboxes = page.locator('input[type="checkbox"]:visible,[role="checkbox"]:visible');
        if (await checkboxes.count()) blockers.push("Review required consent or declaration checkboxes on the employer form.");
        const resultSummary = runReviewResult(allFilled, blockers, allReviewFields, reviewOverflow, data.resumeVersion, acctCtx.acceptedTerms);
        if (blockers.length) {
          await setRun(run, { status: "needs_user", stage: "missing-answers", message: "Some required answers or consent choices need your input. Nothing was submitted.", result: resultSummary });
          return;
        }
        let autoSubmit = await handsFreeStillEnabled(run);
        let reviewed = false;
        if (!autoSubmit) {
          await setRun(run, { status: "awaiting_review", stage: "review", message: "The form is filled. Review every visible application field and value below before approving submission.", result: resultSummary });
          const decision = await waitForDecision(run, page);
          if (decision !== "approve") {
            await setRun(run, { status: decision === "reject" ? "cancelled" : "cancelled", stage: decision, message: decision === "reject" ? "Application review rejected by the user." : "Application run cancelled." });
            return;
          }
          reviewed = true;
        }
        if (autoSubmit && !(await handsFreeStillEnabled(run))) {
          autoSubmit = false;
          await setRun(run, { status: "awaiting_review", stage: "review", message: "Hands-free submission was turned off. Review every visible application field and value below before approving submission.", result: resultSummary });
          const decision = await waitForDecision(run, page);
          if (decision !== "approve") { await setRun(run, { status: "cancelled", stage: decision, message: decision === "reject" ? "Application review rejected by the user." : "Application run cancelled." }); return; }
          reviewed = true;
        }
        const [current] = await rest(`application_runs?select=user_decision&user_id=eq.${encodeURIComponent(run.user_id)}&id=eq.${encodeURIComponent(run.id)}&limit=1`);
        if ((!autoSubmit && (!reviewed || current?.user_decision !== "approve")) || current?.user_decision === "cancel" || current?.user_decision === "reject") return;
        if (autoSubmit && !(await handsFreeStillEnabled(run))) { await setRun(run, { status: "cancelled", stage: "consent-withdrawn", message: "Hands-free submission consent changed. Start a new run to continue." }); return; }
        if (await shouldCancel(run)) { await setRun(run, { status: "cancelled", stage: "cancelled", message: "Application run cancelled." }); return; }
        await submit.click();
        await page.waitForTimeout(1500);
        const confirmation = (await page.locator("body").innerText().catch(() => "")).slice(0, 1000);
        const confirmed = /application (has been )?submitted|thank you for applying|successfully applied|submission (was )?received/i.test(confirmation);
        if (!confirmed) {
          await setRun(run, { status: "needs_user", stage: "confirm-submission", message: "The submit action ran, but Workday did not show a clear confirmation. Check the employer page before retrying.", result: { ...resultSummary, confirmation_text: confirmation.slice(0, 300) } });
          return;
        }
        await setRun(run, { status: "submitted", stage: "complete", message: "Workday confirmed the application submission.", result: { ...resultSummary, submitted_at: new Date().toISOString(), confirmation_text: confirmation.slice(0, 300) } });
        await recordTracker(run, data.resumeVersion);
        return;
      }
      const next = page.getByRole("button", { name: /^(save and continue|continue|next|review)$/i }).last();
      if (!(await next.count())) break;
      await next.click();
      await page.waitForTimeout(900);
    }
    await setRun(run, { status: "needs_user", stage: "unsupported-form", message: "This Workday page did not match the supported flow. No application was submitted.", result: runReviewResult(allFilled, allMissing, allReviewFields, reviewOverflow, data.resumeVersion, acctCtx.acceptedTerms) });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function recordTracker(run, resumeVersion) {
  const endpoint = `applications?user_id=eq.${encodeURIComponent(run.user_id)}&job_key=eq.${encodeURIComponent(run.job_key)}`;
  const [row] = await rest(`${endpoint}&select=history,job&limit=1`);
  const now = new Date().toISOString();
  const history = Array.isArray(row?.history) ? row.history.slice(-99) : [];
  history.push({ at: now, from: row?.status || "ready-for-review", to: "submitted", note: "Submitted by Job Compass worker", receipt: { destination: run.job_key, resume_version: resumeVersion, confirmed_by_worker: true } });
  await rest(`applications?on_conflict=user_id,job_key`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ user_id: run.user_id, job_key: run.job_key, job: row?.job || run.job, status: "submitted", notes: "", history, updated_at: now }) });
}

// A run cancelled or rejected while still queued is never claimed; mark it cancelled so the app shows the right status.
export async function sweepCancelled() {
  await rest("application_runs?status=eq.queued&user_decision=in.(cancel,reject)", {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "cancelled", stage: "cancelled", message: "Application run cancelled.", updated_at: new Date().toISOString() }),
  });
}

async function claimOne() {
  await sweepCancelled().catch(() => {});
  const rows = await rest("application_runs?select=*&status=eq.queued&user_decision=eq.pending&order=created_at.asc&limit=1");
  const run = rows[0];
  if (!run) return null;
  const claimed = await rest(`application_runs?id=eq.${encodeURIComponent(run.id)}&status=eq.queued`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "running", stage: "starting", message: "Worker claimed this application." }),
  });
  return claimed?.[0] || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Job Compass Workday worker is polling the private application queue.");
  if (startInboundServer({ rest })) console.log("Inbound verification-mail webhook is listening.");
  for (;;) {
    try {
      const run = await claimOne();
      if (run) {
        try { await processRun(run); }
        catch (error) {
          console.error(`Run ${run.id} failed:`, error?.message || "unknown worker error");
          await setRun(run, { status: "failed", stage: "worker-error", message: "The application worker encountered an error. Retry from Job Compass." }).catch(() => {});
        }
      } else await sleep(pollMs);
    } catch (error) {
      console.error("Queue poll failed:", error?.message || "unknown error");
      await sleep(pollMs);
    }
  }
}
