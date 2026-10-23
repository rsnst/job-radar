// GET: the signed-in user's resume text.  PUT { text }: save it (empty text deletes it).
import { currentUser, restHeaders } from "../lib/supa.js";

const MAX = 20000;

export default async function handler(req, res) {
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });
  const rest = `${ctx.url}/rest/v1/profiles`;

  if (req.method === "GET") {
    const r = await fetch(`${rest}?select=text,updated_at&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't load your profile." });
    const [row] = await r.json();
    return res.status(200).json({ text: row?.text || "", updated_at: row?.updated_at || null });
  }

  if (req.method === "PUT") {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : null;
    if (text === null) return res.status(400).json({ error: "Send the resume text as text." });
    if (text.length > MAX) return res.status(400).json({ error: `Keep it under ${MAX.toLocaleString()} characters.` });
    if (!text) {
      const d = await fetch(`${rest}?user_id=eq.${ctx.id}`, { method: "DELETE", headers: restHeaders(ctx) });
      return d.ok ? res.status(200).json({ text: "" }) : res.status(502).json({ error: "Couldn't delete your profile." });
    }
    const u = await fetch(`${rest}?on_conflict=user_id`, {
      method: "POST",
      headers: restHeaders(ctx, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ user_id: ctx.id, text, updated_at: new Date().toISOString() }),
    });
    return u.ok ? res.status(200).json({ text }) : res.status(502).json({ error: "Couldn't save your profile." });
  }

  return res.status(405).end();
}
