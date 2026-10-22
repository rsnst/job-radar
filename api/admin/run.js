// POST: start a scrape sweep. Admins only; refuses while another run is still queued or running.
import { requireAdmin, ghHeaders, GH, WORKFLOW, isActive } from "../../lib/admin.js";

const MODES = new Set(["full", "incremental"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!(await requireAdmin(req))) return res.status(403).json({ error: "Admins only." });
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN isn't set on the server yet." });
  const mode = MODES.has(req.body?.mode) ? req.body.mode : "full";
  try {
    const list = await fetch(`${GH}/workflows/${WORKFLOW}/runs?per_page=10`, { headers: ghHeaders() });
    if (!list.ok) throw new Error(`github ${list.status}`);
    if ((await list.json()).workflow_runs?.some(isActive)) {
      return res.status(409).json({ error: "A sweep is already running. Wait for it to finish." });
    }
    const d = await fetch(`${GH}/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { mode } }),
    });
    if (d.status !== 204) throw new Error(`dispatch ${d.status}`);
    return res.status(202).json({ ok: true, mode });
  } catch {
    return res.status(502).json({ error: "Couldn't start the sweep. Try again in a moment." });
  }
}
