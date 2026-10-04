import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { isId, parseVaultFile, VaultError, type VaultFile } from './crypto';

// ---------- Air-gap: a browser-enforced network kill switch ----------
// A CSP <meta> added at runtime can only tighten policy, never be removed, so once locked
// this tab cannot make fetch/XHR/WebSocket requests until it is reloaded.
const AIRGAP_PREF = 'ztv.airgap';
let locked = false;

export const airGap = {
  get active() { return locked; },
  get preferred() { try { return localStorage.getItem(AIRGAP_PREF) === '1'; } catch { return false; } },
  set preferred(on: boolean) { try { on ? localStorage.setItem(AIRGAP_PREF, '1') : localStorage.removeItem(AIRGAP_PREF); } catch { /* storage blocked */ } },
  lock() {
    if (locked) return;
    const m = document.createElement('meta');
    m.httpEquiv = 'Content-Security-Policy';
    m.content = "connect-src 'none'";
    document.head.append(m);
    locked = true;
    client?.auth.stopAutoRefresh();
  },
  /** Proves the lock: a same-origin request must now be refused by the browser. */
  async verify(): Promise<boolean> {
    try { await fetch(`${location.href.split('#')[0]}?airgap-probe=${Date.now()}`, { cache: 'no-store' }); return false; } catch { return true; }
  },
};

// ---------- Local: IndexedDB ----------
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('zero-trust-vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('vaults', { keyPath: 'h.id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('vaults', mode);
    const r = fn(t.objectStore('vaults'));
    t.oncomplete = () => { d.close(); res(r.result); };
    t.onerror = t.onabort = () => { d.close(); rej(t.error ?? r.error); };
  });
}

export const local = {
  list: () => tx<VaultFile[]>('readonly', (s) => s.getAll()),
  async get(id: string) {
    const f = await tx<VaultFile | undefined>('readonly', (s) => s.get(id));
    return f ? parseVaultFile(JSON.stringify(f)) : undefined;
  },
  async put(f: VaultFile) {
    // Ask the browser not to evict our data under storage pressure.
    await navigator.storage?.persist?.().catch(() => false);
    await tx('readwrite', (s) => s.add(f)); // add, not put: never silently overwrite a record
  },
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  persisted: async () => (await navigator.storage?.persisted?.()) ?? false,
};

// ---------- Cloud: Supabase Storage, path = <auth.uid()>/<id>.vault, RLS in supabase/migrations ----------
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const BUCKET = 'vault-store';
export const cloudConfigured = Boolean(URL_ && KEY);
let client: SupabaseClient | null = null;

function sb(): SupabaseClient {
  if (locked) throw new VaultError('Air-gap is on — the network is blocked in this tab.');
  if (!cloudConfigured) throw new VaultError('Cloud sync is not configured for this build.');
  return (client ??= createClient(URL_!, KEY!, { auth: { storage: sessionStorage } }));
}

async function userPath(id?: string): Promise<string> {
  const { data } = await sb().auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) throw new VaultError('Sign in to use the cloud vault.');
  if (id !== undefined && !isId(id)) throw new VaultError('Invalid record id.');
  return id === undefined ? uid : `${uid}/${id}.vault`;
}

const raise = (error: { message: string } | null) => { if (error) throw new VaultError(error.message); };

export interface CloudEntry { id: string; created: string; size: number }

export const cloud = {
  async session(): Promise<Session | null> {
    if (!cloudConfigured || locked) return null;
    const { data } = await sb().auth.getSession();
    return data.session;
  },
  onChange(cb: () => void) {
    if (cloudConfigured && !locked) sb().auth.onAuthStateChange(() => cb());
  },
  async signIn(email: string, password: string) {
    raise((await sb().auth.signInWithPassword({ email, password })).error);
  },
  /** Returns false when the project requires email confirmation first. */
  async signUp(email: string, password: string): Promise<boolean> {
    const { data, error } = await sb().auth.signUp({ email, password });
    raise(error);
    return Boolean(data.session);
  },
  async signOut() { raise((await sb().auth.signOut()).error); },
  async list(): Promise<CloudEntry[]> {
    const { data, error } = await sb().storage.from(BUCKET).list(await userPath(), { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
    raise(error);
    return (data ?? []).filter((o) => o.name.endsWith('.vault')).map((o) => ({
      id: o.name.slice(0, -6), created: o.created_at ?? '', size: (o.metadata?.size as number | undefined) ?? 0,
    }));
  },
  async get(id: string): Promise<VaultFile> {
    const { data, error } = await sb().storage.from(BUCKET).download(await userPath(id));
    raise(error);
    return parseVaultFile(await data!.text());
  },
  async put(f: VaultFile) {
    const body = new Blob([JSON.stringify(f)], { type: 'application/json' });
    const { error } = await sb().storage.from(BUCKET).upload(await userPath(f.h.id), body, { contentType: 'application/json', upsert: false });
    if (error && /row-level security/i.test(error.message)) {
      throw new VaultError('The Free plan includes 2 cloud vaults. Upgrade to Pro for unlimited, or save this one to the device.');
    }
    raise(error);
  },
  async remove(id: string) {
    const { data, error } = await sb().storage.from(BUCKET).remove([await userPath(id)]);
    raise(error);
    if (!data?.length) throw new VaultError('Nothing was deleted — the record was not found.');
  },
};

// ---------- Plans (written only by the server's Stripe webhook; read here) ----------
export interface Plan { pro: boolean; status: string; periodEnd: string | null }
const FREE: Plan = { pro: false, status: 'free', periodEnd: null };

export const billing = {
  checkoutYearly: import.meta.env.VITE_CHECKOUT_URL_YEARLY as string | undefined,
  checkoutLifetime: import.meta.env.VITE_CHECKOUT_URL_LIFETIME as string | undefined,
  portal: import.meta.env.VITE_BILLING_PORTAL_URL as string | undefined,
  get configured() { return cloudConfigured && Boolean(this.checkoutYearly || this.checkoutLifetime); },
  async plan(): Promise<Plan> {
    if (!(await cloud.session())) return FREE;
    const { data, error } = await sb().rpc('is_pro');
    if (error) return FREE;
    const { data: row } = await sb().from('entitlements').select('status, current_period_end').maybeSingle();
    return { pro: Boolean(data), status: (row?.status as string) ?? 'free', periodEnd: (row?.current_period_end as string) ?? null };
  },
  /** Stripe Payment Link carrying the user id, so the webhook can attribute the purchase. */
  async checkoutUrl(link: string): Promise<string> {
    const s = await cloud.session();
    if (!s) throw new VaultError('Sign in first, so the purchase is attached to your account.');
    const u = new URL(link);
    u.searchParams.set('client_reference_id', s.user.id);
    if (s.user.email) u.searchParams.set('prefilled_email', s.user.email);
    return u.toString();
  },
};

// ---------- Legacy (dead man's switch) ----------
export interface Trustee { name: string; email: string }
export interface LegacyPlan {
  enabled: boolean; interval_days: number; grace_days: number; last_checkin: string;
  trustees: Trustee[]; message: string; vault_ids: string[]; escrow_shard: string | null;
  reminded_at: string | null; released_at: string | null;
}
export type LegacyInput = Pick<LegacyPlan, 'enabled' | 'interval_days' | 'grace_days' | 'trustees' | 'message' | 'vault_ids' | 'escrow_shard'>;

export const legacy = {
  async get(): Promise<LegacyPlan | null> {
    const { data, error } = await sb().from('legacy_plans').select('*').maybeSingle();
    raise(error);
    return data as LegacyPlan | null;
  },
  async save(input: LegacyInput, exists: boolean) {
    const uid = await userPath();
    const q = exists
      ? sb().from('legacy_plans').update(input).eq('user_id', uid)
      : sb().from('legacy_plans').insert({ ...input, user_id: uid });
    const { error } = await q;
    if (error && /row-level security/i.test(error.message)) throw new VaultError('Legacy plans need Pro. Upgrade to create or edit one.');
    raise(error);
  },
  async remove() { raise((await sb().from('legacy_plans').delete().eq('user_id', await userPath())).error); },
  /** Resets the clock. Any sign-in + app open counts, so active owners never trigger a false release. */
  async checkin(): Promise<string | null> {
    const { data, error } = await sb().rpc('legacy_checkin');
    raise(error);
    return (data as string | null) ?? null;
  },
};
