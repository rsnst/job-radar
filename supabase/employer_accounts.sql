-- Employer accounts the worker creates for a user (opt-in), and the verification mail it receives for them.
-- Run once in the Supabase SQL editor. The worker uses the service-role key; users never see passwords.

create table if not exists employer_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  host text not null,                       -- e.g. acme.wd5.myworkdayjobs.com
  email text not null,                      -- the alias address used for this account
  password_enc text not null,               -- AES-256-GCM, key held only by the worker
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, host)
);
alter table employer_accounts enable row level security;
revoke all on employer_accounts from anon, authenticated;
grant select (user_id, host, email, created_at, last_used_at) on employer_accounts to authenticated;
grant delete on employer_accounts to authenticated;
drop policy if exists "own accounts read" on employer_accounts;
create policy "own accounts read" on employer_accounts for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own accounts delete" on employer_accounts;
create policy "own accounts delete" on employer_accounts for delete to authenticated using (auth.uid() = user_id);

-- One alias per user: jc-<token>@INBOX_DOMAIN. Worker-only.
create table if not exists mail_aliases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table mail_aliases enable row level security;
revoke all on mail_aliases from anon, authenticated;

-- Only the extracted code or link is kept, never the message body. Rows expire after 30 minutes.
create table if not exists inbound_mail (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sender text not null default '',
  subject text not null default '',
  code text not null default '',
  link text not null default '',
  consumed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
create index if not exists inbound_mail_user on inbound_mail (user_id, created_at desc);
alter table inbound_mail enable row level security;
revoke all on inbound_mail from anon, authenticated;
