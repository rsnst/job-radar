-- Job Compass: application tracker, versioned tailored materials, and tailoring usage.
-- Run once in the Supabase SQL editor. User data is owner-scoped; usage is server-managed.

create table if not exists public.applications (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null check (char_length(job_key) <= 2000),
  job jsonb not null default '{}'::jsonb check (pg_column_size(job) <= 4000),
  status text not null default 'saved' check (status in (
    'saved','preparing','needs-info','ready-for-review','submitted','interview','rejected','offer','withdrawn')),
  notes text not null default '' check (char_length(notes) <= 4000),
  history jsonb not null default '[]'::jsonb check (pg_column_size(history) <= 30000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, job_key)
);
alter table public.applications enable row level security;
create policy "applications: own" on public.applications for select using (auth.uid() = user_id);
create policy "applications: insert own" on public.applications for insert with check (auth.uid() = user_id);
create policy "applications: update own" on public.applications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "applications: delete own" on public.applications for delete using (auth.uid() = user_id);

create table if not exists public.application_docs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null check (char_length(job_key) <= 2000),
  kind text not null check (kind in ('resume', 'cover')),
  version integer not null check (version > 0),
  body text not null check (char_length(body) <= 30000),
  flags jsonb not null default '[]'::jsonb check (pg_column_size(flags) <= 8000),
  source text not null default 'ai' check (source in ('ai', 'edited')),
  created_at timestamptz not null default now(),
  unique (user_id, job_key, kind, version)
);
alter table public.application_docs enable row level security;
create policy "application_docs: own" on public.application_docs for select using (auth.uid() = user_id);
create policy "application_docs: insert own" on public.application_docs for insert with check (auth.uid() = user_id);
create policy "application_docs: delete own" on public.application_docs for delete using (auth.uid() = user_id);

create table if not exists public.tailor_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.tailor_usage enable row level security;
-- Usage rows are server-managed through supabase/usage_limits.sql; no client policies.
