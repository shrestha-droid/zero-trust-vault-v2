# Launch checklist

Everything here is a one-time setup. Allow about two hours. Do it all in **test mode** first (Dodo test keys), run the smoke test, then repeat the Dodo steps in live mode.

## What needs what

You can launch in stages. Each feature only needs the services in its row.

| Feature | Needs | Database? |
|---|---|---|
| Seal/open, shards, passphrase, passkeys, offline app, air-gap | Nothing (just Vercel) | No |
| **Save to Google Drive** (vaults in the user's own Drive) | A Google Cloud OAuth client ID | **No** |
| **Sign in** with Google / Apple / GitHub / email link | Supabase Auth (free tier) + provider setup | No SQL needed |
| Zero-Trust Cloud vaults, **Pro**, **Legacy** | Supabase + migrations + Dodo Payments + Resend | Yes (steps 1–3) |

Smallest money-making launch: Vercel + Google Drive + Supabase Auth, then add Dodo Payments and Legacy when you're ready.

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
   - `supabase/migrations/0003_waitlist.sql`
   - `supabase/migrations/0004_provider_neutral_billing.sql`
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

## 2. Dodo Payments (payments and tax)

Stripe isn't open to new Indian sellers, so billing uses [Dodo Payments](https://dodopayments.com), a merchant of record: **Dodo is the legal seller, collects and remits sales tax/VAT worldwide, and pays you out to your Indian bank account.** Fees are roughly 4% + $0.40 (plus surcharges for international cards and subscriptions) and $1 per refund; confirm current rates on their pricing page.

1. Sign up as an **Individual** (no company needed). Complete KYC (government ID + selfie) and add your payout bank details. Live payments stay locked until Dodo approves; test mode works immediately.
2. Before building anything on it, email Dodo support one line: *"We sell a client-side encryption / password-vault web app (no custody of funds, no crypto exchange). Is this an accepted product category?"* Their prohibited list names unlicensed crypto exchanges, not security software, but get it in writing.
3. **Products** (dashboard → Products), in **test mode** first:
   - **Pro (yearly):** subscription, billed yearly, price from `site/pricing.json` (USD).
   - **Lifetime:** one-time payment.
   - Turn on **Localized Pricing** and enter the per-currency amounts from `site/pricing.json` so the price a visitor sees on the site is the price Dodo charges.
4. **Developer → API Keys:** create a key. **Developer → Webhooks:** add endpoint `https://YOUR-DOMAIN/api/billing-webhook`, subscribe to every `subscription.*`, `payment.succeeded` and `refund.succeeded` event, and copy the signing secret (`whsec_…`).
5. In Vercel add (test values first): `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_YEARLY`, `DODO_PRODUCT_LIFETIME` (the `pdt_…` ids) and `DODO_ENV=test`. Run migration `supabase/migrations/0004_provider_neutral_billing.sql`.
6. **Test mode does not publish checkout.** Set `VITE_PAYMENTS=1` only when you're ready to test the buy buttons (the site then switches from the waitlist to real checkout), pay with Dodo's test card, and check the account gets Pro.
7. **Verify the webhook payloads once.** Dodo doesn't publish full payload schemas, so the handler (`server/billing.ts`) reads fields defensively: `data.metadata.user_id`, `data.customer.customer_id`, `data.subscription_id`, `data.next_billing_date`, `data.product_cart`, `data.is_partial`. In **Developer → Webhooks → delivery logs**, open a real `subscription.active`, `payment.succeeded` (Lifetime) and `refund.succeeded` delivery and confirm those names and that `metadata` we send at checkout comes back. If one differs, change the one line in `entitlementFrom` and add the real payload to `server/server.test.ts`. Also check what `subscription.cancelled` means for a customer who cancels mid-term: the handler revokes Pro immediately.
8. **Going live:** once approved, create the same two products in live mode, replace the four values in Vercel with live ones, **remove `DODO_ENV`**, and redeploy.

Safety rails already built in:
- **The purchaser can't be forged:** the browser only asks `/api/checkout`, which verifies the Supabase login server-side and attaches the user id to the Dodo checkout. The webhook is signature-checked (Standard Webhooks, 5-minute replay window).
- **Test and live are separate** (different API keys and webhook secrets), so a test purchase can never grant real Pro on a live deployment.
- **A Lifetime purchase can't be downgraded** by a later subscription event.
- **A full refund revokes Pro.** Partial refunds don't.

Customers manage or cancel their subscription from the links in Dodo's receipt emails; optionally set `VITE_BILLING_PORTAL_URL` to Dodo's customer portal.

### Regional prices

The landing page shows each visitor a local price from `site/pricing.json`. Dodo's Localized Pricing must hold the same amounts (set manually in the dashboard). To add a country, add it to the file and run `npm test`: the test fails and shows the exact `vercel.json` rewrite that's missing.

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
   | `VITE_PAYMENTS` | `1` to switch the site from the waitlist to real checkout (leave unset until step 2 is done) |
   | `DODO_API_KEY` / `DODO_WEBHOOK_SECRET` | From Dodo → Developer. **Never** with a `VITE_` prefix |
   | `DODO_PRODUCT_YEARLY` / `DODO_PRODUCT_LIFETIME` | The `pdt_…` product ids |
   | `DODO_ENV` | `test` while testing; remove for live |
   | `CRON_SECRET` | `openssl rand -hex 32` (Vercel sends it to the cron automatically) |
   | `CHECKIN_SECRET` | another `openssl rand -hex 32` |
   | `RESEND_API_KEY` | Resend API key |
   | `EMAIL_FROM` | `Zero-Trust Vault <legacy@YOUR-DOMAIN>` |

3. **Settings → Domains:** add your domain.
4. **Plan:** Vercel's Hobby tier is for non-commercial use, so a paid product needs **Vercel Pro**. Cron runs daily, which is all Legacy needs.

`VITE_*` values are compiled into the public app. They're public by nature (the anon key and the payments flag); nothing secret may use that prefix.

## 5. Smoke test (Dodo test mode)

1. Open `/`, then `/app/`. Seal and open a vault locally.
2. Press **Sign in** (top right) → Continue with Google → you land back signed in. Try "Email me a sign-in link" too.
3. Seal a vault with destination **Google Drive** → approve Google's popup → check your Drive for the "Zero-Trust Vault" folder → open the vault again from the Vault tab → Google Drive.
4. Upgrade with Dodo's test card. You land back on `/app/`, and the **PRO** badge appears within seconds. If it doesn't, check Dodo → Developer → Webhooks → delivery logs.
5. Seal a vault to **Cloud**, then create a Legacy plan with yourself as the trustee and a 30-day interval.
6. Fire the cron by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-DOMAIN/api/legacy-tick` returns `{"reminded":0,"released":0,"failed":0}`.
7. To rehearse a release, in Supabase run `update legacy_plans set last_checkin = now() - interval '200 days';`, call the cron URL again, and check the trustee inbox: message, vault link and escrow shard. Then delete that plan.
8. Cancel the test subscription from Dodo's dashboard and confirm the app shows Free again.

## 6. Before taking real money

- Replace every `[BRACKETED]` field in `site/terms.html` and `site/privacy.html`, have them reviewed, and remove the template notes.
- Switch Dodo to live mode: live products, API key and webhook secret in Vercel, and remove `DODO_ENV`.
- Book an independent security review of the app (the Shamir library is already audited). Publish the result.
- Set up a support address and link it in the footer.

## What runs without you

| Automated | Still needs a human, occasionally |
|---|---|
| Payments, renewals, failed-card retries, tax (Dodo) | Answering support email and security reports |
| Pro activation and deactivation (webhook + RLS) | Reviewing and merging Dependabot PRs (CI tests them first) |
| Legacy reminders and releases (daily Vercel Cron) | Paying the Vercel, Supabase and Resend bills |
| Release builds with checksums (GitHub Actions on tag) | Renewing your domain |
