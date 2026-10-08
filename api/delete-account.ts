// Vercel Function. Deletes the signed-in user's cloud vaults, waitlist row and account.
import { makeDeleteAccountHandler } from '../server/account.js';
import { admin } from '../server/env.js';

const BUCKET = 'vault-store';

export async function POST(request: Request): Promise<Response> {
  const db = admin();
  return makeDeleteAccountHandler({
    userFor: async (token) => {
      const { data } = await db.auth.getUser(token);
      return data.user ? { id: data.user.id, email: data.user.email } : null;
    },
    hasActiveSubscription: async (userId) => {
      const { data } = await db.from('entitlements').select('status').eq('user_id', userId).maybeSingle();
      return ['active', 'past_due'].includes((data as { status?: string } | null)?.status ?? '');
    },
    removeVaults: async (userId) => {
      for (;;) {
        const { data, error } = await db.storage.from(BUCKET).list(userId, { limit: 1000 });
        if (error) throw error;
        if (!data?.length) return;
        const { error: rmError } = await db.storage.from(BUCKET).remove(data.map((o) => `${userId}/${o.name}`));
        if (rmError) throw rmError;
      }
    },
    removeWaitlist: async (email) => {
      const { error } = await db.from('waitlist').delete().eq('email', email);
      if (error) throw error;
    },
    deleteUser: async (userId) => {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) throw error;
    },
  })(request);
}
