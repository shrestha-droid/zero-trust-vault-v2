# Security

## Reporting a vulnerability

Please use **GitHub → Security → Report a vulnerability** (private advisory) on this repository. Don't open a public issue. Include the steps to reproduce and the affected version (shown in the app header).

## Threat model

### Protects against

| Threat | How |
|---|---|
| Server or database breach | Only ciphertext is stored. Keys never leave the browser tab. |
| Malicious or curious host operator | Same as above. Cloud records are write-once (no UPDATE policy), so they can't be silently replaced. |
| Another user reading your cloud records | Supabase RLS limits every object to `auth.uid()/…`. |
| Tampering with a vault file (label, policy, KDF params, ciphertext) | The header is AES-GCM associated data, so any change fails decryption. The wrapped key is bound to the vault id. |
| Fewer than K shards leaking | Shamir sharing gives information-theoretic secrecy below the threshold. |
| K shards leaking (theft, collusion) | Optional two-factor slot: the KEK also needs Argon2id(passphrase). |
| Typos or mixed-up shards | Per-shard checksum, plus a key fingerprint checked after reconstruction. |
| A shard holder submitting a forged shard | With more than K shards, a K-subset search finds a consistent set; inconsistent shards are named. |
| Moving or reinterpreting key slots | Each slot's AAD binds the vault id and slot type; HKDF info separates KEK domains. |
| Key exposure to page scripts and extensions' DOM access | Data keys and Shamir secrets exist only inside a dedicated Web Worker. |
| Future quantum computers | No public-key cryptography in the format. Symmetric primitives at 256 bits, and Shamir is information-theoretic. |
| Offline brute force of a passphrase | Argon2id at 64 MiB / 3 passes. Strength still depends on the passphrase; use the generator (130 bits). |
| Crafted vault requesting huge KDF memory (DoS) | KDF parameters are bounds-checked before use. |
| XSS / script injection | Hash-pinned CSP with no `unsafe-inline` or `eval`, plus Trusted Types. The UI never uses `innerHTML`. |
| Supply-chain injection via CDN | No CDN. All dependencies are bundled at build time from a lockfile. |
| Exact-size fingerprinting | Padmé padding. |
| This website disappearing | A single-file offline build (in the app and on GitHub Releases) opens every v2 vault. |

### Does not protect against

- **A compromised device or browser.** Malware, a malicious extension with page access, or a keylogger sees what you see.
- **A compromised build or deployment.** If someone changes the code you load, it can exfiltrate keys. Mitigation: use the hashed release build, kept offline.
- **Losing more than N−K shards, or forgetting the passphrase.** By design there is no recovery and no backdoor.
- **Memory forensics.** JavaScript can't guarantee secrets are wiped from RAM. Decrypted output must reach the page to be shown; it auto-clears after 5 minutes.
- **Losing the domain for passkey-only vaults.** WebAuthn binds passkeys to the site's domain. Never make a passkey the only slot.
- **Fewer than K+1 shards when one is forged.** With exactly K shards, a forgery is detected but can't be pinpointed.
- **Metadata.** The vault id, creation time, label, policy and approximate size are visible to whoever holds the file.

## Status

The Shamir library is independently audited. **This application has not been audited.** The crypto composition is standard (AES-GCM, Argon2id, Shamir), with tests in `src/crypto.test.ts`, but don't treat it as audited software until a third-party review is published here.
