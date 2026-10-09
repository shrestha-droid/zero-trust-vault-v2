# Support runbook

Run SQL in Supabase → SQL Editor. Nothing here needs the browser app.

## "I paid but I'm not Pro"
1. Dodo → Developer → Webhooks → delivery logs: did `subscription.active` / `payment.succeeded` go out, and did our endpoint answer 200? A 4xx/5xx shows why; fix, then **Resend** that delivery.
2. If it can't be fixed quickly, grant it by hand (find the user id by email first):
   ```sql
   select id from auth.users where email = 'person@example.com';
   -- yearly:
   insert into public.entitlements (user_id, plan, status, current_period_end)
   values ('<user id>', 'pro', 'active', now() + interval '1 year')
   on conflict (user_id) do update set plan = 'pro', status = 'active', current_period_end = excluded.current_period_end, updated_at = now();
   -- lifetime: use status 'lifetime' and current_period_end null
   ```

## Refund
Refund in the Dodo dashboard. The `refund.succeeded` webhook revokes Pro by itself. To do it by hand:
```sql
update public.entitlements set plan = 'free', status = 'refunded', updated_at = now() where user_id = '<user id>';
```

## "Delete my account" (they can't sign in)
```sql
-- vaults live in storage under <user id>/ ; remove them in Storage → vault-store, then:
delete from public.waitlist where email = 'person@example.com';
-- Authentication → Users → delete the user (entitlements and Legacy plan cascade)
```
If they have an active subscription, cancel it in Dodo first.

## Legacy didn't fire / fired by mistake
- Cron: Vercel → project → Cron Jobs → `/api/legacy-tick` logs. Manual run: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/legacy-tick`.
- Stop a plan immediately: `update public.legacy_plans set enabled = false where user_id = '<user id>';`

## Weekly (two minutes)
Dodo dashboard (payments, failed renewals) · Vercel cron log · Supabase → Reports (storage near the plan limit?) · reply to support email.
