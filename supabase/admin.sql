-- Job Radar: admin role. Run once in the Supabase SQL editor.
-- Admins see the Admin tab (scrape numbers). Rows are added by hand, never by the app.

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.admins enable row level security;

-- A signed-in user can only ask "am I an admin?" about themselves.
create policy "admins: read own"
  on public.admins for select
  using (auth.uid() = user_id);

-- To make someone an admin (after they have signed in once):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
