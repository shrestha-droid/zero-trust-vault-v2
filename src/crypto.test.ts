import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  __testing, describeSlots, encodeShard, forgedShards, STRONG_KDF, MAX_BYTES, open, padme, parseShard, parseVaultFile, rand, seal, shardTokens, toB64, verifyShards,
  type Plain,
} from './crypto';

const FAST = { m: 8192, t: 1, p: 1 }; // real default is 64 MiB; keep tests quick
const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (s: string): Plain => ({ meta: { kind: 'text', name: 'note.txt', type: 'text/plain', size: 0 }, data: enc.encode(s) });
const roundTrip = (f: unknown) => parseVaultFile(JSON.stringify(f));
const parseAll = (xs: string[]) => Promise.all(xs.map(parseShard));
const passkey = () => ({ cred: 'Y3JlZA', salt: toB64(rand(32)), rp: 'vault.example', prf: rand(32) });

describe('seal/open', () => {
  it('opens with exactly k shards, any subset', async () => {
    const { file, shards } = await seal(text('hello'), { shards: { k: 3, n: 5 } });
    expect(shards).toHaveLength(5);
    for (const subset of [[0, 1, 2], [2, 3, 4], [0, 4, 2]]) {
      const out = await open(roundTrip(file), { shards: await parseAll(subset.map((i) => shards[i])) });
      expect(dec.decode(out.data)).toBe('hello');
      expect(out.via).toBe('shards');
    }
  });

  it('refuses k-1 shards and duplicate shards', async () => {
    const { file, shards } = await seal(text('x'), { shards: { k: 3, n: 5 } });
    await expect(open(file, { shards: await parseAll(shards.slice(0, 2)) })).rejects.toThrow(/Need 3/);
    await expect(open(file, { shards: await parseAll([shards[0], shards[0], shards[1]]) })).rejects.toThrow(/Need 3/);
  });

  it('refuses shards from another vault', async () => {
    const a = await seal(text('a'), { shards: { k: 2, n: 2 } });
    const b = await seal(text('b'), { shards: { k: 2, n: 2 } });
    await expect(open(a.file, { shards: await parseAll(b.shards) })).rejects.toThrow(/belong to vault/);
    await expect(verifyShards(await parseAll([a.shards[0], b.shards[1]]))).rejects.toThrow(/different vaults/);
  });

  // v1 bug: the passphrase-derived key was split into shards and the passphrase was never usable to decrypt.
  it('passphrase alone opens a passphrase vault; wrong one fails', async () => {
    const { file, shards } = await seal(text('secret'), { passphrase: 'correct horse', kdf: FAST });
    expect(shards).toEqual([]);
    expect(dec.decode((await open(roundTrip(file), { passphrase: 'correct horse' })).data)).toBe('secret');
    await expect(open(file, { passphrase: 'wrong' })).rejects.toThrow(/Wrong passphrase/);
  });

  it('"either" policy opens with shards or passphrase', async () => {
    const { file, shards } = await seal(text('both'), { shards: { k: 2, n: 3 }, passphrase: 'pw', kdf: FAST });
    expect((await open(file, { passphrase: 'pw' })).via).toBe('pass');
    expect((await open(file, { shards: await parseAll(shards.slice(1)) })).via).toBe('shards');
  });

  it('"require both" needs shards AND passphrase — either alone fails', async () => {
    const { file, shards } = await seal(text('2fa'), { shards: { k: 2, n: 3 }, passphrase: 'pw', requireBoth: true, kdf: FAST });
    const keys = await parseAll(shards.slice(0, 2));
    expect(file.h.slots.map((s) => s.type)).toEqual(['shards+pass']);
    await expect(open(file, { shards: keys })).rejects.toThrow(/together/);
    await expect(open(file, { passphrase: 'pw' })).rejects.toThrow(/together/);
    await expect(open(file, { shards: keys, passphrase: 'nope' })).rejects.toThrow(/Wrong passphrase/);
    const out = await open(roundTrip(file), { shards: keys, passphrase: 'pw' });
    expect([dec.decode(out.data), out.via]).toEqual(['2fa', 'shards+pass']);
  });

  it('passkey slot opens with the matching PRF output only', async () => {
    const pk = passkey();
    const { file } = await seal(text('pk'), { shards: { k: 2, n: 2 }, passkey: { ...pk, prf: pk.prf.slice() } });
    expect(file.h.slots.find((s) => s.type === 'passkey')).toMatchObject({ cred: pk.cred, rp: pk.rp, salt: pk.salt });
    expect((await open(roundTrip(file), { prf: pk.prf.slice() })).via).toBe('passkey');
    await expect(open(file, { prf: rand(32) })).rejects.toThrow(/passkey does not match/);
    expect(describeSlots(file.h)).toBe('any 2 of 2 shards · or your passkey');
  });

  it('a slot moved to another vault does not unwrap (slot AAD binds vault id)', async () => {
    const a = await seal(text('a'), { passphrase: 'pw', kdf: FAST });
    const b = await seal(text('b'), { passphrase: 'pw', kdf: FAST });
    const franken = structuredClone(b.file);
    franken.h.slots = a.file.h.slots;
    franken.h.kdf = a.file.h.kdf;
    await expect(open(franken, { passphrase: 'pw' })).rejects.toThrow(/Wrong passphrase/);
  });

  it('detects tampering with header, ciphertext, and KDF params', async () => {
    const { file, shards } = await seal(text('tamper'), { shards: { k: 2, n: 2 }, passphrase: 'pw', kdf: FAST });
    const keys = await parseAll(shards);
    const relabeled = structuredClone(file); relabeled.h.label = 'evil';
    await expect(open(relabeled, { shards: keys })).rejects.toThrow(/modified/);
    const flipped = structuredClone(file);
    flipped.ct = (flipped.ct[0] === 'A' ? 'B' : 'A') + flipped.ct.slice(1);
    await expect(open(flipped, { shards: keys })).rejects.toThrow(/modified/);
    const weakened = structuredClone(file); weakened.h.kdf!.t = 2;
    await expect(open(weakened, { passphrase: 'pw' })).rejects.toThrow(/Wrong passphrase|modified/);
    const stripped = structuredClone(file); stripped.h.slots = stripped.h.slots.filter((s) => s.type === 'pass');
    await expect(open(stripped, { passphrase: 'pw' })).rejects.toThrow(/modified/);
  });

  it('round-trips binary files byte-exact', async () => {
    const data = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) & 255);
    const { file, shards } = await seal({ meta: { kind: 'file', name: 'a.bin', type: 'application/octet-stream', size: 0 }, data }, { shards: { k: 2, n: 3 } });
    const out = await open(roundTrip(file), { shards: await parseAll(shards.slice(0, 2)) });
    expect(out.meta).toMatchObject({ kind: 'file', name: 'a.bin', size: 70_000 });
    expect(out.data).toEqual(data);
  });

  it('rejects bad policies and oversized payloads', async () => {
    await expect(seal(text('x'), {})).rejects.toThrow(/at least one/);
    await expect(seal(text('x'), { shards: { k: 1, n: 3 } })).rejects.toThrow(/Threshold/);
    await expect(seal(text('x'), { shards: { k: 4, n: 3 } })).rejects.toThrow(/Threshold/);
    await expect(seal(text('x'), { passphrase: 'pw', requireBoth: true })).rejects.toThrow(/needs shards/);
    const big = { meta: text('').meta, data: { length: MAX_BYTES + 1 } as Uint8Array };
    await expect(seal(big, { passphrase: 'x' })).rejects.toThrow(/100 MB/);
  });
});

describe('shards', () => {
  it('checksum catches a single-character typo', async () => {
    const { shards } = await seal(text('x'), { shards: { k: 2, n: 2 } });
    const s = shards[0];
    const i = s.lastIndexOf('.') - 3;
    const typo = s.slice(0, i) + (s[i] === 'a' ? 'b' : 'a') + s.slice(i + 1);
    await expect(parseShard(typo)).rejects.toThrow(/Checksum/);
    await expect(parseShard('hello')).rejects.toThrow(/Not a/);
  });

  it('verifies a shard set without the vault', async () => {
    const { shards } = await seal(text('x'), { shards: { k: 3, n: 4 } });
    await expect(verifyShards(await parseAll(shards.slice(1)))).resolves.toEqual({ bad: [] });
  });

  // A malicious holder can produce a shard with a *valid* checksum but a forged share.
  it('identifies a forged shard and still recovers with k+1 shards', async () => {
    const { file, shards } = await seal(text('cheat'), { shards: { k: 3, n: 5 } });
    const parsed = await parseAll(shards);
    const forged = { ...parsed[1], share: parsed[1].share.slice() };
    forged.share[0] ^= 0xff; // keep the x-coordinate (last byte) intact
    const evil = await parseShard(await encodeShard(forged));
    const set = [parsed[0], evil, parsed[2], parsed[3]];
    await expect(verifyShards(set)).resolves.toEqual({ bad: [2] });
    const out = await open(file, { shards: set });
    expect([dec.decode(out.data), out.bad]).toEqual(['cheat', [2]]);
    // v3 commitments name the forgery even with exactly k shards:
    await expect(open(file, { shards: [parsed[0], evil, parsed[2]] })).rejects.toThrow(/#2 doesn't match this vault .*Bring 1 more/);
  });

  it('extracts shard tokens from messy pasted text', async () => {
    const { shards } = await seal(text('x'), { shards: { k: 2, n: 2 } });
    expect(shardTokens(`Shard 1:\n  ${shards[0]}\r\n\nnotes ${shards[1]}  `)).toEqual(shards);
  });
});

describe('parseVaultFile', () => {
  it('rejects v1 records, junk, missing slots, and dangerous KDF params', async () => {
    expect(() => parseVaultFile('{"iv":[1],"ciphertext":[2]}')).toThrow(/v1 record/);
    expect(() => parseVaultFile('nope')).toThrow(/invalid JSON/);
    expect(() => parseVaultFile('{"h":{"v":4}}')).toThrow(/newer version/);
    const { file } = await seal(text('x'), { passphrase: 'pw', kdf: FAST });
    const noSlots = structuredClone(file); noSlots.h.slots = [];
    expect(() => roundTrip(noSlots)).toThrow(/Not a valid/);
    const orphan = structuredClone(file); orphan.h.slots[0].type = 'shards';
    expect(() => roundTrip(orphan)).toThrow(/Not a valid/);
    const evil = structuredClone(file); evil.h.kdf!.m = 64 * 1024 * 1024;
    await expect(open(evil, { passphrase: 'pw' })).rejects.toThrow(/key-derivation/);
  });
});

it('padme pads to coarse buckets and never shrinks', () => {
  for (const n of [0, 1, 2, 3, 100, 1000, 12345, 10 ** 7]) {
    expect(padme(n)).toBeGreaterThanOrEqual(n);
    expect(padme(n)).toBeLessThanOrEqual(Math.max(n * 1.12, n + 1));
  }
});

describe('format v3', () => {
  const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/v2-vault.json', import.meta.url), 'utf8'));

  it('still opens a real v2 vault (made by the v2 code) with shards and with the passphrase', async () => {
    const file = roundTrip(fixture.file);
    expect(file.h.v).toBe(2);
    expect(dec.decode((await open(file, { shards: await parseAll(fixture.shards.slice(1)) })).data)).toBe(fixture.plaintext);
    expect(dec.decode((await open(file, { passphrase: fixture.passphrase })).data)).toBe(fixture.plaintext);
    expect(await forgedShards(file.h, await parseAll(fixture.shards))).toEqual([]); // v2: no commitments, nothing flagged
  });

  it('writes v3 with a key commitment and one commitment per shard', async () => {
    const { file } = await seal(text('x'), { shards: { k: 2, n: 4 } });
    expect(file.h.v).toBe(3);
    expect(file.h.kc).toHaveLength(44);
    expect(file.h.shamir!.commits).toHaveLength(4);
    const noKc = structuredClone(file); delete noKc.h.kc;
    expect(() => roundTrip(noKc)).toThrow(/Not a valid/);
    const short = structuredClone(file); short.h.shamir!.commits!.pop();
    expect(() => roundTrip(short)).toThrow(/Not a valid/);
    expect(() => parseVaultFile(JSON.stringify({ ...file, h: { ...file.h, v: 4 } }))).toThrow(/newer version/);
  });

  it('names a forged shard with exactly k shards, and opens once a genuine one is added', async () => {
    const { file, shards } = await seal(text('commit'), { shards: { k: 3, n: 5 } });
    const parsed = await parseAll(shards);
    const forged = { ...parsed[3], share: parsed[3].share.slice() };
    forged.share[0] ^= 0x01;
    const evil = await parseShard(await encodeShard(forged)); // valid checksum, tampered share
    expect(await forgedShards(file.h, [parsed[0], evil, parsed[2]])).toEqual([4]);
    await expect(open(file, { shards: [parsed[0], evil, parsed[2]] })).rejects.toThrow(/#4 doesn't match/);
    const out = await open(file, { shards: [parsed[0], evil, parsed[2], parsed[1]] });
    expect([dec.decode(out.data), out.bad]).toEqual(['commit', [4]]);
  });

  // The attack key commitment exists for: a malicious sealer makes the passphrase slot unwrap to a
  // different key than the one the vault (and kc) was built for, to show different people different contents.
  it('rejects a vault whose key slot unwraps to a key other than the committed one', async () => {
    const { wrap, keyCommit, argonRaw, aad, aesKey } = __testing;
    const id = '00112233aabbccdd';
    const k1 = rand(32), k2 = rand(32);
    const kdf = { name: 'argon2id' as const, ...FAST, salt: toB64(rand(16)) };
    const passRaw = await argonRaw('pw', kdf);
    const h = { v: 3 as const, alg: 'AES-256-GCM' as const, id, created: new Date().toISOString(), label: '', shamir: null, kdf,
      slots: [await wrap('pass', id, { passRaw }, k2)], kc: await keyCommit(k1, id) };
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(h) }, await aesKey(k1), new Uint8Array(64));
    const evil = roundTrip({ h, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
    await expect(open(evil, { passphrase: 'pw' })).rejects.toThrow(/keys don't agree/);
  });

  it('hardens new passphrases with Argon2id at 256 MiB by default', async () => {
    const { file } = await seal(text('strong'), { passphrase: 'correct horse battery staple' });
    expect(file.h.kdf).toMatchObject({ m: STRONG_KDF.m, t: STRONG_KDF.t });
    expect(dec.decode((await open(roundTrip(file), { passphrase: 'correct horse battery staple' })).data)).toBe('strong');
  }, 30_000);
});
