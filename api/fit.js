// POST { url, title, description } -> how well the signed-in user's resume fits this job.
// Uses Groq's free API (GROQ_API_KEY). Results are cached per user and job, and each user
// gets FIT_DAILY_LIMIT new checks a day (default 5), so the free quota goes a long way.
import { createHash } from "node:crypto";
import { currentUser, restHeaders } from "../lib/supa.js";
import { useQuota } from "../lib/usage.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const DAILY = Math.max(1, Math.min(1000, Math.floor(Number(process.env.FIT_DAILY_LIMIT) || 5)));
const JOB_CHARS = 8000;
const RESUME_CHARS = 8000;

const SYSTEM = `You compare a candidate's resume with a job posting.
Use only what the two texts say. Never assume a skill or years of experience that isn't written.
Reply with JSON only, in this shape:
{"score": <integer 0-100, how well the resume fits the posting>,
 "summary": "<one plain sentence>",
 "matched": ["<requirement the resume clearly meets>", ...],
 "missing": ["<requirement the posting asks for that the resume does not show>", ...],
 "evidence": ["<short quote copied exactly from the job posting that supports the score>", ...]}
Keep each list to at most 8 short items.`;

function plain(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

function clean(list, jobText) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 8);
}

async function askGroq(job, resume) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `RESUME:\n${resume}\n\nJOB POSTING (${job.title}):\n${job.text}` },
      ],
    }),
  });
  if (r.status === 429) throw Object.assign(new Error("limit"), { code: 429 });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "AI checks aren't set up yet." });
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });

  const url = String(req.body?.url || "");
  const title = String(req.body?.title || "").slice(0, 300);
  const jobText = plain(req.body?.description).slice(0, JOB_CHARS);
  if (!url || jobText.length < 80) {
    return res.status(400).json({ error: "This job has no description to compare yet." });
  }

  const pr = await fetch(`${ctx.url}/rest/v1/profiles?select=text&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) });
  const [profile] = pr.ok ? await pr.json() : [];
  if (!profile?.text) return res.status(409).json({ error: "Add your resume first.", needsProfile: true });
  const resume = profile.text.slice(0, RESUME_CHARS);
  const profileHash = createHash("sha256").update(resume).digest("hex");

  // cached result for this resume and job
  const cr = await fetch(`${ctx.url}/rest/v1/fit_cache?select=result&user_id=eq.${ctx.id}&job_key=eq.${encodeURIComponent(url)}`, { headers: restHeaders(ctx) });
  const [hit] = cr.ok ? await cr.json() : [];
  if (hit?.result?.profile_hash === profileHash) return res.status(200).json({ ...hit.result, cached: true });

  const q = await useQuota(ctx, "fit", DAILY);
  if (!q.ok) return res.status(502).json({ error: "Couldn't check your limit. Try again." });
  if (!q.allowed) return res.status(429).json({ error: `You've used today's ${DAILY} checks. Try again tomorrow.` });

  let raw;
  try {
    raw = await askGroq({ title, text: jobText }, resume);
  } catch (e) {
    if (e.code === 429) return res.status(429).json({ error: "The free AI limit is used up for today. Try again later." });
    return res.status(502).json({ error: "The AI check didn't finish. Try again in a moment." });
  }

  // keep only quotes that really appear in the posting, so the model can't invent evidence
  const hay = norm(jobText);
  const score = Math.max(0, Math.min(100, Math.round(Number(raw.score)) || 0));
  const result = {
    score,
    summary: String(raw.summary || "").slice(0, 300),
    matched: clean(raw.matched),
    missing: clean(raw.missing),
    evidence: clean(raw.evidence).filter((q) => hay.includes(norm(q))),
    profile_hash: profileHash,
    model: MODEL,
  };

  await fetch(`${ctx.url}/rest/v1/fit_cache?on_conflict=user_id,job_key`, {
    method: "POST",
    headers: restHeaders(ctx, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ user_id: ctx.id, job_key: url, result }),
  });
  return res.status(200).json({ ...result, cached: false });
}
