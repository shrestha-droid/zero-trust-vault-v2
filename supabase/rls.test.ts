// Row-level security, quotas and column privileges, exercised as real Postgres roles (PGlite, in-process).
// Supabase's auth/storage schemas are stubbed to the minimum the migrations touch.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const db = new PGlite();
type Res = { rows?: Record<string, unknown>[]; error?: string };

async function as(uid: string | null, sql: string, params?: unknown[]): Promise<Res> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return { rows: (await db.query(sql, params)).rows as Record<string, unknown>[] }; }
  catch (e) { return { error: (e as Error).message }; }
  finally { await db.exec('reset role'); }
}
const service = (sql: string, p?: unknown[]) => db.query(sql, p);
const put = (uid: string, id: string, owner = uid) => as(uid, `insert into storage.objects (bucket_id, name) values ('vault-store', $1)`, [`${owner}/${id}.vault`]);
const isPro = async (uid: string) => (await as(uid, 'select public.is_pro() as p')).rows![0].p;
const RLS = /row-level security/;
const DENIED = /permission denied/;
const plan = `insert into public.legacy_plans (user_id, trustees, message, vault_ids) values ($1, '[{"name":"Ana","email":"ana@example.com"}]', 'hi', '{000000000000000a}')`;

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, created_at timestamptz default now());
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1] $$;
    grant usage on schema auth, storage, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant all on storage.objects to authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated; -- Supabase's default
    insert into auth.users values ('${A}'), ('${B}');
  `);
  for (const f of ['0001_vault_store.sql', '0002_billing_legacy.sql']) await db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
}, 60_000);

describe('cloud storage', () => {
  it('free quota of 2, own folder only, valid names only, write-once, private', async () => {
    expect((await put(A, '000000000000000a')).error).toBeUndefined();
    expect((await put(A, '000000000000000b')).error).toBeUndefined();
    expect((await put(A, '000000000000000c')).error).toMatch(RLS);
    expect((await put(A, '000000000000000d', B)).error).toMatch(RLS);
    expect((await as(A, `insert into storage.objects (bucket_id, name) values ('vault-store', $1)`, [`${A}/../x.vault`])).error).toMatch(RLS);
    expect((await as(B, 'select * from storage.objects')).rows).toHaveLength(0);
    expect((await as(A, 'update storage.objects set name = name returning 1')).rows ?? []).toHaveLength(0);
  });
});

describe('entitlements', () => {
  it('only the server grants Pro; Pro lifts the quota; expiry has a 3-day grace', async () => {
    expect(await isPro(A)).toBe(false);
    expect((await as(A, `insert into public.entitlements (user_id, plan, status) values ($1, 'pro', 'lifetime')`, [A])).error).toBeDefined();
    await service(`insert into public.entitlements (user_id, plan, status, current_period_end) values ($1, 'pro', 'active', now() + interval '30 days')`, [A]);
    expect(await isPro(A)).toBe(true);
    expect((await as(B, 'select * from public.entitlements')).rows).toHaveLength(0);
    expect((await put(A, '000000000000000c')).error).toBeUndefined();
    await service(`update public.entitlements set current_period_end = now() - interval '2 days' where user_id = $1`, [A]);
    expect(await isPro(A)).toBe(true);
    await service(`update public.entitlements set current_period_end = now() - interval '5 days' where user_id = $1`, [A]);
    expect(await isPro(A)).toBe(false);
    await service(`update public.entitlements set current_period_end = now() + interval '30 days' where user_id = $1`, [A]);
  });
});

describe('legacy plans', () => {
  it('Pro creates; owners cannot touch scheduler columns; check-in survives a lapse; private', async () => {
    expect((await as(B, plan, [B])).error).toMatch(RLS);
    expect((await as(A, plan, [A])).error).toBeUndefined();
    expect((await as(A, plan, [B])).error).toMatch(RLS);
    expect((await as(A, `update public.legacy_plans set last_checkin = now() + interval '10 years'`)).error).toMatch(DENIED);
    expect((await as(A, 'update public.legacy_plans set released_at = now()')).error).toMatch(DENIED);
    expect((await as(A, `update public.legacy_plans set message = 'updated', interval_days = 180`)).error).toBeUndefined();

    await service(`update public.legacy_plans set last_checkin = now() - interval '100 days', reminded_at = now() where user_id = $1`, [A]);
    expect((await as(A, 'select public.legacy_checkin() as t')).rows![0].t).toBeTruthy();
    const after = (await service(`select reminded_at, last_checkin > now() - interval '1 minute' as fresh from public.legacy_plans`)).rows[0] as Record<string, unknown>;
    expect(after).toEqual({ reminded_at: null, fresh: true });

    await service(`update public.entitlements set plan = 'free', status = 'canceled' where user_id = $1`, [A]);
    expect((await as(A, 'select public.legacy_checkin() as t')).rows![0].t).toBeTruthy();
    expect((await as(A, `update public.legacy_plans set message = 'x' returning 1`)).rows ?? []).toHaveLength(0);
    expect((await as(B, 'select * from public.legacy_plans')).rows).toHaveLength(0);
    expect((await as(null, 'select public.legacy_checkin()')).error).toBeDefined();
    await expect(service(`insert into public.legacy_plans (user_id, trustees) values ($1, '[]')`, [B])).rejects.toThrow(/check/);
    expect((await as(A, 'delete from public.legacy_plans returning 1')).rows).toHaveLength(1);
  });
});
