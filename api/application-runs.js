// User-facing queue for app-owned browser automation. The worker uses a separate
// service key; this route only accepts and returns the signed-in user's runs.
import { currentUser, restHeaders } from "../lib/supa.js";

const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
// PostgREST returns identity IDs as numbers; JSON decisions must accept those too.
const runId = (v) => {
  if (typeof v === "number" && (!Number.isSafeInteger(v) || v <= 0)) return "";
  const id = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : "";
};
const jobFields = ["title", "company", "loc", "ats", "pay"];
const cleanJob = (j = {}, jobKey = "") => Object.fromEntries([
  ...jobFields.map((k) => [k, str(j[k], 200)]), ["url", jobKey],
].filter(([, v]) => v));
function isWorkdayUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "myworkdayjobs.com" || u.hostname.endsWith(".myworkdayjobs.com")
      || u.hostname === "myworkday.com" || u.hostname.endsWith(".myworkday.com"));
  } catch { return false; }
}
const safeRun = (r) => ({
  id: r.id, job_key: r.job_key, job: r.job, status: r.status,
  stage: r.stage, message: r.message, auto_submit: r.auto_submit,
  user_decision: r.user_decision,
  result: r.result || {}, created_at: r.created_at, updated_at: r.updated_at,
});

export default async function handler(req, res) {
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });
  const table = `${ctx.url}/rest/v1/application_runs`;

  if (req.method === "GET") {
    const id = runId(req.query?.id);
    if (req.query?.id != null && !id) return res.status(400).json({ error: "Choose a valid application run." });
    const jobKey = str(req.query?.job, 2000);
    const filters = id ? `id=eq.${encodeURIComponent(id)}`
      : jobKey ? `job_key=eq.${encodeURIComponent(jobKey)}` : "";
    const query = `?select=id,job_key,job,status,stage,message,auto_submit,user_decision,result,created_at,updated_at&user_id=eq.${ctx.id}${filters ? `&${filters}` : ""}&order=created_at.desc&limit=${filters ? 10 : 50}`;
    const r = await fetch(`${table}${query}`, { headers: restHeaders(ctx) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't load application progress." });
    const rows = (await r.json()).map(safeRun);
    return res.status(200).json(filters ? { runs: rows } : { runs: rows });
  }

  if (req.method === "POST") {
    const jobKey = str(req.body?.job_key, 2000);
    if (!isWorkdayUrl(jobKey)) return res.status(400).json({ error: "The first Job Compass worker release supports Workday application links only." });
    const job = cleanJob(req.body?.job, jobKey);
    const profileResponse = await fetch(`${ctx.url}/rest/v1/profile_details?select=data&user_id=eq.${ctx.id}&limit=1`, { headers: restHeaders(ctx) });
    if (!profileResponse.ok) return res.status(502).json({ error: "Couldn't load your apply settings." });
    const [profileRow] = await profileResponse.json();
    const autoSubmit = req.body?.auto_submit === true && profileRow?.data?.autoApply?.autoSubmit === true;
    const existing = await fetch(`${table}?select=id,job_key,job,status,stage,message,auto_submit,user_decision,result,created_at,updated_at&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(jobKey)}&status=in.(queued,running,awaiting_review)&limit=1`, { headers: restHeaders(ctx) });
    if (!existing.ok) return res.status(502).json({ error: "Couldn't check for an active application." });
    const [active] = await existing.json();
    if (active) return res.status(200).json({ run: safeRun(active), reused: true });
    const r = await fetch(table, {
      method: "POST",
      headers: restHeaders(ctx, { Prefer: "return=representation" }),
      body: JSON.stringify({ user_id: ctx.id, job_key: jobKey, job, status: "queued", stage: "queued", message: "Waiting for the application worker.", auto_submit: autoSubmit, user_decision: "pending" }),
    });
    if (r.status === 409) return res.status(409).json({ error: "An application for this job is already running." });
    if (!r.ok) return res.status(502).json({ error: "Couldn't queue this application. The application-run database setup may be missing." });
    const [run] = await r.json();
    return res.status(201).json({ run: safeRun(run) });
  }

  if (req.method === "PATCH") {
    const id = runId(req.body?.id);
    const decision = ["approve", "reject", "cancel"].includes(req.body?.decision) ? req.body.decision : "";
    if (!id || !decision) return res.status(400).json({ error: "Choose a valid application decision." });
    const statusFilter = decision === "cancel" ? "status=in.(queued,running,needs_user,awaiting_review)" : "status=eq.awaiting_review";
    const r = await fetch(`${table}?id=eq.${encodeURIComponent(id)}&user_id=eq.${ctx.id}&${statusFilter}&user_decision=eq.pending`, {
      method: "PATCH", headers: restHeaders(ctx, { Prefer: "return=representation" }),
      body: JSON.stringify({ user_decision: decision }),
    });
    if (!r.ok) return res.status(502).json({ error: "Couldn't save your decision." });
    const [run] = await r.json();
    return run ? res.status(200).json({ run: safeRun(run) }) : res.status(409).json({ error: "This run is no longer waiting for your decision." });
  }

  return res.status(405).end();
}
