// "I'm still here" link from reminder emails. Verifies the signed token, records the check-in, redirects to the app.
import { makeCheckinHandler } from '../server/legacy.js';
import { admin, need, site } from '../server/env.js';

export async function GET(request: Request): Promise<Response> {
  const handler = makeCheckinHandler({
    secret: need('CHECKIN_SECRET'),
    appUrl: `${site()}/app/`,
    checkin: async (userId) => {
      const { data, error } = await admin().from('legacy_plans')
        .update({ last_checkin: new Date().toISOString(), reminded_at: null } as never)
        .eq('user_id', userId).is('released_at', null).select('user_id');
      return !error && Boolean(data?.length);
    },
  });
  return handler(request);
}
