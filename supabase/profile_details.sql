-- Job Compass: full application profile (contact, links, work authorization, experience,
-- education, skills). Run once in the Supabase SQL editor. Row-level security: own rows only.
create table if not exists public.profile_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 60000),
  updated_at timestamptz not null default now()
);
alter table public.profile_details enable row level security;
create policy "profile_details: own" on public.profile_details for select using (auth.uid() = user_id);
create policy "profile_details: insert own" on public.profile_details for insert with check (auth.uid() = user_id);
create policy "profile_details: update own" on public.profile_details for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profile_details: delete own" on public.profile_details for delete using (auth.uid() = user_id);
