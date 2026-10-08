// Vercel Function. Stripe → Developers → Webhooks → endpoint https://<site>/api/stripe-webhook
// Events: checkout.session.completed, customer.subscription.created|updated|deleted
import { makeBillingHandler, type EntitlementRow } from '../server/billing.js';
import { admin, need } from '../server/env.js';

const stamp = (row: EntitlementRow) => ({ ...row, updated_at: new Date().toISOString() });

export async function POST(request: Request): Promise<Response> {
  const handler = makeBillingHandler({
    secret: need('STRIPE_WEBHOOK_SECRET'),
    // Set STRIPE_ACCEPT_TEST=1 only while testing with Stripe's test mode; remove it when going live.
    acceptTest: process.env.STRIPE_ACCEPT_TEST === '1',
    currentStatus: async (userId) => {
      const { data } = await admin().from('entitlements').select('status').eq('user_id', userId).maybeSingle();
      return (data as { status?: string } | null)?.status ?? null;
    },
    revokeByCustomer: async (customer) => await admin().from('entitlements').update({ plan: 'free', status: 'refunded', updated_at: new Date().toISOString() } as never).eq('stripe_customer', customer),
    upsertByUser: async (row) => await admin().from('entitlements').upsert(stamp(row) as never, { onConflict: 'user_id' }),
    // A lifetime purchase is never downgraded by later subscription events on the same customer.
    updateByCustomer: async (row) => row.stripe_customer
      ? await admin().from('entitlements').update(stamp(row) as never).eq('stripe_customer', row.stripe_customer).neq('status', 'lifetime')
      : { error: null },
  });
  return handler(request);
}
