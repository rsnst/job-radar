// Workday account step: sign in with a stored employer account, or (opt-in) create one with an alias address,
// then finish email verification from the alias inbox. CAPTCHAs and other bot checks always stop the run for the
// user; nothing here tries to get past them.
import { decryptSecret, encryptSecret, generatePassword } from "./vault.js";
import { ensureAlias, takeVerification } from "./inbound.js";
import { linkAllowed } from "./mail.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAPTCHA = 'iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]';
const EMAIL = 'input[type="email"]:visible, input[name*="email" i]:visible, input[autocomplete="username"]:visible';
const CODE = 'input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[aria-label*="code" i]:visible';
const testLocal = (u) => process.env.NODE_ENV === "test" && process.env.WORKER_TEST_ALLOW_LOCAL === "1" && ["localhost", "127.0.0.1"].includes(new URL(u).hostname);
const stop = (stage, message) => ({ stop: { status: "needs_user", stage, message } });
const SECURITY = stop("security-check", "A CAPTCHA or security check appeared. Complete it on the employer's site; Job Compass will not attempt to bypass it.");

async function click(page, name) {
  const b = page.getByRole("button", { name }).first();
  if (!(await b.count())) return false;
  await b.click(); await page.waitForTimeout(700); return true;
}
const passwordFields = (page) => page.locator('input[type="password"]:visible');
const blocked = async (page) => (await page.locator(CAPTCHA).count()) > 0;

async function signIn(page, acct, key) {
  await page.locator(EMAIL).first().fill(acct.email);
  await passwordFields(page).first().fill(decryptSecret(acct.password_enc, key));
  await click(page, /^sign in$/i);
  if (await blocked(page)) return SECURITY;
  if (await passwordFields(page).count()) return stop("account-signin", "Sign-in to the saved employer account did not work. Remove the saved account in Job Compass settings or sign in yourself.");
  return null;
}

async function verify(page, ctx, since) {
  const text = await page.locator("body").innerText().catch(() => "");
  if (!/verif(y|ication)|check your email|enter the code|confirm your email/i.test(text)) return null;
  const until = Date.now() + ctx.verifyMs;
  while (Date.now() < until) {
    const got = await takeVerification(ctx.rest, ctx.run.user_id, since);
    if (got?.code && await page.locator(CODE).count()) {
      await page.locator(CODE).first().fill(got.code);
      await click(page, /^(verify|submit|continue|confirm)$/i);
      return null;
    }
    if (got?.link && (linkAllowed(got.link) || testLocal(got.link))) {
      const tab = await page.context().newPage();
      await tab.goto(got.link, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await tab.close().catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      return null;
    }
    await sleep(ctx.verifyPollMs);
  }
  return stop("email-verification", "Workday sent a verification email that did not reach the Job Compass inbox in time. Check the saved account's email in settings or verify it yourself.");
}

async function create(page, ctx, host) {
  if (!ctx.key || !ctx.domain) return stop("account-not-configured", "Account creation is on, but the worker has no CREDENTIAL_KEY or INBOX_DOMAIN yet.");
  // Opting into account automation is not consent to an employer's agreement.
  // Hand off before creating an alias or saving a password.
  const boxes = page.locator('input[type="checkbox"]:visible');
  for (let i = 0; i < await boxes.count(); i++) {
    const box = boxes.nth(i);
    const label = await box.evaluate((el) => [...(el.labels || [])].map((l) => l.innerText || l.textContent || "").join(" ") + " " + (el.getAttribute("aria-label") || ""));
    if (/terms|privacy|agree|consent|certif(y|ication)|authorize|declaration/i.test(label)) {
      return stop("account-terms", "Review the employer's terms and create the account yourself. Job Compass will not accept legal agreements for you.");
    }
  }
  const email = await ensureAlias(ctx.rest, ctx.run.user_id, ctx.domain);
  const password = generatePassword();
  await page.locator(EMAIL).first().fill(email);
  const pws = passwordFields(page);
  for (let i = 0; i < await pws.count(); i++) await pws.nth(i).fill(password);
  // Save the credential before submitting so a created account is never left without its password.
  const row = { user_id: ctx.run.user_id, host, email, password_enc: encryptSecret(password, ctx.key) };
  await ctx.rest("employer_accounts?on_conflict=user_id,host", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
  const since = new Date(Date.now() - 2000).toISOString();
  await click(page, /^create account$/i);
  if (await blocked(page)) return SECURITY;
  const v = await verify(page, ctx, since);
  if (v) return v;
  const left = await passwordFields(page).count();
  if (left === 1) return signIn(page, { email, password_enc: row.password_enc }, ctx.key);   // created, now at sign-in
  if (left > 1) {
    await ctx.rest(`employer_accounts?user_id=eq.${encodeURIComponent(ctx.run.user_id)}&host=eq.${encodeURIComponent(host)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return stop("account-create", "Workday did not accept the new account (the password rules or form may have changed). Nothing was saved. Create the account yourself.");
  }
  return null;
}

// Returns null when the page is clear to continue, or { stop: {...} } to hand the run back to the user.
export async function handleAccount(page, ctx) {
  if (await blocked(page)) return SECURITY;
  if (!(await passwordFields(page).count())) return null;
  const host = new URL(page.url()).hostname;
  const uid = encodeURIComponent(ctx.run.user_id);
  const [acct] = await ctx.rest(`employer_accounts?select=email,password_enc&user_id=eq.${uid}&host=eq.${encodeURIComponent(host)}&limit=1`);
  const creating = (await passwordFields(page).count()) >= 2;
  let out;
  if (acct && !creating) out = await signIn(page, acct, ctx.key);
  else if (!ctx.settings.createAccounts) {
    return stop("account", "This Workday tenant needs an account. Turn on “Create employer accounts for me” in your apply settings, or sign in yourself.");
  } else {
    if (!creating) { // sign-in page: switch to the create form
      const link = page.getByRole("button", { name: /create account/i }).or(page.getByRole("link", { name: /create account/i })).first();
      if (await link.count()) { await link.click(); await page.waitForTimeout(700); }
    }
    out = await create(page, ctx, host);
  }
  if (out) return out;
  await ctx.rest(`employer_accounts?user_id=eq.${uid}&host=eq.${encodeURIComponent(host)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_used_at: new Date().toISOString() }) }).catch(() => {});
  return null;
}
