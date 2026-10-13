// The flows a person relies on when it matters: seal, open from a quorum, spot a forged shard, run a drill.
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const SECRET = 'e2e: abandon ability able about above absent';

/** A shard with a tampered share but a valid checksum: what a dishonest holder would hand back. */
function forge(shard: string): string {
  const p = shard.split('.');
  p[6] = (p[6][0] === 'A' ? 'B' : 'A') + p[6].slice(1);
  const body = p.slice(0, 7).join('.');
  return `${body}.${createHash('sha256').update(body).digest('hex').slice(0, 8)}`;
}

async function seal(page: Page): Promise<string[]> {
  await page.goto('/#seal');
  await page.fill('#secret-text', SECRET);
  await page.click('#seal-btn');
  await expect(page.locator('#sealed-dialog')).toBeVisible();
  const shards = await page.locator('#shard-grid .shard-text').allTextContents();
  await page.click('#sealed-done');
  await page.click('#confirm-ok'); // "close without saving shards?": we kept them in the test
  await expect(page.locator('#sealed-dialog')).toBeHidden();
  return shards;
}

test('seal → open with 3 of 5, forged shard named → recovery drill', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));

  const shards = await seal(page);
  expect(shards).toHaveLength(5);
  expect(new Set(shards).size).toBe(5);

  await page.click('#tab-open');
  const local = page.locator('#vault-pick option[value^="local:"]');
  await expect(local).toHaveCount(1);
  await page.selectOption('#vault-pick', await local.getAttribute('value'));
  await expect(page.locator('#vault-info')).toBeVisible();

  await page.fill('#shard-paste', shards.slice(0, 2).join('\n'));
  await expect(page.locator('#open-btn')).toBeDisabled(); // 2 of 3: not enough

  await page.fill('#shard-paste', [...shards.slice(0, 3), forge(shards[3])].join('\n'));
  await page.click('#open-btn');
  await expect(page.locator('#result-pre')).toHaveText(SECRET);
  await expect(page.locator('#result-bad')).toBeVisible();
  await expect(page.locator('#result-bad-text')).toContainText('#4');

  await page.click('#tab-verify');
  await page.fill('#verify-paste', shards.slice(2, 4).join('\n'));
  await expect(page.locator('#verdict-title')).toHaveText('2 of 3 shards');
  await page.fill('#verify-paste', shards.slice(2, 5).join('\n'));
  await expect(page.locator('#verdict-title')).toHaveText('Recovery confirmed');

  expect(problems).toEqual([]); // includes Content Security Policy violations in the production build
});

test('a damaged shard is caught by its checksum, not silently used', async ({ page }) => {
  const shards = await seal(page);
  await page.click('#tab-verify');
  await page.fill('#verify-paste', shards[0].slice(0, -1) + (shards[0].endsWith('0') ? '1' : '0'));
  await expect(page.locator('#verdict-title')).toHaveText('No valid shards');
});
