// Vercel Function. Stripe → Developers → Webhooks → endpoint https://<site>/api/stripe-webhook
// Events: checkout.session.completed, customer.subscription.created|updated|deleted
import { makeBillingHandler, type EntitlementRow } from '../server/billing.js';
import { admin, need } from '../server/env.js';

const stamp = (row: EntitlementRow) => ({ ...row, updated_at: new Date().toISOString() });

export async function POST(request: Request): Promise<Response> {
  const handler = makeBillingHandler({
    secret: need('STRIPE_WEBHOOK_SECRET'),
    upsertByUser: async (row) => await admin().from('entitlements').upsert(stamp(row) as never, { onConflict: 'user_id' }),
    // A lifetime purchase is never downgraded by later subscription events on the same customer.
    updateByCustomer: async (row) => await admin().from('entitlements').update(stamp(row) as never).eq('stripe_customer', row.stripe_customer).neq('status', 'lifetime'),
  });
  return handler(request);
}
