// Dodo Payments (merchant of record) → entitlements. Web-standard APIs only; wired up in api/billing-webhook.ts.
// Dodo signs webhooks with the Standard Webhooks spec (https://www.standardwebhooks.com).
//
// Dodo's docs don't publish full payload schemas, so every field read below is deliberately tolerant
// (`pick`/`str`), and anything unrecognised is ignored rather than guessed. Confirm against a real
// test-mode event (LAUNCH.md §2) before going live.

export interface EntitlementRow {
  user_id?: string;
  /** Dodo customer id (cus_…). Null if the event didn't carry one. */
  customer_ref: string | null;
  subscription_ref: string | null;
  plan: 'free' | 'pro';
  status: string;
  current_period_end: string | null;
}

type Obj = Record<string, any>;
export interface DodoEvent { type: string; data: Obj }

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Standard Webhooks: HMAC-SHA256 of `${id}.${timestamp}.${body}`, key = base64 of the secret after `whsec_`. */
export async function signStandard(secret: string, id: string, ts: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', unb64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${raw}`)));
}

/** Headers webhook-id, webhook-timestamp, webhook-signature ("v1,<sig> v1,<sig2>"), with a replay window. */
export async function verifyDodo(raw: string, h: Headers, secret: string, nowSec = Date.now() / 1000, toleranceSec = 300): Promise<boolean> {
  const id = h.get('webhook-id'), ts = h.get('webhook-timestamp'), header = h.get('webhook-signature');
  if (!id || !ts || !header || !secret || !Number.isFinite(+ts) || Math.abs(nowSec - +ts) > toleranceSec) return false;
  let mac: string;
  try { mac = await signStandard(secret, id, ts, raw); } catch { return false; } // secret isn't valid base64
  return header.split(' ').some((p) => p.startsWith('v1,') && safeEqual(p.slice(3), mac));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const when = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const customerOf = (d: Obj) => str(d.customer?.customer_id) ?? str(d.customer_id);
const userOf = (d: Obj) => (UUID.test(d.metadata?.user_id ?? '') ? (d.metadata.user_id as string) : undefined);

export interface Products { lifetime?: string }

/** Map a Dodo event to the entitlement fields it implies, or null if irrelevant. */
export function entitlementFrom(event: DodoEvent, products: Products = {}): EntitlementRow | null {
  const d = event.data ?? {};
  const t = event.type;
  if (t.startsWith('subscription.')) {
    const customer = customerOf(d);
    const user_id = userOf(d);
    if (!customer && !user_id) return null;
    const base = { user_id, customer_ref: customer, subscription_ref: str(d.subscription_id), current_period_end: when(d.next_billing_date) };
    // active/renewed/plan_changed/updated: paid up. past_due keeps access through Dodo's grace window (is_pro adds 3 days).
    if (['subscription.active', 'subscription.renewed', 'subscription.plan_changed'].includes(t)) return { ...base, plan: 'pro', status: 'active' };
    if (t === 'subscription.past_due') return { ...base, plan: 'pro', status: 'past_due' };
    if (t === 'subscription.updated') {
      const s = String(d.status ?? '');
      return s === 'active' ? { ...base, plan: 'pro', status: 'active' } : s ? { ...base, plan: 'free', status: s } : null;
    }
    if (['subscription.on_hold', 'subscription.cancelled', 'subscription.expired', 'subscription.failed'].includes(t)) {
      return { ...base, plan: 'free', status: t.slice('subscription.'.length) };
    }
    return null;
  }
  // Lifetime = a successful one-time payment (no subscription) for the Lifetime product.
  if (t === 'payment.succeeded') {
    const user_id = userOf(d);
    if (!user_id || d.subscription_id) return null;
    const cart: Obj[] = Array.isArray(d.product_cart) ? d.product_cart : [];
    const isLifetime = d.metadata?.plan === 'lifetime' || Boolean(products.lifetime && cart.some((c) => c?.product_id === products.lifetime));
    if (!isLifetime) return null;
    return { user_id, customer_ref: customerOf(d), subscription_ref: null, plan: 'pro', status: 'lifetime', current_period_end: null };
  }
  return null;
}

/** A completed full refund revokes access. Returns who to revoke, or null (partial refunds don't). */
export function refundTarget(event: DodoEvent): { user_id?: string; customer?: string } | null {
  const d = event.data ?? {};
  if (event.type !== 'refund.succeeded' || d.is_partial === true) return null;
  const user_id = userOf(d), customer = customerOf(d);
  return user_id || customer ? { user_id, customer: customer ?? undefined } : null;
}

export interface BillingDeps {
  /** Dodo → Developer → Webhooks → signing secret (`whsec_…`). Test and live have different secrets. */
  secret: string;
  products?: Products;
  /** Existing plan status for a user, so a Pro purchase can never downgrade a Lifetime plan. */
  currentStatus?: (userId: string) => Promise<string | null>;
  /** Remove paid access after a full refund. */
  revoke?: (who: { user_id?: string; customer?: string }) => Promise<{ error: { message: string } | null }>;
  /** Insert or replace the row for a known user. */
  upsertByUser: (row: EntitlementRow) => Promise<{ error: { message: string } | null }>;
  /** Update the row for an existing customer when the event carries no user id. Never downgrades a lifetime plan. */
  updateByCustomer: (row: EntitlementRow) => Promise<{ error: { message: string } | null }>;
}

export function makeBillingHandler(deps: BillingDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await req.text();
    if (!(await verifyDodo(raw, req.headers, deps.secret))) return new Response('Invalid signature', { status: 400 });
    let event: DodoEvent;
    try { event = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const refund = refundTarget(event);
    if (refund && deps.revoke) {
      const r = await deps.revoke(refund);
      return r.error ? new Response(r.error.message, { status: 500 }) : new Response('ok');
    }
    const row = entitlementFrom(event, deps.products);
    if (!row) return new Response('ignored');
    if (row.user_id && row.status !== 'lifetime' && (await deps.currentStatus?.(row.user_id)) === 'lifetime') return new Response('ignored: already lifetime');
    const { error } = row.user_id ? await deps.upsertByUser(row) : await deps.updateByCustomer(row);
    // A 5xx makes Dodo retry, which is what we want for transient DB errors.
    if (error) return new Response(error.message, { status: 500 });
    return new Response('ok');
  };
}

// ---------------------------------------------------------------- Checkout

export type Plan = 'yearly' | 'lifetime';
export interface CheckoutDeps {
  /** Resolve a Supabase access token to the user it belongs to, or null. */
  userFor: (token: string) => Promise<{ id: string; email?: string } | null>;
  apiKey: string;
  /** https://live.dodopayments.com or https://test.dodopayments.com */
  apiBase: string;
  products: Record<Plan, string>;
  returnUrl: string;
  fetch?: typeof fetch;
}

/** POST {plan} with `Authorization: Bearer <supabase token>` → {url} of a Dodo-hosted checkout carrying the user id. */
export function makeCheckoutHandler(deps: CheckoutDeps) {
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const token = req.headers.get('authorization')?.replace(/^Bearer /i, '');
    const user = token ? await deps.userFor(token) : null;
    if (!user) return json({ error: 'Sign in first, so the purchase is attached to your account.' }, 401);
    const plan = (await req.json().catch(() => ({}))).plan as Plan;
    if (plan !== 'yearly' && plan !== 'lifetime') return json({ error: 'Unknown plan' }, 400);
    const res = await (deps.fetch ?? fetch)(`${deps.apiBase}/checkouts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        product_cart: [{ product_id: deps.products[plan], quantity: 1 }],
        customer: user.email ? { email: user.email } : undefined,
        metadata: { user_id: user.id, plan },
        return_url: deps.returnUrl,
      }),
    });
    const out = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok || typeof out.checkout_url !== 'string') return json({ error: 'Checkout is unavailable right now. Please try again shortly.' }, 502);
    return json({ url: out.checkout_url });
  };
}
