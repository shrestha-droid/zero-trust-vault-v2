// Vercel Function. The browser asks for a checkout for the signed-in user; Dodo hosts the payment page.
import { makeCheckoutHandler } from '../server/billing.js';
import { admin, need, site } from '../server/env.js';

export async function POST(request: Request): Promise<Response> {
  return makeCheckoutHandler({
    userFor: async (token) => {
      const { data } = await admin().auth.getUser(token);
      return data.user ? { id: data.user.id, email: data.user.email } : null;
    },
    apiKey: need('DODO_API_KEY'),
    apiBase: process.env.DODO_ENV === 'test' ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com',
    products: { yearly: need('DODO_PRODUCT_YEARLY'), lifetime: need('DODO_PRODUCT_LIFETIME') },
    returnUrl: `${site()}/app/?upgraded=1`, // Dodo appends its own query parameters
  })(request);
}
