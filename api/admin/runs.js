// GET: recent scrape runs, plus live progress for the run that is active now. Admins only.
import { requireAdmin, ghHeaders, GH, WORKFLOW, SHARDS, isActive } from "../../lib/admin.js";

function summarize(r) {
  const start = r.run_started_at || r.created_at;
  const end = r.status === "completed" ? r.updated_at : null;
  return {
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    title: r.display_title,
    sha: (r.head_sha || "").slice(0, 7),
    started: start,
    seconds: end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null,
    url: r.html_url,
  };
}

async function progressOf(run) {
  const r = await fetch(`${GH}/runs/${run.id}/jobs?per_page=100`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`jobs ${r.status}`);
  const jobs = (await r.json()).jobs || [];
  const shards = jobs.filter((j) => /^scrape \(\d+\)$/.test(j.name));
  const done = shards.filter((j) => j.status === "completed").length;
  const failed = shards.filter((j) => j.status === "completed" && j.conclusion === "failure").length;
  const running = shards.filter((j) => j.status === "in_progress").length;
  const build = jobs.find((j) => j.name === "build");
  return {
    id: run.id,
    started: run.run_started_at || run.created_at,
    elapsed: Math.max(0, Math.round((Date.now() - Date.parse(run.run_started_at || run.created_at)) / 1000)),
    shards: {
      total: SHARDS,
      done: done - failed,
      failed,
      running,
      queued: Math.max(0, SHARDS - done - running), // shards GitHub hasn't started yet
    },
    build: build ? (build.status === "completed" ? build.conclusion : build.status) : "not started",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  if (!(await requireAdmin(req))) return res.status(403).json({ error: "Admins only." });
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: "GITHUB_TOKEN isn't set on the server yet." });
  try {
    const r = await fetch(`${GH}/workflows/${WORKFLOW}/runs?per_page=20`, { headers: ghHeaders() });
    if (!r.ok) throw new Error(`github ${r.status}`);
    const runs = (await r.json()).workflow_runs || [];
    const live = runs.find(isActive);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      runs: runs.map(summarize),
      active: live ? await progressOf(live) : null,
    });
  } catch {
    return res.status(502).json({ error: "Couldn't reach GitHub. Try again in a moment." });
  }
}
