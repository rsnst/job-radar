-- Job Compass hardening (audit follow-up). Safe to re-run. Run once in the Supabase SQL editor,
-- BEFORE deploying the API change that calls use_quota / refund_quota.

-- 1) Daily limits that can't be raced or reset. Users could previously UPDATE their own counter row,
--    and the API read-then-wrote it. Now only these functions change the counters, atomically.
drop policy if exists "chat_usage: insert own" on public.chat_usage;
drop policy if exists "chat_usage: update own" on public.chat_usage;
drop policy if exists "fit_usage: insert own" on public.fit_usage;
drop policy if exists "fit_usage: update own" on public.fit_usage;
drop policy if exists "tailor_usage: insert own" on public.tailor_usage;
drop policy if exists "tailor_usage: update own" on public.tailor_usage;
revoke insert, update, delete on public.chat_usage, public.fit_usage, public.tailor_usage from anon, authenticated;

create or replace function public.use_quota(kind text, daily integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); hit integer;
begin
  if uid is null or kind not in ('chat', 'fit', 'tailor') or daily < 1 then return false; end if;
  execute format(
    'insert into public.%1$I as u (user_id, day, n) values ($1, (now() at time zone ''utc'')::date, 1)
       on conflict (user_id, day) do update set n = u.n + 1 where u.n < $2 returning u.n', kind || '_usage')
    into hit using uid, daily;
  return hit is not null;
end $$;

create or replace function public.refund_quota(kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or kind not in ('chat', 'fit', 'tailor') then return; end if;
  execute format('update public.%1$I set n = greatest(n - 1, 0) where user_id = $1 and day = (now() at time zone ''utc'')::date', kind || '_usage') using uid;
end $$;

revoke all on function public.use_quota(text, integer), public.refund_quota(text) from public, anon;
grant execute on function public.use_quota(text, integer), public.refund_quota(text) to authenticated;

-- 2) Application runs: users may only queue a plain run for themselves.
--    No self-set review decisions or results, hands-free submit only with the profile opt-in,
--    and at most 50 runs per user per day so one account can't flood the shared worker.
-- Counting runs inside the policy itself would recurse (the policy reads its own table), so the
-- count lives in a small security-definer function.
create or replace function public.runs_last_day()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.application_runs where user_id = auth.uid() and created_at > now() - interval '1 day'
$$;
revoke all on function public.runs_last_day() from public, anon;
grant execute on function public.runs_last_day() to authenticated;

drop policy if exists "application_runs: own enqueue" on public.application_runs;
create policy "application_runs: own enqueue" on public.application_runs
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and status = 'queued' and stage = 'queued' and user_decision = 'pending' and result = '{}'::jsonb
    and (auto_submit = false or exists (
      select 1 from public.profile_details d
      where d.user_id = (select auth.uid()) and d.data -> 'autoApply' ->> 'autoSubmit' = 'true'))
    and public.runs_last_day() < 50
  );
