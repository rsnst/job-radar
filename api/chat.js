// POST { messages, description?, title?, useResume? } -> { reply }
// Chat assistant for job search. Uses Groq's free API (GROQ_API_KEY). Signed-in users only,
// CHAT_DAILY_LIMIT messages a day (default 30). Only the job open on screen and, if the user
// ticks the box, their resume are sent to the model.
import { currentUser, restHeaders } from "../lib/supa.js";
import { useQuota } from "../lib/usage.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const DAILY = Math.max(1, Math.min(1000, Math.floor(Number(process.env.CHAT_DAILY_LIMIT) || 30)));
const MAX_TURNS = 10;
const MAX_MSG = 2000;
const JOB_CHARS = 6000;
const RESUME_CHARS = 6000;

const BASE = `You are the assistant inside Job Compass, a site that lists US jobs from employer career pages.
Help the user with their job search: explain what a posting asks for, suggest how to present their experience,
compare options, and answer questions about the job open on their screen.
Rules: use only the job posting and resume given to you. If something isn't in them, say so. Never invent
company facts, salaries, or requirements. Keep answers short and practical.`;

function plain(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "The assistant isn't set up yet." });
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in to use the assistant." });

  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_TURNS) : [];
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG) }));
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return res.status(400).json({ error: "Send a question first." });
  }

  let system = BASE;
  const jobText = plain(req.body?.description).slice(0, JOB_CHARS);
  if (jobText) {
    system += `\n\nJOB OPEN ON SCREEN (${String(req.body?.title || "untitled").slice(0, 200)}):\n${jobText}`;
  }
  if (req.body?.useResume === true) {
    const pr = await fetch(`${ctx.url}/rest/v1/profiles?select=text&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) });
    const [profile] = pr.ok ? await pr.json() : [];
    if (profile?.text) system += `\n\nUSER'S RESUME:\n${profile.text.slice(0, RESUME_CHARS)}`;
  }

  const q = await useQuota(ctx, "chat", DAILY);
  if (!q.ok) return res.status(502).json({ error: "Couldn't check your limit. Try again." });
  if (!q.allowed) return res.status(429).json({ error: `You've used today's ${DAILY} messages. Try again tomorrow.` });

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.4, max_tokens: 600,
      messages: [{ role: "system", content: system }, ...clean] }),
  });
  if (r.status === 429) return res.status(429).json({ error: "The free AI limit is used up for today. Try again later." });
  if (!r.ok) return res.status(502).json({ error: "The assistant didn't answer. Try again in a moment." });
  const data = await r.json();
  const reply = String(data.choices?.[0]?.message?.content || "").trim() || "I couldn't write an answer. Try rephrasing.";

  return res.status(200).json({ reply });
}
