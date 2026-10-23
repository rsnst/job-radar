-- Long-running application jobs. The app creates queued rows; a separately hosted
-- Playwright worker claims and updates them with the Supabase service key.
create table if not exists public.application_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null check (char_length(job_key) <= 2000),
  job jsonb not null default '{}'::jsonb check (pg_column_size(job) <= 6000),
  status text not null default 'queued' check (status in (
    'queued','running','needs_user','awaiting_review','submitted','failed','cancelled')),
  stage text not null default 'queued' check (char_length(stage) <= 60),
  message text not null default '' check (char_length(message) <= 500),
  auto_submit boolean not null default false,
  user_decision text not null default 'pending' check (user_decision in ('pending','approve','reject','cancel')),
  result jsonb not null default '{}'::jsonb check (pg_column_size(result) <= 30000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists application_runs_user_recent
  on public.application_runs (user_id, created_at desc);
create index if not exists application_runs_worker_queue
  on public.application_runs (created_at asc) where status = 'queued';
drop index if exists public.application_runs_one_active_per_job;
create unique index application_runs_one_active_per_job
  on public.application_runs (user_id, job_key)
  where status in ('queued','running','awaiting_review');

alter table public.application_runs enable row level security;
create policy "application_runs: own read" on public.application_runs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "application_runs: own enqueue" on public.application_runs
  for insert to authenticated with check (
    (select auth.uid()) = user_id and status = 'queued'
  );
create policy "application_runs: own decision" on public.application_runs
  for update to authenticated
  using ((select auth.uid()) = user_id and status in ('queued','running','needs_user','awaiting_review') and user_decision = 'pending')
  with check ((select auth.uid()) = user_id and case
    when user_decision = 'cancel' then status in ('queued','running','needs_user','awaiting_review')
    when user_decision = 'reject' then status = 'awaiting_review'
    when user_decision = 'approve' then status = 'awaiting_review' and
      case when jsonb_typeof(result->'review_fields') = 'array'
        then jsonb_array_length(result->'review_fields') > 0 and result->>'review_overflow' is distinct from 'true'
        else false end
    else false
  end);
grant select, insert on public.application_runs to authenticated;
grant update (user_decision) on public.application_runs to authenticated;
grant usage, select on sequence public.application_runs_id_seq to authenticated;
