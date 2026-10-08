// Stripe webhook → entitlement. Web-standard APIs only; wired up in api/stripe-webhook.ts.

export interface EntitlementRow {
  user_id?: string;
  /** Null for a one-time (Lifetime) purchase made without a Stripe customer. */
  stripe_customer: string | null;
  stripe_subscription: string | null;
  plan: 'free' | 'pro';
  status: string;
  current_period_end: string | null;
}

type Obj = Record<string, any>;
export interface StripeEvent { type: string; livemode?: boolean; data: { object: Obj } }

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

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

/** Stripe-Signature: "t=<unix>,v1=<hex hmac of `${t}.${body}`>[,v1=...]", with a replay window. */
export async function verifyStripe(raw: string, header: string | null, secret: string, nowSec = Date.now() / 1000, toleranceSec = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || !Number.isFinite(+t) || Math.abs(nowSec - +t) > toleranceSec) return false;
  const mac = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, mac));
}

/** Map a Stripe event to the entitlement fields it implies, or null if irrelevant. */
export function entitlementFrom(event: StripeEvent): EntitlementRow | null {
  const o = event.data?.object ?? {};
  if (event.type === 'checkout.session.completed') {
    if (!UUID.test(o.client_reference_id ?? '')) return null;
    const lifetime = o.mode === 'payment';
    // A subscription always has a customer. A one-time payment may not (Stripe only creates one if asked to),
    // and requiring it here would silently drop a paid Lifetime purchase.
    if (!o.customer && !lifetime) return null;
    if (o.payment_status && o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return null;
    return {
      user_id: o.client_reference_id, stripe_customer: o.customer ?? null, stripe_subscription: o.subscription ?? null,
      plan: 'pro', status: lifetime ? 'lifetime' : 'active', current_period_end: null,
    };
  }
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    if (!o.customer) return null;
    const deleted = event.type === 'customer.subscription.deleted';
    // API versions from 2025 moved current_period_end onto subscription items.
    const end: number | undefined = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
    return {
      stripe_customer: o.customer, stripe_subscription: o.id ?? null,
      plan: !deleted && ACTIVE.has(o.status) ? 'pro' : 'free',
      status: deleted ? 'canceled' : String(o.status),
      current_period_end: end ? new Date(end * 1000).toISOString() : null,
    };
  }
  return null;
}

/** A fully refunded charge revokes access (looked up by customer, so Lifetime must be created with a customer). */
export function refundedCustomer(event: StripeEvent): string | null {
  const o = event.data?.object ?? {};
  return event.type === 'charge.refunded' && o.refunded === true && typeof o.customer === 'string' ? o.customer : null;
}

export interface BillingDeps {
  secret: string;
  /** Test-mode events are rejected unless this is true, so a leftover test link can never grant real Pro. */
  acceptTest?: boolean;
  /** Existing plan status for a user, so a Pro purchase can never downgrade a Lifetime plan. */
  currentStatus?: (userId: string) => Promise<string | null>;
  /** Remove paid access for a refunded customer. */
  revokeByCustomer?: (customer: string) => Promise<{ error: { message: string } | null }>;
  /** Insert or replace the row for a known user (checkout). */
  upsertByUser: (row: EntitlementRow) => Promise<{ error: { message: string } | null }>;
  /** Update the row for an existing Stripe customer (subscription lifecycle). Never downgrades a lifetime plan. */
  updateByCustomer: (row: EntitlementRow) => Promise<{ error: { message: string } | null }>;
}

export function makeBillingHandler(deps: BillingDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await req.text();
    if (!(await verifyStripe(raw, req.headers.get('stripe-signature'), deps.secret))) return new Response('Invalid signature', { status: 400 });
    let event: StripeEvent;
    try { event = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (event.livemode === false && !deps.acceptTest) return new Response('ignored: test-mode event');
    const refunded = refundedCustomer(event);
    if (refunded && deps.revokeByCustomer) {
      const r = await deps.revokeByCustomer(refunded);
      return r.error ? new Response(r.error.message, { status: 500 }) : new Response('ok');
    }
    const row = entitlementFrom(event);
    if (!row) return new Response('ignored');
    if (row.user_id && row.status !== 'lifetime' && (await deps.currentStatus?.(row.user_id)) === 'lifetime') return new Response('ignored: already lifetime');
    const { error } = row.user_id ? await deps.upsertByUser(row) : await deps.updateByCustomer(row);
    // A 5xx makes Stripe retry with backoff, which is what we want for transient DB errors.
    if (error) return new Response(error.message, { status: 500 });
    return new Response('ok');
  };
}
