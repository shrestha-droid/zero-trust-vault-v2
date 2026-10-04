// Legacy (dead man's switch). Pure logic + dependency-injected runners (web-standard APIs only; wired up in api/).
//
// Zero-knowledge stays intact: the service stores trustee contacts, a plaintext message, and at most
// ONE optional escrow shard. One shard reveals nothing about a vault (Shamir, k ≥ 2). On release,
// trustees get the message, time-limited download links to the encrypted vaults, and the escrow shard.
import { hmacHex, safeEqual } from './billing.js';

export interface Trustee { name: string; email: string }
export interface LegacyPlan {
  user_id: string;
  enabled: boolean;
  interval_days: number;
  grace_days: number;
  last_checkin: string;
  trustees: Trustee[];
  message: string;
  vault_ids: string[];
  escrow_shard: string | null;
  reminded_at: string | null;
  released_at: string | null;
}
export interface Email { to: string; subject: string; text: string; html: string }
export type Action = 'none' | 'remind' | 'release';

export const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const REMIND_EVERY = 7 * DAY;

export const dueAt = (p: Pick<LegacyPlan, 'last_checkin' | 'interval_days'>) => Date.parse(p.last_checkin) + p.interval_days * DAY;
export const releaseAt = (p: Pick<LegacyPlan, 'last_checkin' | 'interval_days' | 'grace_days'>) => dueAt(p) + p.grace_days * DAY;

/** What the daily tick should do for one plan. Billing status is deliberately NOT an input:
 *  a deceased owner's card eventually fails, and the plan must still fire. */
export function decide(p: LegacyPlan, now: number): Action {
  if (!p.enabled || p.released_at) return 'none';
  if (now >= releaseAt(p)) return 'release';
  if (now >= dueAt(p) && (!p.reminded_at || now - Date.parse(p.reminded_at) >= REMIND_EVERY)) return 'remind';
  return 'none';
}

// ---------- Check-in tokens: `${userId}.${issuedSec}.${hmac}` ----------
export async function makeCheckinToken(userId: string, secret: string, nowMs: number): Promise<string> {
  const body = `${userId}.${Math.floor(nowMs / 1000)}`;
  return `${body}.${await hmacHex(secret, body)}`;
}
export async function verifyCheckinToken(token: string, secret: string, nowMs: number, maxAgeDays = 60): Promise<string | null> {
  const [userId, issued, mac] = token.split('.');
  if (!userId || !issued || !mac || !secret) return null;
  if (!safeEqual(await hmacHex(secret, `${userId}.${issued}`), mac)) return null;
  if (nowMs / 1000 - Number(issued) > maxAgeDays * 86_400) return null;
  return userId;
}

// ---------- Emails ----------
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (ms: number) => new Date(ms).toUTCString().slice(5, 16);
const wrap = (inner: string) => `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;line-height:1.6;color:#1b1514">${inner}<hr style="border:0;border-top:1px solid #ddd;margin:24px 0"><p style="color:#777;font-size:12px">Zero-Trust Vault · client-side, zero-knowledge encryption</p></div>`;
const button = (href: string, label: string) => `<p><a href="${esc(href)}" style="display:inline-block;background:#8f1d22;color:#fff7f2;padding:11px 20px;border-radius:6px;letter-spacing:.01em;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;

export function reminderEmail(p: LegacyPlan, ownerEmail: string, checkinUrl: string, now: number): Email {
  const when = fmt(releaseAt(p));
  const days = Math.max(0, Math.ceil((releaseAt(p) - now) / DAY));
  const n = p.trustees.length;
  const subject = `Check in: your Legacy plan notifies ${n} trustee${n === 1 ? '' : 's'} in ${days} day${days === 1 ? '' : 's'}`;
  const text = `You haven't checked in to Zero-Trust Vault for ${p.interval_days} days.\n\nUnless you check in, your Legacy plan will contact ${n} trustee${n === 1 ? '' : 's'} on ${when}.\n\nI'm still here: ${checkinUrl}\n\nIf you didn't set this up, you can ignore this email.`;
  const html = wrap(`<h2>Are you still there?</h2><p>You haven't checked in to Zero-Trust Vault for ${p.interval_days} days. Unless you check in, your Legacy plan will contact <b>${n} trustee${n === 1 ? '' : 's'}</b> on <b>${when}</b>.</p>${button(checkinUrl, "I'm still here")}<p style="color:#555">Opening the app while signed in also counts as a check-in.</p>`);
  return { to: ownerEmail, subject, text, html };
}

export function releaseEmail(p: LegacyPlan, t: Trustee, ownerEmail: string, links: { id: string; url: string }[], appUrl: string, now: number): Email {
  const subject = `${ownerEmail} asked us to contact you`;
  const since = fmt(Date.parse(p.last_checkin));
  const linkText = links.map((l) => `  ${l.id}: ${l.url}`).join('\n');
  const text = [
    `Hello ${t.name},`,
    `${ownerEmail} set up a Zero-Trust Vault Legacy plan and named you as a trustee. They asked us to contact you if they stopped checking in. Their last check-in was ${since}.`,
    p.message ? `Their message to you:\n\n${p.message}` : '',
    links.length ? `Encrypted vault files (links expire in 30 days, download them now):\n${linkText}` : '',
    p.escrow_shard ? `One recovery shard they left with us:\n\n${p.escrow_shard}\n\nOn its own this shard cannot open anything.` : '',
    `To open a vault: go to ${appUrl}, choose Open, load the .vault file, and add enough shards (from the people named in the message) or the passphrase.`,
    `We cannot open these vaults and we don't have the keys. Nobody does except the people who hold them.`,
  ].filter(Boolean).join('\n\n');
  const html = wrap([
    `<h2>${esc(ownerEmail)} asked us to contact you</h2>`,
    `<p>Hello ${esc(t.name)}, ${esc(ownerEmail)} set up a Zero-Trust Vault <b>Legacy</b> plan and named you as a trustee. They asked us to contact you if they stopped checking in. Their last check-in was <b>${since}</b>.</p>`,
    p.message ? `<p><b>Their message to you:</b></p><blockquote style="border-left:3px solid #8f1d22;margin:0;padding:4px 14px;white-space:pre-wrap">${esc(p.message)}</blockquote>` : '',
    links.length ? `<p><b>Encrypted vault files.</b> The links expire in 30 days, so download them now:</p><ul>${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.id)}.vault</a></li>`).join('')}</ul>` : '',
    p.escrow_shard ? `<p><b>One recovery shard they left with us.</b> On its own it cannot open anything:</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px;font-size:12px">${esc(p.escrow_shard)}</pre>` : '',
    `<p>To open a vault, open the app, choose <b>Open</b>, load the .vault file, and add enough shards (from the people named in the message) or the passphrase.</p>`,
    button(appUrl, 'Open Zero-Trust Vault'),
    `<p style="color:#555">We cannot open these vaults and we don't have the keys. Nobody does except the people who hold them.</p>`,
  ].join(''));
  void now;
  return { to: t.email, subject, text, html };
}

export function ownerReleasedEmail(p: LegacyPlan, ownerEmail: string, appUrl: string): Email {
  const names = p.trustees.map((t) => t.name).join(', ');
  return {
    to: ownerEmail,
    subject: 'Your Legacy plan was released',
    text: `Your Zero-Trust Vault Legacy plan has contacted your trustees (${names}) because you hadn't checked in. If you're fine, let them know, and consider re-keying your vaults at ${appUrl}.`,
    html: wrap(`<h2>Your Legacy plan was released</h2><p>We contacted your trustees (${esc(names)}) because you hadn't checked in. If you're fine, let them know, and consider re-keying your vaults.</p>${button(appUrl, 'Open Zero-Trust Vault')}`),
  };
}

// ---------- Daily tick ----------
export interface TickDeps {
  now: number;
  appUrl: string;
  checkinBaseUrl: string;
  checkinSecret: string;
  plans: () => Promise<LegacyPlan[]>;
  ownerEmail: (userId: string) => Promise<string | null>;
  signedUrl: (userId: string, vaultId: string) => Promise<string | null>;
  send: (e: Email) => Promise<boolean>;
  mark: (userId: string, patch: Partial<Pick<LegacyPlan, 'reminded_at' | 'released_at'>>) => Promise<void>;
}

export async function runTick(d: TickDeps) {
  const summary = { reminded: 0, released: 0, failed: 0 };
  for (const p of await d.plans()) {
    const action = decide(p, d.now);
    if (action === 'none') continue;
    const owner = await d.ownerEmail(p.user_id);
    if (!owner) { summary.failed++; continue; }
    if (action === 'remind') {
      const token = await makeCheckinToken(p.user_id, d.checkinSecret, d.now);
      const ok = await d.send(reminderEmail(p, owner, `${d.checkinBaseUrl}?t=${encodeURIComponent(token)}`, d.now));
      if (ok) { await d.mark(p.user_id, { reminded_at: new Date(d.now).toISOString() }); summary.reminded++; } else summary.failed++;
      continue;
    }
    const links: { id: string; url: string }[] = [];
    for (const id of p.vault_ids) {
      const url = await d.signedUrl(p.user_id, id);
      if (url) links.push({ id, url });
    }
    const trustees = p.trustees.filter((t) => EMAIL_RE.test(t.email));
    const results: boolean[] = [];
    for (const t of trustees) results.push(await d.send(releaseEmail(p, t, owner, links, d.appUrl, d.now))); // sequential: provider rate limits
    // Only mark released once every trustee was reached; a failed run retries tomorrow (a duplicate beats a miss).
    if (trustees.length && results.every(Boolean)) {
      await d.send(ownerReleasedEmail(p, owner, d.appUrl));
      await d.mark(p.user_id, { released_at: new Date(d.now).toISOString() });
      summary.released++;
    } else summary.failed++;
  }
  return summary;
}

// ---------- Email-link check-in ----------
export function makeCheckinHandler(d: { secret: string; appUrl: string; checkin: (userId: string) => Promise<boolean>; now?: () => number }) {
  return async (req: Request): Promise<Response> => {
    const token = new URL(req.url).searchParams.get('t') ?? '';
    const userId = await verifyCheckinToken(token, d.secret, (d.now ?? Date.now)());
    const ok = userId ? await d.checkin(userId) : false;
    // Redirect instead of rendering HTML: the app shows the result.
    return Response.redirect(`${d.appUrl}#checkin=${ok ? 'ok' : 'expired'}`, 302);
  };
}

export function makeTickHandler(cronSecret: string, run: () => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    if (!cronSecret || !safeEqual(req.headers.get('authorization') ?? '', `Bearer ${cronSecret}`)) return new Response('Unauthorized', { status: 401 });
    return Response.json(await run());
  };
}

// ---------- Email delivery (Resend) ----------
/** Sends one email; retries rate limits (429) and 5xx with backoff. Returns false instead of throwing. */
export async function sendEmail(e: Email, apiKey: string, from: string, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  if (!apiKey || !from) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [e.to], subject: e.subject, text: e.text, html: e.html }),
    }).catch(() => null);
    if (r?.ok) return true;
    if (r && r.status !== 429 && r.status < 500) return false; // bad request/auth: retrying won't help
    await sleep(1000 * 2 ** attempt);
  }
  return false;
}
