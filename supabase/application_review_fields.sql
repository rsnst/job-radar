-- Allow bounded field-by-field Workday review summaries in application_runs.
alter table public.application_runs drop constraint if exists application_runs_result_check;
alter table public.application_runs add constraint application_runs_result_check
  check (pg_column_size(result) <= 60000);

-- Existing rows from before the preview cannot be approved directly.
drop policy if exists "application_runs: own review decision" on public.application_runs;
drop policy if exists "application_runs: own cancel" on public.application_runs;
drop policy if exists "application_runs: own decision" on public.application_runs;
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
