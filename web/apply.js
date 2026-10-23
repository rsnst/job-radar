// Application tracker, the details-panel kit, and the preparation queue.
// The application flow itself (materials, answers, review) lives in flow.js. Everything here uses store.js,
// so demo jobs never reach the network or the tracker.
import { account, apiFetch } from "./account.js";
import { matchJob, cleanAutoApply } from "./autoapply.js";
import { openApplyEntry, openDemo } from "./flow.js";
import { openAddByLink } from "./intake.js";
import { STEP_LABEL } from "./flow-model.js";
import { getApplication, saveStatus, saveDoc, draftFor, postingHtml } from "./store.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export const STATUSES = [
  ["saved", "Saved"], ["preparing", "Preparing"], ["needs-info", "Needs your info"], ["ready-for-review", "Ready for review"],
  ["submitted", "Submitted"], ["interview", "Interview"], ["rejected", "Rejected"], ["offer", "Offer"], ["withdrawn", "Withdrawn"],
];
const LABEL = Object.fromEntries(STATUSES);
const statusOptions = (cur) => STATUSES.map(([v, t]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`).join("");

// ---------- details-panel kit
let kitJob = null;

export function renderApplyKit(job) {
  kitJob = job;
  const box = $("#sheet-apply-kit");
  box.hidden = false;
  if (!account.enabled || !account.user) {
    const why = !account.enabled
      ? "Accounts aren't set up on this site, so applications can't be saved here."
      : "Sign in to tailor a resume and cover letter for this job, track it, and keep a receipt.";
    box.innerHTML = `<h3>Application</h3><p class="note">${why}</p>
      <div class="sheet-actions"><button type="button" class="btn primary" data-kit="apply">${account.enabled ? "Sign in to apply" : "Apply"}</button>
        <button type="button" class="btn" data-kit="demo">Try the demo</button></div>`;
    return;
  }
  box.innerHTML = `<h3>Application</h3><p class="note" id="kit-state" role="status">Loading…</p>`;
  loadKit(job);
}

async function loadKit(job) {
  const r = await getApplication(job);
  if (kitJob !== job) return;
  const box = $("#sheet-apply-kit");
  if (!r.ok) {
    box.innerHTML = `<h3>Application</h3><p class="note">${esc(r.data?.error || "Couldn't load this application.")}</p><div class="sheet-actions"><button type="button" class="btn" id="kit-retry">Try again</button></div>`;
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
      <button type="button" class="btn primary" data-kit="open">${app ? "Open application" : "Start application"}</button>
    </div>
    <label class="pf-field"><span>Status</span><select id="kit-status">${statusOptions(status || "saved")}</select></label>
    <label class="pf-field"><span>Notes</span><textarea id="kit-notes" rows="2" maxlength="4000">${esc(app?.notes || "")}</textarea></label>
    <div class="sheet-actions"><button type="button" class="btn" id="kit-track">${app ? "Save status" : "Track this job"}</button></div>
    <p id="kit-msg" class="note" role="status"></p>`;
  $("#kit-track").addEventListener("click", async () => {
    const btn = $("#kit-track");
    btn.disabled = true; $("#kit-msg").textContent = "Saving…";
    const res = await saveStatus(job, $("#kit-status").value, $("#kit-notes").value.trim());
    btn.disabled = false;
    if (!res.ok) { $("#kit-msg").textContent = res.data?.error || "Couldn't save. Try again."; return; }
    $("#kit-msg").textContent = "Saved.";
    loadKit(job);
  });
}

const addJobBar = () => `<div class="sheet-actions"><button type="button" class="btn" data-add-job>Add a job from another site</button>
  <span class="note">LinkedIn, Indeed or any career page: paste its link, or use the browser extension or your phone's Share menu.</span></div>`;

// ---------- tracker tab
let trackerFilter = "";
export async function renderTracker() {
  const root = $("#apps-root");
  if (!account.user) {
    const note = account.enabled ? "Sign in to track your applications." : "Accounts aren't set up on this site, so applications can't be tracked here.";
    root.innerHTML = `<p class="empty">${note}</p>
      <div class="sheet-actions"><button type="button" class="btn" data-demo>Try the application demo (synthetic data)</button></div>`;
    return;
  }
  root.innerHTML = `<p class="note" role="status">Loading your applications…</p>`;
  const r = await apiFetch("/api/applications");
  if (!r.ok) {
    root.innerHTML = `<p class="note">${esc(r.data.error || "Couldn't load your applications.")}</p><div class="sheet-actions"><button type="button" class="btn" id="ap-retry">Try again</button></div>`;
    $("#ap-retry").addEventListener("click", renderTracker);
    return;
  }
  const apps = r.data.applications || [];
  if (!apps.length) {
    root.innerHTML = `<p class="empty">No tracked applications yet. Open a job and choose "Apply" to start one, or add a job you found on another site.</p>${addJobBar()}`;
    return;
  }
  const counts = STATUSES.map(([v, t]) => [v, t, apps.filter((a) => a.status === v).length]).filter(([, , n]) => n);
  const shown = apps.filter((a) => !trackerFilter || a.status === trackerFilter);
  root.innerHTML = `
    <div class="auto-banner"><strong>What the app automates:</strong> it drafts tailored materials for jobs you saved that match your criteria. Creating employer accounts and submitting without your review are opt-ins in your profile, off by default, and only on Workday. It never solves CAPTCHAs and never reads your own inbox.</div>
    ${addJobBar()}
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
    if (!res.ok) { alert(res.data?.error || "Couldn't update the status."); }
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
        <span><button type="button" class="btn primary" id="queue-run" ${matches.length ? "" : "disabled"}>Prepare next ${Math.min(QUEUE_BATCH, matches.length) || ""}</button>
          <button type="button" class="btn" id="queue-stop" hidden>Stop</button></span>
      </div>
      <p class="note">Each job here gets a draft resume and cover letter from your profile. Nothing is submitted. Open a job to review and submit it yourself. Up to ${QUEUE_BATCH} drafts per click.</p>
      ${matches.length ? `<ol class="queue-list">${matches.map((a) => `<li><span>${esc(a.job?.title || "Untitled role")}</span> <span class="note">${esc(a.job?.company || "")}${a.job?.loc ? " · " + esc(a.job.loc) : ""}</span></li>`).join("")}</ol>`
        : `<p class="note">No saved jobs match your criteria yet. Save jobs from the Jobs tab, then they appear here.</p>`}
      <p id="queue-msg" class="note" role="status"></p>
      ${skipped.length ? `<details><summary>${skipped.length} saved job${skipped.length === 1 ? "" : "s"} not queued</summary><ul>${skipped.map((x) => `<li>${esc(x.a.job?.title || "Untitled")}: ${esc(x.m.reasons.join(" "))}</li>`).join("")}</ul></details>` : ""}
    </div>`;
  $("#queue-run")?.addEventListener("click", () => runQueue(matches.slice(0, QUEUE_BATCH)));
}

let queueStop = false;
async function runQueue(list) {
  const msg = $("#queue-msg");
  const run = $("#queue-run");
  const stop = $("#queue-stop");
  run.disabled = true;
  queueStop = false; stop.hidden = false;
  stop.onclick = () => { queueStop = true; stop.disabled = true; msg.textContent = "Stopping after this draft…"; };
  let done = 0;
  for (const app of list) {
    if (queueStop) { msg.textContent = `Stopped. ${done} prepared.`; break; }
    msg.textContent = `Preparing ${done + 1} of ${list.length}: ${app.job?.title || "job"}…`;
    const res = await prepareOne(app);
    if (res.ok) done++;
    else { msg.textContent = `${res.reason}${res.stop ? "" : " Stopped here."} ${done} prepared.`; break; }
  }
  if (!queueStop && done === list.length) msg.textContent = `${done} prepared. Open each one from the job to review it.`;
  renderTracker();
}

async function prepareOne(app) {
  const job = { ...(app.job || {}), url: app.job_key };
  const text = plainText(await postingHtml(job));
  if (!text) return { ok: false, reason: `No posting text for ${job.title || "this job"}. Open it and try again.` };
  const key = job;
  const r = await draftFor(key, text);
  if (!r.ok) return { ok: false, stop: r.status === 429, reason: r.data?.error || "Couldn't draft right now." };
  const d = r.data;
  const res = await saveDoc(key, "resume", d.resume, d.flags || [], "ai");
  if (!res.ok) return { ok: false, reason: res.data?.error || "Couldn't save the resume draft." };
  if (d.cover) {
    const c = await saveDoc(key, "cover", d.cover, [], "ai");
    if (!c.ok) return { ok: false, reason: c.data?.error || "Couldn't save the cover letter draft." };
  }
  const needs = (d.profileGaps || []).length + (d.missing || []).length;
  const status = needs ? "needs-info" : "ready-for-review";
  const st = await saveStatus(key, status, app.notes || "");
  if (!st.ok) return { ok: false, reason: st.data?.error || "Couldn't update the status." };
  return { ok: true, status };
}
const plainText = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function appRow(a) {
  const job = a.job || {};
  const hist = (a.history || []).slice().reverse();
  const receipts = hist.filter((h) => h.receipt);
  return `<li class="app">
    <div class="app-head">
      <div><span>${esc(job.title || "Untitled role")}</span>
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
  $("#sheet-apply-kit").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kit]");
    if (!b || !kitJob) return;
    if (b.dataset.kit === "demo") return openDemo();
    openApplyEntry(kitJob); // "apply" and "open" both go through the flow, never straight to the employer
  });
  $("#apps-root").addEventListener("click", (e) => {
    if (e.target.closest("[data-demo]")) openDemo();
    if (e.target.closest("[data-add-job]")) openAddByLink();
  });
}
