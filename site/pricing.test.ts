import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectedRewrites, landingPages, pricing } from './pricing';

const template = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
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
});
