// The build-time settings the app reads. They are public by design (compiled into the page), and together with
// the source commit they are everything needed to rebuild the served app byte-for-byte. vite.config.ts publishes
// them as /app/build-info.json; .github/workflows/reproducible.yml rebuilds from it and compares hashes.
export const APP_ENV = [
  'VITE_AUTH_PROVIDERS', 'VITE_BILLING_PORTAL_URL', 'VITE_EMAIL_CODE', 'VITE_GOOGLE_CLIENT_ID',
  'VITE_PAYMENTS', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL',
] as const;
