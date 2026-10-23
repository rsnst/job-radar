// Employer accounts the worker created for the signed-in user. Lists host + address only (the password column
// is not readable by users), and lets the user delete an account record at any time.
import { currentUser, restHeaders } from "../lib/supa.js";

export default async function handler(req, res) {
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });
  const table = `${ctx.url}/rest/v1/employer_accounts`;
  if (req.method === "GET") {
    const r = await fetch(`${table}?select=host,email,created_at,last_used_at&user_id=eq.${ctx.id}&order=created_at.desc&limit=100`, { headers: restHeaders(ctx) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't load your employer accounts." });
    return res.status(200).json({ accounts: await r.json() });
  }
  if (req.method === "DELETE") {
    const host = String(req.query?.host || req.body?.host || "").trim().toLowerCase().slice(0, 255);
    if (!/^[a-z0-9.-]+$/.test(host)) return res.status(400).json({ error: "Choose a valid employer account." });
    const r = await fetch(`${table}?user_id=eq.${ctx.id}&host=eq.${encodeURIComponent(host)}`, { method: "DELETE", headers: restHeaders(ctx, { Prefer: "return=minimal" }) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't remove that account." });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}
