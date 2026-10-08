// Vercel Function. Dodo Payments → Developers → Webhooks → endpoint https://<site>/api/billing-webhook
// Events: subscription.* , payment.succeeded , refund.succeeded
import { makeBillingHandler, type EntitlementRow } from '../server/billing.js';
import { admin, need } from '../server/env.js';

const stamp = (row: EntitlementRow) => ({ ...row, updated_at: new Date().toISOString() });

export async function POST(request: Request): Promise<Response> {
  const handler = makeBillingHandler({
    secret: need('DODO_WEBHOOK_SECRET'),
    products: { lifetime: process.env.DODO_PRODUCT_LIFETIME },
    currentStatus: async (userId) => {
      const { data } = await admin().from('entitlements').select('status').eq('user_id', userId).maybeSingle();
      return (data as { status?: string } | null)?.status ?? null;
    },
    revoke: async ({ user_id, customer }) => {
      const q = admin().from('entitlements').update({ plan: 'free', status: 'refunded', updated_at: new Date().toISOString() } as never);
      return await (user_id ? q.eq('user_id', user_id) : q.eq('customer_ref', customer ?? ''));
    },
    upsertByUser: async (row) => await admin().from('entitlements').upsert(stamp(row) as never, { onConflict: 'user_id' }),
    // A lifetime purchase is never downgraded by later subscription events on the same customer.
    updateByCustomer: async (row) => row.customer_ref
      ? await admin().from('entitlements').update(stamp(row) as never).eq('customer_ref', row.customer_ref).neq('status', 'lifetime')
      : { error: null },
  });
  return handler(request);
}
