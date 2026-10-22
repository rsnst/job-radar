// Optional accounts: Google sign-in and per-user saved jobs, stored in Supabase.
// If Supabase isn't configured (no SUPABASE_URL / SUPABASE_ANON_KEY at build time),
// everything here stays disabled and the public job search works unchanged.

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
const cfg = window.JOB_RADAR_CONFIG || {};

export const account = {
  enabled: false,
  user: null,
  isAdmin: false, // a row in public.admins for this user; the UI gate, see supabase/admin.sql
  saved: new Set(), // apply URLs of the signed-in user's saved jobs
  onChange: () => {},
};

let sb = null;

export async function initAccount() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return account;
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, detectSessionInUrl: true, flowType: "implicit" },
    });
    account.enabled = true;
    const { data } = await sb.auth.getSession();
    await setUser(data.session?.user ?? null);
    sb.auth.onAuthStateChange((_event, session) => { setUser(session?.user ?? null); });
  } catch (e) {
    account.enabled = false;
    console.warn("Accounts unavailable:", e);
  }
  return account;
}

async function setUser(user) {
  account.user = user;
  account.saved = new Set();
  account.isAdmin = false;
  if (user) {
    try {
      const { data } = await sb.from("saved_jobs").select("url").limit(5000);
      for (const r of data || []) account.saved.add(r.url);
    } catch (e) { console.warn("Couldn't load saved jobs:", e); }
    try {
      const { data } = await sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
      account.isAdmin = !!data;
    } catch (e) { console.warn("Couldn't check admin role:", e); }
  }
  account.onChange();
}

// Passwordless sign-in: Supabase emails a link that signs the browser in.
export async function signInWithEmail(email) {
  if (!sb) throw new Error("Accounts are not configured");
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
}

// Email and password. Accounts created here are confirmed by an email link first (see the note in the dialog).
export async function signInWithPassword(email, password) {
  if (!sb) throw new Error("Accounts are not configured");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpWithPassword(email, password) {
  if (!sb) throw new Error("Accounts are not configured");
  const { data, error } = await sb.auth.signUp({
    email, password, options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  // With email confirmation on, there's no session until the link is opened.
  return { needsConfirm: !data.session };
}

export async function signIn() {
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
}

export async function signOut() {
  if (sb) await sb.auth.signOut();
}

// job = { url, title, company, loc }
export async function toggleSave(job) {
  if (!account.user) return signIn();
  if (account.saved.has(job.url)) {
    const { error } = await sb.from("saved_jobs").delete().eq("url", job.url);
    if (error) throw error;
    account.saved.delete(job.url);
  } else {
    const { error } = await sb.from("saved_jobs").insert({
      url: job.url, title: job.title, company: job.company, loc: job.loc || null,
    });
    if (error) throw error;
    account.saved.add(job.url);
  }
  account.onChange();
}

export async function listSaved() {
  const { data, error } = await sb.from("saved_jobs").select("url,title,company,loc,created_at")
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
}

// The signed-in user's access token, for calls to our own admin functions.
export async function accessToken() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
