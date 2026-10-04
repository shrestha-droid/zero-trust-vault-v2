# Zero-Trust Vault

Client-side, zero-knowledge encryption for things that must outlive you: seed phrases, recovery codes, wills, credentials, files.

A vault can be unlocked by **Shamir shards** (any *K* of *N*), an **Argon2id passphrase**, **both together** (two-factor), or a **hardware passkey** (Touch ID, Windows Hello, YubiKey) via WebAuthn PRF. Each method is an independent, LUKS-style key slot. All cryptography runs in an isolated Web Worker on your device. No server ever sees a key or plaintext.

The whole app builds into **one self-contained HTML file** with no CDN, no external requests, and nothing to install. Keep a copy next to your shards and your vaults stay openable even if this website disappears.

## Features

**Cryptography**
- **AES-256-GCM** payload encryption. The vault header (policy, KDF parameters, slots, label) is bound as associated data, so changing any byte fails decryption.
- **Key slots:** a random data key is wrapped once per unlock method, under a KEK from HKDF-SHA256. Each slot's associated data binds it to its vault and type, so slots can't be moved between vaults or reinterpreted.
- **Shamir secret sharing** via [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing), audited by Cure53 and Zellic. Configurable from 2 to 16 shards.
- **Forged-shard detection:** given more than *K* shards, the app finds a consistent *K*-subset, recovers the key, and names the shards that don't fit, even if a holder forged one with a valid checksum.
- **Two-factor vaults:** KEK = HKDF(Shamir secret ‖ Argon2id(passphrase)). Stolen shards alone are useless, and so is a leaked passphrase.
- **Passkeys (WebAuthn PRF):** the authenticator derives a secret in hardware, with a per-vault salt. Synced passkeys work on every device they sync to (same domain).
- **Argon2id** (64 MiB, 3 passes), with KDF parameters bounds-checked to stop memory-exhaustion headers.
- **Padmé padding** hides exact payload sizes.
- **Post-quantum by construction:** the format uses no public-key cryptography. AES-256, HMAC/HKDF-SHA256 and Shamir (information-theoretic) leave a quantum adversary nothing better than Grover-speed brute force.

**Isolation and hardening**
- **Crypto Web Worker:** data keys and Shamir secrets live only in a dedicated worker, never in the page's heap. Argon2 doesn't freeze the UI. If a browser can't start the worker, the app falls back to in-page crypto.
- **Strict CSP:** hash-pinned inline script and style, `wasm-unsafe-eval` only for Argon2, no external origins, and blob: workers only.
- **Trusted Types:** a single `default` policy that admits only the service worker URL and the crypto worker's blob. The UI never uses `innerHTML`.
- **Air-gap mode:** adds a runtime CSP `connect-src 'none'`, which the browser enforces for the life of the tab. The app proves it with a probe request.
- **Memory hygiene:** decrypted data auto-clears after 5 minutes, or after a minute in a background tab. Copied secrets are cleared from the clipboard after 45 s. Key buffers are zeroed after use.

**Recovery UX**
- **Verify tab:** a recovery drill without the vault. It checks checksums and set membership, rebuilds the key in memory, matches it against the fingerprint, and flags forged shards.
- **Printable recovery kit:** one page per shard with a QR code, the shard text, and instructions that state exactly what else is needed.
- **In-app QR scanning:** the native BarcodeDetector where available, with jsQR as the fallback (iOS Safari).
- **Re-key:** re-seal an opened vault under a new key and new shards, then delete the old record so the old shards become useless.
- **Self-verifying shards:** a per-shard checksum catches typos, and a key fingerprint catches mixed-up sets.

**Storage:** IndexedDB on the device (asks for persistent storage), Supabase (per-user folders, write-once records, RLS), or a downloadable `.vault` file.

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

Passkey slots are bound to the domain they were created on (the WebAuthn RP ID). They don't work from the offline file. Always pair a passkey with shards or a passphrase.

## File format (v2)

A `.vault` file is JSON:

```jsonc
{
  "h": {                                  // header: authenticated as AES-GCM AAD (JSON.stringify(h))
    "v": 2, "alg": "AES-256-GCM",
    "id": "16 hex chars", "created": "ISO-8601", "label": "plaintext, ≤80 chars",
    "shamir": { "k": 3, "n": 5, "fp": "SHA-256('ztv2-fp' ‖ S)[0..8] hex" } | null,
    "kdf": { "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "b64" } | null,
    "slots": [
      { "type": "shards" | "pass" | "shards+pass" | "passkey",
        "iv": "b64", "key": "b64: AES-GCM(KEK, dataKey, AAD = 'ztv2-slot:' id ':' type)",
        "cred": "b64url credential id", "salt": "b64 PRF salt", "rp": "domain" }   // passkey only
    ]
  },
  "iv": "b64 (12 bytes)",
  "ct": "b64: AES-GCM(dataKey, padmé(u32 metaLen ‖ metaJSON ‖ data), AAD = h)"
}
```

The KEK for each slot is `HKDF-SHA256(ikm, salt = 'ztv2:' id, info = 'ztv2/' type)`, where:

| slot | ikm |
|---|---|
| `shards` | S (32-byte Shamir secret) |
| `pass` | Argon2id(passphrase, kdf) |
| `shards+pass` | S ‖ Argon2id(passphrase, kdf) |
| `passkey` | WebAuthn PRF(cred, salt) |

`meta` is `{ kind: "text" | "file", name, type, size }`, which keeps file names and types encrypted.

A **shard** is `ztv2.<id>.<index>.<k>.<n>.<fp>.<share b64url>.<checksum>`, where the checksum is the first 4 bytes of SHA-256 over everything before it.

Any change to bytes on disk requires bumping `v`. Readers reject versions they don't know. v1 records (from `legacy-v1.html`) are not readable by v2. Open them with the legacy file and re-seal them.

## Project layout

```
index.html                 markup (no inline scripts, styles or handlers; CSP-clean)
src/crypto.ts              format, key slots, seal/open, shards + cheater detection, validation (pure; Node-testable)
src/crypto.test.ts         round-trips, 2FA, passkey slots, forged shards, slot swapping, tampering, hostile headers
src/worker.ts              crypto worker (RPC over postMessage)
src/storage.ts             IndexedDB, Supabase, air-gap lock
src/main.ts                UI, passkeys, QR scanner, auto-clear
src/style.css              design system (dark and light, mobile bottom bar, print kit)
vite.config.ts             single-file build + CSP hash generation + _headers
public/sw.js               offline cache for the hosted site
supabase/migrations/       bucket + RLS policies
```

## Limits

- Payloads up to 100 MB. Everything is held in memory, so larger files would need a chunked format.
- JavaScript cannot guarantee that key material is wiped from memory. Buffers are zeroed on a best-effort basis.
- Passkey slots need the HTTPS site on the same domain, plus an authenticator with PRF support (recent iCloud Keychain, Google Password Manager, Windows Hello, YubiKey 5).
- See [SECURITY.md](SECURITY.md) for the threat model.
