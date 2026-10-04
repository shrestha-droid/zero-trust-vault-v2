-- Zero-Trust Vault v2: private bucket, per-user folders, write-once records.
-- Object path is "<auth.uid()>/<16-hex-id>.vault". The server only ever holds ciphertext.
--
-- IMPORTANT: Postgres OR-combines policies. Any older, broader policy on storage.objects
-- for this bucket (e.g. from v1) will override these. List them with:
--   select policyname, cmd, qual, with_check from pg_policies
--   where schemaname = 'storage' and tablename = 'objects';
-- and drop anything that grants access to 'vault-store' beyond the three below.

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
