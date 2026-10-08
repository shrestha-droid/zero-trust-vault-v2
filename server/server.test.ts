import { describe, expect, it } from 'vitest';
import { makeWaitlistHandler } from './waitlist.js';
import { entitlementFrom, hmacHex, makeBillingHandler, refundedCustomer, verifyStripe, type EntitlementRow } from './billing.js';
import {
  DAY, decide, esc, sendEmail, makeCheckinHandler, makeCheckinToken, makeTickHandler, releaseEmail, runTick, verifyCheckinToken,
  type Email, type LegacyPlan,
} from './legacy.js';

const SECRET = 'whsec_test';
const UID = '3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';
const signed = async (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
const post = (body: string, sig: string | null) => new Request('https://x/api/stripe-webhook', { method: 'POST', body, headers: sig ? { 'stripe-signature': sig } : {} });

describe('stripe signature', () => {
  it('accepts a valid signature, rejects tampering, wrong secret, and replays', async () => {
    const body = '{"a":1}';
    expect(await verifyStripe(body, await signed(body), SECRET)).toBe(true);
    expect(await verifyStripe('{"a":2}', await signed(body), SECRET)).toBe(false);
    expect(await verifyStripe(body, await signed(body, undefined, 'other'), SECRET)).toBe(false);
    expect(await verifyStripe(body, await signed(body, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    expect(await verifyStripe(body, null, SECRET)).toBe(false);
    expect(await verifyStripe(body, await signed(body), '')).toBe(false);
  });

  it('accepts any of several v1 signatures (secret rotation)', async () => {
    const body = '{}';
    const t = Math.floor(Date.now() / 1000);
    expect(await verifyStripe(body, `t=${t},v1=deadbeef,v1=${await hmacHex(SECRET, `${t}.${body}`)}`, SECRET)).toBe(true);
  });
});

describe('entitlementFrom', () => {
  const ev = (type: string, object: object) => ({ type, data: { object } });
  it('checkout → pro (subscription) or lifetime (one-time payment)', () => {
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'subscription', client_reference_id: UID, customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' })))
      .toMatchObject({ user_id: UID, plan: 'pro', status: 'active', stripe_subscription: 'sub_1' });
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'payment', client_reference_id: UID, customer: 'cus_1', payment_status: 'paid' })))
      .toMatchObject({ plan: 'pro', status: 'lifetime' });
  });
  it('a Lifetime payment with NO Stripe customer still grants Pro (Stripe omits the customer on one-time payments)', () => {
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'payment', client_reference_id: UID, customer: null, payment_status: 'paid' })))
      .toMatchObject({ user_id: UID, plan: 'pro', status: 'lifetime', stripe_customer: null });
    // …but a subscription with no customer is malformed and must not grant anything
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'subscription', client_reference_id: UID, customer: null, payment_status: 'paid' }))).toBeNull();
  });
  it('ignores unpaid checkouts and missing/forged user ids', () => {
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'payment', client_reference_id: UID, customer: 'c', payment_status: 'unpaid' }))).toBeNull();
    expect(entitlementFrom(ev('checkout.session.completed', { mode: 'payment', client_reference_id: "x' or 1=1", customer: 'c' }))).toBeNull();
    expect(entitlementFrom(ev('invoice.paid', {}))).toBeNull();
  });
  it('subscription lifecycle maps status and period end (old and new API shapes)', () => {
    const end = 1_900_000_000;
    expect(entitlementFrom(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: end })))
      .toMatchObject({ plan: 'pro', status: 'active', current_period_end: new Date(end * 1000).toISOString() });
    expect(entitlementFrom(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'past_due', items: { data: [{ current_period_end: end }] } })))
      .toMatchObject({ plan: 'pro', current_period_end: new Date(end * 1000).toISOString() });
    expect(entitlementFrom(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'unpaid' }))).toMatchObject({ plan: 'free' });
    expect(entitlementFrom(ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', status: 'active' }))).toMatchObject({ plan: 'free', status: 'canceled' });
  });
});

describe('billing handler', () => {
  const setup = (error: { message: string } | null = null) => {
    const calls: [string, EntitlementRow][] = [];
    const h = makeBillingHandler({
      secret: SECRET,
      upsertByUser: async (r) => { calls.push(['user', r]); return { error }; },
      updateByCustomer: async (r) => { calls.push(['customer', r]); return { error }; },
    });
    return { h, calls };
  };
  it('routes checkout to upsert-by-user and lifecycle to update-by-customer', async () => {
    const { h, calls } = setup();
    const a = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: UID, customer: 'cus_1', payment_status: 'paid' } } });
    const b = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 's', customer: 'cus_1', status: 'canceled' } } });
    expect((await h(post(a, await signed(a)))).status).toBe(200);
    expect((await h(post(b, await signed(b)))).status).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(['user', 'customer']);
  });
  it('400 on bad signature, 405 on GET, 500 on DB error (so Stripe retries), 200 on ignored events', async () => {
    const { h } = setup({ message: 'db down' });
    const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 's', customer: 'c', status: 'active' } } });
    expect((await h(post(body, 't=1,v1=00'))).status).toBe(400);
    expect((await h(new Request('https://x', { method: 'GET' }))).status).toBe(405);
    expect((await h(post(body, await signed(body)))).status).toBe(500);
    const ignored = '{"type":"invoice.paid","data":{"object":{}}}';
    expect(await (await setup().h(post(ignored, await signed(ignored)))).text()).toBe('ignored');
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
    const flood = await h(form({ email: 'a@example.com' }));
    expect([flood.status, flood.headers.get('retry-after'), rows.length]).toEqual([429, '3600', 0]);
  });
});

describe('billing safety rails', () => {
  const evt = (type: string, object: object, livemode = true) => JSON.stringify({ type, livemode, data: { object } });
  const post2 = async (h: (r: Request) => Promise<Response>, body: string) => h(new Request('https://x/api/stripe-webhook', { method: 'POST', body, headers: { 'stripe-signature': await signed(body) } }));
  const setup2 = (over: { acceptTest?: boolean; status?: string | null } = {}) => {
    const calls: string[] = [];
    const h = makeBillingHandler({
      secret: SECRET, acceptTest: over.acceptTest,
      currentStatus: async () => over.status ?? null,
      upsertByUser: async (r) => { calls.push(`upsert:${r.status}`); return { error: null }; },
      updateByCustomer: async (r) => { calls.push(`update:${r.status}`); return { error: null }; },
      revokeByCustomer: async (c) => { calls.push(`revoke:${c}`); return { error: null }; },
    });
    return { h, calls };
  };
  const checkout = (mode: string, livemode = true) => evt('checkout.session.completed', { mode, client_reference_id: UID, customer: mode === 'payment' ? null : 'cus_1', payment_status: 'paid' }, livemode);

  it('test-mode events are ignored unless explicitly accepted (a leftover test link can never grant real Pro)', async () => {
    const live = setup2();
    expect(await (await post2(live.h, checkout('payment', false))).text()).toBe('ignored: test-mode event');
    expect(live.calls).toEqual([]);
    const test = setup2({ acceptTest: true });
    await post2(test.h, checkout('payment', false));
    expect(test.calls).toEqual(['upsert:lifetime']);
  });
  it('a later Pro purchase can never downgrade an existing Lifetime plan', async () => {
    const { h, calls } = setup2({ status: 'lifetime' });
    expect(await (await post2(h, checkout('subscription'))).text()).toBe('ignored: already lifetime');
    await post2(h, checkout('payment'));
    expect(calls).toEqual(['upsert:lifetime']); // re-buying Lifetime is still recorded
  });
  it('a full refund revokes paid access; a partial refund does not', async () => {
    expect(refundedCustomer({ type: 'charge.refunded', data: { object: { refunded: true, customer: 'cus_9' } } })).toBe('cus_9');
    expect(refundedCustomer({ type: 'charge.refunded', data: { object: { refunded: false, customer: 'cus_9' } } })).toBeNull();
    expect(refundedCustomer({ type: 'charge.refunded', data: { object: { refunded: true, customer: null } } })).toBeNull();
    const { h, calls } = setup2();
    await post2(h, evt('charge.refunded', { refunded: true, customer: 'cus_9' }));
    await post2(h, evt('charge.refunded', { refunded: false, customer: 'cus_9' }));
    expect(calls).toEqual(['revoke:cus_9']);
  });
});
