// Application assistant: tailored materials per job, an apply review, and the application tracker.
// Everything here is the signed-in user's own data. Nothing is submitted by this app: the user opens the
// employer's page, completes the form, and then records the submission here with a receipt.
import { account, apiFetch } from "./account.js";
import { matchJob, cleanAutoApply } from "./autoapply.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export const STATUSES = [
  ["saved", "Saved"], ["preparing", "Preparing"], ["needs-info", "Needs your info"], ["ready-for-review", "Ready for review"],
  ["submitted", "Submitted"], ["interview", "Interview"], ["rejected", "Rejected"], ["offer", "Offer"], ["withdrawn", "Withdrawn"],
];
const LABEL = Object.fromEntries(STATUSES);
const STEP_LABEL = {
  account_created_by_user: "You confirmed you created an account",
  verification_waiting: "Waiting for the verification email (you check your inbox)",
  verification_done: "You confirmed email verification",
  submitted_by_user: "You confirmed you submitted the application",
};
// What the app can do on each platform today. Nothing here is automated yet; see docs/ATS_SUPPORT.md.
export function supportText(ats) {
  const name = ats ? String(ats) : "This employer's site";
  return `${name}: the app doesn't fill or submit this form. You complete the account and application steps yourself. Pre-fill isn't built for this platform yet.`;
}
const statusOptions = (cur) => STATUSES.map(([v, t]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`).join("");

const GAP_FIELDS = [
  ["Full legal name", (d) => d.contact?.fullName],
  ["Email", (d) => d.contact?.email],
  ["Phone", (d) => d.contact?.phone],
  ["Work authorization in the US", (d) => d.work?.authorizedUS],
  ["Visa sponsorship", (d) => d.work?.needsSponsorship],
];

// Plain-language answers for the review screen, in the order most application forms ask them.
function answerRows(d = {}) {
  const a = d.address || {}, w = d.work || {}, c = d.contact || {}, l = d.links || {};
  const yn = (v) => (v === "yes" ? "Yes" : v === "no" ? "No" : "");
  const salary = [w.salaryMin, w.salaryMax].filter(Boolean).join(" to ");
  return [
    ["Full legal name", c.fullName, true], ["Preferred name", c.preferredName], ["Pronouns", c.pronouns],
    ["Email", c.email, true], ["Phone", c.phone, true],
    ["Street address", [a.street, a.apt].filter(Boolean).join(", ")], ["City, state, ZIP", [a.city, a.state, a.zip].filter(Boolean).join(", ")],
    ["Country", a.country],
    ["LinkedIn", l.linkedin], ["GitHub", l.github], ["Portfolio", l.portfolio],
    ["Authorized to work in the US", yn(w.authorizedUS), true], ["Needs visa sponsorship", yn(w.needsSponsorship), true],
    ["Visa or status", w.visaStatus], ["Security clearance", w.clearance], ["Over 18", yn(w.over18)],
    ["Background check", yn(w.backgroundCheck)], ["Drug test", yn(w.drugTest)], ["Willing to relocate", yn(w.willingToRelocate)],
    ["Work type", w.workType], ["Notice period", w.noticePeriod], ["Earliest start", w.startDate],
    ["Desired salary (USD)", salary], ["How did you hear about us", w.howHeard], ["Worked here before", w.formerEmployee],
    ["Skills", (d.skills || []).join(", ")], ["Certifications", (d.certifications || []).join(", ")], ["Languages", (d.languages || []).join(", ")],
    ["References", d.references?.length ? `${d.references.length} on file` : ""],
  ];
}

// ---------- API helpers (every call goes through the caller's own token)
async function getApplication(jobKey) {
  return apiFetch(`/api/applications?job=${encodeURIComponent(jobKey)}`);
}
async function saveStatus(job, status, notes, extra = {}) {
  return apiFetch("/api/applications", { method: "PUT", body: { job_key: job.url, job, status, notes, ...extra } });
}
async function saveDoc(job, kind, body, flags, source) {
  return apiFetch("/api/applications", { method: "POST", body: { job_key: job.url, kind, body, flags, source } });
}

// ---------- job panel section
let kitJob = null;
let getDesc = () => "";
// app.js gives us a getter so the description is read at the moment the user asks for a draft.
export function setDescriptionSource(fn) { getDesc = fn; }
let loadLive = async () => "";
// app.js gives us the live posting loader, used when the queue prepares a job that isn't open on screen.
export function setLiveDescriptionLoader(fn) { loadLive = fn; }
const plainText = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
export function renderApplyKit(job) {
  kitJob = job;
  const box = $("#sheet-apply-kit");
  box.hidden = !account.enabled;
  if (!account.enabled) return;
  if (!account.user) {
    box.innerHTML = `<h3>Application</h3><p class="note">Sign in to tailor a resume and cover letter for this job and keep track of your applications.</p>`;
    return;
  }
  box.innerHTML = `<h3>Application</h3><p class="note" id="kit-state">Loading…</p>`;
  loadKit(job);
}

async function loadKit(job) {
  const r = await getApplication(job.url);
  if (kitJob !== job) return;
  const box = $("#sheet-apply-kit");
  if (!r.ok) {
    box.innerHTML = `<h3>Application</h3><p class="note">${esc(r.data.error || "Couldn't load this application.")}</p><div class="sheet-actions"><button type="button" class="btn" id="kit-retry">Try again</button></div>`;
    $("#kit-retry").addEventListener("click", () => loadKit(job));
    return;
  }
  const app = r.data.application;
  const status = app?.status || "";
  const docs = r.data.docs || [];
  const latest = (k) => docs.find((d) => d.kind === k);
  box.innerHTML = `<h3>Application</h3>
    <p class="note">${app ? `Status: <strong>${esc(LABEL[status])}</strong> · updated ${esc(fmtDate(app.updated_at))}` : "Not tracked yet."}
      ${latest("resume") ? ` · Resume v${latest("resume").version}` : ""}${latest("cover") ? ` · Cover letter v${latest("cover").version}` : ""}</p>
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="kit-tailor">${latest("resume") ? "Open tailored materials" : "Tailor resume and cover letter"}</button>
      <button type="button" class="btn" id="kit-review">Prepare to apply</button>
    </div>
    <label class="pf-field"><span>Status</span><select id="kit-status">${statusOptions(status || "saved")}</select></label>
    <label class="pf-field"><span>Notes</span><textarea id="kit-notes" rows="2" maxlength="4000">${esc(app?.notes || "")}</textarea></label>
    <div class="sheet-actions"><button type="button" class="btn" id="kit-track">${app ? "Save status" : "Track this job"}</button></div>
    <p id="kit-msg" class="note" role="status"></p>`;
  $("#kit-tailor").addEventListener("click", () => openTailor(job, getDesc()));
  $("#kit-review").addEventListener("click", () => openReview(job));
  $("#kit-track").addEventListener("click", async () => {
    const btn = $("#kit-track");
    btn.disabled = true; $("#kit-msg").textContent = "Saving…";
    const res = await saveStatus(job, $("#kit-status").value, $("#kit-notes").value.trim());
    btn.disabled = false;
    if (!res.ok) { $("#kit-msg").textContent = res.data.error || "Couldn't save. Try again."; return; }
    $("#kit-msg").textContent = "Saved.";
    loadKit(job);
  });
}

// ---------- tailoring: draft, compare, edit, save a version
let tailorState = null;

export async function openTailor(job, descriptionHtml) {
  const dlg = $("#tailor-dialog");
  const root = $("#tailor-root");
  if (!account.user) return;
  const text = String(descriptionHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  tailorState = { job, draft: null, kind: "resume", edited: { resume: null, cover: null } };
  dlg.showModal();
  if (!text) {
    root.innerHTML = `<div class="pf-top"><h2>Tailor for ${esc(job.title)}</h2><button type="button" class="link" id="tl-close">Close</button></div>
      <p class="note">Open the job's full details first, so there is a posting to match against.</p>`;
    $("#tl-close").addEventListener("click", () => dlg.close());
    return;
  }
  await draft(job, text);
}

async function draft(job, text) {
  const root = $("#tailor-root");
  root.innerHTML = `<div class="pf-top"><h2>Tailor for ${esc(job.title)}</h2><button type="button" class="link" id="tl-close">Close</button></div>
    <p class="note" role="status">Drafting from your profile and resume. Only facts you've entered are used.</p>
    <div class="skeleton" aria-hidden="true" style="height:120px"></div>`;
  $("#tl-close").addEventListener("click", () => $("#tailor-dialog").close());
  const r = await apiFetch("/api/tailor", { method: "POST", body: { job_key: job.url, title: job.title, company: job.company, description: text } });
  if (!r.ok) {
    root.innerHTML = `<div class="pf-top"><h2>Tailor for ${esc(job.title)}</h2><button type="button" class="link" id="tl-close">Close</button></div>
      <p class="note">${esc(r.data.error || "Couldn't draft right now.")}</p>
      ${r.data.needsProfile ? `<p class="note">Fill in My profile first.</p>` : `<div class="sheet-actions"><button type="button" class="btn primary" id="tl-retry">Try again</button></div>`}`;
    $("#tl-close").addEventListener("click", () => $("#tailor-dialog").close());
    $("#tl-retry")?.addEventListener("click", () => draft(job, text));
    return;
  }
  tailorState.draft = { ...r.data, text };
  tailorState.edited = { resume: r.data.resume, cover: r.data.cover };
  renderTailor();
}

function renderTailor() {
  const { job, draft: d, kind, edited } = tailorState;
  const isResume = kind === "resume";
  const body = edited[kind] ?? "";
  const gapList = d.profileGaps?.length
    ? `<div class="warn-box"><strong>Add these to My profile first:</strong><ul>${d.profileGaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
        <button type="button" class="btn" id="tl-open-profile">Open My profile</button></div>` : "";
  const missing = d.missing?.length
    ? `<div class="warn-box"><strong>The posting asks for these. Your profile doesn't show them, so we haven't claimed them:</strong><ul>${d.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : "";
  const flags = d.flags?.length
    ? `<div class="warn-box"><strong>Check these. They aren't in your profile, resume or the posting:</strong><ul>${d.flags.map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul></div>` : "";
  const notes = d.notes?.length ? `<details><summary>What changed</summary><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : "";
  $("#tailor-root").innerHTML = `
    <div class="pf-top"><h2>Tailor for ${esc(job.title)}</h2><button type="button" class="link" id="tl-close">Close</button></div>
    <p class="note">${esc(job.company)}. Every line comes from your profile or resume. Edit anything before you save.</p>
    ${gapList}${missing}${flags}${notes}
    <div class="tabs-inline" role="tablist">
      <button type="button" role="tab" data-kind="resume" aria-selected="${isResume}">Resume</button>
      <button type="button" role="tab" data-kind="cover" aria-selected="${!isResume}">Cover letter</button>
    </div>
    ${isResume ? `<div class="diff" aria-label="Changes from your original resume">${diffHtml(d.originalResume || "", body)}</div>` : ""}
    <label class="pf-field wide"><span>${isResume ? "Your tailored resume (edit me)" : "Your cover letter (edit me)"}</span>
      <textarea id="tl-body" rows="14" maxlength="30000">${esc(body)}</textarea></label>
    <p class="note" id="tl-count">${body.length.toLocaleString()} / 30,000</p>
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="tl-save">Save as new version</button>
      <button type="button" class="btn" id="tl-again">Draft again</button>
    </div>
    <p id="tl-msg" class="note" role="status"></p>
    <div id="tl-versions"></div>`;
  $("#tl-close").addEventListener("click", () => $("#tailor-dialog").close());
  $("#tl-open-profile")?.addEventListener("click", () => { $("#tailor-dialog").close(); $("#resume-open").click(); });
  for (const b of $("#tailor-root").querySelectorAll("[data-kind]")) b.addEventListener("click", () => { tailorState.kind = b.dataset.kind; renderTailor(); });
  $("#tl-body").addEventListener("input", (e) => {
    tailorState.edited[kind] = e.target.value;
    $("#tl-count").textContent = `${e.target.value.length.toLocaleString()} / 30,000`;
    if (isResume) $(".diff").innerHTML = diffHtml(tailorState.draft.originalResume || "", e.target.value);
  });
  $("#tl-save").addEventListener("click", saveVersion);
  $("#tl-again").addEventListener("click", () => draft(job, tailorState.draft.text));
  loadVersions(job);
}

function diffHtml(before, after) {
  const rows = lineDiffLocal(before, after);
  if (!rows.some((r) => r.type !== "same")) return `<p class="note">No changes from your original resume yet.</p>`;
  return rows.map((r) => `<div class="dl dl-${r.type}">${r.type === "add" ? "+ " : r.type === "del" ? "− " : "  "}${esc(r.text)}</div>`).join("");
}

// The same line diff as lib/tailor.js, kept here so the browser doesn't need a module import from lib/.
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

async function saveVersion() {
  const { job, kind, draft: d, edited } = tailorState;
  const text = edited[kind].trim();
  const msg = $("#tl-msg");
  if (!text) { msg.textContent = "Nothing to save. Write or draft something first."; return; }
  const btn = $("#tl-save");
  btn.disabled = true; msg.textContent = "Saving version…";
  const source = text === (kind === "resume" ? d.resume : d.cover) ? "ai" : "edited";
  const flags = kind === "resume" ? d.flags || [] : [];
  const r = await saveDoc(job, kind, text, flags, source);
  if (!r.ok) { btn.disabled = false; msg.textContent = r.data.error || "Couldn't save. Try again."; return; }
  const gaps = (d.profileGaps || []).length + (d.missing || []).length;
  const status = gaps ? "needs-info" : "ready-for-review";
  await saveStatus(job, status, "");
  btn.disabled = false;
  msg.textContent = `Saved ${kind === "resume" ? "resume" : "cover letter"} version ${r.data.doc.version}.`;
  loadVersions(job);
}

async function loadVersions(job) {
  const box = $("#tl-versions");
  if (!box) return;
  const r = await getApplication(job.url);
  if (!r.ok) { box.innerHTML = `<p class="note">Couldn't load saved versions.</p>`; return; }
  const docs = (r.data.docs || []).filter((x) => x.kind === tailorState.kind);
  box.innerHTML = docs.length
    ? `<h3>Saved versions</h3><ul class="versions">${docs.map((x) => `<li><span>v${x.version} · ${esc(x.source === "edited" ? "edited by you" : "drafted")} · ${esc(fmtDate(x.created_at))}</span> <button type="button" class="link" data-load="${x.id}">Load</button></li>`).join("")}</ul>`
    : `<p class="note">No saved versions yet.</p>`;
  for (const b of box.querySelectorAll("[data-load]")) b.addEventListener("click", () => {
    const doc = docs.find((x) => String(x.id) === b.dataset.load);
    tailorState.edited[tailorState.kind] = doc.body;
    renderTailor();
  });
}

// ---------- apply review: exact answers, attachments, destination, and what still needs the user
export async function openReview(job) {
  if (!account.user) return;
  const dlg = $("#review-dialog");
  dlg.showModal();
  const root = $("#review-root");
  root.innerHTML = `<div class="pf-top"><h2>Prepare to apply</h2><button type="button" class="link" id="rv-close">Close</button></div><p class="note" role="status">Loading your answers…</p>`;
  $("#rv-close").addEventListener("click", () => dlg.close());
  const [pd, app] = await Promise.all([apiFetch("/api/profile-details"), getApplication(job.url)]);
  if (!pd.ok || !app.ok) {
    root.innerHTML = `<div class="pf-top"><h2>Prepare to apply</h2><button type="button" class="link" id="rv-close">Close</button></div>
      <p class="note">${esc((pd.ok ? app.data : pd.data).error || "Couldn't load your details.")}</p>
      <div class="sheet-actions"><button type="button" class="btn" id="rv-retry">Try again</button></div>`;
    $("#rv-close").addEventListener("click", () => dlg.close());
    $("#rv-retry").addEventListener("click", () => openReview(job));
    return;
  }
  const d = pd.data.data || {};
  const docs = app.data.docs || [];
  const resume = docs.find((x) => x.kind === "resume");
  const cover = docs.find((x) => x.kind === "cover");
  const rows = answerRows(d);
  const needed = GAP_FIELDS.filter(([, get]) => !get(d)).map(([label]) => label);
  const eeo = d.eeo || {};
  const eeoRows = [["Gender", eeo.gender], ["Race or ethnicity", eeo.ethnicity], ["Veteran status", eeo.veteran], ["Disability", eeo.disability]];
  const custom = d.custom || [];
  root.innerHTML = `
    <div class="pf-top"><h2>Prepare to apply</h2><button type="button" class="link" id="rv-close">Close</button></div>
    <p class="note">Nothing is sent from here. Open the employer's page, fill in the form with these answers, and submit it yourself. Then come back and record it.</p>
    <dl class="facts"><div><dt>Destination</dt><dd>${esc(job.url)}</dd></div><div><dt>Role</dt><dd>${esc(job.title)} · ${esc(job.company)}</dd></div></dl>
    <p class="warn-box support"><strong>Automation:</strong> ${esc(supportText(job.ats))}</p>
    ${needed.length ? `<div class="warn-box"><strong>Needs your input before you apply:</strong><ul>${needed.map((n) => `<li>${esc(n)}</li>`).join("")}</ul><button type="button" class="btn" id="rv-profile">Open My profile</button></div>` : ""}
    <h3>Attachments</h3>
    <ul class="attach">
      <li>${resume ? `Resume v${resume.version} (tailored) <button type="button" class="link" id="rv-dl-resume">Download .txt</button>` : `No tailored resume saved. Use your uploaded resume, or <button type="button" class="link" id="rv-tailor">tailor one first</button>.`}</li>
      <li>${cover ? `Cover letter v${cover.version} <button type="button" class="link" id="rv-copy-cover">Copy text</button>` : "No cover letter saved yet."}</li>
    </ul>
    <h3>Your answers</h3>
    <table class="answers"><tbody>${rows.map(([k, v, req]) => `<tr><th scope="row">${esc(k)}</th><td>${v ? esc(v) : `<span class="needs">Needs your input</span>`}</td></tr>`).join("")}</tbody></table>
    ${custom.length ? `<h3>Your saved answers</h3><table class="answers"><tbody>${custom.map((q) => `<tr><th scope="row">${esc(q.question)}</th><td>${esc(q.answer)}</td></tr>`).join("")}</tbody></table>` : ""}
    <details><summary>Optional: equal opportunity answers</summary>
      <table class="answers"><tbody>${eeoRows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v && v !== "decline" ? esc(v) : "Not answered. Choose on the form."}</td></tr>`).join("")}</tbody></table>
    </details>
    <h3>Account setup (you do this)</h3>
    <p class="note">The app doesn't create accounts, choose passwords, read your email, or enter verification codes. Use your password manager. Record each step here after you finish it.</p>
    <div class="sheet-actions">
      <button type="button" class="btn" id="rv-step-account">I created my account</button>
      <button type="button" class="btn" id="rv-step-waiting">Waiting for verification email</button>
      <button type="button" class="btn" id="rv-step-verified">I verified my email</button>
    </div>
    <h3>Things you complete on the employer's site</h3>
    <ul class="checklist">
      <li>Create or sign in to an account, if the site asks.</li>
      <li>Solve any CAPTCHA or security check, and enter any verification code from email.</li>
      <li>Upload the resume file, and answer any question not listed above.</li>
      <li>Read the terms and tick any consent boxes yourself.</li>
      <li>Press the final submit button.</li>
    </ul>
    <label class="pf-check wide approve"><input type="checkbox" id="rv-approve"> I've checked every answer and attachment above, and they're accurate.</label>
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="rv-open">Open application page</button>
      <button type="button" class="btn" id="rv-copy">Copy my answers</button>
      <button type="button" class="btn" id="rv-submitted" disabled>I submitted it</button>
    </div>
    <p id="rv-msg" class="note" role="status"></p>`;
  $("#rv-close").addEventListener("click", () => dlg.close());
  $("#rv-profile")?.addEventListener("click", () => { dlg.close(); $("#resume-open").click(); });
  $("#rv-tailor")?.addEventListener("click", () => { dlg.close(); openTailor(job, getDesc()); });
  $("#rv-dl-resume")?.addEventListener("click", () => download(`${job.company || "job"}-resume-v${resume.version}.txt`, resume.body));
  $("#rv-copy-cover")?.addEventListener("click", () => copy(cover.body, "Cover letter copied."));
  $("#rv-copy").addEventListener("click", () => copy(answersText(rows, custom, job, resume, cover), "Answers copied. Paste them into the form."));
  $("#rv-open").addEventListener("click", async () => {
    window.open(job.url, "_blank", "noopener");
    if (!app.data.application || app.data.application.status === "saved") await saveStatus(job, "preparing", app.data.application?.notes || "");
    $("#rv-msg").textContent = "Opened the employer's page. Come back here to record the submission.";
  });
  const stepBtn = (id, step, status) => $(id).addEventListener("click", async () => {
    const res = await saveStatus(job, status || app.data.application?.status || "preparing", app.data.application?.notes || "", { step });
    $("#rv-msg").textContent = res.ok ? `Recorded: ${STEP_LABEL[step]}.` : (res.data.error || "Couldn't record that step.");
    if (res.ok) app.data.application = res.data.application;
  });
  stepBtn("#rv-step-account", "account_created_by_user");
  stepBtn("#rv-step-waiting", "verification_waiting");
  stepBtn("#rv-step-verified", "verification_done");
  $("#rv-approve").addEventListener("change", (e) => { $("#rv-submitted").disabled = !e.target.checked; });
  $("#rv-submitted").addEventListener("click", async () => {
    if (!confirm("Did you submit this application on the employer's site? This records a receipt with the resume and cover letter versions you used.")) return;
    const btn = $("#rv-submitted");
    btn.disabled = true; $("#rv-msg").textContent = "Recording…";
    const res = await saveStatus(job, "submitted", app.data.application?.notes || "", {
      step: "submitted_by_user",
      receipt: { destination: job.url, resume_version: resume?.version, cover_version: cover?.version },
    });
    btn.disabled = false;
    $("#rv-msg").textContent = res.ok ? "Recorded. It's now in your tracker." : (res.data.error || "Couldn't record. Try again.");
  });
}

function answersText(rows, custom, job, resume, cover) {
  const lines = [`${job.title} · ${job.company}`, job.url, ""];
  for (const [k, v] of rows) if (v) lines.push(`${k}: ${v}`);
  for (const q of custom) lines.push("", `${q.question}`, q.answer);
  if (resume) lines.push("", `Resume: v${resume.version} (download from Prepare to apply)`);
  if (cover) lines.push("", "Cover letter:", cover.body);
  return lines.join("\n");
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name.replace(/[^\w.-]+/g, "-") });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(text, ok) {
  try { await navigator.clipboard.writeText(text); $("#rv-msg").textContent = ok; }
  catch { $("#rv-msg").textContent = "Couldn't copy. Select the text and copy it yourself."; }
}

// ---------- tracker tab
let trackerFilter = "";
export async function renderTracker() {
  const root = $("#apps-root");
  if (!account.user) { root.innerHTML = `<p class="empty">Sign in to track your applications.</p>`; return; }
  root.innerHTML = `<p class="note" role="status">Loading your applications…</p>`;
  const r = await apiFetch("/api/applications");
  if (!r.ok) {
    root.innerHTML = `<p class="note">${esc(r.data.error || "Couldn't load your applications.")}</p><div class="sheet-actions"><button type="button" class="btn" id="ap-retry">Try again</button></div>`;
    $("#ap-retry").addEventListener("click", renderTracker);
    return;
  }
  const apps = r.data.applications || [];
  if (!apps.length) {
    root.innerHTML = `<p class="empty">No tracked applications yet. Open a job and choose "Track this job" or "Tailor resume and cover letter".</p>`;
    return;
  }
  const counts = STATUSES.map(([v, t]) => [v, t, apps.filter((a) => a.status === v).length]).filter(([, , n]) => n);
  const shown = apps.filter((a) => !trackerFilter || a.status === trackerFilter);
  root.innerHTML = `
    <div class="auto-banner"><strong>What the app automates:</strong> it drafts tailored materials for jobs you saved that match your criteria. It never submits applications, creates accounts, or reads your email. You review and submit each one.</div>
    <section id="queue-root" aria-live="polite"></section>
    <div class="ap-summary">${counts.map(([v, t, n]) => `<button type="button" class="chip ${trackerFilter === v ? "on" : ""}" data-f="${v}">${esc(t)} <strong>${n}</strong></button>`).join("")}
      ${trackerFilter ? `<button type="button" class="link" data-f="">Show all</button>` : ""}</div>
    <ol class="apps">${shown.map(appRow).join("")}</ol>`;
  for (const b of root.querySelectorAll("[data-f]")) b.addEventListener("click", () => { trackerFilter = b.dataset.f; renderTracker(); });
  renderQueue(apps);
  for (const s of root.querySelectorAll("[data-status]")) s.addEventListener("change", async () => {
    const jobKey = s.dataset.status;
    const app = apps.find((x) => x.job_key === jobKey);
    s.disabled = true;
    const res = await saveStatus(app.job, s.value, app.notes || "");
    if (!res.ok) { alert(res.data.error || "Couldn't update the status."); }
    renderTracker();
  });
  for (const t of root.querySelectorAll("[data-hist]")) t.addEventListener("click", () => {
    const li = t.closest("li"); li.classList.toggle("open");
  });
}

// ---------- preparation queue: saved jobs that match the user's criteria, drafted one at a time
const QUEUE_BATCH = 5;
async function renderQueue(apps) {
  const box = $("#queue-root");
  if (!box) return;
  box.innerHTML = `<p class="note" role="status">Checking your auto-apply criteria…</p>`;
  const r = await apiFetch("/api/profile-details");
  if (!r.ok) { box.innerHTML = `<p class="note">${esc(r.data.error || "Couldn't load your criteria.")}</p>`; return; }
  const criteria = cleanAutoApply(r.data.data?.autoApply);
  if (!criteria.enabled) {
    box.innerHTML = `<div class="queue-empty"><p>Auto-apply criteria are off. Turn them on to build a preparation queue from the jobs you save.</p><button type="button" class="btn" id="queue-open">Set up criteria in My profile</button></div>`;
    $("#queue-open").addEventListener("click", () => $("#resume-open").click());
    return;
  }
  const saved = apps.filter((a) => a.status === "saved");
  const checked = saved.map((a) => ({ a, m: matchJob(a.job, criteria) }));
  const matches = checked.filter((x) => x.m.match).map((x) => x.a);
  const skipped = checked.filter((x) => !x.m.match);
  box.innerHTML = `
    <div class="queue">
      <div class="queue-head">
        <h3>Preparation queue <span class="count">${matches.length}</span></h3>
        <button type="button" class="btn primary" id="queue-run" ${matches.length ? "" : "disabled"}>Prepare next ${Math.min(QUEUE_BATCH, matches.length) || ""}</button>
      </div>
      <p class="note">Each job here gets a draft resume and cover letter from your profile. Nothing is submitted. Open a job to review and submit it yourself. Up to ${QUEUE_BATCH} drafts per click.</p>
      ${matches.length ? `<ol class="queue-list">${matches.map((a) => `<li><span>${esc(a.job?.title || "Untitled role")}</span> <span class="note">${esc(a.job?.company || "")}${a.job?.loc ? " · " + esc(a.job.loc) : ""}</span></li>`).join("")}</ol>`
        : `<p class="note">No saved jobs match your criteria yet. Save jobs from the Jobs tab, then they appear here.</p>`}
      <p id="queue-msg" class="note" role="status"></p>
      ${skipped.length ? `<details><summary>${skipped.length} saved job${skipped.length === 1 ? "" : "s"} not queued</summary><ul>${skipped.map((x) => `<li>${esc(x.a.job?.title || "Untitled")}: ${esc(x.m.reasons.join(" "))}</li>`).join("")}</ul></details>` : ""}
    </div>`;
  $("#queue-run")?.addEventListener("click", () => runQueue(matches.slice(0, QUEUE_BATCH)));
}

async function runQueue(list) {
  const msg = $("#queue-msg");
  const run = $("#queue-run");
  run.disabled = true;
  let done = 0;
  for (const app of list) {
    msg.textContent = `Preparing ${done + 1} of ${list.length}: ${app.job?.title || "job"}…`;
    const res = await prepareOne(app);
    if (res.ok) done++;
    else { msg.textContent = `${res.reason}${res.stop ? "" : " Stopped here."} ${done} prepared.`; break; }
  }
  if (done === list.length) msg.textContent = `${done} prepared. Open each one from Prepare to apply to review it.`;
  renderTracker();
}

async function prepareOne(app) {
  const job = app.job || {};
  const html = await loadLive(job.url).catch(() => "");
  const text = plainText(html);
  if (!text) return { ok: false, reason: `No posting text for ${job.title || "this job"}. Open it and try again.` };
  const r = await apiFetch("/api/tailor", { method: "POST", body: { job_key: app.job_key, title: job.title, company: job.company, description: text } });
  if (!r.ok) return { ok: false, stop: r.status === 429, reason: r.data.error || "Couldn't draft right now." };
  const d = r.data;
  const res = await saveDoc(job, "resume", d.resume, d.flags || [], "ai");
  if (!res.ok) return { ok: false, reason: res.data.error || "Couldn't save the resume draft." };
  if (d.cover) {
    const c = await saveDoc(job, "cover", d.cover, [], "ai");
    if (!c.ok) return { ok: false, reason: c.data.error || "Couldn't save the cover letter draft." };
  }
  const needs = (d.profileGaps || []).length + (d.missing || []).length;
  const status = needs ? "needs-info" : "ready-for-review";
  const st = await saveStatus(job, status, app.notes || "");
  if (!st.ok) return { ok: false, reason: st.data.error || "Couldn't update the status." };
  return { ok: true, status };
}

function appRow(a) {
  const job = a.job || {};
  const hist = (a.history || []).slice().reverse();
  const receipts = hist.filter((h) => h.receipt);
  return `<li class="app">
    <div class="app-head">
      <div><a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.title || "Untitled role")}</a>
        <div class="note">${esc(job.company || "")}${job.loc ? " · " + esc(job.loc) : ""} · updated ${esc(fmtDate(a.updated_at))}</div></div>
      <label class="pf-field"><span class="visually-hidden">Status</span><select data-status="${esc(a.job_key)}">${statusOptions(a.status)}</select></label>
    </div>
    ${receipts.length ? `<p class="note receipt">Receipt: submitted ${esc(fmtDate(receipts[0].at))} · resume v${receipts[0].receipt.resume_version ?? "—"} · cover letter v${receipts[0].receipt.cover_version ?? "—"}</p>` : ""}
    <button type="button" class="link" data-hist>History (${hist.length})</button>
    <ul class="hist">${hist.map((h) => `<li>${esc(fmtDate(h.at))} · ${h.from ? esc(LABEL[h.from] || h.from) + " → " : ""}${esc(LABEL[h.to] || h.to)}${h.step ? " · " + esc(STEP_LABEL[h.step] || h.step) : ""}${h.receipt ? " · receipt recorded" : ""}${h.note ? ` · ${esc(h.note)}` : ""}</li>`).join("") || "<li>No changes yet.</li>"}</ul>
  </li>`;
}

// ---------- wiring
export function initApply() {
  for (const id of ["tailor-dialog", "review-dialog"]) {
    const dlg = $("#" + id);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
}
