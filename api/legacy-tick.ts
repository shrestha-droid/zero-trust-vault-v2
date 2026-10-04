// Vercel Cron (see vercel.json) calls this daily with `Authorization: Bearer $CRON_SECRET`.
import { makeTickHandler, runTick, sendEmail, type LegacyPlan } from '../server/legacy.js';
import { admin, need, site } from '../server/env.js';

const LINK_TTL_S = 30 * 86_400;

export async function GET(request: Request): Promise<Response> {
  const db = admin();
  const handler = makeTickHandler(need('CRON_SECRET'), () => runTick({
    now: Date.now(),
    appUrl: `${site()}/app/`,
    checkinBaseUrl: `${site()}/api/legacy-checkin`,
    checkinSecret: need('CHECKIN_SECRET'),
    plans: async () => {
      // ponytail: one pass over all armed plans; paginate/queue if this ever reaches tens of thousands
      const { data, error } = await db.from('legacy_plans').select('*').eq('enabled', true).is('released_at', null);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as LegacyPlan[];
    },
    ownerEmail: async (id) => (await db.auth.admin.getUserById(id)).data.user?.email ?? null,
    signedUrl: async (uid, vid) => (await db.storage.from('vault-store').createSignedUrl(`${uid}/${vid}.vault`, LINK_TTL_S, { download: `${vid}.vault` })).data?.signedUrl ?? null,
    send: (e) => sendEmail(e, need('RESEND_API_KEY'), need('EMAIL_FROM')),
    mark: async (uid, patch) => {
      const { error } = await db.from('legacy_plans').update(patch as never).eq('user_id', uid);
      if (error) throw new Error(error.message);
    },
  }));
  return handler(request);
}
