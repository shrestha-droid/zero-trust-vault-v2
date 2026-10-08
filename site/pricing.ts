// Regional pricing: one static landing page per currency, picked by visitor country in vercel.json.
import { readFileSync } from 'node:fs';

export interface Currency { yearly: number; lifetime: number; countries: string[] }
export interface Pricing { default: string; currencies: Record<string, Currency> }

export const pricing = JSON.parse(readFileSync(new URL('./pricing.json', import.meta.url), 'utf8')) as Pricing;

/** "<span class="cur">¥</span>8,900": the symbol is set in the sans (Bodoni's ¥ hairlines vanish at display size). */
const money = (cur: string, n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 })
  .formatToParts(n).map((p) => (p.type === 'currency' ? `<span class="cur">${p.value.trim()}</span>` : p.type === 'literal' ? '' : p.value)).join('');
const plain = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
const serial = (n: number) => String(n).padStart(3, '0').repeat(2).slice(-6);

/** What the build knows about which features can actually be bought/used right now. */
export interface Flags { payments: boolean; legacy: boolean; fragments?: Record<string, string> }
export const NO_FLAGS: Flags = { payments: false, legacy: false };

export function render(template: string, cur: string, p: Currency, flags: Flags = NO_FLAGS): string {
  const vars: Record<string, string> = {
    CURRENCY: cur,
    PRICE_FREE: money(cur, 0),
    PRICE_YEARLY: money(cur, p.yearly), PRICE_LIFETIME: money(cur, p.lifetime),
    DEN_YEARLY: plain(p.yearly), DEN_LIFETIME: plain(p.lifetime),
    AMOUNT_YEARLY: String(p.yearly), AMOUNT_LIFETIME: String(p.lifetime),
    SERIAL_YEARLY: serial(p.yearly), SERIAL_LIFETIME: serial(p.lifetime),
    // Until payments are enabled, buy buttons collect a waitlist email instead of dead-ending in the app.
    PRO_HREF: flags.payments ? '/app/#settings' : '#waitlist', PRO_LABEL: flags.payments ? 'Upgrade in the app' : 'Join the waitlist',
    LIFE_HREF: flags.payments ? '/app/#settings' : '#waitlist', LIFE_LABEL: flags.payments ? 'Get Lifetime' : 'Join the waitlist',
    LEGACY_HREF: flags.legacy ? '/app/#legacy' : '#waitlist', LEGACY_LABEL: flags.legacy ? 'Set up Legacy' : 'Get early access',
    LEGACY_TAG: flags.legacy ? 'Pro' : 'Pro · Opening soon',
    WAITLIST: flags.payments && flags.legacy ? '' : (flags.fragments?.waitlist ?? ''),
  };
  return template.replace(/%([A-Z_]+)%/g, (m, k: string) => vars[k] ?? m);
}

export const landingPages = (template: string, flags: Flags = NO_FLAGS) =>
  Object.fromEntries(Object.entries(pricing.currencies).map(([cur, p]) => [cur, render(template, cur, p, flags)]));

/** The rewrites vercel.json must contain, in order: one per country, then the default. */
export function expectedRewrites() {
  const rules = Object.entries(pricing.currencies).flatMap(([cur, p]) =>
    p.countries.map((c) => ({ source: '/', has: [{ type: 'header', key: 'x-vercel-ip-country', value: c }], destination: `/p/${cur.toLowerCase()}` })));
  return [...rules, { source: '/', destination: `/p/${pricing.default.toLowerCase()}` }];
}
