-- Job Radar: per-user saved jobs. Run once in the Supabase SQL editor.
-- The job index itself is NOT stored here; it lives in the static SQLite files on GitHub Pages.

create table if not exists public.saved_jobs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  url        text not null,            -- the employer's apply link; stable key for a posting
  title      text not null,
  company    text not null,
  loc        text,
  created_at timestamptz not null default now(),
  primary key (user_id, url)
);

alter table public.saved_jobs enable row level security;

create policy "saved_jobs: read own"
  on public.saved_jobs for select
  using (auth.uid() = user_id);

create policy "saved_jobs: insert own"
  on public.saved_jobs for insert
  with check (auth.uid() = user_id);

create policy "saved_jobs: delete own"
  on public.saved_jobs for delete
  using (auth.uid() = user_id);

-- No update policy on purpose: saved rows are only added and removed.
-- The anon key can't read or write anything except through these policies.
