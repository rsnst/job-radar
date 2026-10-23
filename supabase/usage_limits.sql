-- Secure, atomic usage counters for the AI routes.
-- Apply after ai.sql, applications.sql, and chat.sql. The API schema setting
-- below preserves Supabase's default schemas and exposes only this guarded RPC
-- alongside them. This is a manual PostgREST override; update it manually if
-- additional schemas are exposed later.

create schema if not exists usage_guard;
revoke all on schema usage_guard from public, anon, authenticated;
grant usage on schema usage_guard to authenticated;

-- Make the quota RPC usable even when an install has only enabled part of the
-- app so far. The feature migrations use these same table definitions.
create table if not exists public.fit_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
create table if not exists public.tailor_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
create table if not exists public.chat_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.fit_usage enable row level security;
alter table public.tailor_usage enable row level security;
alter table public.chat_usage enable row level security;

-- The browser may read profile data and fit cache, but cannot set or decrement
-- quota rows. Only this one RPC can increment them, and it derives the owner
-- and UTC day from the caller/database rather than accepting either as input.
revoke all on table public.fit_usage, public.tailor_usage, public.chat_usage from public, anon, authenticated;

drop policy if exists "fit_usage: own" on public.fit_usage;
drop policy if exists "tailor_usage: own" on public.tailor_usage;
drop policy if exists "chat_usage: own" on public.chat_usage;

create or replace function usage_guard.consume_ai_usage(p_kind text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_n integer;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_kind = 'fit' then
    insert into public.fit_usage (user_id, day, n) values (v_user, v_day, 1)
    on conflict (user_id, day) do update set n = public.fit_usage.n + 1
    returning n into v_n;
  elsif p_kind = 'tailor' then
    insert into public.tailor_usage (user_id, day, n) values (v_user, v_day, 1)
    on conflict (user_id, day) do update set n = public.tailor_usage.n + 1
    returning n into v_n;
  elsif p_kind = 'chat' then
    insert into public.chat_usage (user_id, day, n) values (v_user, v_day, 1)
    on conflict (user_id, day) do update set n = public.chat_usage.n + 1
    returning n into v_n;
  else
    raise exception 'unknown usage category' using errcode = '22023';
  end if;

  -- Limit storage growth if an authenticated client repeatedly calls the RPC.
  if v_n > 1000 then
    raise exception 'daily usage ceiling reached' using errcode = '22023';
  end if;
  return v_n;
end;
$$;

revoke all on function usage_guard.consume_ai_usage(text) from public, anon;
grant execute on function usage_guard.consume_ai_usage(text) to authenticated;

alter role authenticator set pgrst.db_schemas = 'public, graphql_public, usage_guard';
notify pgrst, 'reload config';

-- Retire older public quota RPCs that allowed callers to refund usage or choose
-- their own limit. The app now uses only the fixed-category RPC above.
revoke all on function public.use_quota(text, integer) from public, anon, authenticated;
revoke all on function public.refund_quota(text) from public, anon, authenticated;
revoke all on function public.runs_last_day() from public, anon, authenticated;
