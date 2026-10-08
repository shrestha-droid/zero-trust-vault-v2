-- Waitlist: emails of people who want Pro/Legacy before payments go live.
-- Written only by the server (api/waitlist.ts, service role). No policies on purpose: with RLS on and
-- no grants, the browser (anon/authenticated) can neither read nor write it.
create table if not exists public.waitlist (
  email text primary key check (length(email) <= 254 and email = lower(email) and email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'),
  source text not null default 'site' check (length(source) <= 32),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now()
);
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;
create index if not exists waitlist_created_idx on public.waitlist (created_at);
