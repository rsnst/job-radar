// Signed-in user for a request, checked by Supabase with the caller's own token.
// Calls to the tables below then run as that user, so row-level security does the rest.
// No service-role key is used anywhere.
export async function currentUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!token || !url || !key) return null;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const user = await r.json();
  return user?.id ? { id: user.id, token, url, key } : null;
}

export function restHeaders(ctx, extra = {}) {
  return { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json", ...extra };
}
