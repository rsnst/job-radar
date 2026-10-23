// POST { job_key, title, company, description } -> tailored resume and cover letter for this job.
// Built only from the signed-in user's saved profile and resume. Nothing is saved here; the client
// saves a version with /api/applications. Uses Groq's free API (GROQ_API_KEY) with TAILOR_DAILY_LIMIT
// new drafts per user per day (default 10).
import { currentUser, restHeaders } from "../lib/supa.js";
import { useQuota } from "../lib/usage.js";
import { SYSTEM_PROMPT, buildUserMessage, verifyAgainst, parseMaterials, profileGaps, minimalProfile } from "../lib/tailor.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const DAILY = Math.max(1, Math.min(1000, Math.floor(Number(process.env.TAILOR_DAILY_LIMIT) || 10)));
const JOB_CHARS = 8000;
const SOURCE_CHARS = 12000;

async function askGroq(source, job) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage({ source, job }) },
      ],
    }),
  });
  if (r.status === 429) throw Object.assign(new Error("limit"), { status: 429 });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const data = await r.json();
  return String(data.choices?.[0]?.message?.content || "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "Tailoring isn't set up yet." });
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in to tailor your materials." });

  const jobKey = String(req.body?.job_key || "");
  if (!/^https?:\/\//.test(jobKey)) return res.status(400).json({ error: "This job has no link to tailor for." });
  const job = {
    title: String(req.body?.title || "Untitled role").slice(0, 200),
    company: String(req.body?.company || "the company").slice(0, 200),
    text: String(req.body?.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, JOB_CHARS),
  };
  if (!job.text) return res.status(400).json({ error: "Open the job's details first so there is a posting to tailor for." });

  const [dr, rr] = await Promise.all([
    fetch(`${ctx.url}/rest/v1/profile_details?select=data&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) }),
    fetch(`${ctx.url}/rest/v1/profiles?select=text&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) }),
  ]);
  if (!dr.ok || !rr.ok) return res.status(502).json({ error: "Couldn't load your profile. Try again." });
  const [detailRow] = await dr.json();
  const [resumeRow] = await rr.json();
  const details = detailRow?.data || {};
  const resumeText = resumeRow?.text || "";
  const gaps = profileGaps(details, resumeText);

  // Send the model only what a resume needs. Street address, ZIP, references and EEO answers stay out.
  const profileForModel = minimalProfile(details);
  const source = `PROFILE (JSON):\n${JSON.stringify(profileForModel).slice(0, SOURCE_CHARS)}\n\nRESUME TEXT:\n${resumeText.slice(0, SOURCE_CHARS)}`;
  if (!resumeText && !Object.keys(profileForModel).length) {
    return res.status(409).json({ error: "Add your profile and resume first.", needsProfile: true, gaps });
  }

  const q = await useQuota(ctx, "tailor", DAILY);
  if (!q.ok) return res.status(502).json({ error: "Couldn't check your daily limit. Try again." });
  if (!q.allowed) return res.status(429).json({ error: `You've used today's ${DAILY} drafts. Try again tomorrow.` });

  let materials;
  try {
    materials = parseMaterials(await askGroq(source, job));
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ error: "The free AI limit is used up for today. Try again later." });
    return res.status(502).json({ error: "The drafting service didn't answer. Try again in a moment." });
  }
  if (!materials) return res.status(502).json({ error: "The draft came back incomplete. Try again." });

  const flags = verifyAgainst({ source: `${JSON.stringify(profileForModel)}\n${resumeText}`, job, output: `${materials.resume}\n${materials.cover}` });

  return res.status(200).json({
    resume: materials.resume,
    cover: materials.cover,
    missing: materials.missing,
    notes: materials.notes,
    flags,
    profileGaps: gaps,
    originalResume: resumeText,
  });
}
