import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * After single-file inlining, hash the inline <script>/<style> and embed a strict CSP as a <meta>.
 * The policy travels with the HTML, so it protects the hosted app and the downloaded offline file alike,
 * on any host (static platform headers can't know per-build hashes).
 */
function csp(supabaseUrl?: string): Plugin {
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
      const connect = supabaseUrl ? `${supabaseUrl} ${supabaseUrl.replace(/^https:/, 'wss:')}` : "'none'";
      const policy = [
        "default-src 'none'",
        `script-src ${scripts[0]} 'wasm-unsafe-eval'`, // Argon2id runs as WebAssembly
        `style-src ${styles[0]}`,
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
function site(siteUrl: string): Plugin {
  return {
    name: 'ztv-site',
    apply: 'build',
    closeBundle() {
      mkdirSync('dist', { recursive: true });
      for (const f of readdirSync('site')) {
        if (f.endsWith('.html')) writeFileSync(`dist/${f}`, readFileSync(`site/${f}`, 'utf8').replaceAll('%SITE_URL%', siteUrl));
        else copyFileSync(`site/${f}`, `dist/${f}`);
      }
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
    plugins: [viteSingleFile(), csp(env.VITE_SUPABASE_URL), site((env.SITE_URL ?? '').replace(/\/+$/, ''))],
  };
});
