import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_ENV } from './build-env';

it('APP_ENV lists exactly the VITE_ variables the app reads (or the published build info could not reproduce it)', () => {
  const used = new Set<string>();
  for (const f of readdirSync(new URL('.', import.meta.url)).filter((f) => /\.ts$/.test(f) && !f.endsWith('.test.ts'))) {
    for (const m of readFileSync(new URL(f, import.meta.url), 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z_]+)/g)) used.add(m[1]);
  }
  for (const m of readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8').matchAll(/env\.(VITE_[A-Z_]+)/g)) used.add(m[1]);
  expect([...used].sort()).toEqual([...APP_ENV].sort());
});
