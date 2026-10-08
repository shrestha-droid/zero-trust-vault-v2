// Runs ops/stripe-setup.mjs against a fake in-memory Stripe CLI (and a fake `npx vercel`), so the real
// account is never touched. Covers: first run, safe re-runs, price changes, rejected currencies, live mode, secret hygiene.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each fake CLI call is a real process, so a full run takes a few seconds.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT = join(process.cwd(), 'ops/stripe-setup.mjs');
const REAL_PRICING = join(process.cwd(), 'site/pricing.json');

const FAKE_STRIPE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [db, logf] = [process.env.FAKE_DB, process.env.FAKE_LOG];
const args = process.argv.slice(2);
const OPS = ['list', 'create', 'update', 'delete'];
const opAt = args.findIndex((a) => OPS.includes(a));
const resource = args.slice(0, opAt).join(' '), op = args[opAt];
const rest = args.slice(opAt + 1);
const live = rest.includes('--live');
const ids = [], flat = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '-d') { const [k, ...v] = rest[++i].split('='); flat[k] = v.join('='); }
  else if (rest[i] !== '--live') ids.push(rest[i]);
}
appendFileSync(logf, JSON.stringify({ resource, op, live, flat }) + '\\n');
const unflatten = (f) => { const out = {}; for (const [k, v] of Object.entries(f)) {
  const path = k.replace(/\\]/g, '').split('['); let o = out;
  path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else o = o[p] ??= {}; }); } return out; };
const state = existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) : { n: 0, products: [], prices: [], payment_links: [], 'billing_portal configurations': [], webhook_endpoints: [] };
const save = () => writeFileSync(db, JSON.stringify(state));
const out = (o) => { save(); console.log(JSON.stringify(o)); };
const fail = (message, param) => { console.error(JSON.stringify({ error: { message, param } })); process.exit(1); };
const store = state[resource];
if (!store) fail('unknown resource ' + resource);
const nest = unflatten(flat);
const arr = (o) => (o && typeof o === 'object' ? Object.values(o) : o);
if (op === 'list') {
  let data = store.filter((x) => flat.active !== 'true' || x.active !== false);
  if (flat['lookup_keys[0]']) data = data.filter((x) => x.lookup_key === flat['lookup_keys[0]']);
  out({ object: 'list', data: data.map(({ secret, ...x }) => x), has_more: false });
} else if (op === 'create') {
  const id = resource.split(' ')[0].replace(/s$/, '').slice(0, 5) + '_' + ++state.n;
  const obj = { id, active: true, ...nest };
  if (resource === 'prices') {
    const reject = process.env.FAKE_REJECT;
    if (reject && flat['currency_options[' + reject + '][unit_amount]']) fail('Invalid currency: ' + reject + ' is not supported for this account', 'currency_options[' + reject + '][unit_amount]');
    obj.unit_amount = +flat.unit_amount;
    for (const o of Object.values(obj.currency_options ?? {})) o.unit_amount = +o.unit_amount;
    if (flat.transfer_lookup_key === 'true') for (const p of store) if (p.lookup_key === flat.lookup_key) p.lookup_key = null;
  }
  if (resource === 'payment_links') obj.url = 'https://buy.stripe.com/test_' + id;
  if (resource === 'billing_portal configurations') obj.login_page = { enabled: true, url: 'https://billing.stripe.com/p/login/test_' + id };
  if (resource === 'webhook_endpoints') { obj.enabled_events = arr(nest.enabled_events); obj.secret = 'whsec_FAKESECRET' + id; }
  store.push(obj); out(obj);
} else if (op === 'update') {
  const o = store.find((x) => x.id === ids[0]); if (!o) fail('no such ' + ids[0]);
  if (nest.active) o.active = nest.active === 'true';
  if (nest.enabled_events) o.enabled_events = arr(nest.enabled_events);
  out(o);
} else if (op === 'delete') {
  state[resource] = store.filter((x) => x.id !== ids[0]); out({ id: ids[0], deleted: true });
}
`;

const FAKE_NPX = `
import { appendFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2); // --yes vercel env add|rm NAME production ...
const [, , sub, name] = a.slice(1);
const input = sub === 'add' ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.FAKE_VERCEL, JSON.stringify({ sub, name, sensitive: a.includes('--sensitive'), value: input }) + '\\n');
`;

let dir: string, env: Record<string, string>;
const run = (args: string[], extra: Record<string, string> = {}, pathOverride?: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, ...extra, ...(pathOverride ? { PATH: pathOverride } : {}) } });
const jsonOf = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf('\n{') + 1));
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ztv-stripe-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  for (const [name, code] of [['stripe', FAKE_STRIPE], ['npx', FAKE_NPX]]) {
    writeFileSync(join(bin, `${name}.mjs`), code);
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, name)}.mjs" "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: join(dir, 'db.json'), FAKE_LOG: join(dir, 'stripe.log'), FAKE_VERCEL: join(dir, 'vercel.log'), ZTV_PRICING: REAL_PRICING };
});

describe('stripe-setup', () => {
  it('first run (test mode) builds everything in the right currencies and keeps secrets out of the output', () => {
    const r = run(['--site', 'https://v.example', '--vercel']);
    expect(r.status).toBe(0);
    const out = jsonOf(r.stdout);
    expect(out.created).toHaveLength(8); // 2 products, 2 prices, 2 links, portal, webhook
    const db = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    const yearly = db.prices.find((p: { lookup_key: string }) => p.lookup_key === 'ztv_yearly');
    expect(yearly).toMatchObject({ currency: 'usd', unit_amount: 6000, recurring: { interval: 'year' } });
    expect(yearly.currency_options.eur.unit_amount).toBe(5900);
    expect(yearly.currency_options.jpy.unit_amount).toBe(8900); // zero-decimal currency: NOT multiplied by 100
    expect(yearly.currency_options.inr.unit_amount).toBe(499_900); // paise
    expect(db.prices.find((p: { lookup_key: string }) => p.lookup_key === 'ztv_lifetime').recurring).toBeUndefined();
    expect(out.links.yearly).toMatch(/^https:\/\/buy\.stripe\.com\/test_/);
    expect(db.webhook_endpoints[0]).toMatchObject({ url: 'https://v.example/api/stripe-webhook' });
    expect(db.webhook_endpoints[0].enabled_events).toContain('charge.refunded');
    // secret hygiene: saved to Vercel as sensitive, never printed
    expect(r.stdout + r.stderr).not.toContain('whsec_');
    const v = lines(env.FAKE_VERCEL);
    expect(v.find((x) => x.name === 'STRIPE_WEBHOOK_SECRET')).toMatchObject({ sensitive: true, value: expect.stringContaining('whsec_') });
    // TEST mode must NOT publish checkout links: the public site keeps showing the waitlist
    expect(v.map((x) => x.name)).toEqual(['STRIPE_WEBHOOK_SECRET', 'STRIPE_ACCEPT_TEST']);
    expect(lines(env.FAKE_LOG).every((c) => !c.live)).toBe(true);
  });

  it('link settings: Lifetime creates a customer (refunds/receipts depend on it), subscription link does not', () => {
    run(['--site', 'https://v.example']);
    const db = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    const [yearly, lifetime] = ['pro_yearly', 'lifetime'].map((k) => db.payment_links.find((l: { metadata: { ztv: string } }) => l.metadata.ztv === k));
    expect(lifetime.customer_creation).toBe('always');
    expect(yearly.customer_creation).toBeUndefined();
    expect(yearly.after_completion.redirect.url).toBe('https://v.example/app/#upgraded');
    expect(yearly.automatic_tax.enabled).toBe('false');
  });

  it('is idempotent: a second run creates nothing and never rewrites the webhook secret', () => {
    run(['--site', 'https://v.example', '--vercel']);
    const before = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    const second = jsonOf(run(['--site', 'https://v.example', '--vercel']).stdout);
    expect(second.created).toEqual([]);
    expect(second.reused.length).toBeGreaterThanOrEqual(7);
    const after = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    for (const k of ['products', 'prices', 'payment_links', 'webhook_endpoints']) expect(after[k]).toHaveLength(before[k].length);
    expect(lines(env.FAKE_VERCEL).filter((x) => x.name === 'STRIPE_WEBHOOK_SECRET')).toHaveLength(1);
  });

  it('a price change makes a new price + new link and deactivates the old link', () => {
    run(['--site', 'https://v.example']);
    const changed = JSON.parse(readFileSync(REAL_PRICING, 'utf8'));
    changed.currencies.USD.yearly = 72;
    const alt = join(dir, 'pricing.json');
    writeFileSync(alt, JSON.stringify(changed));
    const out = jsonOf(run(['--site', 'https://v.example'], { ZTV_PRICING: alt }).stdout);
    expect(out.created.some((c: string) => c.startsWith('price ztv_yearly'))).toBe(true);
    expect(out.created.some((c: string) => c.includes('payment link pro_yearly'))).toBe(true);
    const db = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    const links = db.payment_links.filter((l: { metadata: { ztv: string } }) => l.metadata.ztv === 'pro_yearly');
    expect(links.map((l: { active: boolean }) => l.active)).toEqual([false, true]);
    expect(db.prices.filter((p: { lookup_key: string }) => p.lookup_key === 'ztv_yearly')).toHaveLength(1); // key moved to the new price
  });

  it('drops a currency Stripe refuses, still succeeds, and says exactly what to fix', () => {
    const r = run(['--site', 'https://v.example'], { FAKE_REJECT: 'inr' });
    expect(r.status).toBe(0);
    expect(jsonOf(r.stdout).dropped).toEqual(['INR']);
    expect(r.stdout).toContain('ACTION NEEDED');
    const db = JSON.parse(readFileSync(env.FAKE_DB, 'utf8'));
    expect(db.prices.every((p: { currency_options: Record<string, unknown> }) => !('inr' in p.currency_options))).toBe(true);
    expect(db.prices[0].currency_options.eur).toBeDefined();
  });

  it('live mode: uses --live everywhere, publishes checkout links, removes test-mode acceptance', () => {
    const r = run(['--site', 'https://v.example', '--live', '--vercel']);
    expect(r.status).toBe(0);
    expect(lines(env.FAKE_LOG).every((c) => c.live)).toBe(true);
    const v = lines(env.FAKE_VERCEL);
    expect(v.filter((x) => x.sub === 'add').map((x) => x.name)).toEqual(['STRIPE_WEBHOOK_SECRET', 'VITE_CHECKOUT_URL_YEARLY', 'VITE_CHECKOUT_URL_LIFETIME', 'VITE_BILLING_PORTAL_URL']);
    expect(v.find((x) => x.sub === 'rm')).toMatchObject({ name: 'STRIPE_ACCEPT_TEST' });
    expect(v.find((x) => x.name === 'VITE_CHECKOUT_URL_YEARLY')).toMatchObject({ sensitive: false });
    expect(r.stdout).not.toContain('whsec_');
  });

  it('refuses a bad --site and explains a missing Stripe CLI', () => {
    expect(run(['--site', 'http://v.example']).status).toBe(2);
    expect(run([]).status).toBe(2);
    const missing = run(['--site', 'https://v.example'], {}, '/usr/bin:/bin'); // no fake stripe on PATH
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Stripe CLI is not installed/);
  });
});
