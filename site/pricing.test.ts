import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedRewrites, landingPages, pricing, type Flags } from './pricing';

const template = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fragments = { waitlist: '<section id="waitlist">FORM</section>' };
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

describe('regional pricing', () => {
  it('every currency has sane whole-number prices and no country appears twice', () => {
    const seen = new Set<string>();
    for (const [cur, p] of Object.entries(pricing.currencies)) {
      expect(cur).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(p.yearly) && Number.isInteger(p.lifetime) && p.lifetime > p.yearly * 2).toBe(true);
      for (const c of p.countries) { expect(c).toMatch(/^[A-Z]{2}$/); expect(seen.has(c)).toBe(false); seen.add(c); }
    }
    expect(pricing.currencies[pricing.default]).toBeDefined();
  });

  it('renders every placeholder, with local currency formatting', () => {
    const pages = landingPages(template);
    for (const page of Object.values(pages)) expect(page.match(/%[A-Z_]+%/g)?.filter((m) => m !== '%SITE_URL%') ?? []).toEqual([]);
    expect(pages.USD).toContain('<strong><span class="cur">$</span>60</strong>');
    expect(pages.GBP).toContain('<strong><span class="cur">£</span>49</strong>');
    expect(pages.INR).toContain('<strong><span class="cur">₹</span>4,999</strong>');
    expect(pages.INR).toContain('Prices in INR.');
    expect(pages.EUR).toContain('"priceCurrency":"EUR"');
    expect(pages.CHF).toContain('<span class="cur">CHF</span>55');
  });

  it('vercel.json routes each country to its page, with the default last (drift guard)', () => {
    expect(vercel.rewrites).toEqual(expectedRewrites());
  });

  it('buy buttons collect a waitlist email until payments are enabled, then go to real checkout', () => {
    const off = landingPages(template, { payments: false, legacy: false, fragments }).USD;
    expect(off).toContain('href="#waitlist">Join the waitlist</a>');
    expect(off).not.toContain('href="/app/#settings"');
    expect(off).toContain('href="#waitlist">Get early access</a>');
    expect(off).toContain('Legacy · Pro · Opening soon');
    expect(off).toContain('<section id="waitlist">FORM</section>');

    const paid: Flags = { payments: true, legacy: false, fragments };
    const mid = landingPages(template, paid).USD;
    expect(mid).toContain('href="/app/#settings">Upgrade in the app</a>');
    expect(mid).toContain('href="/app/#settings">Get Lifetime</a>');
    expect(mid).toContain('href="#waitlist">Get early access</a>'); // Legacy still needs email
    expect(mid).toContain('<section id="waitlist">'); // still collecting Legacy interest

    const live = landingPages(template, { payments: true, legacy: true, fragments }).USD;
    expect(live).toContain('href="/app/#legacy">Set up Legacy</a>');
    expect(live).toContain('Legacy · Pro</p>');
    expect(live).not.toContain('id="waitlist">FORM');
    for (const page of [off, mid, live]) expect(page.match(/%[A-Z_]+%/g)?.filter((m) => m !== '%SITE_URL%') ?? []).toEqual([]);
  });
});
