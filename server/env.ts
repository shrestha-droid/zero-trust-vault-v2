// Server-only configuration for the Vercel functions in api/. Never prefix these with VITE_:
// only VITE_* variables are compiled into the browser bundle.
import { createClient } from '@supabase/supabase-js';

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const site = () => need('SITE_URL').replace(/\/+$/, '');

let client: ReturnType<typeof createClient> | null = null;
/** Service-role client: bypasses RLS, so it is only ever used server-side. */
export const admin = () => (client ??= createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
}));
