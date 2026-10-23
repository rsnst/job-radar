-- Job Compass: daily message count for the chat assistant. Run once in the Supabase SQL editor.
create table if not exists public.chat_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.chat_usage enable row level security;
-- Usage rows are server-managed through supabase/usage_limits.sql; no client policies.
