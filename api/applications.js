// Application tracker for the signed-in user.
//   GET                 -> { applications: [...] }  (newest activity first)
//   GET ?job=<key>      -> { application, docs: [...] }  (docs newest version first)
//   PUT { job_key, job, status, notes, receipt? } -> saves status and notes, appends a history entry on change
//   POST { job_key, kind, body, flags, source }   -> saves the next version of a resume or cover letter
import { currentUser, restHeaders } from "../lib/supa.js";

export const STATUSES = ["saved", "preparing", "needs-info", "ready-for-review", "submitted", "interview", "rejected", "offer", "withdrawn"];
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isUrl = (v) => typeof v === "string" && /^https?:\/\//.test(v) && v.length <= 2000;

function cleanJob(j = {}) {
  return { title: str(j.title, 200), company: str(j.company, 200), url: str(j.url, 2000), loc: str(j.loc, 200),
    ats: str(j.ats, 40), posted: typeof j.posted === "number" ? j.posted : null, remote: j.remote === true };
}

export default async function handler(req, res) {
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });
  const apps = `${ctx.url}/rest/v1/applications`;
  const docs = `${ctx.url}/rest/v1/application_docs`;

  if (req.method === "GET") {
    const job = req.query?.job;
    if (job) {
      const [a, d] = await Promise.all([
        fetch(`${apps}?select=*&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(job)}`, { headers: restHeaders(ctx) }),
        fetch(`${docs}?select=id,kind,version,body,flags,source,created_at&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(job)}&order=version.desc&limit=40`, { headers: restHeaders(ctx) }),
      ]);
      if (!a.ok || !d.ok) return res.status(502).json({ error: "Couldn't load this application." });
      const [application] = await a.json();
      return res.status(200).json({ application: application || null, docs: await d.json() });
    }
    const r = await fetch(`${apps}?select=job_key,job,status,notes,history,updated_at&user_id=eq.${ctx.id}&order=updated_at.desc&limit=300`, { headers: restHeaders(ctx) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't load your applications. Try again." });
    return res.status(200).json({ applications: await r.json() });
  }

  if (req.method === "PUT") {
    const b = req.body || {};
    const jobKey = str(b.job_key, 2000);
    if (!isUrl(jobKey)) return res.status(400).json({ error: "This job has no link, so it can't be tracked." });
    const status = STATUSES.includes(b.status) ? b.status : null;
    if (!status) return res.status(400).json({ error: "Choose a valid status." });
    const notes = str(b.notes, 4000);

    const cur = await fetch(`${apps}?select=status,history&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(jobKey)}`, { headers: restHeaders(ctx) });
    if (!cur.ok) return res.status(502).json({ error: "Couldn't save. Try again." });
    const [existing] = await cur.json();
    const history = Array.isArray(existing?.history) ? existing.history.slice(-99) : [];
    const now = new Date().toISOString();
    if (!existing || existing.status !== status) {
      history.push({ at: now, from: existing?.status || null, to: status, note: str(b.note, 300) || null });
    }
    if (b.receipt && typeof b.receipt === "object") {
      history.push({ at: now, to: status, receipt: {
        destination: str(b.receipt.destination, 2000),
        resume_version: Number(b.receipt.resume_version) || null,
        cover_version: Number(b.receipt.cover_version) || null,
        confirmed_by_user: true,
      } });
    }
    const row = { user_id: ctx.id, job_key: jobKey, job: cleanJob(b.job), status, notes, history, updated_at: now };
    const u = await fetch(`${apps}?on_conflict=user_id,job_key`, {
      method: "POST",
      headers: restHeaders(ctx, { Prefer: "resolution=merge-duplicates,return=representation" }),
      body: JSON.stringify(row),
    });
    if (!u.ok) return res.status(502).json({ error: "Couldn't save. Try again." });
    const [saved] = await u.json();
    return res.status(200).json({ application: saved });
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const jobKey = str(b.job_key, 2000);
    const kind = b.kind === "resume" || b.kind === "cover" ? b.kind : null;
    const body = typeof b.body === "string" ? b.body.trim() : "";
    if (!isUrl(jobKey) || !kind) return res.status(400).json({ error: "Missing job or document type." });
    if (!body) return res.status(400).json({ error: "The document is empty." });
    if (body.length > 30000) return res.status(400).json({ error: "The document is too long." });
    const flags = Array.isArray(b.flags) ? b.flags.slice(0, 40).map((f) => ({ kind: str(f?.kind, 20), text: str(f?.text, 120), message: str(f?.message, 300) })) : [];

    const last = await fetch(`${docs}?select=version&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(jobKey)}&kind=eq.${kind}&order=version.desc&limit=1`, { headers: restHeaders(ctx) });
    if (!last.ok) return res.status(502).json({ error: "Couldn't save this version. Try again." });
    const [prev] = await last.json();
    const version = (prev?.version || 0) + 1;
    const ins = await fetch(docs, {
      method: "POST",
      headers: restHeaders(ctx, { Prefer: "return=representation" }),
      body: JSON.stringify({ user_id: ctx.id, job_key: jobKey, kind, version, body, flags, source: b.source === "edited" ? "edited" : "ai" }),
    });
    if (!ins.ok) return res.status(502).json({ error: "Couldn't save this version. Try again." });
    const [doc] = await ins.json();
    return res.status(200).json({ doc });
  }

  return res.status(405).end();
}
