-- Zero-Trust Vault: plans (Free/Pro), cloud quota, and Legacy (dead man's switch).
-- Run after 0001_vault_store.sql. Every write that grants or changes a paid plan happens server-side
-- (api/stripe-webhook.ts with the service role); the browser can only read its own rows.

-- ---------------------------------------------------------------- Entitlements
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'inactive',
  stripe_customer text unique,
  stripe_subscription text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;
revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;
drop policy if exists "read own entitlement" on public.entitlements;
create policy "read own entitlement" on public.entitlements
  for select to authenticated using (user_id = (select auth.uid()));

-- Pro = active/trialing/past_due subscription (3-day grace past period end) or a lifetime purchase.
-- No argument: it only ever answers for the caller, so it can't be used to probe other accounts.
create or replace function public.is_pro() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = auth.uid() and e.plan = 'pro'
      and (e.status = 'lifetime'
        or (e.status in ('active', 'trialing', 'past_due')
            and (e.current_period_end is null or e.current_period_end > now() - interval '3 days')))
  );
$$;

-- ---------------------------------------------------------------- Cloud quota
-- Free accounts may keep 2 encrypted vaults in the cloud; Pro is unlimited.
create or replace function public.cloud_vault_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from storage.objects
  where bucket_id = 'vault-store' and (storage.foldername(name))[1] = auth.uid()::text;
$$;

drop policy if exists "vault owner can create" on storage.objects;
create policy "vault owner can create" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-store'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[0-9a-f]{16}\.vault$'
    and (public.is_pro() or public.cloud_vault_count() < 2)
  );

-- ---------------------------------------------------------------- Legacy plans
create table if not exists public.legacy_plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  interval_days integer not null default 90 check (interval_days between 30 and 730),
  grace_days integer not null default 14 check (grace_days between 7 and 90),
  last_checkin timestamptz not null default now(),
  trustees jsonb not null check (jsonb_typeof(trustees) = 'array' and jsonb_array_length(trustees) between 1 and 10),
  message text not null default '' check (length(message) <= 5000),
  vault_ids text[] not null default '{}' check (cardinality(vault_ids) <= 50),
  escrow_shard text check (escrow_shard is null or (escrow_shard ~ '^ztv2\.[0-9a-f]{16}\.' and length(escrow_shard) < 400)),
  reminded_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.legacy_plans enable row level security;

-- Owners may read and delete their plan; creating or editing one requires Pro.
-- Billing is NOT checked at release time: a deceased owner's card eventually fails, and the plan must still fire.
drop policy if exists "legacy: owner reads" on public.legacy_plans;
drop policy if exists "legacy: pro creates" on public.legacy_plans;
drop policy if exists "legacy: pro edits" on public.legacy_plans;
drop policy if exists "legacy: owner deletes" on public.legacy_plans;
create policy "legacy: owner reads" on public.legacy_plans
  for select to authenticated using (user_id = (select auth.uid()));
create policy "legacy: pro creates" on public.legacy_plans
  for insert to authenticated with check (user_id = (select auth.uid()) and public.is_pro());
create policy "legacy: pro edits" on public.legacy_plans
  for update to authenticated
  using (user_id = (select auth.uid()) and released_at is null)
  with check (user_id = (select auth.uid()) and public.is_pro());
create policy "legacy: owner deletes" on public.legacy_plans
  for delete to authenticated using (user_id = (select auth.uid()));

-- Column privileges: owners can never write the timestamps the scheduler relies on.
revoke all on public.legacy_plans from anon, authenticated;
grant select, delete on public.legacy_plans to authenticated;
grant insert (user_id, enabled, interval_days, grace_days, trustees, message, vault_ids, escrow_shard) on public.legacy_plans to authenticated;
grant update (enabled, interval_days, grace_days, trustees, message, vault_ids, escrow_shard) on public.legacy_plans to authenticated;

-- Check-in: opening the app while signed in (or the email link) resets the clock. Works on any plan,
-- so a lapsed subscription never causes a false release while the owner is alive and active.
create or replace function public.legacy_checkin() returns timestamptz
language sql volatile security definer set search_path = '' as $$
  update public.legacy_plans set last_checkin = now(), reminded_at = null
  where user_id = auth.uid() and released_at is null
  returning last_checkin;
$$;
revoke all on function public.legacy_checkin() from public, anon;
grant execute on function public.legacy_checkin() to authenticated;
-- Policies evaluate these as the calling user, so authenticated needs EXECUTE.
revoke all on function public.is_pro() from public, anon;
grant execute on function public.is_pro() to authenticated;
revoke all on function public.cloud_vault_count() from public, anon;
grant execute on function public.cloud_vault_count() to authenticated;
