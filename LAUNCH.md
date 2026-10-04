# Launch checklist

Everything here is a one-time setup. Allow about two hours. Do it all in **test mode** first (Stripe test keys, a test Supabase project if you like), run the smoke test, then repeat the Stripe steps in live mode.

## 1. Supabase (database, auth, storage)

1. Open your project → **SQL Editor** and run, in order:
   - `supabase/migrations/0001_vault_store.sql`
   - `supabase/migrations/0002_billing_legacy.sql`
2. Remove anything left over from v1. In the SQL editor:
   ```sql
   select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects';
   ```
   Drop every policy on `vault-store` except the three named `vault owner can …`. Then, under **Storage → vault-store**, delete the old v1 files at the bucket root (`*.enc`, `*.meta`). Those records contain their own shards and can be decrypted by anyone who reads them.
3. **Authentication → URL Configuration:** set *Site URL* to `https://YOUR-DOMAIN/app/`. **Authentication → Providers → Email:** keep "Confirm email" on.
4. **Project Settings → API:** copy the *Project URL*, the *anon* key and the *service_role* key. The service_role key bypasses all security, so it only ever goes into Vercel's server variables.

## 2. Stripe (payments)

1. **Product catalog:** create *Zero-Trust Vault Pro* with a **yearly recurring** price ($60 on the website), and *Zero-Trust Vault Lifetime* with a **one-time** price ($199). Change the amounts freely, but keep `site/index.html` in sync.
2. **Payment Links:** create one link per price. Under *After payment*, choose "Don't show confirmation page" and redirect to `https://YOUR-DOMAIN/app/#upgraded`. Copy both links.
3. **Settings → Billing → Customer portal:** activate it and copy the portal login link.
4. **Developers → Webhooks → Add endpoint:** `https://YOUR-DOMAIN/api/stripe-webhook`, with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the signing secret (`whsec_…`).
5. **Settings → Billing → Subscriptions and emails:** turn on Smart Retries and failed-payment emails, so Stripe chases failed cards without you.
6. **Tax:** you are the seller of record. Turn on Stripe Tax (Settings → Tax) or get advice. If you'd rather never deal with sales tax or VAT, a merchant-of-record provider (Paddle, Lemon Squeezy) is the alternative; only `server/billing.ts` would change.

## 3. Resend (Legacy emails)

Add and verify your domain (DNS records), create an API key, and choose a sender such as `Zero-Trust Vault <legacy@YOUR-DOMAIN>`.

## 4. Vercel (hosting)

1. **Add New → Project →** import `shrestha-droid/zero-trust-vault-v2`. `vercel.json` already sets the build (`npm run check`), the output (`dist`), the headers and the daily cron.
2. **Settings → Environment Variables** (Production and Preview):

   | Variable | Value |
   |---|---|
   | `SITE_URL` | `https://YOUR-DOMAIN` (no trailing slash) |
   | `VITE_SUPABASE_URL` / `SUPABASE_URL` | Supabase Project URL (same value twice) |
   | `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key. **Never** with a `VITE_` prefix |
   | `VITE_CHECKOUT_URL_YEARLY` | Stripe Payment Link (yearly) |
   | `VITE_CHECKOUT_URL_LIFETIME` | Stripe Payment Link (lifetime) |
   | `VITE_BILLING_PORTAL_URL` | Stripe customer portal link |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
   | `CRON_SECRET` | `openssl rand -hex 32` (Vercel sends it to the cron automatically) |
   | `CHECKIN_SECRET` | another `openssl rand -hex 32` |
   | `RESEND_API_KEY` | Resend API key |
   | `EMAIL_FROM` | `Zero-Trust Vault <legacy@YOUR-DOMAIN>` |

3. **Settings → Domains:** add your domain.
4. **Plan:** Vercel's Hobby tier is for non-commercial use, so a paid product needs **Vercel Pro**. Cron runs daily, which is all Legacy needs.

`VITE_*` values are compiled into the public app. They're public by nature (the anon key and Stripe links); nothing secret may use that prefix.

## 5. Smoke test (Stripe test mode)

1. Open `/`, then `/app/`. Seal and open a vault locally.
2. Settings → create an account → confirm the email → sign in.
3. Upgrade with test card `4242 4242 4242 4242`. You land back on `/app/#upgraded`, and the **PRO** badge appears within seconds. If it doesn't, check Stripe → Webhooks → the endpoint's recent deliveries.
4. Seal a vault to **Cloud**, then create a Legacy plan with yourself as the trustee and a 30-day interval.
5. Fire the cron by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/legacy-tick` returns `{"reminded":0,"released":0,"failed":0}`.
6. To rehearse a release, in Supabase run `update legacy_plans set last_checkin = now() - interval '200 days';`, call the cron URL again, and check the trustee inbox: message, vault link and escrow shard. Then delete that plan.
7. Cancel the test subscription in the customer portal and confirm the app shows Free again.

## 6. Before taking real money

- Replace every `[BRACKETED]` field in `site/terms.html` and `site/privacy.html`, have them reviewed, and remove the template notes.
- Switch Stripe to live mode: new Payment Links, portal link and webhook secret in Vercel.
- Book an independent security review of the app (the Shamir library is already audited). Publish the result.
- Set up a support address and link it in the footer.

## What runs without you

| Automated | Still needs a human, occasionally |
|---|---|
| Payments, renewals, failed-card retries (Stripe) | Answering support email and security reports |
| Pro activation and deactivation (webhook + RLS) | Reviewing and merging Dependabot PRs (CI tests them first) |
| Legacy reminders and releases (daily Vercel Cron) | Paying the Vercel, Supabase and Resend bills |
| Release builds with checksums (GitHub Actions on tag) | Renewing your domain |
