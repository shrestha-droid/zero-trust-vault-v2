// Vault format v2. Everything here is pure and runs in browsers and Node (tests).
// Spec: README.md#file-format. Changing anything that touches bytes = bump VERSION.
import { argon2id } from 'hash-wasm';
import { combine, split } from 'shamir-secret-sharing';

export const VERSION = 2;
// ponytail: whole payload is held in memory; a chunked/streaming format is the upgrade if >100 MB is ever needed
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_SHARDS = 16;
export const DEFAULT_KDF = { m: 65536, t: 3, p: 1 }; // 64 MiB, 3 passes

type Bytes = Uint8Array<ArrayBuffer>;
export interface Kdf { name: 'argon2id'; m: number; t: number; p: number; salt: string }
export interface Header {
  v: 2;
  alg: 'AES-256-GCM';
  id: string;
  created: string;
  label: string;
  shamir: { k: number; n: number; fp: string } | null;
  pass: { kdf: Kdf; iv: string; key: string } | null;
}
export interface VaultFile { h: Header; iv: string; ct: string }
export interface Meta { kind: 'text' | 'file'; name: string; type: string; size: number }
export interface Plain { meta: Meta; data: Uint8Array }
export interface Shard { id: string; i: number; k: number; n: number; fp: string; share: Bytes }
export interface Policy {
  shards?: { k: number; n: number };
  passphrase?: string;
  label?: string;
  kdf?: { m: number; t: number; p: number };
}

export class VaultError extends Error {}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ID_RE = /^[0-9a-f]{16}$/;

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
const toB64url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

const sha256 = async (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new Uint8Array(await subtle.digest('SHA-256', all));
};
// 64-bit public fingerprint of the key, so shard sets can be verified without the vault.
const fingerprint = async (key: Uint8Array) => hex(await sha256(enc.encode('ztv2-fp'), key)).slice(0, 16);
const checksum = async (body: string) => hex(await sha256(enc.encode(body))).slice(0, 8);
const aesKey = (raw: Bytes) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const aad = (h: Header) => enc.encode(JSON.stringify(h));
const wrapAad = (id: string) => enc.encode(`ztv2-wrap:${id}`);

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

async function deriveKek(pass: string, kdf: Kdf): Promise<CryptoKey> {
  // Bounds stop a crafted header from asking for 100 GB of RAM.
  const ok = kdf.name === 'argon2id' && kdf.m >= 8192 && kdf.m <= 1048576 && kdf.t >= 1 && kdf.t <= 20 && kdf.p >= 1 && kdf.p <= 8;
  if (!ok) throw new VaultError('Unsupported key-derivation parameters in this vault.');
  const raw = await argon2id({
    password: pass.normalize('NFC'), salt: fromB64(kdf.salt),
    memorySize: kdf.m, iterations: kdf.t, parallelism: kdf.p, hashLength: 32, outputType: 'binary',
  });
  return aesKey(new Uint8Array(raw));
}

async function encodeShard(s: Shard): Promise<string> {
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

/** Pull every shard-looking token out of arbitrary text (pasted blobs, .key files). */
export const shardTokens = (text: string) => text.split(/\s+/).filter((t) => t.startsWith('ztv2.'));

export async function recoverKey(shards: Shard[]): Promise<Bytes> {
  if (!shards.length) throw new VaultError('No shards provided.');
  const { id, k, n, fp } = shards[0];
  if (shards.some((s) => s.id !== id || s.k !== k || s.n !== n || s.fp !== fp)) throw new VaultError('These shards come from different vaults.');
  const unique = [...new Map(shards.map((s) => [s.i, s])).values()];
  if (unique.length < k) throw new VaultError(`Need ${k} different shards — have ${unique.length}.`);
  const key = new Uint8Array(await combine(unique.map((s) => s.share)));
  if ((await fingerprint(key)) !== fp) throw new VaultError('Shards did not reconstruct the key — one is from a different set.');
  return key;
}

export async function seal(plain: Plain, policy: Policy): Promise<{ file: VaultFile; shards: string[] }> {
  if (!policy.shards && !policy.passphrase) throw new VaultError('Choose shards, a passphrase, or both.');
  if (plain.data.length > MAX_BYTES) throw new VaultError('Payload is larger than 100 MB.');
  const id = hex(rand(8));
  const key = rand(32);
  try {
    let shamir: Header['shamir'] = null;
    let shards: string[] = [];
    if (policy.shards) {
      const { k, n } = policy.shards;
      if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || k > n || n > MAX_SHARDS) {
        throw new VaultError(`Threshold must be 2…shard count, with at most ${MAX_SHARDS} shards.`);
      }
      shamir = { k, n, fp: await fingerprint(key) };
      const parts = await split(key, n, k);
      shards = await Promise.all(parts.map((s, i) => encodeShard({ id, i: i + 1, k, n, fp: shamir!.fp, share: new Uint8Array(s) })));
    }
    let pass: Header['pass'] = null;
    if (policy.passphrase) {
      const kdf: Kdf = { name: 'argon2id', ...(policy.kdf ?? DEFAULT_KDF), salt: toB64(rand(16)) };
      const iv = rand(12);
      const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(id) }, await deriveKek(policy.passphrase, kdf), key);
      pass = { kdf, iv: toB64(iv), key: toB64(new Uint8Array(wrapped)) };
    }
    const h: Header = { v: 2, alg: 'AES-256-GCM', id, created: new Date().toISOString(), label: (policy.label ?? '').trim().slice(0, 80), shamir, pass };
    const iv = rand(12);
    const meta = { ...plain.meta, size: plain.data.length };
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(h) }, await aesKey(key), frame({ meta, data: plain.data }));
    return { file: { h, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }, shards };
  } finally {
    key.fill(0); // best effort: JS cannot guarantee no copies survive in memory
  }
}

export async function open(file: VaultFile, unlock: { shards?: Shard[]; passphrase?: string }): Promise<Plain> {
  const { h } = file;
  let key: Bytes;
  if (unlock.shards?.length) {
    if (!h.shamir) throw new VaultError('This vault has no shards — use its passphrase.');
    const s = unlock.shards[0];
    if (s.id !== h.id || s.fp !== h.shamir.fp) throw new VaultError(`These shards belong to vault ${s.id}, not ${h.id}.`);
    key = await recoverKey(unlock.shards);
  } else if (unlock.passphrase) {
    if (!h.pass) throw new VaultError('This vault has no passphrase — use its shards.');
    const kek = await deriveKek(unlock.passphrase, h.pass.kdf);
    try {
      key = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(h.pass.iv), additionalData: wrapAad(h.id) }, kek, fromB64(h.pass.key)));
    } catch {
      throw new VaultError('Wrong passphrase.');
    }
  } else {
    throw new VaultError('Provide shards or the passphrase.');
  }
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv), additionalData: aad(h) }, await aesKey(key), fromB64(file.ct));
    return unframe(new Uint8Array(pt));
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError('Decryption failed — the vault file was modified or damaged.');
  } finally {
    key.fill(0);
  }
}

export async function verifyShards(shards: Shard[]): Promise<void> {
  (await recoverKey(shards)).fill(0);
}

/** Validates untrusted input (uploaded file, cloud download, IndexedDB) into a VaultFile. */
export function parseVaultFile(text: string): VaultFile {
  let f: any;
  try { f = JSON.parse(text); } catch { throw new VaultError('Not a vault file (invalid JSON).'); }
  if (f && Array.isArray(f.iv) && Array.isArray(f.ciphertext)) throw new VaultError('This is a v1 record. Open it with legacy-v1.html from the repository.');
  const h = f?.h;
  const str = (x: unknown) => typeof x === 'string';
  const ok = h && h.v === VERSION && h.alg === 'AES-256-GCM' && ID_RE.test(h.id) && str(h.created) && str(h.label)
    && str(f.iv) && str(f.ct)
    && (h.shamir === null || (Number.isInteger(h.shamir?.k) && Number.isInteger(h.shamir?.n) && str(h.shamir?.fp)))
    && (h.pass === null || (str(h.pass?.iv) && str(h.pass?.key) && str(h.pass?.kdf?.salt)))
    && (h.shamir || h.pass);
  if (!ok) throw new VaultError(h?.v > VERSION ? 'This vault was made by a newer version of the app.' : 'Not a valid v2 vault file.');
  return f as VaultFile;
}

export const isId = (s: string) => ID_RE.test(s);
