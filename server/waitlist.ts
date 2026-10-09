// Waitlist signup: a plain HTML form (works with JavaScript off) posts here.
// Pure logic with injected storage, so it is unit-tested without a database.
export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const SOURCES = ['hero', 'pricing', 'legacy', 'footer', 'site'] as const;
const FLOOD_PER_HOUR = 300; // a real launch spike is far below this; a bot flood is far above

export interface WaitlistDeps {
  siteUrl: string;
  insert: (row: { email: string; source: string; country: string | null }) => Promise<{ error: { message: string; code?: string } | null }>;
  /** Signups in the last hour, for the flood cap. */
  recent: () => Promise<number>;
}

const back = (siteUrl: string, hash: string) => new Response(null, { status: 303, headers: { Location: `${siteUrl}/${hash}` } });

export function makeWaitlistHandler(d: WaitlistDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    // Only our own pages may post (blocks cross-site form abuse). Our pages send Referrer-Policy: no-referrer,
    // and browsers then send "Origin: null" on form posts, so prefer Sec-Fetch-Site and accept "null" as a fallback.
    const fetchSite = req.headers.get('sec-fetch-site');
    const origin = req.headers.get('origin');
    if (fetchSite ? fetchSite !== 'same-origin' : origin && origin !== 'null' && origin !== d.siteUrl) return new Response('Forbidden', { status: 403 });
    const form = new URLSearchParams(await req.text());
    // Honeypot: real people never fill the hidden "website" field. Pretend success so bots learn nothing.
    if (form.get('website')) return back(d.siteUrl, '#joined');
    const email = (form.get('email') ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return back(d.siteUrl, '#invalid');
    const src = form.get('source') ?? 'site';
    const source = (SOURCES as readonly string[]).includes(src) ? src : 'site';
    const c = (req.headers.get('x-vercel-ip-country') ?? '').toUpperCase();
    const country = /^[A-Z]{2}$/.test(c) ? c : null;
    if ((await d.recent()) >= FLOOD_PER_HOUR) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '3600' } });
    const { error } = await d.insert({ email, source, country });
    // 23505 = already on the list: same friendly result, and it doesn't reveal who is signed up.
    if (error && error.code !== '23505') return new Response('Something went wrong. Please try again.', { status: 500 });
    return back(d.siteUrl, '#joined');
  };
}
