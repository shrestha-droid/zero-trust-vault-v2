import { defineConfig, devices } from '@playwright/test';

// Browser tests of the real production build (CSP and all). Run `npm run build` first, then `npm run e2e`.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:4317' },
  // PW_CHANNEL=chrome uses an installed Google Chrome instead of downloading Chromium.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL } }],
  webServer: { command: 'npx vite preview --port 4317 --strictPort', port: 4317, reuseExistingServer: !process.env.CI },
});
