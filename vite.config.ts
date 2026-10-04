import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * After single-file inlining, hash the inline <script>/<style> and emit a strict CSP twice:
 * as a <meta> (so the downloaded offline file is protected too) and as Netlify _headers
 * (adds directives a meta tag can't carry, plus the other security headers).
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
      const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => sha(m[1]));
      const styles = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => sha(m[1]));
      if (scripts.length !== 1 || styles.length !== 1) throw new Error(`expected 1 inline script + 1 style, got ${scripts.length}/${styles.length}`);
      const connect = supabaseUrl ? `${supabaseUrl} ${supabaseUrl.replace(/^https:/, 'wss:')}` : "'none'";
      const policy = [
        "default-src 'none'",
        `script-src ${scripts[0]} 'wasm-unsafe-eval'`, // Argon2id runs as WebAssembly
        `style-src ${styles[0]}`,
        "img-src 'self' data: blob:",
        `connect-src ${connect}`,
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        "require-trusted-types-for 'script'",
        'trusted-types sw',
      ].join('; ');
      html.source = src.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: `/*
  Content-Security-Policy: ${policy}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Strict-Transport-Security: max-age=63072000; includeSubDomains

/sw.js
  Cache-Control: no-cache
`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { target: 'es2022', modulePreload: false, reportCompressedSize: false },
    plugins: [viteSingleFile(), csp(env.VITE_SUPABASE_URL)],
  };
});
