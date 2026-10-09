import { describe, expect, it } from 'vitest';
import { makeDeleteAccountHandler } from './account.js';
import { makeWaitlistHandler } from './waitlist.js';
import { entitlementFrom, makeBillingHandler, makeCheckoutHandler, refundTarget, signStandard, verifyDodo, type EntitlementRow } from './billing.js';
import {
  DAY, decide, esc, sendEmail, makeCheckinHandler, makeCheckinToken, makeTickHandler, releaseEmail, runTick, verifyCheckinToken,
  type Email, type LegacyPlan,
} from './legacy.js';

const SECRET = `whsec_${btoa('test-signing-key-0123456789abcdef')}`;
const UID = '3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';
const headers = async (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET, id = 'msg_1') =>
  new Headers({ 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': `v1,${await signStandard(secret, id, String(t), body)}` });
const post = async (body: string, h?: Headers) => new Request('https://x/api/billing-webhook', { method: 'POST', body, headers: h ?? (await headers(body)) });

describe('dodo (standard webhooks) signature', () => {
  it('accepts a valid signature, rejects tampering, wrong secret, replays and missing headers', async () => {
    const body = '{"a":1}';
    expect(await verifyDodo(body, await headers(body), SECRET)).toBe(true);
    expect(await verifyDodo('{"a":2}', await headers(body), SECRET)).toBe(false);
    expect(await verifyDodo(body, await headers(body, undefined, `whsec_${btoa('other-key')}`), SECRET)).toBe(false);
    expect(await verifyDodo(body, await headers(body, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    expect(await verifyDodo(body, new Headers(), SECRET)).toBe(false);
    expect(await verifyDodo(body, await headers(body), '')).toBe(false);
    expect(await verifyDodo(body, await headers(body), 'whsec_not base64!!')).toBe(false);
  });
  it('accepts any of several v1 signatures (secret rotation)', async () => {
    const body = '{}', h = await headers(body);
    h.set('webhook-signature', `v1,AAAA ${h.get('webhook-signature')}`);
    expect(await verifyDodo(body, h, SECRET)).toBe(true);
  });
});

describe('entitlementFrom', () => {
  const ev = (type: string, data: object) => ({ type, data });
  const sub = { subscription_id: 'sub_1', customer: { customer_id: 'cus_1' }, metadata: { user_id: UID }, next_billing_date: '2030-01-01T00:00:00Z' };
  it('subscription.active/renewed → pro with period end; on_hold/cancelled/expired → free', () => {
    expect(entitlementFrom(ev('subscription.active', sub))).toMatchObject({ user_id: UID, plan: 'pro', status: 'active', subscription_ref: 'sub_1', customer_ref: 'cus_1', current_period_end: '2030-01-01T00:00:00.000Z' });
    expect(entitlementFrom(ev('subscription.renewed', sub))).toMatchObject({ plan: 'pro' });
    expect(entitlementFrom(ev('subscription.past_due', sub))).toMatchObject({ plan: 'pro', status: 'past_due' });
    for (const t of ['on_hold', 'cancelled', 'expired', 'failed']) expect(entitlementFrom(ev(`subscription.${t}`, sub))).toMatchObject({ plan: 'free', status: t });
    expect(entitlementFrom(ev('subscription.updated', { ...sub, status: 'active' }))).toMatchObject({ plan: 'pro' });
    expect(entitlementFrom(ev('subscription.updated', { ...sub, status: 'cancelled' }))).toMatchObject({ plan: 'free' });
    expect(entitlementFrom(ev('subscription.updated', sub))).toBeNull();
  });
  it('lifecycle events without a user id still resolve by customer; with neither they are dropped', () => {
    expect(entitlementFrom(ev('subscription.cancelled', { subscription_id: 's', customer: { customer_id: 'cus_1' } }))).toMatchObject({ user_id: undefined, customer_ref: 'cus_1', plan: 'free' });
    expect(entitlementFrom(ev('subscription.active', { subscription_id: 's' }))).toBeNull();
  });
  it('one-time payment of the Lifetime product → lifetime; subscription payments and other products do not', () => {
    const pay = { metadata: { user_id: UID, plan: 'lifetime' }, customer: { customer_id: 'cus_2' } };
    expect(entitlementFrom(ev('payment.succeeded', pay))).toMatchObject({ user_id: UID, plan: 'pro', status: 'lifetime', customer_ref: 'cus_2' });
    expect(entitlementFrom(ev('payment.succeeded', { metadata: { user_id: UID }, product_cart: [{ product_id: 'pdt_life' }] }), { lifetime: 'pdt_life' })).toMatchObject({ status: 'lifetime' });
    expect(entitlementFrom(ev('payment.succeeded', { metadata: { user_id: UID }, product_cart: [{ product_id: 'pdt_other' }] }), { lifetime: 'pdt_life' })).toBeNull();
    expect(entitlementFrom(ev('payment.succeeded', { ...pay, subscription_id: 'sub_1' }))).toBeNull(); // renewal payment, not Lifetime
  });
  it('ignores forged user ids and unrelated events', () => {
    expect(entitlementFrom(ev('payment.succeeded', { metadata: { user_id: "x' or 1=1", plan: 'lifetime' } }))).toBeNull();
    expect(entitlementFrom(ev('dispute.opened', {}))).toBeNull();
  });
});

describe('billing handler', () => {
  const setup = (over: { error?: { message: string } | null; status?: string | null } = {}) => {
    const error = over.error ?? null;
    const calls: string[] = [];
    const h = makeBillingHandler({
      secret: SECRET, products: { lifetime: 'pdt_life' },
      currentStatus: async () => over.status ?? null,
      upsertByUser: async (r: EntitlementRow) => { calls.push(`user:${r.status}`); return { error }; },
      updateByCustomer: async (r: EntitlementRow) => { calls.push(`customer:${r.status}`); return { error }; },
      revoke: async (w) => { calls.push(`revoke:${w.user_id ?? w.customer}`); return { error: null }; },
    });
    return { h, calls };
  };
  const evt = (type: string, data: object) => JSON.stringify({ business_id: 'b', type, timestamp: '2030-01-01T00:00:00Z', data });
  const sub = { subscription_id: 's', customer: { customer_id: 'cus_1' } };

  it('routes events with a user id to upsert-by-user and others to update-by-customer', async () => {
    const { h, calls } = setup();
    const a = evt('subscription.active', { ...sub, metadata: { user_id: UID } }), b = evt('subscription.cancelled', sub);
    expect((await h(await post(a))).status).toBe(200);
    expect((await h(await post(b))).status).toBe(200);
    expect(calls).toEqual(['user:active', 'customer:cancelled']);
  });
  it('400 on bad signature, 405 on GET, 500 on DB error (so Dodo retries), 200 on ignored events', async () => {
    const body = evt('subscription.active', { ...sub, metadata: { user_id: UID } });
    expect((await setup().h(await post(body, new Headers({ 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,00' })))).status).toBe(400);
    expect((await setup().h(new Request('https://x', { method: 'GET' }))).status).toBe(405);
    expect((await setup({ error: { message: 'db down' } }).h(await post(body))).status).toBe(500);
    expect(await (await setup().h(await post(evt('dispute.opened', {})))).text()).toBe('ignored');
  });
  it('a later Pro event can never downgrade an existing Lifetime plan, but Lifetime can still be recorded', async () => {
    const { h, calls } = setup({ status: 'lifetime' });
    expect(await (await h(await post(evt('subscription.active', { ...sub, metadata: { user_id: UID } })))).text()).toBe('ignored: already lifetime');
    await h(await post(evt('payment.succeeded', { metadata: { user_id: UID, plan: 'lifetime' } })));
    expect(calls).toEqual(['user:lifetime']);
  });
  it('a full refund revokes paid access; a partial refund does not', async () => {
    expect(refundTarget({ type: 'refund.succeeded', data: { metadata: { user_id: UID } } })).toEqual({ user_id: UID, customer: undefined });
    expect(refundTarget({ type: 'refund.succeeded', data: { customer: { customer_id: 'cus_9' } } })).toEqual({ user_id: undefined, customer: 'cus_9' });
    expect(refundTarget({ type: 'refund.succeeded', data: { is_partial: true, customer: { customer_id: 'cus_9' } } })).toBeNull();
    expect(refundTarget({ type: 'refund.succeeded', data: {} })).toBeNull();
    const { h, calls } = setup();
    await h(await post(evt('refund.succeeded', { customer: { customer_id: 'cus_9' } })));
    await h(await post(evt('refund.succeeded', { is_partial: true, customer: { customer_id: 'cus_9' } })));
    expect(calls).toEqual(['revoke:cus_9']);
  });
});

describe('checkout handler', () => {
  const make = (userFor: (t: string) => Promise<{ id: string; email?: string } | null>, reply: { ok: boolean; body: object } = { ok: true, body: { checkout_url: 'https://checkout.dodopayments.com/s/1' } }) => {
    const sent: { url: string; init: RequestInit }[] = [];
    const h = makeCheckoutHandler({
      userFor, apiKey: 'k', apiBase: 'https://test.dodopayments.com', products: { yearly: 'pdt_y', lifetime: 'pdt_l' }, returnUrl: 'https://x/app/?upgraded=1',
      fetch: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify(reply.body), { status: reply.ok ? 200 : 500 }); }) as typeof fetch,
    });
    return { h, sent };
  };
  const req = (plan: unknown, auth: string | null = 'Bearer tok') => new Request('https://x/api/checkout', { method: 'POST', body: JSON.stringify({ plan }), headers: auth ? { authorization: auth } : {} });
  it('creates a checkout for the signed-in user, tagging the purchase with their id and plan', async () => {
    const { h, sent } = make(async () => ({ id: UID, email: 'a@b.co' }));
    const res = await h(req('lifetime'));
    expect(await res.json()).toEqual({ url: 'https://checkout.dodopayments.com/s/1' });
    const body = JSON.parse(String(sent[0].init.body));
    expect(sent[0].url).toBe('https://test.dodopayments.com/checkouts');
    expect(body).toMatchObject({ product_cart: [{ product_id: 'pdt_l', quantity: 1 }], metadata: { user_id: UID, plan: 'lifetime' }, customer: { email: 'a@b.co' } });
  });
  it('401 without a valid session, 400 for an unknown plan (never reaches Dodo), 502 when Dodo fails', async () => {
    const anon = make(async () => null);
    expect((await anon.h(req('yearly'))).status).toBe(401);
    expect((await anon.h(req('yearly', null))).status).toBe(401);
    const ok = make(async () => ({ id: UID }));
    expect((await ok.h(req('free'))).status).toBe(400);
    expect(ok.sent).toHaveLength(0);
    expect((await make(async () => ({ id: UID }), { ok: false, body: { message: 'boom' } }).h(req('yearly'))).status).toBe(502);
  });
});

const NOW = Date.parse('2027-01-01T00:00:00Z');
const plan = (o: Partial<LegacyPlan> = {}): LegacyPlan => ({
  user_id: UID, enabled: true, interval_days: 90, grace_days: 14, last_checkin: new Date(NOW - 10 * DAY).toISOString(),
  trustees: [{ name: 'Ana', email: 'ana@example.com' }, { name: 'Ben', email: 'ben@example.com' }],
  message: 'Shards: Ana has #1, Ben has #2, the lawyer has #3. <b>love</b>', vault_ids: ['0123456789abcdef'],
  escrow_shard: 'ztv2.0123456789abcdef.4.3.5.aaaaaaaaaaaaaaaa.AAAA.bbbbbbbb', reminded_at: null, released_at: null, ...o,
});

describe('legacy decide', () => {
  it('none → remind at due (weekly) → release after grace; disabled/released never act', () => {
    const p = plan({ last_checkin: new Date(NOW).toISOString() });
    expect(decide(p, NOW + 89 * DAY)).toBe('none');
    expect(decide(p, NOW + 90 * DAY)).toBe('remind');
    expect(decide({ ...p, reminded_at: new Date(NOW + 90 * DAY).toISOString() }, NOW + 93 * DAY)).toBe('none');
    expect(decide({ ...p, reminded_at: new Date(NOW + 90 * DAY).toISOString() }, NOW + 97 * DAY)).toBe('remind');
    expect(decide(p, NOW + 104 * DAY)).toBe('release');
    expect(decide({ ...p, enabled: false }, NOW + 200 * DAY)).toBe('none');
    expect(decide({ ...p, released_at: new Date().toISOString() }, NOW + 200 * DAY)).toBe('none');
  });
});

describe('check-in tokens', () => {
  it('round-trip; reject tampering, wrong secret, and expiry', async () => {
    const t = await makeCheckinToken(UID, 's3cret', NOW);
    expect(await verifyCheckinToken(t, 's3cret', NOW + DAY)).toBe(UID);
    expect(await verifyCheckinToken(t.replace(UID, '00000000-0000-4000-8000-000000000000'), 's3cret', NOW)).toBeNull();
    expect(await verifyCheckinToken(t, 'other', NOW)).toBeNull();
    expect(await verifyCheckinToken(t, 's3cret', NOW + 61 * DAY)).toBeNull();
    expect(await verifyCheckinToken('garbage', 's3cret', NOW)).toBeNull();
  });
  it('check-in endpoint redirects to the app with the outcome', async () => {
    const t = await makeCheckinToken(UID, 's', NOW);
    const seen: string[] = [];
    const h = makeCheckinHandler({ secret: 's', appUrl: 'https://v.example/app/', checkin: async (u) => { seen.push(u); return true; }, now: () => NOW });
    const ok = await h(new Request(`https://v.example/api/legacy-checkin?t=${encodeURIComponent(t)}`));
    expect([ok.status, ok.headers.get('location'), seen]).toEqual([302, 'https://v.example/app/#checkin=ok', [UID]]);
    expect((await h(new Request('https://v.example/api/legacy-checkin?t=bad'))).headers.get('location')).toBe('https://v.example/app/#checkin=expired');
  });
});

describe('legacy tick', () => {
  const deps = (plans: LegacyPlan[], sendOk: (e: Email) => boolean = () => true) => {
    const sent: Email[] = [];
    const marks: [string, object][] = [];
    return {
      sent, marks,
      d: {
        now: NOW, appUrl: 'https://v.example/app/', checkinBaseUrl: 'https://v.example/api/legacy-checkin', checkinSecret: 'k',
        plans: async () => plans,
        ownerEmail: async () => 'owner@example.com',
        signedUrl: async (_u: string, id: string) => `https://storage.example/${id}?token=abc`,
        send: async (e: Email) => { sent.push(e); return sendOk(e); },
        mark: async (u: string, patch: object) => { marks.push([u, patch]); },
      },
    };
  };

  it('reminds the owner with a working check-in link', async () => {
    const { d, sent, marks } = deps([plan({ last_checkin: new Date(NOW - 91 * DAY).toISOString() })]);
    expect(await runTick(d)).toEqual({ reminded: 1, released: 0, failed: 0 });
    expect(sent[0].to).toBe('owner@example.com');
    const token = decodeURIComponent(sent[0].text.match(/\?t=(\S+)/)![1]);
    expect(await verifyCheckinToken(token, 'k', NOW)).toBe(UID);
    expect(marks).toEqual([[UID, { reminded_at: new Date(NOW).toISOString() }]]);
  });

  it('releases to every trustee with message, vault links and escrow shard, HTML-escaped', async () => {
    const { d, sent, marks } = deps([plan({ last_checkin: new Date(NOW - 120 * DAY).toISOString() })]);
    expect(await runTick(d)).toEqual({ reminded: 0, released: 1, failed: 0 });
    expect(sent.map((e) => e.to)).toEqual(['ana@example.com', 'ben@example.com', 'owner@example.com']);
    const ana = sent[0];
    expect(ana.text).toContain('Ana has #1');
    expect(ana.text).toContain('https://storage.example/0123456789abcdef?token=abc');
    expect(ana.text).toContain('ztv2.0123456789abcdef.4.3.5');
    expect(ana.html).toContain('&lt;b&gt;love&lt;/b&gt;');
    expect(ana.html).not.toContain('<b>love</b>');
    expect(marks[0][1]).toHaveProperty('released_at');
  });

  it('does not mark released if any trustee email fails (retries next run)', async () => {
    const { d, marks } = deps([plan({ last_checkin: new Date(NOW - 120 * DAY).toISOString() })], (e) => e.to !== 'ben@example.com');
    expect(await runTick(d)).toEqual({ reminded: 0, released: 0, failed: 1 });
    expect(marks).toEqual([]);
  });

  it('cron endpoint requires the bearer secret', async () => {
    const h = makeTickHandler('cron', async () => ({ ok: true }));
    expect((await h(new Request('https://x', { headers: { authorization: 'Bearer nope' } }))).status).toBe(401);
    expect((await h(new Request('https://x'))).status).toBe(401);
    expect(await (await h(new Request('https://x', { headers: { authorization: 'Bearer cron' } }))).json()).toEqual({ ok: true });
    expect((await makeTickHandler('', async () => 1)(new Request('https://x', { headers: { authorization: 'Bearer ' } }))).status).toBe(401);
  });
});

it('esc neutralises HTML', () => {
  expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  expect(releaseEmail(plan({ message: '' }), { name: '<i>', email: 'a@b.co' }, 'o@x.co', [], 'https://a', NOW).html).toContain('&lt;i&gt;');
});

it('sendEmail retries 429/5xx, gives up on 4xx, never throws', async () => {
  const email = { to: 'a@b.co', subject: 's', text: 't', html: 'h' };
  const seq = (codes: number[]) => { let i = 0; return (async () => new Response('', { status: codes[i++] ?? 500 })) as unknown as typeof fetch; };
  const noSleep = async () => {};
  expect(await sendEmail(email, 'k', 'f', seq([429, 503, 200]), noSleep)).toBe(true);
  expect(await sendEmail(email, 'k', 'f', seq([422]), noSleep)).toBe(false);
  expect(await sendEmail(email, 'k', 'f', seq([500, 500, 500, 500]), noSleep)).toBe(false);
  expect(await sendEmail(email, 'k', 'f', (async () => { throw new Error('dns'); }) as unknown as typeof fetch, noSleep)).toBe(false);
  expect(await sendEmail(email, '', 'f')).toBe(false);
});

describe('waitlist', () => {
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    new Request('https://v.example/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://v.example', ...headers }, body: new URLSearchParams(fields).toString() });
  const setup = (over: { error?: { message: string; code?: string }; recent?: number } = {}) => {
    const rows: { email: string; source: string; country: string | null }[] = [];
    const h = makeWaitlistHandler({ siteUrl: 'https://v.example', insert: async (r) => { rows.push(r); return { error: over.error ?? null }; }, recent: async () => over.recent ?? 0 });
    return { h, rows };
  };

  it('stores a normalised email with source and country, then redirects to #joined', async () => {
    const { h, rows } = setup();
    const r = await h(form({ email: '  Ana@Example.COM ', source: 'pricing' }, { 'x-vercel-ip-country': 'in' }));
    expect([r.status, r.headers.get('location')]).toEqual([303, 'https://v.example/#joined']);
    expect(rows).toEqual([{ email: 'ana@example.com', source: 'pricing', country: 'IN' }]);
  });
  it('rejects bad emails, unknown sources fall back, junk country becomes null', async () => {
    const { h, rows } = setup();
    for (const bad of ['', 'nope', 'a@b', 'a b@c.co', '<x>@y.co', 'a@b.co'.padEnd(300, 'z')]) expect((await h(form({ email: bad }))).headers.get('location')).toBe('https://v.example/#invalid');
    await h(form({ email: 'ok@example.com', source: '<script>' }, { 'x-vercel-ip-country': 'XXL' }));
    expect(rows).toEqual([{ email: 'ok@example.com', source: 'site', country: null }]);
  });
  it('honeypot: bots look successful but nothing is stored', async () => {
    const { h, rows } = setup();
    expect((await h(form({ email: 'bot@example.com', website: 'http://spam' }))).headers.get('location')).toBe('https://v.example/#joined');
    expect(rows).toEqual([]);
  });
  it('a duplicate signup looks identical (no email enumeration); real DB errors surface', async () => {
    expect((await setup({ error: { message: 'dup', code: '23505' } }).h(form({ email: 'a@example.com' }))).headers.get('location')).toBe('https://v.example/#joined');
    expect((await setup({ error: { message: 'down' } }).h(form({ email: 'a@example.com' }))).status).toBe(500);
  });
  it('blocks other origins, wrong methods, and floods', async () => {
    const { h, rows } = setup({ recent: 300 });
    expect((await h(form({ email: 'a@example.com' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await h(new Request('https://v.example/api/waitlist'))).status).toBe(405);
    // Real browsers: our no-referrer policy makes the form post carry "Origin: null" (this was a live 403).
    const real = setup();
    expect((await real.h(form({ email: 'a@example.com' }, { origin: 'null', 'sec-fetch-site': 'same-origin' }))).status).toBe(303);
    expect((await real.h(form({ email: 'a@example.com' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await real.h(form({ email: 'a@example.com' }, { origin: 'null' }))).status).toBe(303);
    const flood = await h(form({ email: 'a@example.com' }));
    expect([flood.status, flood.headers.get('retry-after'), rows.length]).toEqual([429, '3600', 0]);
  });
});

describe('delete account', () => {
  const make = (over: { user?: { id: string; email?: string } | null; sub?: boolean; failAt?: string } = {}) => {
    const log: string[] = [];
    const step = (name: string) => async (...a: string[]) => { log.push(`${name}:${a[0]}`); if (over.failAt === name) throw new Error('boom'); };
    const h = makeDeleteAccountHandler({
      userFor: async () => (over.user === undefined ? { id: UID, email: 'Ana@Example.com' } : over.user),
      hasActiveSubscription: async () => over.sub ?? false,
      removeVaults: step('vaults'), removeWaitlist: step('waitlist'), deleteUser: step('user'),
    });
    return { h, log };
  };
  const req = (auth: string | null = 'Bearer t', method = 'POST') => new Request('https://x/api/delete-account', { method, headers: auth ? { authorization: auth } : {} });

  it('deletes vaults, then the waitlist row (lower-cased), then the account', async () => {
    const { h, log } = make();
    expect((await h(req())).status).toBe(200);
    expect(log).toEqual([`vaults:${UID}`, 'waitlist:ana@example.com', `user:${UID}`]);
  });
  it('401 without a valid session and 405 for GET: nothing is touched', async () => {
    const anon = make({ user: null });
    expect((await anon.h(req())).status).toBe(401);
    expect((await anon.h(req(null))).status).toBe(401);
    expect((await anon.h(req('Bearer t', 'GET'))).status).toBe(405);
    expect(anon.log).toEqual([]);
  });
  it('refuses while a subscription is still billing, and deletes nothing', async () => {
    const { h, log } = make({ sub: true });
    const res = await h(req());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Cancel it first/);
    expect(log).toEqual([]);
  });
  it('a failure part-way returns 500 and never deletes the account itself (so a retry can finish)', async () => {
    const { h, log } = make({ failAt: 'vaults' });
    expect((await h(req())).status).toBe(500);
    expect(log.some((l) => l.startsWith('user:'))).toBe(false);
  });
});
