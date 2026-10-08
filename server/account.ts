// Self-serve account deletion (the privacy policy promises it). Pure logic with injected effects, wired in api/delete-account.ts.
// Every step is idempotent, so a failure part-way can simply be retried.

export interface AccountDeps {
  /** Resolve a Supabase access token to the user it belongs to, or null. */
  userFor: (token: string) => Promise<{ id: string; email?: string } | null>;
  /** True while a recurring subscription is still billing (deleting then would leave them paying for nothing). */
  hasActiveSubscription: (userId: string) => Promise<boolean>;
  removeVaults: (userId: string) => Promise<void>;
  removeWaitlist: (email: string) => Promise<void>;
  /** Also removes entitlements and the Legacy plan (ON DELETE CASCADE). */
  deleteUser: (userId: string) => Promise<void>;
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function makeDeleteAccountHandler(d: AccountDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const token = req.headers.get('authorization')?.replace(/^Bearer /i, '');
    const user = token ? await d.userFor(token) : null;
    if (!user) return json({ error: 'Sign in again, then retry.' }, 401);
    try {
      if (await d.hasActiveSubscription(user.id)) {
        return json({ error: "You still have an active Pro subscription. Cancel it first (the link is in Dodo's receipt email), then delete your account." }, 409);
      }
      await d.removeVaults(user.id);
      if (user.email) await d.removeWaitlist(user.email.toLowerCase());
      await d.deleteUser(user.id);
    } catch {
      return json({ error: 'Something went wrong while deleting. Nothing was lost; please try again.' }, 500);
    }
    return json({ ok: true });
  };
}
