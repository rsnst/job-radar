// Adding a job that isn't in the index: from the extension (#add=), the phone's share sheet, or a pasted link.
// The job is saved as "Saved" in the tracker and nothing else happens: no fetching, no submitting.
import { account } from "./account.js";
import { getApplication, saveStatus } from "./store.js";
import { cleanIncoming, incomingFromLocation } from "./jobs-in.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = "jc.intake";
const TTL_MS = 30 * 60 * 1000;
let hooks = { openSignIn() {}, openApply() {}, showTab() {} };
let draft = null; // { url, title, company, source, manual }

export function initIntake(h) {
  hooks = { ...hooks, ...h };
  $("#intake-dialog").addEventListener("click", (e) => {
    const b = e.target.closest("[data-intake]");
    if (e.target === $("#intake-dialog")) $("#intake-dialog").close();
    if (!b) return;
    const act = b.dataset.intake;
    if (act === "close") $("#intake-dialog").close();
    if (act === "signin") { collect(); stash(draft); $("#intake-dialog").close(); hooks.openSignIn(); }
    if (act === "add") add();
    if (act === "apply") { $("#intake-dialog").close(); hooks.openApply(draft.saved); }
    if (act === "tracker") { $("#intake-dialog").close(); hooks.showTab("applications"); }
  });
}

function stash(job) {
  try { localStorage.setItem(KEY, JSON.stringify({ job, at: Date.now() })); } catch {}
}
function takeStash() {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const o = JSON.parse(raw || "null");
    return o && Date.now() - o.at < TTL_MS ? o.job : null;
  } catch { return null; }
}

// The address is read the moment this module loads: the app rewrites the hash while it starts up,
// which would otherwise erase a "#add=" link before it was seen. The address is tidied straight away.
const INCOMING = typeof location === "undefined" ? null : incomingFromLocation(location);
if (INCOMING) history.replaceState(null, "", location.pathname);

// Called once at start-up: shows the add dialog when the page was opened with a job.
export function startIntake() {
  if (!INCOMING) return false;
  const r = cleanIncoming(INCOMING);
  open(r.ok ? { ...r.job, source: r.source } : { url: "", title: "", company: "", source: "", error: r.error });
  return true;
}

// Called when sign-in finishes: picks up a job the person chose before signing in.
export function resumeIntake() {
  if (!account.user) return;
  const job = takeStash();
  if (job) open(job);
}

// Tracker button: add a job from any site by pasting its link.
export function openAddByLink() { open({ url: "", title: "", company: "", source: "Pasted link", manual: true }); }

function collect() {
  if (!draft) return;
  draft.title = $("#intake-title")?.value.trim() ?? draft.title;
  draft.company = $("#intake-company")?.value.trim() ?? draft.company;
  if ($("#intake-url") && !$("#intake-url").readOnly) draft.url = $("#intake-url").value.trim();
}

function open(d) {
  draft = { ...d, manual: d.manual || !d.url };
  render();
  const dlg = $("#intake-dialog");
  if (!dlg.open) dlg.showModal();
}

function render(message = "", after = null) {
  const d = draft;
  const root = $("#intake-root");
  const head = `<div class="pf-top flow-top"><h2>Add a job to Job Compass</h2><button type="button" class="link" data-intake="close">Close</button></div>`;
  if (!account.enabled) {
    root.innerHTML = `${head}<p class="note">Accounts aren't set up on this site, so jobs can't be added to a tracker here.</p>`;
    return;
  }
  const status = message ? `<p class="note" role="status">${esc(message)}</p>` : `<p class="note" role="status">${d.error ? esc(d.error) : ""}</p>`;
  if (after === "added") {
    root.innerHTML = `${head}${status}<p class="note">It's saved as "Saved". It joins your preparation queue if it matches your criteria. Nothing was submitted.</p>
      <div class="sheet-actions"><button type="button" class="btn primary" data-intake="apply">Start the application</button>
      <button type="button" class="btn" data-intake="tracker">See my tracker</button></div>`;
    return;
  }
  const primary = account.user
    ? `<button type="button" class="btn primary" data-intake="add">Add to my tracker</button>`
    : `<button type="button" class="btn primary" data-intake="signin">Sign in to add it</button>`;
  root.innerHTML = `${head}
    <p class="note">${d.source ? `From: ${esc(d.source)}. ` : ""}Check the details. Only these three things are saved.</p>
    <div class="pf-grid">
      <label class="pf-field wide"><span>Link to the posting</span><input id="intake-url" type="url" maxlength="2000" value="${esc(d.url)}" ${d.manual ? "" : "readonly"} placeholder="https://"></label>
      <label class="pf-field"><span>Job title</span><input id="intake-title" maxlength="200" value="${esc(d.title)}"></label>
      <label class="pf-field"><span>Company</span><input id="intake-company" maxlength="200" value="${esc(d.company)}"></label>
    </div>
    ${status}
    <div class="sheet-actions">${primary}</div>
    ${account.user ? "" : `<p class="note">You'll come back to this job after you sign in.</p>`}`;
}

async function add() {
  collect();
  const r = cleanIncoming(draft);
  if (!r.ok) return render(r.error);
  draft = { ...draft, ...r.job, source: draft.source || r.source };
  render("Adding…");
  const existing = await getApplication(r.job);
  if (!existing.ok) return render(existing.data?.error || "Couldn't check your tracker. Try again.");
  const app = existing.data?.application;
  if (app) { draft.saved = r.job; return render(`Already in your tracker as "${app.status}". Nothing was changed.`, "added"); }
  const saved = await saveStatus(r.job, "saved", `Added from ${draft.source || "a link"}`);
  if (!saved.ok) return render(saved.data?.error || "Couldn't add it. Try again.");
  draft.saved = r.job;
  render("Added to your tracker.", "added");
}
