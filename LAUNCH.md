# Launch checklist

Everything here is a one-time setup. Allow about two hours. Do it all in **test mode** first (Stripe test keys, a test Supabase project if you like), run the smoke test, then repeat the Stripe steps in live mode.

## What needs what

You can launch in stages. Each feature only needs the services in its row.

| Feature | Needs | Database? |
|---|---|---|
| Seal/open, shards, passphrase, passkeys, offline app, air-gap | Nothing (just Vercel) | No |
| **Save to Google Drive** (vaults in the user's own Drive) | A Google Cloud OAuth client ID | **No** |
| **Sign in** with Google / Apple / GitHub / email link | Supabase Auth (free tier) + provider setup | No SQL needed |
| Zero-Trust Cloud vaults, **Pro**, **Legacy** | Supabase + migrations + Stripe + Resend | Yes (steps 1–3) |

Smallest money-making launch: Vercel + Google Drive + Supabase Auth, then add Stripe and Legacy when you're ready.

## 0. Google Cloud (Google sign-in and Google Drive), free

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen:** External; set the app name, support email, your domain, and the links to `/privacy` and `/terms`. Add the scope `.../auth/drive.file` (non-sensitive: the app can only see files it created). Publish the app.
4. **Credentials → Create credentials → OAuth client ID → Web application:**
   - *Authorized JavaScript origins:* `https://YOUR-DOMAIN`
   - *Authorized redirect URIs:* `https://YOUR-DOMAIN/app/` (Drive) **and** `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (Google sign-in)
5. Copy the **Client ID** into Vercel as `VITE_GOOGLE_CLIENT_ID` (it's public by design), and paste the Client ID + **Client secret** into Supabase → Authentication → Providers → Google.

## 1. Supabase (database, auth, storage)

1. Open your project → **SQL Editor** and run, in order:
   - `supabase/migrations/0001_vault_store.sql`
   - `supabase/migrations/0002_billing_legacy.sql`
2. Remove anything left over from v1. In the SQL editor:
   ```sql
   select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects';
   ```
   Drop every policy on `vault-store` except the three named `vault owner can …`. Then, under **Storage → vault-store**, delete the old v1 files at the bucket root (`*.enc`, `*.meta`). Those records contain their own shards and can be decrypted by anyone who reads them.
3. **Authentication → URL Configuration:** set *Site URL* to `https://YOUR-DOMAIN/app/`, and add `https://YOUR-DOMAIN/app/` under *Redirect URLs*.
   **Authentication → Providers:**
   - **Email:** on (powers "Email me a sign-in link").
   - **Google:** paste the client ID/secret from step 0.
   - **Apple:** needs a paid Apple Developer account ($99/year): create a Services ID and a Sign in with Apple key, then follow Supabase's Apple guide. Skip it at first if you like; just leave `apple` out of `VITE_AUTH_PROVIDERS`.
   - **GitHub** (optional): GitHub → Settings → Developer settings → OAuth Apps, with callback `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.
   **Authentication → Emails → SMTP Settings:** use Resend's SMTP. Supabase's built-in email only sends a few messages an hour, which isn't enough for real users.
4. **Project Settings → API:** copy the *Project URL*, the *anon* key and the *service_role* key. The service_role key bypasses all security, so it only ever goes into Vercel's server variables.

## 2. Stripe (payments)

1. **Product catalog:** create *Zero-Trust Vault Pro* with a **yearly recurring** price ($60 on the website), and *Zero-Trust Vault Lifetime* with a **one-time** price ($199). Change the amounts freely, but keep `site/index.html` in sync.
2. **Payment Links:** create one link per price. Under *After payment*, choose "Don't show confirmation page" and redirect to `https://YOUR-DOMAIN/app/#upgraded`. Copy both links.
3. **Settings → Billing → Customer portal:** activate it and copy the portal login link.
4. **Developers → Webhooks → Add endpoint:** `https://YOUR-DOMAIN/api/stripe-webhook`, with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the signing secret (`whsec_…`).
5. **Settings → Billing → Subscriptions and emails:** turn on Smart Retries and failed-payment emails, so Stripe chases failed cards without you.
6. **Tax:** you are the seller of record. Turn on Stripe Tax (Settings → Tax) or get advice. If you'd rather never deal with sales tax or VAT, a merchant-of-record provider (Paddle, Lemon Squeezy) is the alternative; only `server/billing.ts` would change.

### Regional prices (do this when creating the two prices)

The landing page shows each visitor a local price from `site/pricing.json` (e.g. ₹4,999 in India, £49 in the UK). Stripe must charge the same amounts:

1. Open each price (Pro yearly, Lifetime) → **Add currency** (Stripe calls these *currency options*).
2. Add every currency in `site/pricing.json` with **exactly** its amount: EUR 59/189, GBP 49/159, INR 4999/16499, CAD 79/269, AUD 89/299, JPY 8900/29800, CHF 55/179.
3. Payment Links then charge visitors in their local currency automatically. Don't turn on Stripe's *Adaptive Pricing* instead: it converts at live rates, so checkout wouldn't match the price on the site.
4. With Stripe Tax, set prices to **tax-inclusive** for EUR/GBP/CHF so the shown price is what people pay.

To change a price later, edit `site/pricing.json` and the matching Stripe currency option together. To add a country, add it to `pricing.json` and run `npm test`: the test fails and shows the exact `vercel.json` rewrite that's missing.

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
   | `VITE_AUTH_PROVIDERS` | e.g. `google,apple,github`: sign-in buttons to show (only ones enabled in Supabase) |
   | `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID (enables Google Drive storage) |
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
2. Press **Sign in** (top right) → Continue with Google → you land back signed in. Try "Email me a sign-in link" too.
3. Seal a vault with destination **Google Drive** → approve Google's popup → check your Drive for the "Zero-Trust Vault" folder → open the vault again from the Vault tab → Google Drive.
4. Upgrade with test card `4242 4242 4242 4242`. You land back on `/app/#upgraded`, and the **PRO** badge appears within seconds. If it doesn't, check Stripe → Webhooks → the endpoint's recent deliveries.
5. Seal a vault to **Cloud**, then create a Legacy plan with yourself as the trustee and a 30-day interval.
6. Fire the cron by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/legacy-tick` returns `{"reminded":0,"released":0,"failed":0}`.
7. To rehearse a release, in Supabase run `update legacy_plans set last_checkin = now() - interval '200 days';`, call the cron URL again, and check the trustee inbox: message, vault link and escrow shard. Then delete that plan.
8. Cancel the test subscription in the customer portal and confirm the app shows Free again.

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
