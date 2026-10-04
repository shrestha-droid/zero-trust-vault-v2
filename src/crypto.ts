// Vault format v2. Pure: runs in the browser worker, the main thread fallback, and Node (tests).
// Spec: README.md#file-format. Changing anything that touches bytes = bump VERSION.
//
// Design: a random data key encrypts the payload. Each way of unlocking is a "slot" that wraps
// the data key under its own key-encryption key (KEK), LUKS-style:
//   shards       KEK = HKDF(S)                    S = Shamir secret, split into N shards
//   pass         KEK = HKDF(Argon2id(passphrase))
//   shards+pass  KEK = HKDF(S ‖ Argon2id(pass))   two-factor: neither alone suffices
//   passkey      KEK = HKDF(WebAuthn PRF output)  hardware-bound (Touch ID, YubiKey…)
// No public-key cryptography anywhere in the format, so nothing here falls to Shor's algorithm.
import { argon2id } from 'hash-wasm';
import { combine, split } from 'shamir-secret-sharing';

export const VERSION = 2;
// ponytail: whole payload is held in memory; a chunked/streaming format is the upgrade if >100 MB is ever needed
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_SHARDS = 16;
export const DEFAULT_KDF = { m: 65536, t: 3, p: 1 }; // 64 MiB, 3 passes

type Bytes = Uint8Array<ArrayBuffer>;
export type SlotType = 'shards' | 'pass' | 'shards+pass' | 'passkey';
export interface Kdf { name: 'argon2id'; m: number; t: number; p: number; salt: string }
export interface Slot { type: SlotType; iv: string; key: string; cred?: string; salt?: string; rp?: string }
export interface Header {
  v: 2;
  alg: 'AES-256-GCM';
  id: string;
  created: string;
  label: string;
  shamir: { k: number; n: number; fp: string } | null;
  kdf: Kdf | null;
  slots: Slot[];
}
export interface VaultFile { h: Header; iv: string; ct: string }
export interface Meta { kind: 'text' | 'file'; name: string; type: string; size: number }
export interface Plain { meta: Meta; data: Uint8Array }
export interface Opened extends Plain { via: SlotType; bad: number[] }
export interface Shard { id: string; i: number; k: number; n: number; fp: string; share: Bytes }
export interface PasskeyInput { cred: string; salt: string; rp: string; prf: Uint8Array }
export interface Policy {
  shards?: { k: number; n: number };
  passphrase?: string;
  requireBoth?: boolean; // shards AND passphrase, instead of either
  passkey?: PasskeyInput;
  label?: string;
  kdf?: { m: number; t: number; p: number };
}
export interface Unlock { shards?: Shard[]; passphrase?: string; prf?: Uint8Array }

export class VaultError extends Error {}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ID_RE = /^[0-9a-f]{16}$/;
const SLOT_TYPES: SlotType[] = ['shards', 'pass', 'shards+pass', 'passkey'];

export const rand = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function toB64(b: Uint8Array): string {
  const native = (b as { toBase64?: () => string }).toBase64;
  if (native) return native.call(b);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Bytes {
  const native = (Uint8Array as { fromBase64?: (s: string) => Bytes }).fromBase64;
  if (native) return native(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const toB64url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

const concat = (...parts: Uint8Array[]): Bytes => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
};
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
// 64-bit public fingerprint of the Shamir secret, so shard sets can be verified without the vault.
const fingerprint = async (secret: Uint8Array) => hex(await sha256(enc.encode('ztv2-fp'), secret)).slice(0, 16);
const checksum = async (body: string) => hex(await sha256(enc.encode(body))).slice(0, 8);
const aesKey = (raw: Bytes) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const aad = (h: Header) => enc.encode(JSON.stringify(h));
const slotAad = (id: string, type: SlotType) => enc.encode(`ztv2-slot:${id}:${type}`);

async function hkdf(ikm: Bytes, id: string, info: string): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`ztv2:${id}`), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

interface Factors { secret?: Bytes; passRaw?: Bytes; prf?: Bytes }
function kek(type: SlotType, id: string, f: Factors): Promise<CryptoKey> {
  switch (type) {
    case 'shards': return hkdf(f.secret!, id, 'ztv2/shards');
    case 'pass': return hkdf(f.passRaw!, id, 'ztv2/pass');
    case 'shards+pass': return hkdf(concat(f.secret!, f.passRaw!), id, 'ztv2/shards+pass');
    case 'passkey': return hkdf(f.prf!, id, 'ztv2/passkey');
  }
}

async function wrap(type: SlotType, id: string, f: Factors, dataKey: Bytes): Promise<Slot> {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: slotAad(id, type) }, await kek(type, id, f), dataKey);
  return { type, iv: toB64(iv), key: toB64(new Uint8Array(ct)) };
}

async function unwrap(slot: Slot, id: string, f: Factors): Promise<Bytes | null> {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(slot.iv), additionalData: slotAad(id, slot.type) }, await kek(slot.type, id, f), fromB64(slot.key)));
  } catch {
    return null;
  }
}

// Padmé padding: hides exact size, leaks only O(log log n) bits, costs <12% overhead.
export function padme(len: number): number {
  if (len < 2) return len;
  const e = Math.floor(Math.log2(len));
  const step = 2 ** (e - Math.floor(Math.log2(e)) - 1);
  return Math.ceil(len / step) * step;
}

function frame({ meta, data }: Plain): Bytes {
  const m = enc.encode(JSON.stringify(meta));
  const out = new Uint8Array(padme(4 + m.length + data.length));
  new DataView(out.buffer).setUint32(0, m.length);
  out.set(m, 4);
  out.set(data, 4 + m.length);
  return out;
}

function unframe(b: Bytes): Plain {
  const mLen = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (4 + mLen > b.length) throw new VaultError('Corrupt payload.');
  const meta = JSON.parse(dec.decode(b.subarray(4, 4 + mLen))) as Meta;
  const end = 4 + mLen + meta.size;
  if (!Number.isInteger(meta.size) || end > b.length) throw new VaultError('Corrupt payload.');
  return { meta, data: b.slice(4 + mLen, end) };
}

async function argonRaw(pass: string, kdf: Kdf): Promise<Bytes> {
  // Bounds stop a crafted header from asking for 100 GB of RAM.
  const ok = kdf.name === 'argon2id' && kdf.m >= 8192 && kdf.m <= 1048576 && kdf.t >= 1 && kdf.t <= 20 && kdf.p >= 1 && kdf.p <= 8;
  if (!ok) throw new VaultError('Unsupported key-derivation parameters in this vault.');
  return new Uint8Array(await argon2id({
    password: pass.normalize('NFC'), salt: fromB64(kdf.salt),
    memorySize: kdf.m, iterations: kdf.t, parallelism: kdf.p, hashLength: 32, outputType: 'binary',
  }));
}

// ---------------- Shards ----------------
export async function encodeShard(s: Shard): Promise<string> {
  const body = `ztv2.${s.id}.${s.i}.${s.k}.${s.n}.${s.fp}.${toB64url(s.share)}`;
  return `${body}.${await checksum(body)}`;
}

export async function parseShard(text: string): Promise<Shard> {
  const parts = text.trim().split('.');
  if (parts.length !== 8 || parts[0] !== 'ztv2') throw new VaultError('Not a Zero-Trust Vault shard.');
  const [, id, i, k, n, fp, share, chk] = parts;
  if ((await checksum(parts.slice(0, 7).join('.'))) !== chk) throw new VaultError('Checksum failed — this shard has a typo or is damaged.');
  return { id, i: +i, k: +k, n: +n, fp, share: fromB64url(share) };
}

/** Pull every shard-looking token out of arbitrary text (pasted blobs, .key files, QR payloads). */
export const shardTokens = (text: string) => text.split(/\s+/).filter((t) => t.startsWith('ztv2.'));

function* subsets<T>(xs: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i <= xs.length - (k - acc.length); i++) yield* subsets(xs, k, i + 1, [...acc, xs[i]]);
}

/**
 * Rebuild the Shamir secret. With more than k shards, a failed fingerprint triggers cheater
 * detection: search k-subsets for one that reconstructs, then test every other shard against it.
 */
export async function recoverSecret(shards: Shard[]): Promise<{ secret: Bytes; bad: number[] }> {
  if (!shards.length) throw new VaultError('No shards provided.');
  const { id, k, n, fp } = shards[0];
  if (shards.some((s) => s.id !== id || s.k !== k || s.n !== n || s.fp !== fp)) throw new VaultError('These shards come from different vaults.');
  const unique = [...new Map(shards.map((s) => [s.i, s])).values()];
  if (unique.length < k) throw new VaultError(`Need ${k} different shards — have ${unique.length}.`);

  const attempt = async (set: Shard[]): Promise<Bytes | null> => {
    try {
      const s = new Uint8Array(await combine(set.map((x) => x.share)));
      if ((await fingerprint(s)) === fp) return s;
      s.fill(0);
    } catch { /* malformed share */ }
    return null;
  };
  const all = await attempt(unique);
  if (all) return { secret: all, bad: [] };
  if (unique.length === k) throw new VaultError('Shards did not reconstruct the key — one is damaged, forged, or from a different set.');

  let tries = 0;
  for (const set of subsets(unique, k)) {
    if (++tries > 20_000) break; // ponytail: bounded search; C(16,8)=12870 so every real case fits
    const secret = await attempt(set);
    if (!secret) continue;
    const bad: number[] = [];
    for (const x of unique) {
      if (set.includes(x)) continue;
      const check = await attempt([...set.slice(1), x]);
      if (check) check.fill(0); else bad.push(x.i);
    }
    return { secret, bad };
  }
  throw new VaultError('No combination of these shards reconstructs the key. Too many are damaged or forged.');
}

export async function verifyShards(shards: Shard[]): Promise<{ bad: number[] }> {
  const { secret, bad } = await recoverSecret(shards);
  secret.fill(0);
  return { bad };
}

// ---------------- Seal / open ----------------
export async function seal(plain: Plain, policy: Policy): Promise<{ file: VaultFile; shards: string[] }> {
  if (!policy.shards && !policy.passphrase && !policy.passkey) throw new VaultError('Choose at least one way to unlock.');
  if (policy.requireBoth && !(policy.shards && policy.passphrase)) throw new VaultError('"Require both" needs shards and a passphrase.');
  if (plain.data.length > MAX_BYTES) throw new VaultError('Payload is larger than 100 MB.');
  const id = hex(rand(8));
  const dataKey = rand(32);
  const f: Factors = {};
  try {
    let shamir: Header['shamir'] = null;
    let shards: string[] = [];
    if (policy.shards) {
      const { k, n } = policy.shards;
      if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || k > n || n > MAX_SHARDS) {
        throw new VaultError(`Threshold must be 2…shard count, with at most ${MAX_SHARDS} shards.`);
      }
      f.secret = rand(32);
      shamir = { k, n, fp: await fingerprint(f.secret) };
      const parts = await split(f.secret, n, k);
      shards = await Promise.all(parts.map((s, i) => encodeShard({ id, i: i + 1, k, n, fp: shamir!.fp, share: new Uint8Array(s) })));
    }
    let kdf: Kdf | null = null;
    if (policy.passphrase) {
      kdf = { name: 'argon2id', ...(policy.kdf ?? DEFAULT_KDF), salt: toB64(rand(16)) };
      f.passRaw = await argonRaw(policy.passphrase, kdf);
    }
    const slots: Slot[] = [];
    if (policy.requireBoth) slots.push(await wrap('shards+pass', id, f, dataKey));
    else {
      if (f.secret) slots.push(await wrap('shards', id, f, dataKey));
      if (f.passRaw) slots.push(await wrap('pass', id, f, dataKey));
    }
    if (policy.passkey) {
      const { cred, salt, rp, prf } = policy.passkey;
      if (prf.length < 32) throw new VaultError('Passkey returned too little key material.');
      slots.push({ ...(await wrap('passkey', id, { prf: new Uint8Array(prf) }, dataKey)), cred, salt, rp });
    }
    const h: Header = { v: 2, alg: 'AES-256-GCM', id, created: new Date().toISOString(), label: (policy.label ?? '').trim().slice(0, 80), shamir, kdf, slots };
    const iv = rand(12);
    const meta = { ...plain.meta, size: plain.data.length };
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(h) }, await aesKey(dataKey), frame({ meta, data: plain.data }));
    return { file: { h, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }, shards };
  } finally {
    // best effort: JS cannot guarantee no copies survive in memory
    dataKey.fill(0); f.secret?.fill(0); f.passRaw?.fill(0);
  }
}

export async function open(file: VaultFile, u: Unlock): Promise<Opened> {
  const { h } = file;
  const slot = (t: SlotType) => h.slots.find((s) => s.type === t);
  const f: Factors = {};
  let bad: number[] = [];
  try {
    const given = [u.shards?.length, u.passphrase, u.prf].filter(Boolean).length;
    if (u.shards?.length) {
      if (h.shamir) {
        const s = u.shards[0];
        if (s.id !== h.id || s.fp !== h.shamir.fp) throw new VaultError(`These shards belong to vault ${s.id}, not ${h.id}.`);
        ({ secret: f.secret, bad } = await recoverSecret(u.shards));
      } else if (given === 1) throw new VaultError('This vault has no shards.');
    }
    if (u.passphrase) {
      if (h.kdf) f.passRaw = await argonRaw(u.passphrase, h.kdf);
      else if (given === 1) throw new VaultError('This vault has no passphrase.');
    }
    if (u.prf) f.prf = new Uint8Array(u.prf);

    const order: [SlotType, boolean][] = [['shards+pass', !!(f.secret && f.passRaw)], ['shards', !!f.secret], ['pass', !!f.passRaw], ['passkey', !!f.prf]];
    let dataKey: Bytes | null = null;
    let via: SlotType | null = null;
    for (const [t, have] of order) {
      const s = have && slot(t);
      if (s && (dataKey = await unwrap(s, h.id, f))) { via = t; break; }
    }
    if (!dataKey || !via) {
      if (f.secret && slot('shards+pass') && !f.passRaw) throw new VaultError('This vault needs its shards and the passphrase together.');
      if (f.passRaw && slot('shards+pass') && !slot('pass') && !f.secret) throw new VaultError('This vault needs its shards and the passphrase together.');
      if (f.passRaw) throw new VaultError('Wrong passphrase.');
      if (f.prf) throw new VaultError('That passkey does not match this vault.');
      throw new VaultError('These keys cannot open this vault.');
    }
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv), additionalData: aad(h) }, await aesKey(dataKey), fromB64(file.ct));
      return { ...unframe(new Uint8Array(pt)), via, bad };
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError('Decryption failed — the vault file was modified or damaged.');
    } finally {
      dataKey.fill(0);
    }
  } finally {
    f.secret?.fill(0); f.passRaw?.fill(0); f.prf?.fill(0);
  }
}

/** Validates untrusted input (uploaded file, cloud download, IndexedDB) into a VaultFile. */
export function parseVaultFile(text: string): VaultFile {
  let f: any;
  try { f = JSON.parse(text); } catch { throw new VaultError('Not a vault file (invalid JSON).'); }
  if (f && Array.isArray(f.iv) && Array.isArray(f.ciphertext)) throw new VaultError('This is a v1 record. Open it with legacy-v1.html from the repository.');
  const h = f?.h;
  const str = (x: unknown) => typeof x === 'string';
  const slotOk = (s: any) => s && SLOT_TYPES.includes(s.type) && str(s.iv) && str(s.key)
    && (s.type !== 'passkey' || (str(s.cred) && str(s.salt) && str(s.rp)))
    && (!s.type.includes('shards') || h.shamir)
    && (!s.type.includes('pass') || s.type === 'passkey' || h.kdf);
  const ok = h && h.v === VERSION && h.alg === 'AES-256-GCM' && ID_RE.test(h.id) && str(h.created) && str(h.label)
    && str(f.iv) && str(f.ct)
    && (h.shamir === null || (Number.isInteger(h.shamir?.k) && Number.isInteger(h.shamir?.n) && str(h.shamir?.fp)))
    && (h.kdf === null || (h.kdf?.name === 'argon2id' && str(h.kdf?.salt)))
    && Array.isArray(h.slots) && h.slots.length > 0 && h.slots.every(slotOk);
  if (!ok) throw new VaultError(h?.v > VERSION ? 'This vault was made by a newer version of the app.' : 'Not a valid v2 vault file.');
  return f as VaultFile;
}

export const isId = (s: string) => ID_RE.test(s);

/** Human summary of what opens a vault, e.g. "3 of 5 shards + passphrase · or passkey". */
export function describeSlots(h: Pick<Header, 'shamir' | 'slots'>): string {
  const names = h.slots.map((s) => s.type === 'shards' ? `any ${h.shamir!.k} of ${h.shamir!.n} shards`
    : s.type === 'pass' ? 'the passphrase'
    : s.type === 'shards+pass' ? `${h.shamir!.k} of ${h.shamir!.n} shards + the passphrase`
    : 'your passkey');
  return names.join(' · or ');
}
