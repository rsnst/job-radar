-- Job Compass: resume profiles and AI fit checks. Run once in the Supabase SQL editor.
-- Every table is readable and writable only by the user it belongs to (RLS).

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  text text not null check (char_length(text) <= 20000),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: own" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles: update own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles: delete own" on public.profiles for delete using (auth.uid() = user_id);

create table if not exists public.fit_cache (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, job_key)
);
alter table public.fit_cache enable row level security;
create policy "fit_cache: own" on public.fit_cache for select using (auth.uid() = user_id);
create policy "fit_cache: insert own" on public.fit_cache for insert with check (auth.uid() = user_id);
create policy "fit_cache: update own" on public.fit_cache for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.fit_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.fit_usage enable row level security;
create policy "fit_usage: own" on public.fit_usage for select using (auth.uid() = user_id);
create policy "fit_usage: insert own" on public.fit_usage for insert with check (auth.uid() = user_id);
create policy "fit_usage: update own" on public.fit_usage for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
