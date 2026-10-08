#!/usr/bin/env node
// One-command Stripe setup. Idempotent: run it again any time and it only creates what's missing or changed.
//
//   stripe login                                   (once; opens your browser)
//   node ops/stripe-setup.mjs --site https://your-domain.com [--vercel] [--tax]        TEST mode (safe, no real money)
//   node ops/stripe-setup.mjs --site https://your-domain.com --live --vercel           LIVE mode (after Stripe activates your account)
//
// Creates: the Pro (yearly) and Lifetime products with prices in every currency from site/pricing.json,
// a Payment Link for each, a customer billing portal, and the webhook endpoint the app listens on.
// Uses the Stripe CLI for auth, so this script never sees or stores your Stripe keys.
//
// --vercel   writes what the app needs into Vercel's production environment (secrets via stdin, never printed).
//            TEST mode only sets the webhook secret and STRIPE_ACCEPT_TEST=1, so the public site keeps showing
//            the waitlist. LIVE mode also sets the public checkout links, which turns on real buying.
// --tax      turn on Stripe Tax on the links and mark prices tax-inclusive/exclusive by region (needs Stripe Tax set up).
// --rotate-webhook   delete and recreate the webhook endpoint to get a fresh signing secret.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const LIVE = has('--live');
const TAX = has('--tax');
const VERCEL = has('--vercel');
const SITE = (val('--site') ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(SITE)) {
  console.error('Pass your public address: --site https://your-domain.com (https, no path)');
  process.exit(2);
}
const mode = LIVE ? 'LIVE' : 'TEST';

const pricing = JSON.parse(readFileSync(process.env.ZTV_PRICING ?? new URL('../site/pricing.json', import.meta.url), 'utf8')); // env override is for tests
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP']);
const TAX_INCLUSIVE = new Set(['EUR', 'GBP', 'CHF', 'AUD', 'JPY', 'INR']); // consumer prices include VAT/GST here; US/CA add tax on top
const minor = (cur, n) => (ZERO_DECIMAL.has(cur) ? n : n * 100);

class StripeError extends Error {
  constructor(message, param) { super(message); this.param = param; }
}

/** Calls the Stripe CLI and returns parsed JSON. Params go as -d key=value (Stripe's bracket notation). */
function stripe(resource, op, params = {}, extra = []) {
  const args = [...resource.split(' '), op, ...extra, ...Object.entries(params).flatMap(([k, v]) => ['-d', `${k}=${v}`]), ...(LIVE ? ['--live'] : [])];
  try {
    return JSON.parse(execFileSync('stripe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    let err = {};
    try { err = JSON.parse(text.slice(text.indexOf('{'))).error ?? {}; } catch { /* not JSON */ }
    if (e.code === 'ENOENT') throw new StripeError('The Stripe CLI is not installed (brew install stripe/stripe-cli/stripe).');
    throw new StripeError(err.message ?? text.trim().slice(0, 300) ?? 'Stripe CLI failed', err.param);
  }
}
const list = (resource, params = {}) => stripe(resource, 'list', { limit: 100, ...params }).data;

const log = (s) => console.log(s);
const results = { mode, site: SITE, dropped: [], created: [], reused: [] };
const note = (kind, what) => { results[kind].push(what); log(`  ${kind === 'created' ? '+' : '·'} ${what}`); };

// ---------------------------------------------------------------- products & prices
function ensureProduct(key, name, description) {
  const found = list('products', { active: 'true' }).find((p) => p.metadata?.ztv === key);
  if (found) { note('reused', `product ${name}`); return found; }
  const p = stripe('products', 'create', { name, description, 'metadata[ztv]': key });
  note('created', `product ${name}`);
  return p;
}

function wantedAmounts(plan) {
  return Object.fromEntries(Object.entries(pricing.currencies).map(([cur, c]) => [cur.toLowerCase(), minor(cur, c[plan])]));
}

function ensurePrice(product, plan, interval) {
  const lookup = `ztv_${plan}`;
  const base = pricing.default.toLowerCase();
  let wanted = wantedAmounts(plan);
  const same = (price) => {
    const have = { [price.currency]: price.unit_amount, ...Object.fromEntries(Object.entries(price.currency_options ?? {}).map(([c, o]) => [c, o.unit_amount])) };
    return Object.entries(wanted).every(([c, n]) => have[c] === n);
  };
  const existing = list('prices', { 'lookup_keys[0]': lookup, active: 'true', 'expand[0]': 'data.currency_options' })[0];
  if (existing && same(existing)) { note('reused', `price ${lookup}`); return { price: existing, currencies: Object.keys(wanted) }; }

  for (;;) { // create; if Stripe rejects a currency for this account, drop it and say so loudly
    const params = {
      product: product.id, currency: base, unit_amount: wanted[base], lookup_key: lookup, transfer_lookup_key: 'true',
      'metadata[ztv]': plan, ...(interval ? { 'recurring[interval]': interval } : {}),
    };
    if (TAX) params.tax_behavior = TAX_INCLUSIVE.has(base.toUpperCase()) ? 'inclusive' : 'exclusive';
    for (const [c, n] of Object.entries(wanted)) {
      if (c === base) continue;
      params[`currency_options[${c}][unit_amount]`] = n;
      if (TAX) params[`currency_options[${c}][tax_behavior]`] = TAX_INCLUSIVE.has(c.toUpperCase()) ? 'inclusive' : 'exclusive';
    }
    try {
      const price = stripe('prices', 'create', params);
      note('created', `price ${lookup} (${Object.keys(wanted).map((c) => c.toUpperCase()).join(', ')})`);
      return { price, currencies: Object.keys(wanted) };
    } catch (e) {
      const bad = /currency_options\[(\w+)\]/.exec(e.param ?? '')?.[1] ?? /\b([a-z]{3})\b(?=.*not (?:supported|valid))/i.exec(e.message)?.[1]?.toLowerCase();
      if (!bad || !(bad in wanted) || bad === base) throw e;
      delete wanted[bad];
      if (!results.dropped.includes(bad.toUpperCase())) results.dropped.push(bad.toUpperCase()); // both prices may reject the same one
      log(`  ! Stripe would not accept ${bad.toUpperCase()} for ${lookup}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- payment links
function ensureLink(key, price, { subscription }) {
  const redirect = `${SITE}/app/#upgraded`;
  const found = list('payment_links', { active: 'true' }).find((l) => l.metadata?.ztv === key);
  if (found && found.metadata.ztv_price === price.id && found.after_completion?.redirect?.url === redirect) {
    note('reused', `payment link ${key}`);
    return found;
  }
  const params = {
    'line_items[0][price]': price.id, 'line_items[0][quantity]': 1,
    'after_completion[type]': 'redirect', 'after_completion[redirect][url]': redirect,
    allow_promotion_codes: 'true', billing_address_collection: 'auto',
    'automatic_tax[enabled]': String(TAX),
    'metadata[ztv]': key, 'metadata[ztv_price]': price.id,
  };
  if (subscription) {
    params['subscription_data[metadata][ztv]'] = key;
    params['subscription_data[description]'] = 'Zero-Trust Vault Pro (yearly)';
  } else {
    // One-time payments only create a Stripe customer if asked to. Refund handling and receipts rely on it.
    params.customer_creation = 'always';
    params['invoice_creation[enabled]'] = 'true';
    params['payment_intent_data[metadata][ztv]'] = key;
    params['payment_intent_data[description]'] = 'Zero-Trust Vault Lifetime';
  }
  const link = stripe('payment_links', 'create', params);
  note('created', `payment link ${key}`);
  if (found) { stripe('payment_links', 'update', { active: 'false' }, [found.id]); log(`    (old ${key} link deactivated)`); }
  return link;
}

// ---------------------------------------------------------------- billing portal
function ensurePortal() {
  const found = list('billing_portal configurations', { active: 'true' }).find((c) => c.metadata?.ztv === 'portal');
  if (found?.login_page?.url) { note('reused', 'billing portal'); return found.login_page.url; }
  const c = stripe('billing_portal configurations', 'create', {
    'metadata[ztv]': 'portal', 'business_profile[headline]': 'Manage your Zero-Trust Vault Pro plan',
    'business_profile[privacy_policy_url]': `${SITE}/privacy`, 'business_profile[terms_of_service_url]': `${SITE}/terms`,
    default_return_url: `${SITE}/app/#settings`,
    'features[invoice_history][enabled]': 'true', 'features[payment_method_update][enabled]': 'true',
    'features[customer_update][enabled]': 'true', 'features[customer_update][allowed_updates][0]': 'email', 'features[customer_update][allowed_updates][1]': 'name',
    'features[subscription_cancel][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end',
    'login_page[enabled]': 'true',
  });
  note('created', 'billing portal');
  return c.login_page.url;
}

// ---------------------------------------------------------------- webhook
const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'];
function ensureWebhook() {
  const url = `${SITE}/api/stripe-webhook`;
  const events = Object.fromEntries(EVENTS.map((e, i) => [`enabled_events[${i}]`, e]));
  let found = list('webhook_endpoints').find((w) => w.url === url);
  if (found && has('--rotate-webhook')) { stripe('webhook_endpoints', 'delete', {}, [found.id]); log('  (old webhook endpoint deleted)'); found = undefined; }
  if (found) {
    const same = EVENTS.length === found.enabled_events.length && EVENTS.every((e) => found.enabled_events.includes(e));
    if (!same) { stripe('webhook_endpoints', 'update', events, [found.id]); log('  ~ webhook events updated'); }
    note('reused', `webhook ${url} (its signing secret can't be shown again; use --rotate-webhook for a new one)`);
    return { secret: null };
  }
  const w = stripe('webhook_endpoints', 'create', { url, description: 'Zero-Trust Vault billing', ...events });
  note('created', `webhook ${url}`);
  return { secret: w.secret };
}

// ---------------------------------------------------------------- Vercel
function vercelSet(name, value, sensitive) {
  execFileSync('npx', ['--yes', 'vercel', 'env', 'add', name, 'production', sensitive ? '--sensitive' : '--type=config', '--yes', '--force'],
    { input: value, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
}
function vercelRemove(name) {
  try { execFileSync('npx', ['--yes', 'vercel', 'env', 'rm', name, 'production', '--yes'], { stdio: 'ignore' }); } catch { /* wasn't set */ }
}

// ---------------------------------------------------------------- run
log(`\nStripe setup, ${mode} mode, ${SITE}\n`);
if (LIVE) log('  LIVE mode: this creates real products and a real webhook on your live account.\n');
try {
  const pro = ensurePrice(ensureProduct('pro', 'Zero-Trust Vault Pro', 'Unlimited cloud vaults and Legacy (dead man\'s switch).'), 'yearly', 'year');
  const life = ensurePrice(ensureProduct('lifetime', 'Zero-Trust Vault Lifetime', 'Pro, forever. One payment.'), 'lifetime', null);
  const proLink = ensureLink('pro_yearly', pro.price, { subscription: true });
  const lifeLink = ensureLink('lifetime', life.price, { subscription: false });
  const portal = ensurePortal();
  const hook = ensureWebhook();

  results.links = { yearly: proLink.url, lifetime: lifeLink.url, portal };
  if (VERCEL) {
    if (hook.secret) { vercelSet('STRIPE_WEBHOOK_SECRET', hook.secret, true); log('  → STRIPE_WEBHOOK_SECRET saved to Vercel (not printed)'); }
    if (LIVE) {
      vercelRemove('STRIPE_ACCEPT_TEST');
      vercelSet('VITE_CHECKOUT_URL_YEARLY', proLink.url, false);
      vercelSet('VITE_CHECKOUT_URL_LIFETIME', lifeLink.url, false);
      vercelSet('VITE_BILLING_PORTAL_URL', portal, false);
      log('  → live checkout links saved to Vercel, test-mode acceptance removed. Redeploy to switch the site from waitlist to real buying.');
    } else {
      vercelSet('STRIPE_ACCEPT_TEST', '1', false);
      log('  → test-mode webhook accepted by the app. The public site still shows the waitlist (checkout links NOT published).');
    }
  } else if (hook.secret) {
    appendFileSync('.env.local', `\nSTRIPE_WEBHOOK_SECRET=${hook.secret}\n`);
    log('  → webhook signing secret written to .env.local (git-ignored). Re-run with --vercel to put it in production.');
  }
  if (results.dropped.length) {
    log(`\n  ACTION NEEDED: Stripe rejected ${results.dropped.join(', ')}. Remove ${results.dropped.length > 1 ? 'those currencies' : 'that currency'} from site/pricing.json (and vercel.json via \`npm test\`), or the site will show a price Stripe can't charge.`);
  }
  log(`\n${JSON.stringify({ ...results }, null, 2)}`);
} catch (e) {
  console.error(`\nStripe setup failed: ${e.message}${e.param ? ` (param: ${e.param})` : ''}`);
  if (/api[ _]key|authenticat|login/i.test(e.message)) console.error('Run `stripe login` first.');
  process.exit(1);
}
