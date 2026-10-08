-- Stripe isn't available to the seller, so billing moved to Dodo Payments (merchant of record).
-- Columns become provider-neutral. Safe: no paid rows existed when this ran.
alter table public.entitlements rename column stripe_customer to customer_ref;
alter table public.entitlements rename column stripe_subscription to subscription_ref;
