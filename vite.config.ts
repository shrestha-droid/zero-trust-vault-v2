import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { landingPages } from './site/pricing.ts';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * After single-file inlining, hash the inline <script>/<style> and embed a strict CSP as a <meta>.
 * The policy travels with the HTML, so it protects the hosted app and the downloaded offline file alike,
 * on any host (static platform headers can't know per-build hashes).
 */
function csp(supabaseUrl?: string, googleDrive = false, payments = false): Plugin {
  return {
    name: 'ztv-csp',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const html = bundle['index.html'];
      if (html?.type !== 'asset') throw new Error('index.html missing from bundle');
      const src = String(html.source);
      const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
      const scripts = [...src.matchAll(/<script\b(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => sha(m[1]));
      const styles = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => sha(m[1]));
      if (scripts.length !== 1 || styles.length !== 1) throw new Error(`expected 1 inline script + 1 style, got ${scripts.length}/${styles.length}`);
      // Only the backends this build is configured for. Google Drive is called directly from the browser.
      const origins = [supabaseUrl, supabaseUrl?.replace(/^https:/, 'wss:'), googleDrive && 'https://www.googleapis.com', payments && "'self'"].filter(Boolean);
      const connect = origins.length ? origins.join(' ') : "'none'";
      const policy = [
        "default-src 'none'",
        `script-src ${scripts[0]} 'wasm-unsafe-eval'`, // Argon2id runs as WebAssembly
        `style-src ${styles[0]}`,
        "font-src data:", // fonts are inlined into the single file
        "img-src 'self' data: blob:",
        `connect-src ${connect}`,
        "worker-src 'self' blob:", // crypto runs in an inline (blob:) worker
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        "require-trusted-types-for 'script'",
        'trusted-types default',
      ].join('; ');
      html.source = src.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
    },
  };
}

/** Copies the no-JS marketing site (site/) to the output root, filling in the canonical URL. */
function site(siteUrl: string, flags: { payments: boolean; legacy: boolean }): Plugin {
  return {
    name: 'ztv-site',
    apply: 'build',
    closeBundle() {
      cpSync('site', 'dist', { recursive: true, filter: (f) => !/\.(ts|json)$|fragment\.html$/.test(f) });

      // The landing page is rendered once per currency (dist/p/<cur>.html). vercel.json rewrites "/" to the
      // visitor's currency by country; there is deliberately no dist/index.html so that rewrite always wins.
      rmSync('dist/index.html', { force: true });
      // The downloadable offline app: same file minus the install links (no manifest next to a downloaded file).
      // Served with Content-Disposition from vercel.json so every browser saves it as zero-trust-vault.html.
      writeFileSync('dist/app/zero-trust-vault.html', readFileSync('dist/app/index.html', 'utf8')
        .replace(/\s*<link rel="(manifest|apple-touch-icon)"[^>]*>/g, ''));
      // Publish the offline app's fingerprint (computed here, so it can never drift from the file served).
      const offline = readFileSync('dist/app/zero-trust-vault.html');
      const sha = createHash('sha256').update(offline).digest('hex');
      writeFileSync('dist/app/zero-trust-vault.sha256', `${sha}  zero-trust-vault.html\n`);
      const vars: Record<string, string> = { SITE_URL: siteUrl, OFFLINE_SHA256: sha, OFFLINE_KB: String(Math.round(offline.length / 1024)), VERSION: version };
      for (const f of readdirSync('site').filter((f) => f.endsWith('.html') && f !== 'index.html' && !f.endsWith('.fragment.html'))) {
        writeFileSync(`dist/${f}`, readFileSync(`site/${f}`, 'utf8').replace(/%([A-Z0-9_]+)%/g, (m, k: string) => vars[k] ?? m));
      }
      mkdirSync('dist/p', { recursive: true });
      const landing = readFileSync('site/index.html', 'utf8').replaceAll('%SITE_URL%', siteUrl);
      const fragments = { waitlist: readFileSync('site/waitlist.fragment.html', 'utf8') };
      for (const [cur, page] of Object.entries(landingPages(landing, { ...flags, fragments }))) writeFileSync(`dist/p/${cur.toLowerCase()}.html`, page);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { outDir: 'dist/app', target: 'es2022', modulePreload: false, reportCompressedSize: false },
    worker: { format: 'es' as const },
    plugins: [viteSingleFile(), csp(env.VITE_SUPABASE_URL, Boolean(env.VITE_GOOGLE_CLIENT_ID), env.VITE_PAYMENTS === '1'), site((env.SITE_URL ?? '').replace(/\/+$/, ''), {
      // Buy buttons only go to real checkout once checkout is enabled; Legacy only once email can be sent.
      payments: env.VITE_PAYMENTS === '1',
      legacy: env.VITE_PAYMENTS === '1' && Boolean(env.RESEND_API_KEY),
    })],
  };
});
