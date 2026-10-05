-- Zero-Trust Vault v2: private bucket, per-user folders, write-once records.
-- Object path is "<auth.uid()>/<16-hex-id>.vault". The server only ever holds ciphertext.
--
-- Postgres OR-combines policies, so any older, broader policy on this bucket (v1 shipped twelve, incl.
-- anonymous read/insert/delete) would silently override the ones below. Remove every policy that
-- mentions this bucket first; the strict three are recreated right after.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') like '%vault-store%' or coalesce(with_check, '') like '%vault-store%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault-store', 'vault-store', false, 157286400, array['application/json'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "vault owner can read" on storage.objects;
drop policy if exists "vault owner can create" on storage.objects;
drop policy if exists "vault owner can delete" on storage.objects;

create policy "vault owner can read" on storage.objects
  for select to authenticated
  using (bucket_id = 'vault-store' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "vault owner can create" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vault-store'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[0-9a-f]{16}\.vault$'
  );

create policy "vault owner can delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'vault-store' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- No UPDATE policy on purpose: records are write-once, so a stolen session can't silently
-- replace a vault with one whose keys the attacker holds.
