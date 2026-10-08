# Zero-Trust Vault

[![CI](https://github.com/shrestha-droid/zero-trust-vault-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/shrestha-droid/zero-trust-vault-v2/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-b5121b.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-16120f.svg)](SECURITY.md)

**Beta, not yet independently audited.** The secret-sharing library is (Cure53, Zellic); this application is not. Read [SECURITY.md](SECURITY.md) for what is and isn't covered, and keep a backup of anything critical.

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
- **Evidence is public:** the [security page](site/security.html) publishes the file format, names the audited library with its report links, and prints the offline app's SHA-256 (computed at build, so it can't drift).
- **Argon2id** (256 MiB, 2 passes; 64 MiB fallback), with KDF parameters bounds-checked to stop memory-exhaustion headers.
- **Key-committed** (v3): every unlocking key must match a commitment in the header, closing AES-GCM's multi-key ("invisible salamanders") gap.
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

**Storage:** IndexedDB on the device (asks for persistent storage), the user's **own Google Drive** (browser talks to Google directly, `drive.file` scope, no server involved), Supabase (per-user folders, write-once records, RLS), or a downloadable `.vault` file.

**Accounts:** optional. Sign in with Google, Apple, GitHub, Microsoft or a passwordless email link (Supabase Auth, PKCE). An account never holds keys; it only syncs ciphertext and powers Legacy.

## Quick start

```bash
git clone https://github.com/shrestha-droid/zero-trust-vault-v2.git && cd zero-trust-vault-v2
npm install
cp .env.example .env   # optional: add Supabase URL + anon key for cloud sync
npm run dev            # http://localhost:5173
npm run check          # typecheck + tests + production build → dist/
```

`dist/app/index.html` is the entire app; `dist/` also holds the marketing site.

## Deploy

Vercel hosts the site, the app and three serverless functions. Supabase provides auth, the database and encrypted file storage. Dodo Payments (merchant of record) handles payments and tax and Resend sends Legacy emails. **[LAUNCH.md](LAUNCH.md) is the step-by-step go-live checklist.**

```
/            marketing site (site/: no JavaScript, script-src 'none')
/app/        the app (single self-contained HTML file, installable as a PWA)
/api/*       Vercel Functions: billing-webhook, checkout, legacy-tick (daily cron), legacy-checkin
```

The app's Content Security Policy is generated at build time with script/style hashes and embedded as a `<meta>` tag, so it protects the hosted app and the downloaded offline file alike. `vercel.json` adds the static headers (HSTS, frame denial and so on).

The Supabase anon key is public by design. Row-level security enforces access (and is tested against real Postgres in `supabase/rls.test.ts`), and the server only ever holds ciphertext.

Passkey slots are bound to the domain they were created on (the WebAuthn RP ID). They don't work from the offline file, so the app refuses passkey-only vaults.

## Plans

| | Free | Pro |
|---|---|---|
| All cryptography, unlimited local vaults, offline app | ✓ | ✓ |
| Encrypted cloud vaults | 2 | Unlimited |
| Legacy (dead man's switch) | | ✓ |

Entitlements are written only by the billing webhook (service role) and enforced in Postgres via RLS, not in the browser. Opening a vault never requires a plan. An armed Legacy plan is delivered even if billing lapses; Pro is only needed to create or edit one.

## File format (v3; v2 still readable)

A `.vault` file is JSON:

```jsonc
{
  "h": {                                  // header: authenticated as AES-GCM AAD (JSON.stringify(h))
    "v": 3, "alg": "AES-256-GCM",
    "id": "16 hex chars", "created": "ISO-8601", "label": "plaintext, ≤80 chars",
    "shamir": { "k": 3, "n": 5, "fp": "SHA-256('ztv2-fp' ‖ S)[0..8] hex",
                "commits": ["SHA-256('ztv3-share:' id ':' i ':' ‖ share_i)[0..16] hex", "…one per shard"] } | null,
    "kdf": { "name": "argon2id", "m": 262144, "t": 2, "p": 1, "salt": "b64" } | null,   // 64 MiB/3 if 256 MiB can't be allocated
    "kc": "b64: HMAC-SHA256(dataKey, 'ztv3-commit:' id)",                             // key commitment
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

**What v3 adds over v2**

- **Key commitment (`kc`).** AES-GCM is not key-committing: a malicious sealer could build slots that unwrap to *different* keys, with a ciphertext valid under both, and show different trustees different contents ("invisible salamanders"). Every key a slot unwraps must match `kc` before decryption.
- **Shard commitments (`commits`).** A forged shard with a valid checksum is named even when exactly *k* shards are presented, and each holder can check their own shard against the vault. Hash-based, so unlike Feldman/Pedersen verifiable secret sharing it stays post-quantum.
- **Argon2id at 256 MiB** by default, falling back to 64 MiB where the device can't allocate it. Parameters are in the header, so every vault opens with exactly what it was sealed with (bounded to ≤1 GiB against hostile headers).

v2 vaults (no `kc`, no `commits`, `"v": 2`) remain readable; `src/__fixtures__/v2-vault.json` is a real v2 vault that the test suite opens on every run.

A **shard** is `ztv2.<id>.<index>.<k>.<n>.<fp>.<share b64url>.<checksum>`, where the checksum is the first 4 bytes of SHA-256 over everything before it.

Any change to bytes on disk requires bumping `v`. Readers reject versions they don't know. v1 records (from `legacy-v1.html`) are not readable by v2/v3. Open them with the legacy file and re-seal them.

## Project layout

```
index.html                 markup (no inline scripts, styles or handlers; CSP-clean)
src/crypto.ts              format, key slots, seal/open, shards + cheater detection, validation (pure; Node-testable)
src/crypto.test.ts         round-trips, 2FA, passkey slots, forged shards, slot swapping, tampering, hostile headers
src/worker.ts              crypto worker (RPC over postMessage)
src/storage.ts             IndexedDB, Supabase, air-gap lock
src/main.ts                UI, sign-in, passkeys, QR scanner, auto-clear, plans, Legacy
src/gdrive.ts              Google Drive client (own-Drive storage) + OAuth redirect parsing
src/style.css              design system (dark and light, mobile bottom bar, print kit)
public/                    service worker, PWA manifest and icons (served under /app/)
site/                      marketing site, terms, privacy, social image (served at /)
server/                    billing + Legacy logic (pure, tested) and env/Supabase admin client
api/                       Vercel Functions wiring server/ to Dodo Payments, Supabase and Resend
supabase/migrations/       bucket, entitlements, quotas, Legacy tables + RLS
supabase/rls.test.ts       migrations run in PGlite (real Postgres) and attacked as two users
vite.config.ts             single-file build, CSP hash generation, site copy
vercel.json                headers, /app redirect, daily cron
```

## License

Zero-Trust Vault is free software under the **GNU Affero General Public License v3.0 or later** ([LICENSE](LICENSE)). You may read, audit, run and modify it. If you run a modified version as a service that others use over a network, the AGPL requires you to offer them your modified source. Bundled third-party packages keep their own licenses ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)); fonts are under the SIL Open Font License.

The name "Zero-Trust Vault", the logo and the visual identity are **not** licensed by the AGPL. You may fork and self-host the code, but please use your own name and branding for your fork.

**Self-hosting and Pro.** The code that grants Pro and runs Legacy is part of this repository, and the Pro flag lives in your own database, so a self-hosted copy can switch features on for itself. That is by design and fine: what the hosted service sells is reliability (Legacy emails that actually arrive on release day), support, and someone else running it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: use GitHub's private "Report a vulnerability" form, not a public issue.

## Limits

- Payloads up to 100 MB. Everything is held in memory, so larger files would need a chunked format.
- JavaScript cannot guarantee that key material is wiped from memory. Buffers are zeroed on a best-effort basis.
- Passkey slots need the HTTPS site on the same domain, plus an authenticator with PRF support (recent iCloud Keychain, Google Password Manager, Windows Hello, YubiKey 5).
- See [SECURITY.md](SECURITY.md) for the threat model.
