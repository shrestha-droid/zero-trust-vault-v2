-- Shard check-ins: the people holding shards confirm, now and then, that they still have them, and the owner
-- sees which shards are confirmed. Per shard the owner stores verifier = SHA-256(proof), where
-- proof = SHA-256("ztv-custody:<vault id>:<i>:" ‖ share) (src/crypto.ts). A holder's browser sends the proof,
-- never the shard; /api/custody-check (service role) matches it and stamps confirmed_at.
-- Neither value reveals anything about the share (32+ random bytes), and the proof can't be derived from the vault file.
create table if not exists public.custody (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  vault_id text not null check (vault_id ~ '^[0-9a-f]{16}$'),
  idx smallint not null,
  k smallint not null,
  n smallint not null,
  verifier text not null unique check (verifier ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, vault_id, idx),
  check (k between 2 and n and n <= 16 and idx between 1 and n)
);
alter table public.custody enable row level security;

-- Free accounts track one vault; Pro tracks every vault.
create or replace function public.custody_other_vaults(v text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.custody where user_id = auth.uid() and vault_id <> v);
$$;
revoke all on function public.custody_other_vaults(text) from public, anon;
grant execute on function public.custody_other_vaults(text) to authenticated;

drop policy if exists "custody: owner reads" on public.custody;
drop policy if exists "custody: owner enrolls" on public.custody;
drop policy if exists "custody: owner deletes" on public.custody;
create policy "custody: owner reads" on public.custody
  for select to authenticated using (user_id = (select auth.uid()));
create policy "custody: owner enrolls" on public.custody
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (public.is_pro() or not public.custody_other_vaults(vault_id)));
create policy "custody: owner deletes" on public.custody
  for delete to authenticated using (user_id = (select auth.uid()));

-- Owners can never stamp confirmed_at themselves: only a holder's proof, via the server, can.
revoke all on public.custody from anon, authenticated;
grant select, delete on public.custody to authenticated;
grant insert (user_id, vault_id, idx, k, n, verifier) on public.custody to authenticated;
