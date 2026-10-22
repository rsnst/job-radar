// Shared helpers for the admin functions. Runs on Vercel; never shipped to the browser.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (already set), GITHUB_TOKEN (fine-grained, this repo, Actions read & write).

export const REPO = "rsnst/job-radar";
export const WORKFLOW = "scrape.yml";
export const SHARDS = 40; // matches the matrix in .github/workflows/scrape.yml

export const GH = `https://api.github.com/repos/${REPO}/actions`;

export function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "job-compass",
  };
}

// Admin check with the caller's own Supabase token: Supabase confirms who they are, then
// the admins table (RLS: each user can read only their own row) says whether they're an admin.
// No service-role key is needed or used.
export async function requireAdmin(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!token || !url || !key) return null;
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  const me = await fetch(`${url}/auth/v1/user`, { headers });
  if (!me.ok) return null;
  const user = await me.json();
  const row = await fetch(`${url}/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers });
  if (!row.ok) return null;
  return (await row.json()).length ? user : null;
}

export function isActive(run) {
  return run.status !== "completed";
}
