// Every read and write the application flow makes goes through here.
// Demo jobs (demo:// addresses) and the demo profile are kept in this tab's memory only:
// no request is sent, nothing reaches the tracker, and no employer address is ever used.
// Real jobs call the signed-in user's own API routes, as before.
import { apiFetch } from "./account.js";
import { DEMO_JOB, DEMO_PROFILE, buildDemoDraft, isDemoJob } from "./flow-model.js";

const demoState = { profile: structuredClone(DEMO_PROFILE), apps: new Map() };
// Called when a demo starts, so each demo begins from the synthetic profile with no tracked state.
export function resetDemo() {
  demoState.profile = structuredClone(DEMO_PROFILE);
  demoState.apps = new Map();
}

// The posting text for a job, used to tailor. app.js supplies the loader for real jobs.
let loadPosting = async () => "";
export function setPostingLoader(fn) { loadPosting = fn; }
export async function postingHtml(job) {
  if (isDemoJob(job)) return DEMO_JOB.description;
  return (await loadPosting(job).catch(() => "")) || "";
}

// The demo profile is used only by a demo flow (demo=true). Real flows use the signed-in user's profile.
export async function loadProfile(demo = false) {
  if (demo) return { ok: true, status: 200, profile: structuredClone(demoState.profile) };
  const r = await apiFetch("/api/profile-details");
  return { ok: r.ok, status: r.status, profile: r.data?.data, error: r.data?.error };
}
export async function saveProfile(profile, demo = false) {
  if (demo) { demoState.profile = structuredClone(profile); return { ok: true, status: 200 }; }
  const r = await apiFetch("/api/profile-details", { method: "PUT", body: { data: profile } });
  return { ok: r.ok, status: r.status, data: r.data, error: r.data?.error };
}

function demoRecord(job) {
  if (!demoState.apps.has(job.url)) demoState.apps.set(job.url, { application: null, docs: [] });
  return demoState.apps.get(job.url);
}

export async function getApplication(job) {
  if (isDemoJob(job)) {
    const rec = demoRecord(job);
    return { ok: true, status: 200, data: structuredClone(rec) };
  }
  return apiFetch(`/api/applications?job=${encodeURIComponent(job.url)}`);
}

export async function saveStatus(job, status, notes, extra = {}) {
  if (isDemoJob(job)) {
    const rec = demoRecord(job);
    const at = new Date().toISOString();
    const prev = rec.application;
    const history = [...(prev?.history || [])];
    const from = prev?.status ?? null;
    if (from !== status) history.push({ at, from, to: status, step: null, receipt: null, note: "" });
    if (extra.step) history.push({ at, from: status, to: status, step: extra.step, receipt: null, note: "" });
    if (extra.receipt) history.push({ at, from: status, to: status, step: extra.step || null, receipt: extra.receipt, note: "" });
    rec.application = { job_key: job.url, status, notes: notes || "", updated_at: at, history };
    return { ok: true, status: 200, data: { application: structuredClone(rec.application) } };
  }
  return apiFetch("/api/applications", { method: "PUT", body: { job_key: job.url, job, status, notes, ...extra } });
}

export async function saveDoc(job, kind, body, flags, source) {
  if (isDemoJob(job)) {
    const rec = demoRecord(job);
    const version = rec.docs.filter((d) => d.kind === kind).length + 1;
    const doc = { id: `demo-${kind}-${version}`, kind, version, body, flags: flags || [], source, created_at: new Date().toISOString() };
    rec.docs.unshift(doc);
    return { ok: true, status: 200, data: { doc } };
  }
  return apiFetch("/api/applications", { method: "POST", body: { job_key: job.url, kind, body, flags, source } });
}

export async function draftFor(job, text) {
  if (isDemoJob(job)) {
    return { ok: true, status: 200, data: buildDemoDraft(demoState.profile, job) };
  }
  return apiFetch("/api/tailor", { method: "POST", body: { job_key: job.url, title: job.title, company: job.company, description: text } });
}
