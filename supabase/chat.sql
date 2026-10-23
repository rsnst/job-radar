-- Job Compass: daily message count for the chat assistant. Run once in the Supabase SQL editor.
create table if not exists public.chat_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.chat_usage enable row level security;
create policy "chat_usage: own" on public.chat_usage for select using (auth.uid() = user_id);
create policy "chat_usage: insert own" on public.chat_usage for insert with check (auth.uid() = user_id);
create policy "chat_usage: update own" on public.chat_usage for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
