// Vercel Function: POST /api/waitlist (plain HTML form, no JavaScript needed).
import { makeWaitlistHandler } from '../server/waitlist.js';
import { admin, site } from '../server/env.js';

export async function POST(request: Request): Promise<Response> {
  const db = admin();
  return makeWaitlistHandler({
    siteUrl: site(),
    insert: async (row) => await db.from('waitlist').insert(row as never),
    recent: async () => {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const { count } = await db.from('waitlist').select('email', { count: 'exact', head: true }).gte('created_at', since);
      return count ?? 0;
    },
  })(request);
}
