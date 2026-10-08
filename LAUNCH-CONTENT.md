# Launch content kit

Everything here is ready to use. Replace `[LINK]` with your domain once you have one (the `.vercel.app` address works for now).

## Rules for every post (these protect your credibility)

1. **Never show a real seed phrase, password or key on screen.** Use obviously fake data like `abandon ability able about above absent absorb abstract absurd abuse access accident` (the standard BIP-39 test phrase). In this audience a real one would be spotted, and so would a fake that looks real.
2. **Say "beta" and "not yet independently audited" out loud** in at least one video and every written post. People in this space trust you more for it, and it protects you.
3. **Never promise that Legacy will email anyone yet.** It says "opening soon" on the site. Say "Legacy is coming, join the waitlist".
4. **Never give legal or investment advice.** "This is a technical tool, not a will" is the safe line.
5. Do not buy followers, run giveaways or DM strangers. The security-minded communities ban for it, and a ban kills the launch.

---

## The five short videos (Reels / Shorts / TikTok, 25–40 seconds each)

Record your screen at the `/app/` page in **dark mode** (it looks great on video), with a voiceover or captions. Keep captions big and 5–7 words per line.

### 1. "If you died tonight…" (your best hook, post this first)
- **0–2s, text on screen:** *"If you died tonight, could your family get into your crypto?"*
- **2–10s:** type the fake seed phrase into **Seal**. Say: *"Here's a seed phrase. Watch what happens to it."*
- **10–20s:** pick **Trusted people** (3 of 5), press **Seal vault**. The red seal stamps in and 5 coupons appear. *"It's locked on my device. The key is split into five pieces."*
- **20–32s:** show the Open screen: paste two coupons ("not enough"), paste a third, it opens. *"Any three people can open it. Two can't. Not even I can open it with fewer."*
- **32–40s:** *"It's free. Link in bio."*
- **Caption:** `If you died tonight, could your family get into your crypto? 🔐 Free, runs in your browser, nothing for me to leak. [LINK] #crypto #selfcustody #bitcoin #estateplanning`

### 2. "I gave my password to 5 people. None of them can use it."
- **Hook:** *"I gave my password to five people. None of them can use it."*
- Show the five coupons going out (print the recovery kit: one page per person, with the QR code).
- Show one person's coupon failing alone, then three together working.
- **Payoff line:** *"That's called Shamir secret sharing. It's maths, not trust."*

### 3. "Someone tried to fake one of my keys."
- **Hook:** *"One of these five keys is fake. Watch."*
- Open a vault with one tampered coupon (edit one character before the final checksum, or use the **Verify** tab). The app flags **"#2 · forged"** in red and still opens from the honest ones.
- **Payoff:** *"Fake keys get named. The vault still opens."*

### 4. "This works even if the company disappears."
- **Hook:** *"What if this app's company shuts down? Watch."*
- Download the offline file (**Settings → Offline app**), turn off Wi-Fi on camera, open the file, seal and open a vault.
- **Payoff:** *"One file. No server. No internet. Check the fingerprint on the security page."* (This also shows off the transparency.)

### 5. "What happens to your accounts when you die?" (talking-head, 40–50s)
- Face camera. *"Most people have no plan for their digital life. Passwords, crypto, photos, subscriptions. Your family will be locked out and they'll be grieving at the same time."*
- Then show the app: *"I built a tool where you split the key between people you trust. And soon, if you ever go silent, it tells them what to do."*
- **Payoff:** *"It's in beta and free. Join the waitlist for the dead man's switch."* (Legacy is "opening soon", so this is accurate.)

**Posting plan:** one video a day for five days, then repeat the best performer with a new hook. Reply to every comment in the first two hours, because the algorithms reward it.

---

## Reddit posts (read each subreddit's rules first; many ban promotion)

Post as a person sharing a project and asking for feedback, not as an ad. Be in the comments for the first hour.

### r/Bitcoin, r/CryptoCurrency (check weekly "self-promo" threads first)
**Title:** I built a free tool to split a seed phrase between people you trust (any 3 of 5 open it). Looking for honest feedback.

> My dad doesn't know what a seed phrase is, and I realised if something happened to me my family couldn't get into anything. So I built a browser tool that encrypts a secret on your device and splits the key into shards (Shamir secret sharing). Any 3 of 5 can open it, fewer learn nothing.
>
> It runs entirely client-side, there's a single-file offline version, the file format is published, and the crypto is AES-256-GCM + Argon2id + an audited Shamir library. **It's beta and the app itself hasn't been independently audited yet**, so please don't put your only copy of anything in it. The security page lists exactly what is and isn't covered.
>
> I'd love people to try to break it or tell me what's confusing. [LINK]

### r/privacy, r/cybersecurity (technical angle, lead with the design)
**Title:** Client-side vault with key commitment, shard commitments and hash-based forgery detection: feedback on the format wanted

> Format notes: AES-256-GCM with the header as AAD, HKDF-derived key slots (shards / Argon2id passphrase / both / WebAuthn PRF), a key commitment so a malicious sealer can't make a vault that opens to different contents for different people (the "invisible salamanders" problem), and per-shard hash commitments so a forged share is named even with exactly k shards. No public-key crypto anywhere. Spec and threat model: [LINK]/security. Not independently audited yet (the Shamir library is). Break it, please.

### r/personalfinance, r/EstatePlanning (emergency-file angle, not crypto)
**Title:** How are you handling "my family can't access my accounts if I die"?

> I've been trying to solve the digital emergency-file problem without trusting one person or a password manager's "emergency access" with everything. I ended up building a small free tool that splits an emergency file between several people so no single one can read it. Curious how others handle this, and whether this approach makes sense to non-technical family. [LINK]

---

## X / Twitter thread (crypto audience)

1. If you died tomorrow, your family likely couldn't touch your crypto. No seed phrase, no way in. Most people know this and still haven't fixed it. I built something. 🧵
2. The usual "fixes" are bad: a note in a drawer (anyone can read it), one trusted person (a single point of failure and of betrayal), a safe deposit box (nobody knows to look).
3. Better: split the key. Shamir secret sharing: 5 pieces, any 3 rebuild it, 2 reveal *literally nothing*. It's maths, not trust.
4. So I built Zero-Trust Vault. Encrypt on your device, split the key, hand the pieces to people you trust. Free, runs in your browser, one-file offline version, nothing for me to leak. [LINK]
5. Details people ask about: AES-256-GCM, Argon2id, an audited Shamir library, forged-shard detection, hardware passkeys, post-quantum design (no public-key crypto). Spec is public: [LINK]/security
6. Honest status: beta, and the app itself isn't independently audited yet. Don't put your only copy in it. I'd love people to try to break it.
7. Next up: Legacy, a dead man's switch that emails your people if you go silent. Waitlist: [LINK]

---

## Product Hunt (launch only after the domain and Stripe are live)

- **Name:** Zero-Trust Vault
- **Tagline (60 chars):** Split your secrets between people you trust
- **Description:** Encrypt seed phrases, passwords and files on your own device. Split the key into coupons: any 3 of 5 open it, 2 learn nothing. Free, works offline, nothing for us to leak. Pro adds Legacy, a dead man's switch that tells your people what to do if you go silent.
- **First comment (from you):** the "my dad doesn't know what a seed phrase is" story, plus the honest beta/audit note and a request to try breaking it.
- Launch on a Tuesday–Thursday, about 12:01 am Pacific, with 10 friends ready to try it (real comments, not fake upvotes).

---

## Where to find your first customers

- **Crypto self-custody communities:** r/Bitcoin, r/ethereum, r/CryptoCurrency, Bitcoin Twitter, Telegram/Discord groups about inheritance and self-custody. Search for: "inheritance", "what if I die", "dead man's switch", "seed phrase backup".
- **Estate planning and financial planners:** they constantly get asked "what about my crypto and passwords?". A one-page PDF "digital emergency file" guide that points to the tool is a good hook for a cold email to 50 independent financial planners.
- **Small business owners:** "break-glass credentials split between directors". LinkedIn posts perform well here.
- **Journalists and activists:** the air-gap and offline-file features. A few security-newsletter mentions could matter.

## What to measure

| Number | What it tells you |
|---|---|
| Waitlist signups per video/post | Which hook works |
| Visits to `/app/` vs `/` | Whether people try it |
| Vaults sealed (ask in feedback) | Whether the product is understood |
| "Why not?" replies | The objections to fix on the site |

Ten emails from strangers who aren't friends is a real signal. A hundred means you should set up Stripe the same day.
