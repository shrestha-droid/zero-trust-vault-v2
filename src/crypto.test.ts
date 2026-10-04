import { describe, expect, it } from 'vitest';
import { MAX_BYTES, open, padme, parseShard, parseVaultFile, seal, shardTokens, verifyShards, type Plain } from './crypto';

const FAST = { m: 8192, t: 1, p: 1 }; // real default is 64 MiB; keep tests quick
const enc = new TextEncoder();
const text = (s: string): Plain => ({ meta: { kind: 'text', name: 'note.txt', type: 'text/plain', size: 0 }, data: enc.encode(s) });
const roundTrip = (f: unknown) => parseVaultFile(JSON.stringify(f));
const parseAll = (xs: string[]) => Promise.all(xs.map(parseShard));

describe('seal/open', () => {
  it('opens with exactly k shards, any subset', async () => {
    const { file, shards } = await seal(text('hello'), { shards: { k: 3, n: 5 } });
    expect(shards).toHaveLength(5);
    for (const subset of [[0, 1, 2], [2, 3, 4], [0, 4, 2]]) {
      const out = await open(roundTrip(file), { shards: await parseAll(subset.map((i) => shards[i])) });
      expect(new TextDecoder().decode(out.data)).toBe('hello');
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
    expect(new TextDecoder().decode((await open(roundTrip(file), { passphrase: 'correct horse' })).data)).toBe('secret');
    await expect(open(file, { passphrase: 'wrong' })).rejects.toThrow(/Wrong passphrase/);
  });

  it('"either" policy opens with shards or passphrase', async () => {
    const { file, shards } = await seal(text('both'), { shards: { k: 2, n: 3 }, passphrase: 'pw', kdf: FAST });
    expect((await open(file, { passphrase: 'pw' })).data).toEqual(enc.encode('both'));
    expect((await open(file, { shards: await parseAll(shards.slice(1)) })).data).toEqual(enc.encode('both'));
  });

  it('detects tampering with header, ciphertext, and wrapped key', async () => {
    const { file, shards } = await seal(text('tamper'), { shards: { k: 2, n: 2 }, passphrase: 'pw', kdf: FAST });
    const keys = await parseAll(shards);
    const relabeled = structuredClone(file); relabeled.h.label = 'evil';
    await expect(open(relabeled, { shards: keys })).rejects.toThrow(/modified/);
    const flipped = structuredClone(file);
    flipped.ct = (flipped.ct[0] === 'A' ? 'B' : 'A') + flipped.ct.slice(1);
    await expect(open(flipped, { shards: keys })).rejects.toThrow(/modified/);
    const weakened = structuredClone(file); weakened.h.pass!.kdf.t = 2;
    await expect(open(weakened, { passphrase: 'pw' })).rejects.toThrow(/Wrong passphrase|modified/);
  });

  it('round-trips binary files byte-exact', async () => {
    const data = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) & 255);
    const { file, shards } = await seal({ meta: { kind: 'file', name: 'a.bin', type: 'application/octet-stream', size: 0 }, data }, { shards: { k: 2, n: 3 } });
    const out = await open(roundTrip(file), { shards: await parseAll(shards.slice(0, 2)) });
    expect(out.meta).toMatchObject({ kind: 'file', name: 'a.bin', size: 70_000 });
    expect(out.data).toEqual(data);
  });

  it('rejects bad policies and oversized payloads', async () => {
    await expect(seal(text('x'), {})).rejects.toThrow(/Choose/);
    await expect(seal(text('x'), { shards: { k: 1, n: 3 } })).rejects.toThrow(/Threshold/);
    await expect(seal(text('x'), { shards: { k: 4, n: 3 } })).rejects.toThrow(/Threshold/);
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
    await expect(verifyShards(await parseAll(shards.slice(1)))).resolves.toBeUndefined();
  });

  it('extracts shard tokens from messy pasted text', async () => {
    const { shards } = await seal(text('x'), { shards: { k: 2, n: 2 } });
    expect(shardTokens(`Shard 1:\n  ${shards[0]}\r\n\nnotes ${shards[1]}  `)).toEqual(shards);
  });
});

describe('parseVaultFile', () => {
  it('rejects v1 records, junk, and dangerous KDF params', async () => {
    expect(() => parseVaultFile('{"iv":[1],"ciphertext":[2]}')).toThrow(/v1 record/);
    expect(() => parseVaultFile('nope')).toThrow(/invalid JSON/);
    expect(() => parseVaultFile('{"h":{"v":3}}')).toThrow(/newer version/);
    const { file } = await seal(text('x'), { passphrase: 'pw', kdf: FAST });
    const evil = structuredClone(file); evil.h.pass!.kdf.m = 64 * 1024 * 1024;
    await expect(open(evil, { passphrase: 'pw' })).rejects.toThrow(/key-derivation/);
  });
});

it('padme pads to coarse buckets and never shrinks', () => {
  for (const n of [0, 1, 2, 3, 100, 1000, 12345, 10 ** 7]) {
    expect(padme(n)).toBeGreaterThanOrEqual(n);
    expect(padme(n)).toBeLessThanOrEqual(Math.max(n * 1.12, n + 1));
  }
});
