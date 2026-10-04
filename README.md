# Zero-Trust Vault

Client-side, zero-knowledge encryption for things that must outlive you: seed phrases, recovery codes, wills, credentials, files.

You can split a vault's key into **Shamir shards** (any *K* of *N* open it), protect it with an **Argon2id passphrase**, or use both. The encrypted vault can live on the device, in the cloud, or in a file you keep yourself. Every cryptographic step runs in the browser tab. No server ever sees a key or plaintext.

The whole app builds into **one self-contained HTML file** with no CDN, no external requests, and nothing to install. Keep a copy next to your shards and your vaults stay openable even if this website disappears.

## Features

- **AES-256-GCM** encryption. The vault header (policy, KDF parameters, label) is bound as associated data, so editing any byte fails decryption.
- **Shamir secret sharing** via [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing), audited by Cure53 and Zellic. Configurable from 2 to 16 shards.
- **Argon2id** (64 MiB, 3 passes) for passphrases. The passphrase wraps the data key, so it works as an independent way to unlock.
- **Self-verifying shards.** Each shard carries a checksum (catches typos) and a key fingerprint, so a full recovery drill can run without the vault (*Verify* tab).
- **Printable recovery kit.** One page per shard with a QR code, the shard text and recovery instructions.
- **Padmé padding** hides exact payload sizes.
- **Air-gap mode.** Adds a runtime CSP `connect-src 'none'`. The browser then refuses all network requests from the tab, and the app proves it with a probe request.
- **Strict CSP + Trusted Types.** Hash-pinned inline script and style, no `eval`, no `innerHTML` and no external origins. The only permitted connection is your Supabase project, if one is configured.
- **Storage options:** IndexedDB on the device (asks for persistent storage), Supabase (per-user folders, write-once records, RLS), or a downloadable `.vault` file.
- **Offline:** service worker on the hosted site, plus a downloadable single-file build.

## Quick start

```bash
npm install
cp .env.example .env   # optional: add Supabase URL + anon key for cloud sync
npm run dev            # http://localhost:5173
npm run check          # typecheck + tests + production build → dist/
```

`dist/index.html` is the entire app. `dist/_headers` holds the production security headers for Netlify.

## Deploy

1. **Netlify:** connect the repo. `netlify.toml` runs `npm run check` and publishes `dist/`. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the site's environment variables, or leave them unset for a local-only deployment.
2. **Supabase (optional):** run [`supabase/migrations/0001_vault_store.sql`](supabase/migrations/0001_vault_store.sql) in the SQL editor. Read the note at the top: older, broader policies on `storage.objects` override these and must be dropped.
3. **Releases:** push a tag such as `v2.0.0`. CI builds a local-only HTML file and attaches it to a GitHub Release with `SHA256SUMS.txt`.

The Supabase anon key is public by design. Row-level security enforces access, and the server only ever holds ciphertext.

## File format (v2)

A `.vault` file is JSON:

```jsonc
{
  "h": {                         // header — authenticated as AES-GCM AAD (JSON.stringify(h))
    "v": 2, "alg": "AES-256-GCM",
    "id": "16 hex chars",
    "created": "ISO-8601", "label": "plaintext, ≤80 chars",
    "shamir": { "k": 3, "n": 5, "fp": "16 hex: SHA-256('ztv2-fp' ‖ key)[0..8]" } | null,
    "pass": { "kdf": { "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "b64" },
              "iv": "b64", "key": "b64: AES-GCM(KEK, dataKey, AAD='ztv2-wrap:'+id)" } | null
  },
  "iv": "b64 (12 bytes)",
  "ct": "b64: AES-GCM(dataKey, padmé(u32 metaLen ‖ metaJSON ‖ data), AAD=h)"
}
```

`meta` is `{ kind: "text" | "file", name, type, size }`, which keeps file names and types encrypted.

A **shard** is `ztv2.<id>.<index>.<k>.<n>.<fp>.<share b64url>.<checksum>`, where the checksum is the first 4 bytes of SHA-256 over everything before it.

Any change to bytes on disk requires bumping `v`. Readers reject versions they don't know. v1 records (from `legacy-v1.html`) are not readable by v2. Open them with the legacy file and re-seal them.

## Project layout

```
index.html                 markup (no inline scripts, styles or handlers; CSP-clean)
src/crypto.ts              format, seal/open, shards, validation (pure; runs in Node for tests)
src/crypto.test.ts         round-trips, tampering, wrong keys, shard typos, hostile headers
src/storage.ts             IndexedDB, Supabase, air-gap lock
src/main.ts                UI
src/style.css              design system (dark and light, mobile bottom bar, print kit)
vite.config.ts             single-file build + CSP hash generation + _headers
public/sw.js               offline cache for the hosted site
supabase/migrations/       bucket + RLS policies
```

## Limits

- Payloads up to 100 MB. Everything is held in memory, so larger files would need a chunked format.
- Argon2id runs on the main thread, and the UI pauses for about a second while it does.
- JavaScript cannot guarantee that key material is wiped from memory. Buffers are zeroed on a best-effort basis.
- Shards can't be scanned in the app yet. Scan the QR code with a phone camera and paste the text.
- See [SECURITY.md](SECURITY.md) for the threat model.
