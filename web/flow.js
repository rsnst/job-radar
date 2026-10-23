// The in-app application flow: materials, answers, account setup, review, then an explicit open of the employer page.
// Nothing here submits an application. The applicant opens the employer's page, submits it there, and records it here.
// Demo jobs (demo:// addresses) run against a mock application page inside this app with synthetic data.
import { account } from "./account.js";
import { DEMO_JOB, FIELDS, applyAnswers, draftSource, getPath, isDemoJob, missingRequired, reviewBlockers, STEP_LABEL, supportText } from "./flow-model.js";
import { resumeToPdf } from "./resume-pdf.js";
import { getApplication, saveStatus, saveDoc, draftFor, loadProfile, saveProfile, postingHtml, resetDemo } from "./store.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const PENDING_KEY = "jc.pendingApply";
const PENDING_MS = 30 * 60 * 1000;

const STEPS = [["materials", "Materials"], ["answers", "Your answers"], ["account", "Account setup"], ["review", "Review and submit"]];
const MAX_TEXT = 30000;

let st = null;          // the open flow: { job, demo, step, profile, app, posting, draft, kind, edited, mock, approved, opened, receipt, error }
let signInHandler = () => {};
export function setSignInHandler(fn) { signInHandler = fn; }

// ---------- entry points
// The card and details Apply buttons call this. It never opens the employer's site directly.
export function openApplyEntry(job) {
  if (!job) return;
  if (isDemoJob(job)) return openFlow(job);
  if (!account.user) return openGate(job);
  return openFlow(job);
}

export function openDemo() { return openFlow(DEMO_JOB); }

// After signing in, the applicant returns to the job they chose. Read once, then cleared.
export function takePendingApply() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.at && Date.now() - p.at < PENDING_MS && p.job ? p.job : null;
  } catch { return null; }
}
function setPending(job) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ at: Date.now(), job })); } catch { /* storage can be blocked */ }
}

export async function openFlow(job) {
  const demo = isDemoJob(job);
  if (demo) resetDemo();
  if (!demo && !account.user) return openGate(job);
  st = { job, demo, step: "materials", profile: null, app: null, posting: "", pasted: "", draft: null, kind: "resume",
    edited: { resume: "", cover: "" }, mock: false, approved: false, opened: false, receipt: null, error: "", retry: null, loadFailed: false };
  const dlg = $("#flow-dialog");
  if (!dlg.open) dlg.showModal();
  paint("<p class=\"note\" role=\"status\">Loading your application…</p>");
  // Each request is allowed to fail on its own. A failed one shows a message and a retry, never a half-loaded flow.
  const [p, a, text] = await Promise.all([
    settle(() => loadProfile(demo), "Couldn't load your profile."),
    settle(() => getApplication(job), "Couldn't load this application."),
    settle(() => postingHtml(job), null),
  ]);
  if (!st || st.job !== job) return;
  st.posting = plain(text.value || "");
  if (!p.ok || !a.ok) {
    st.loadFailed = true;
    st.error = (!p.ok ? p.error : a.error) || "Couldn't load this application.";
    st.retry = () => openFlow(job);
    return render();
  }
  st.profile = p.value.profile || {};
  st.app = a.value.ok ? a.value.data : { application: null, docs: [] };
  if (!a.value.ok) {
    st.loadFailed = true;
    st.error = a.value.data?.error || "Couldn't load this application.";
    st.retry = () => openFlow(job);
    return render();
  }
  const latest = (k) => (st.app.docs || []).find((d) => d.kind === k);
  st.edited.resume = latest("resume")?.body || "";
  st.edited.cover = latest("cover")?.body || "";
  render();
}

function openGate(job) {
  const g = $("#gate-root");
  const common = `<div class="pf-top"><h2>${account.enabled ? "Sign in to apply" : "Applications need accounts"}</h2>
    <button type="button" class="link" data-gate="close">Close</button></div>`;
  if (account.enabled) {
    g.innerHTML = `${common}
      <p class="note">Sign in to tailor a resume and cover letter for <strong>${esc(job.title)}</strong> at ${esc(job.company)}, track the application, and keep a receipt.
        After you sign in, you'll come back to this job.</p>
      <div class="sheet-actions"><button type="button" class="btn primary" data-gate="signin">Sign in</button>
        <button type="button" class="btn" data-gate="demo">Try the demo</button></div>
      <p class="note">The demo uses made-up data. It saves nothing and submits nothing.</p>`;
  } else {
    const link = /^https?:\/\//.test(job.url || "");
    g.innerHTML = `${common}
      <p class="note">This site isn't set up for accounts yet, so applications can't be saved here. You can try the demo, or open the employer's posting yourself.</p>
      <div class="sheet-actions"><button type="button" class="btn primary" data-gate="demo">Try the demo</button>
        ${link ? `<button type="button" class="btn" data-gate="posting">Open the employer's posting</button>` : ""}</div>
      <p class="note">Opening the posting goes to the employer's site. Nothing here tracks it.</p>`;
  }
  g.dataset.job = job.url;
  setPending(job);
  g.onclick = (e) => {
    const b = e.target.closest("[data-gate]");
    if (!b) return;
    const act = b.dataset.gate;
    if (act === "close") $("#gate-dialog").close();
    if (act === "demo") { $("#gate-dialog").close(); openDemo(); }
    if (act === "signin") { $("#gate-dialog").close(); signInHandler(); }
    if (act === "posting") window.open(job.url, "_blank", "noopener");
  };
  $("#gate-dialog").showModal();
}

// ---------- rendering
function paint(inner) {
  const root = $("#flow-root");
  root.innerHTML = inner;
}

function header(job) {
  return `<div class="pf-top flow-top"><div><h2>Apply: ${esc(job.title)}</h2>
      <p class="note">${esc(job.company)}${job.loc ? " · " + esc(job.loc) : ""}${job.ats ? " · " + esc(job.ats) : ""}</p></div>
      <button type="button" class="link" data-act="close">Close</button></div>`;
}
function demoBanner() {
  return `<p class="demo-banner" role="note"><strong>DEMO · synthetic data.</strong> Made-up applicant and posting. Nothing is saved to your account, sent, or submitted.</p>`;
}
function stepper() {
  return `<ol class="flow-steps">${STEPS.map(([id, label], i) => `<li><button type="button" data-act="go" data-step="${id}" ${st.step === id ? 'aria-current="step"' : ""}>
    <span class="flow-n">${i + 1}</span>${esc(label)}</button></li>`).join("")}</ol>`;
}

// Resolves to { ok, value } or { ok: false, error }. A network failure becomes a message, not an exception.
async function settle(fn, fallbackError) {
  try {
    const value = await fn();
    if (value && typeof value === "object" && "ok" in value && value.ok === false && fallbackError) return { ok: false, error: value.error || value.data?.error || fallbackError, value };
    return { ok: true, value };
  } catch {
    return { ok: false, error: fallbackError || "Network problem. Check your connection and try again.", value: null };
  }
}

function render() {
  if (!st) return;
  const job = st.job;
  const err = st.error
    ? `<p class="warn-box" role="alert">${esc(st.error)}${st.retry ? ` <button type="button" class="btn" data-act="retry">Try again</button>` : ""}</p>` : "";
  if (st.loadFailed) return paint(`${header(job)}${st.demo ? demoBanner() : ""}${err}`);
  let body;
  if (st.mock) body = mockApplication();
  else if (st.step === "materials") body = materialsStep();
  else if (st.step === "answers") body = answersStep();
  else if (st.step === "account") body = accountStep();
  else body = reviewStep();
  paint(`${header(job)}${st.demo ? demoBanner() : ""}${stepper()}${err}${body}`);
}

// Step 1: tailored resume and cover letter, checked against the posting and the profile.
// The posting text a draft is checked against. The employer's text wins; pasted text is used only when there is none.
const draftText = () => draftSource({ posting: st.posting, pasted: st.pasted }).text;
function postingSource() {
  const src = draftSource({ posting: st.posting, pasted: st.pasted }).source;
  if (src === "employer") return "from the employer's posting";
  if (src === "pasted") return "pasted by you, not checked against the employer's page";
  return "not available on this site";
}

function materialsStep() {
  const hasText = !!draftText();
  const d = st.draft;
  const link = /^https?:\/\//.test(st.job.url) ? `<a href="${esc(st.job.url)}" target="_blank" rel="noopener">Read the posting on the employer's site</a>` : "";
  const intro = `<p class="note">Drafts use only what's in your profile and resume. Edit anything before you save.</p>
    <p class="note">Posting text: <strong>${esc(postingSource())}</strong>.</p>`;
  if (!hasText) {
    return `${intro}<p class="warn-box">The posting's text isn't available here, so a draft can't be checked against it yet. ${link}</p>
      <label class="pf-field wide"><span>Paste the posting's text (optional)</span>
        <textarea id="flow-paste" rows="8" maxlength="20000" placeholder="Copy the job description from the employer's page and paste it here."></textarea></label>
      <p class="note">Only the text you paste is used. Nothing is fetched or added for you, and it is kept in this tab only.</p>
      <div class="sheet-actions"><button type="button" class="btn" data-act="use-paste">Use this text for the draft</button></div>
      <p id="flow-msg" class="note" role="status"></p>${nav({ next: "answers" })}`;
  }
  const pasteNote = st.pasted && !st.posting
    ? `<div class="sheet-actions"><button type="button" class="link" data-act="clear-paste">Clear pasted text</button></div>` : "";
  const hasEditor = !!(d || st.edited.resume || st.edited.cover);
  if (!hasEditor) {
    return `${intro}${pasteNote}<div class="sheet-actions"><button type="button" class="btn primary" data-act="draft">Draft resume and cover letter</button></div>
      <p id="flow-msg" class="note" role="status"></p>${nav({ next: "answers" })}`;
  }
  const gaps = d?.profileGaps?.length
    ? `<div class="warn-box"><strong>Needs your answer before you apply:</strong><ul>${d.profileGaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
        <button type="button" class="btn" data-act="go" data-step="answers">Answer these</button></div>` : "";
  const missing = d?.missing?.length
    ? `<div class="warn-box"><strong>The posting asks for these. Your profile doesn't show them, so the draft doesn't claim them:</strong><ul>${d.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : "";
  const flags = d?.flags?.length
    ? `<div class="warn-box"><strong>Check these. They aren't in your profile, resume or the posting:</strong><ul>${d.flags.map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul></div>` : "";
  const notes = d?.notes?.length ? `<details><summary>What changed</summary><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : "";
  const kind = st.kind;
  const body = st.edited[kind];
  const diff = kind === "resume" ? `<div class="diff" aria-label="Changes from your original resume">${diffHtml(d?.originalResume || "", body)}</div>` : "";
  return `${intro}${pasteNote}${gaps}${missing}${flags}${notes}
    <div class="tabs-inline" role="tablist">
      <button type="button" role="tab" data-act="kind" data-kind="resume" aria-selected="${kind === "resume"}">Resume</button>
      <button type="button" role="tab" data-act="kind" data-kind="cover" aria-selected="${kind === "cover"}">Cover letter</button>
    </div>
    ${diff}
    <label class="pf-field wide"><span>${kind === "resume" ? "Your tailored resume (edit me)" : "Your cover letter (edit me)"}</span>
      <textarea id="flow-body" rows="12" maxlength="${MAX_TEXT}">${esc(body)}</textarea></label>
    <p class="note" id="flow-count">${body.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()}</p>
    <div class="sheet-actions">
      <button type="button" class="btn primary" data-act="save-version">Save as new version</button>
      <button type="button" class="btn" data-act="draft">Draft again</button>
    </div>
    <p id="flow-msg" class="note" role="status"></p>
    ${versionsList(kind)}
    ${nav({ next: "answers" })}`;
}

function versionsList(kind) {
  const docs = (st.app.docs || []).filter((x) => x.kind === kind);
  if (!docs.length) return `<p class="note">No saved versions yet.</p>`;
  return `<h3>Saved versions</h3><ul class="versions">${docs.map((x) => `<li><span>v${x.version} · ${esc(x.source === "edited" ? "edited by you" : "drafted")} · ${esc(fmtDate(x.created_at))}</span>
    <button type="button" class="link" data-act="load" data-id="${esc(x.id)}">Load</button></li>`).join("")}</ul>`;
}

// Step 2: every question the form asks. Blank answers are shown as "Needs your answer" and typed in here.
function answersStep() {
  const p = st.profile || {};
  const blanks = missingRequired(p);
  const rows = FIELDS.map((f) => {
    const v = getPath(p, f.path);
    if (filled(v)) return `<tr><th scope="row">${esc(f.label)}${f.required ? "" : ' <span class="note">(optional)</span>'}</th><td>${esc(v)}</td></tr>`;
    const input = f.kind === "yn"
      ? `<select data-field="${f.path}" aria-label="${esc(f.label)}"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select>`
      : `<input type="text" data-field="${f.path}" aria-label="${esc(f.label)}" maxlength="200">`;
    return `<tr><th scope="row">${esc(f.label)}${f.required ? " *" : ""}</th><td>${input}<br><span class="needs">Needs your answer</span></td></tr>`;
  }).join("");
  const gate = blanks.length
    ? `<p class="warn-box">Answer the ${blanks.length} required question${blanks.length === 1 ? "" : "s"} marked * before you can review: ${esc(blanks.join(", "))}.</p>`
    : `<p class="note">All required questions are answered.</p>`;
  return `<p class="note">Your answers come from My profile. Only blank questions are editable here. Answers you type are saved to your profile${st.demo ? " (demo: only in this tab)" : ""}.</p>
    ${gate}
    ${blanks.length || FIELDS.some((f) => !filled(getPath(p, f.path))) ? `<form id="flow-answers" class="answers-form"><table class="answers"><tbody>${rows}</tbody></table>
      <div class="sheet-actions"><button type="button" class="btn" data-act="save-answers">Save answers</button></div></form>`
      : `<table class="answers"><tbody>${rows}</tbody></table>`}
    <p id="flow-msg" class="note" role="status"></p>
    ${nav({ next: "account", nextDisabled: blanks.length > 0, nextLabel: "Continue to account setup" })}`;
}

// Step 3: account and verification. Everything here happens outside the app, in the applicant's own browser and inbox.
// The app records what the applicant says they did. It checks nothing and does none of these steps.
function accountStep() {
  const hist = st.app.application?.history || [];
  const done = hist.filter((h) => h.step).map((h) => `<li>${esc(fmtDate(h.at))} · ${esc(STEP_LABEL[h.step] || h.step)}</li>`).join("");
  const workday = /workday/i.test(st.job.ats || "");
  const platformGuide = workday ? `<section class="workday-guide" aria-label="Workday application steps">
      <h3>Workday application steps</h3>
      <ol><li><strong>Create or sign in:</strong> use the employer's Workday account page. Choose and enter your password there.</li>
        <li><strong>My Information:</strong> enter your contact and location details from the answer packet.</li>
        <li><strong>My Experience:</strong> upload the tailored resume, then check the work history and education Workday parsed.</li>
        <li><strong>Application Questions:</strong> use the work authorization and sponsorship answers shown in Review.</li>
        <li><strong>Voluntary Disclosures:</strong> answer those yourself; this profile does not guess protected or optional disclosures.</li>
        <li><strong>Review:</strong> check every field and attachment before submitting on Workday.</li></ol>
      <p class="note">The guide doesn't interact by itself. If installed, the optional local helper fills clear matches only when you click it; you still create the account, verify email, solve security checks, and review every field.</p>
      <p><a href="https://github.com/rsnst/job-radar/tree/main/extension/workday-helper" target="_blank" rel="noopener">Set up the optional Chrome helper</a></p>
    </section>` : "";
  return `<p class="note">${esc(supportText(st.job.ats))}</p>${platformGuide}
    <div class="warn-box"><strong>Who does what</strong>
      <ul>
        <li><strong>You:</strong> create any account and choose its password, read the verification email, enter any code, and solve any CAPTCHA.</li>
        <li><strong>Job Compass:</strong> doesn't create accounts, read email, or verify anything. On Workday, the optional local helper can fill clear profile matches after you click it.</li>
        <li><strong>Recording:</strong> the buttons below only save your own note of what you did. They don't check it.</li>
      </ul></div>
    <h3>Record what you did</h3>
    <div class="sheet-actions">
      <button type="button" class="btn" data-act="step" data-step="account_created_by_user">Record: I created my account</button>
      <button type="button" class="btn" data-act="step" data-step="verification_waiting">Record: waiting for verification email</button>
      <button type="button" class="btn" data-act="step" data-step="verification_done">Record: I verified my email</button>
    </div>
    <h3>Your recorded status</h3>
    ${done ? `<ul class="hist">${done}</ul>` : `<p class="note">You haven't recorded any account steps yet.</p>`}
    <p id="flow-msg" class="note" role="status"></p>
    ${nav({ next: "review" })}`;
}

// Step 4: everything that goes to the employer, then the one explicit open action.
function reviewStep() {
  const p = st.profile || {};
  const docs = st.app.docs || [];
  const resume = docs.find((x) => x.kind === "resume");
  const cover = docs.find((x) => x.kind === "cover");
  const blockers = reviewBlockers({ profile: p, resumeSaved: !!resume });
  const blocked = blockers.length > 0;
  const destination = st.demo ? "Demo mock application (no real destination)" : st.job.url;
  const answers = FIELDS.map((f) => {
    const v = getPath(p, f.path);
    return `<tr><th scope="row">${esc(f.label)}</th><td>${filled(v) ? esc(v) : `<span class="needs">Needs your answer</span>`}</td></tr>`;
  }).join("");
  const custom = (p.custom || []).map((q) => `<tr><th scope="row">${esc(q.question)}</th><td>${esc(q.answer)}</td></tr>`).join("");
  const receipt = st.receipt
    ? `<div class="receipt-box" role="status"><strong>${st.demo ? "Demo receipt" : "Receipt recorded"}</strong>
        <p class="note">You recorded this submission ${esc(fmtDate(st.receipt.at))} · resume v${st.receipt.resume_version ?? "none"} · cover letter ${st.receipt.cover_version ? "v" + st.receipt.cover_version : "not used"}${st.demo ? " · demo only, nothing was sent" : ""}</p></div>` : "";
  const blockerBox = blocked
    ? `<div class="warn-box" role="alert"><strong>Before you can open the employer's form:</strong><ul>${blockers.map((b) =>
        `<li>${esc(b.text)} <button type="button" class="link" data-act="go" data-step="${b.step}">${b.step === "materials" ? "Go to Materials" : "Go to answers"}</button></li>`).join("")}</ul></div>`
    : "";
  const workdayGuide = /workday/i.test(st.job.ats || "") ? `<section class="workday-guide" aria-label="Workday checklist">
      <h3>Workday checklist</h3>
      <p>Use the packet below as you move through Workday's application sections. Missing profile answers stay marked; the app won't fill them with guesses.</p>
      <ol><li>My Information: contact details and location</li><li>My Experience: upload the tailored resume and verify parsed work history and education</li>
        <li>Application Questions: confirm work authorization and sponsorship answers</li><li>Voluntary Disclosures: choose your own answers</li><li>Review: check the complete application before submitting</li></ol>
    </section>` : "";
  return `${receipt}
    <dl class="facts"><div><dt>Destination</dt><dd>${esc(destination)}</dd></div><div><dt>Role</dt><dd>${esc(st.job.title)} · ${esc(st.job.company)}</dd></div></dl>
    ${blockerBox}
    ${workdayGuide}
    <h3>What the app drafted</h3>
    <ul class="attach">
      <li>${resume
        ? `Resume v${resume.version}: drafted by the app${resume.source === "edited" ? ", then edited by you" : ""}. Saved in your tracker.`
        : `<span class="needs">No tailored resume saved.</span> Save one in Materials before you can open the form.`}</li>
      <li>Cover letter (optional): ${cover
        ? `v${cover.version}, drafted by the app${cover.source === "edited" ? " and edited by you" : ""}.`
        : "not saved. Skip it unless the form asks for one."}</li>
    </ul>
    ${resume ? `<div class="sheet-actions"><button type="button" class="btn" data-act="download-resume">Download tailored resume (.pdf)</button></div>` : ""}
    <h3>Your answers</h3>
    <table class="answers"><tbody>${answers}${custom}</tbody></table>
    <h3>What you do on the employer's site</h3>
    <p class="note">The website does none of these. On Workday, the optional helper can fill clear profile matches after you click it; review them yourself on the employer's site.</p>
    <ul class="checklist">
      <li>Create or sign in to an account, if the site asks.</li>
      <li>Solve any CAPTCHA or security check, and enter any code from email.</li>
      <li>Upload the resume file, and answer any question not listed above.</li>
      <li>Read the terms and tick consent boxes. Press the final submit button.</li>
    </ul>
    <label class="pf-check wide approve"><input type="checkbox" id="flow-approve" data-act="approve" ${st.approved ? "checked" : ""} ${blocked ? "disabled" : ""}>
      I've checked the answers and attachments above, and they're accurate. I understand the app submits nothing.</label>
    <div class="sheet-actions">
      <button type="button" class="btn primary" data-act="open" ${st.approved && !blocked ? "" : "disabled"}>${st.demo ? "Open mock application" : "Open employer application"}</button>
      <button type="button" class="btn" data-act="copy">${/workday/i.test(st.job.ats || "") ? "Copy Workday answer packet" : "Copy my answers"}</button>
      <button type="button" class="btn" data-act="submitted" ${st.approved && st.opened && !st.receipt ? "" : "disabled"}>${st.demo ? "Record demo submission" : "Record: I submitted it"}</button>
    </div>
    <p class="note">${st.opened
      ? "Opened in a new tab. Submit the form there yourself, then come back and record it here."
      : "Opening the form sends you to the employer's site in a new tab. Nothing is sent by this app."}</p>
    <p id="flow-msg" class="note" role="status"></p>
    ${nav({})}`;
}

// The demo's stand-in for an employer form. It is filled with synthetic answers and cannot submit anything.
function mockApplication() {
  const p = st.profile || {};
  const fields = FIELDS.map((f) => `<div class="mock-row"><span>${esc(f.label)}</span><span>${esc(getPath(p, f.path) || "")}</span></div>`).join("");
  return `<div class="mock-ats" aria-label="Demo application form">
      <p class="demo-banner"><strong>Mock employer form · DEMO.</strong> Synthetic answers. The submit button is disabled, and nothing leaves this page.</p>
      <h3>Application form (mock)</h3>${fields}
      <div class="sheet-actions">
        <button type="button" class="btn" disabled>Submit application (disabled in demo)</button>
        <button type="button" class="btn" data-act="back-review">Back to review</button>
      </div>
      <p class="note">Use “Record demo submission” on the review step to see the receipt.</p></div>`;
}

function nav({ next, nextDisabled = false, nextLabel = "Continue" }) {
  const prevId = st.step !== "materials" ? STEPS[STEPS.findIndex(([id]) => id === st.step) - 1]?.[0] : null;
  return `<div class="sheet-actions flow-nav">
    ${prevId ? `<button type="button" class="btn" data-act="go" data-step="${prevId}">Back</button>` : ""}
    ${next ? `<button type="button" class="btn primary" data-act="go" data-step="${next}" ${nextDisabled ? "disabled" : ""}>${esc(nextLabel)}</button>` : ""}
  </div>`;
}

// ---------- diff for the resume (same line diff as lib/tailor.js)
function diffHtml(before, after) {
  const rows = lineDiffLocal(before, after);
  if (!rows.some((r) => r.type !== "same")) return `<p class="note">No changes from your original resume yet.</p>`;
  return rows.map((r) => `<div class="dl dl-${r.type}">${r.type === "add" ? "+ " : r.type === "del" ? "− " : "  "}${esc(r.text)}</div>`).join("");
}
function lineDiffLocal(before, after) {
  const a = String(before || "").split("\n"), b = String(after || "").split("\n");
  if (a.length * b.length > 250000) return [{ type: "del", text: a.join("\n") }, { type: "add", text: b.join("\n") }];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

// ---------- actions
function msg(t) { const m = $("#flow-msg"); if (m) m.textContent = t; }
// A thrown request (no connection, a closed tab) is reported in place, so the applicant can retry.
async function guard(fn) {
  try { await fn(); }
  catch { msg("Network problem. Check your connection, then try again."); }
}
function usePaste() {
  const text = ($("#flow-paste")?.value || "").trim();
  if (!text) return msg("Paste the posting's text first.");
  st.pasted = text;
  st.draft = null;
  st.error = "";
  render();
  msg("Using the text you pasted. Draft when ready.");
}
function currentStatus() { return st.app.application?.status || "preparing"; }

async function reloadApp() {
  const a = await getApplication(st.job);
  if (a.ok) st.app = a.data;
}

async function draft() {
  const job = st.job;
  const text = draftText();
  if (!text) { st.error = "Add the posting's text first, then draft."; return render(); }
  paint(`${header(job)}${st.demo ? demoBanner() : ""}${stepper()}<p class="note" role="status">Drafting from your profile and resume. Only facts you've entered are used.</p>
    <div class="skeleton" aria-hidden="true" style="height:120px"></div>`);
  const r = await settle(() => draftFor(job, text), "Couldn't draft right now.");
  if (st.job !== job) return;
  if (!r.ok || !r.value.ok) {
    const data = r.value?.data || {};
    st.error = r.ok ? (data.error || "Couldn't draft right now.") : r.error;
    if (data.needsProfile) { st.error = "Fill in My profile first, then draft again."; st.retry = null; }
    else st.retry = draft;
    st.step = "materials";
    return render();
  }
  const r2 = r.value;
  st.retry = null;
  st.error = "";
  st.draft = r2.data;
  st.edited.resume = r2.data.resume;
  st.edited.cover = r2.data.cover;
  render();
}

async function saveVersion() {
  const kind = st.kind;
  const text = st.edited[kind].trim();
  if (!text) return msg("Nothing to save. Write or draft something first.");
  const d = st.draft || {};
  const source = st.draft && text === (kind === "resume" ? d.resume : d.cover) ? "ai" : "edited";
  const flags = kind === "resume" ? d.flags || [] : [];
  const r = await saveDoc(st.job, kind, text, flags, source);
  if (!r.ok) return msg(r.data?.error || "Couldn't save. Try again.");
  const gaps = (d.profileGaps || []).length + (d.missing || []).length;
  await saveStatus(st.job, gaps ? "needs-info" : "ready-for-review", st.app.application?.notes || "");
  await reloadApp();
  render();
  msg(`Saved ${kind === "resume" ? "resume" : "cover letter"} version ${r.data.doc.version}.`);
}

async function saveAnswers() {
  const answers = {};
  for (const el of document.querySelectorAll("#flow-answers [data-field]")) answers[el.dataset.field] = el.value;
  const next = applyAnswers(st.profile, answers);
  const r = await saveProfile(next, st.demo);
  if (!r.ok) return msg(r.error || "Couldn't save your answers. Try again.");
  st.profile = next;
  render();
  msg(missingRequired(next).length ? "Saved. Some required answers are still blank." : "Saved. All required answers are in.");
}

async function recordStep(step) {
  const res = await saveStatus(st.job, currentStatus(), st.app.application?.notes || "", { step });
  if (!res.ok) return msg(res.data?.error || "Couldn't record that step.");
  st.app.application = res.data.application;
  render();
  msg(`Recorded: ${STEP_LABEL[step]}.`);
}

function openEmployer() {
  const docs = st.app.docs || [];
  const blockers = reviewBlockers({ profile: st.profile || {}, resumeSaved: docs.some((x) => x.kind === "resume") });
  if (blockers.length) return msg("Fix the items above first.");
  if (st.demo) { st.mock = true; st.opened = true; return render(); }
  if (!/^https?:\/\//.test(st.job.url)) return msg("This posting has no employer link to open.");
  window.open(st.job.url, "_blank", "noopener");
  st.opened = true;
  const pre = !st.app.application || st.app.application.status === "saved";
  if (pre) {
    saveStatus(st.job, "preparing", st.app.application?.notes || "")
      .then(reloadApp).then(render)
      .catch(() => msg("Opened the employer's page, but the tracker couldn't record it yet."));
  }
  render();
  msg("Opened the employer's page. Come back here to record the submission.");
}

async function recordSubmission() {
  if (!st.approved || !st.opened) return;
  const question = st.demo
    ? "Record this demo submission? Nothing is sent anywhere."
    : "Did you submit this application on the employer's site? This records a receipt with the resume and cover letter versions you used.";
  if (!confirm(question)) return;
  const docs = st.app.docs || [];
  const resume = docs.find((x) => x.kind === "resume");
  const cover = docs.find((x) => x.kind === "cover");
  const at = new Date().toISOString();
  const res = await saveStatus(st.job, "submitted", st.app.application?.notes || "", {
    step: "submitted_by_user",
    receipt: { destination: st.demo ? "demo (mock, nothing sent)" : st.job.url, resume_version: resume?.version ?? null, cover_version: cover?.version ?? null },
  });
  if (!res.ok) return msg(res.data?.error || "Couldn't record. Try again.");
  st.app.application = res.data.application;
  st.receipt = { at, resume_version: resume?.version ?? null, cover_version: cover?.version ?? null };
  st.mock = false;
  render();
}

function answersText() {
  const p = st.profile || {};
  const docs = st.app.docs || [];
  const resume = docs.find((x) => x.kind === "resume");
  const cover = docs.find((x) => x.kind === "cover");
  const lines = [`${st.job.title} · ${st.job.company}`, st.demo ? "(demo, synthetic)" : st.job.url, ""];
  for (const f of FIELDS) lines.push(`${f.label}: ${filled(getPath(p, f.path)) ? getPath(p, f.path) : "Not provided — answer on the employer's site"}`);
  for (const q of p.custom || []) lines.push("", q.question, q.answer);
  if (p.experience?.length) {
    lines.push("", "Work history");
    for (const e of p.experience) lines.push(`${e.title || "Role"} · ${e.company || "Company"} · ${e.start || ""}–${e.current ? "Present" : e.end || ""}`, e.summary || "");
  }
  if (p.education?.length) {
    lines.push("", "Education");
    for (const e of p.education) lines.push(`${[e.degree, e.field].filter(Boolean).join(" ")} · ${e.school || "School"}${e.year ? ` · ${e.year}` : ""}`);
  }
  if (p.skills?.length) lines.push("", `Skills: ${p.skills.join(", ")}`);
  if (resume) lines.push("", `Resume: v${resume.version}`);
  if (resume?.body) lines.push(resume.body);
  if (cover) lines.push("", "Cover letter:", cover.body);
  return lines.join("\n");
}

function downloadResume() {
  const resume = (st?.app?.docs || []).find((d) => d.kind === "resume");
  if (!resume?.body) return msg("Save a tailored resume first.");
  const safe = `${st.job.company || "job"}-${st.job.title || "resume"}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  const href = URL.createObjectURL(new Blob([resumeToPdf(resume.body)], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = `${safe || "tailored-resume"}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  msg("PDF resume downloaded. Select it in Workday's resume upload step, then verify what Workday parses.");
}

async function copyAnswers() {
  try { await navigator.clipboard.writeText(answersText()); msg("Answers copied. Paste them into the form."); }
  catch { msg("Couldn't copy. Select the text and copy it yourself."); }
}

// ---------- wiring (once)
export function initFlow() {
  const dlg = $("#flow-dialog");
  const root = $("#flow-root");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !st) return;
    const act = b.dataset.act;
    if (act === "close") return dlg.close();
    if (act === "go") { st.step = b.dataset.step; st.mock = false; return render(); }
    if (act === "kind") { st.kind = b.dataset.kind; return render(); }
    if (act === "retry") { const f = st.retry; st.retry = null; st.error = ""; return f && f(); }
    if (act === "use-paste") return usePaste();
    if (act === "clear-paste") { st.pasted = ""; st.draft = null; return render(); }
    if (act === "load") {
      const doc = (st.app.docs || []).find((x) => String(x.id) === b.dataset.id);
      if (doc) { st.edited[st.kind] = doc.body; render(); }
      return;
    }
    if (act === "open") return openEmployer();
    if (act === "download-resume") return downloadResume();
    if (act === "back-review") { st.mock = false; return render(); }
    if (act === "copy") return copyAnswers();
    // Actions that talk to the network: a failure becomes a message, and the applicant can try again.
    const run = { draft, "save-version": saveVersion, "save-answers": saveAnswers, step: () => recordStep(b.dataset.step), submitted: recordSubmission }[act];
    if (run) guard(run);
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "flow-approve") { st.approved = e.target.checked; render(); }
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "flow-body") {
      st.edited[st.kind] = e.target.value;
      const c = $("#flow-count");
      if (c) c.textContent = `${e.target.value.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()}`;
      if (st.kind === "resume") { const d = root.querySelector(".diff"); if (d) d.innerHTML = diffHtml(st.draft?.originalResume || "", e.target.value); }
    }
  });
  $("#flow-dialog").addEventListener("close", () => { st = null; });
}
