# Contributing

Thanks for looking. This project handles people's most sensitive secrets, so it is deliberately conservative.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + all tests + production build (what CI runs)
```

Node 22.12+ is required. The cloud features need a Supabase project and are optional; everything else works without any backend.

## Ground rules

- **Cryptography changes need tests, and any change to bytes on disk bumps the format version** (`VERSION` in `src/crypto.ts`) while keeping older versions readable. `src/__fixtures__/v2-vault.json` is a real vault from an earlier version that must keep opening.
- **Write the attack as a test.** The suite plays a malicious sealer and a forging trustee; new protections should come with the attack they stop, and that attack should fail.
- **No new runtime dependencies in the crypto path** without a very good reason. Every dependency is shipped to users inside one HTML file and has to be audited by whoever reads this.
- **No third-party scripts, fonts, analytics or network calls in the browser app.** The Content Security Policy is generated at build time and is strict on purpose.
- Keep the marketing site free of JavaScript (`script-src 'none'`).
- Database changes go in a new numbered file under `supabase/migrations/` and are covered by `supabase/rls.test.ts`, which runs the migrations against a real Postgres engine and attacks them as separate users.

## Security issues

Please don't open a public issue. Use GitHub's private **Report a vulnerability** form (Security tab). See [SECURITY.md](SECURITY.md).

## Licensing of contributions

The project is licensed under the AGPL-3.0-or-later (see [LICENSE](LICENSE)). By submitting a contribution you agree that it is licensed under the same terms, and that the maintainer may also distribute it under other licenses (this is what allows a hosted commercial offering to exist alongside the open-source code). If that doesn't work for you, open an issue before sending a pull request.

Add a `Signed-off-by: Your Name <email>` line to your commits (`git commit -s`) to confirm you have the right to contribute the change.
