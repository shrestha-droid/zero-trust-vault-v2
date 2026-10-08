import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
import { cleanCode, isEmail } from './auth';
import * as direct from './crypto';
import {
  describeSlots, forgedShards, fromB64, fromB64url, MAX_BYTES, parseShard, parseVaultFile, rand, shardTokens, toB64, toB64url, VaultError,
  type Header, type Plain, type Policy, type Shard, type SlotType, type Unlock, type VaultFile,
} from './crypto';
import { airGap, billing, cloud, cloudConfigured, drive, legacy, local, type LegacyInput, type LegacyPlan, type Plan } from './storage';
import type { Api } from './worker';
import CryptoWorker from './worker?worker&inline';

declare const __APP_VERSION__: string;

// Trusted Types: the only script URLs this app may ever load are its service worker and the
// crypto worker's blob. Must exist before the worker is constructed.
type TT = { createPolicy: (n: string, p: { createScriptURL: (u: string) => string }) => unknown };
(window as { trustedTypes?: TT }).trustedTypes?.createPolicy('default', {
  createScriptURL: (u) => {
    if (u === './sw.js' || u.startsWith('blob:')) return u;
    throw new TypeError(`Blocked script URL: ${u}`);
  },
});

// Air-gap must engage before anything can reach the network.
if (airGap.preferred) airGap.lock();

// Theme: "system" follows the OS; an explicit choice is stored per device. Applied before first render.
const THEME_KEY = 'ztv.theme';
type Theme = 'system' | 'light' | 'dark';
function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]').forEach((m) => { m.content = dark ? '#131110' : '#f3eee3'; });
}
const storedTheme = (() => { try { return (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system'; } catch { return 'system'; } })();
applyTheme(storedTheme);

// If this load is the Google Drive consent popup returning, hand the token to the opener tab and close.
const oauthPopup = drive.completeRedirect();
const returningFromSignIn = /[?&]code=/.test(location.search);

// ================= Crypto engine: isolated worker, main-thread fallback =================
let worker: Worker | null = null;
try { worker = new CryptoWorker(); } catch { worker = null; }
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
let seq = 0;
worker?.addEventListener('message', ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string; vault?: boolean }>) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.error !== undefined) p.rej(data.vault ? new VaultError(data.error) : new Error(data.error));
  else p.res(data.result);
});
worker?.addEventListener('error', () => {
  worker = null; // fall back to in-page crypto for every later call
  for (const p of pending.values()) p.rej(new VaultError('The crypto engine stopped, usually because the device ran out of memory. Try a smaller file, or use a computer.'));
  pending.clear();
  renderEngine();
});
function engine<F extends keyof Api>(fn: F, ...args: Parameters<Api[F]>): ReturnType<Api[F]> {
  if (!worker) return (direct[fn] as (...a: unknown[]) => ReturnType<Api[F]>)(...args);
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res: res as (v: unknown) => void, rej });
    worker!.postMessage({ id, fn, args });
  }) as ReturnType<Api[F]>;
}

// ================= DOM helpers =================
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';
const enc = new TextEncoder();
const dec = new TextDecoder();

const ICONS: Record<string, string> = {
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2',
  unlock: 'M6 11V8a6 6 0 0 1 11.3-2.8M5 11h14v10H5zM12 15v2',
  stack: 'M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  gear: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  upload: 'M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  download: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5',
  x: 'M6 6l12 12M18 6 6 18',
  shard: 'M12 3l7.5 9L12 21 4.5 12zM4.5 12h15',
  key: 'M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM10.8 12.2 20 3M16 7l3 3M14 9l2 2',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'eye-off': 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
  device: 'M3 5h18v11H3zM8 20h8M12 16v4',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.6a4.5 4.5 0 0 1-.5 9.9z',
  shield: 'M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6L12 3z',
  alert: 'M12 4 2.5 20h19L12 4zM12 10v4.5M12 17.5h.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  printer: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  'wifi-off': 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3a10 10 0 0 1 5 2.7M2 9.5a15 15 0 0 1 4.5-2.9M10.5 5.1A15 15 0 0 1 22 9.5M12 20h.01',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  fingerprint: 'M7.5 4.6A8.5 8.5 0 0 1 20.5 12v1M3.5 16a8.5 8.5 0 0 0 .8-7.3M8 12a4 4 0 0 1 8 0v1.5a13 13 0 0 1-1.6 6.2M12 12v1.5a9 9 0 0 1-2.4 6.2M8 15.5a9 9 0 0 1-1.3 3.4M19.6 17a14 14 0 0 1-.9 3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  contrast: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18',
  hourglass: 'M6 3h12M6 21h12M7 3v3a5 5 0 0 0 10 0V3M7 21v-3a5 5 0 0 1 10 0v3',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z',
  plus: 'M12 5v14M5 12h14',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  drive: 'M3 6.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7',
};

function svgEl(tag: string, attrs: Record<string, string>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function icon(name: string): SVGSVGElement {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }) as SVGSVGElement;
  s.append(svgEl('path', { d: ICONS[name] ?? '' }));
  return s;
}
const setIcon = (holder: Element, name: string) => holder.replaceChildren(icon(name));

type Kid = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | EventListener | undefined> = {}, ...kids: Kid[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const button = (label: string, ic: string, onclick: () => void, cls = 'btn ghost sm') => h('button', { class: cls, type: 'button', onclick }, icon(ic), label);

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const vaultName = (f: VaultFile) => `${slug(f.h.label) || 'vault'}-${f.h.id}.vault`;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listIdx = (xs: number[]) => xs.map((i) => `#${i}`).join(', ');

function log(msg: string) {
  const list = $('log');
  list.prepend(h('li', {}, h('time', {}, new Date().toTimeString().slice(0, 8)), msg));
  while (list.children.length > 200) list.lastChild!.remove();
}

function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'ok' ? 'check' : 'alert'), h('span', {}, msg));
  const box = $('toasts');
  box.append(t);
  while (box.children.length > 3) box.firstChild!.remove();
  setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove()); }, kind === 'error' ? 6500 : 3500);
  log(kind === 'error' ? `ERROR ${msg}` : msg);
}
const fail = (e: unknown) => {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return toast('Cancelled.', 'error');
  toast(e instanceof Error ? e.message : String(e), 'error');
};
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  const kids = [...btn.childNodes];
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.replaceChildren(icon('spinner'), h('span', {}, label));
  await nextFrame();
  try { await fn(); } catch (e) { fail(e); } finally {
    btn.replaceChildren(...kids);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

function download(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const downloadVault = (f: VaultFile) => download(vaultName(f), JSON.stringify(f), 'application/json');

async function copy(text: string, what = 'Copied', clearAfter = 0) {
  try {
    await navigator.clipboard.writeText(text);
    toast(clearAfter ? `${what} Clipboard clears in ${clearAfter} s.` : what);
    if (clearAfter) setTimeout(() => { if (document.hasFocus()) navigator.clipboard.writeText('').catch(() => {}); }, clearAfter * 1000);
  } catch { toast('Clipboard is blocked. Select and copy manually.', 'error'); }
}

function confirmDialog(title: string, body: string, ok = 'Confirm', danger = false): Promise<boolean> {
  const d = $<HTMLDialogElement>('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  const okBtn = $('confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}

/** Segmented radio control with arrow-key support. */
function seg(id: string, onChange: (v: string) => void) {
  const btns = [...$(id).querySelectorAll('button')];
  const get = () => btns.find((b) => b.getAttribute('aria-checked') === 'true')!.dataset.v!;
  const set = (v: string) => {
    btns.forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.v === v)); b.tabIndex = b.dataset.v === v ? 0 : -1; });
    onChange(v);
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => set(b.dataset.v!));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = btns[(i + d + btns.length) % btns.length];
      next.focus();
      set(next.dataset.v!);
    });
  });
  btns.forEach((b) => (b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1));
  return { get, set };
}

function dropzone(zone: HTMLElement, onFiles: (files: File[]) => void) {
  const input = zone.querySelector<HTMLInputElement>('input[type=file]')!;
  input.addEventListener('change', () => { onFiles([...(input.files ?? [])]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFiles([...(e.dataTransfer?.files ?? [])]); });
}
// A file dropped outside a drop zone must not navigate away (and lose state).
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function qr(text: string): HTMLElement {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const svg = svgEl('svg', { viewBox: `-2 -2 ${n + 4} ${n + 4}`, 'shape-rendering': 'crispEdges' });
  svg.append(svgEl('path', { d, fill: '#000' }));
  return h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code containing this shard' }, svg);
}

const SLOT_TAG: Record<SlotType, [string, (hd: Header) => string]> = {
  shards: ['shard', (hd) => `${hd.shamir!.k} of ${hd.shamir!.n} shards`],
  pass: ['key', () => 'Passphrase'],
  'shards+pass': ['lock', (hd) => `${hd.shamir!.k}/${hd.shamir!.n} shards + passphrase`],
  passkey: ['fingerprint', () => 'Passkey'],
};
function tagsFor(f: VaultFile): HTMLElement[] {
  const t = f.h.slots.map((s) => h('span', { class: 'tag accent' }, icon(SLOT_TAG[s.type][0]), SLOT_TAG[s.type][1](f.h)));
  t.push(h('span', { class: 'tag' }, fmtBytes(Math.floor((f.ct.length * 3) / 4))));
  return t;
}
const needsPassToo = (hd: Header) => hd.slots.some((s) => s.type === 'shards+pass') && !hd.slots.some((s) => s.type === 'shards');

// ================= Passkeys (WebAuthn PRF) =================
const PK_KEY = 'ztv.passkey';
interface SavedPasskey { cred: string; created: string; rp: string }
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

const passkey = {
  get supported() { return isSecureContext && location.protocol !== 'file:' && 'PublicKeyCredential' in window; },
  get saved(): SavedPasskey | null {
    try { return JSON.parse(localStorage.getItem(PK_KEY) ?? 'null') as SavedPasskey | null; } catch { return null; }
  },
  set saved(v: SavedPasskey | null) {
    try { if (v) localStorage.setItem(PK_KEY, JSON.stringify(v)); else localStorage.removeItem(PK_KEY); } catch { /* storage blocked */ }
  },
  async register(): Promise<SavedPasskey> {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Zero-Trust Vault' },
        user: { id: rand(16), name: 'vault-key', displayName: 'Zero-Trust Vault key' },
        challenge: rand(32), // no server: the credential is used only for its PRF, never as a login assertion
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new VaultError('Passkey creation was cancelled.');
    if (!(cred.getClientExtensionResults() as PrfResults).prf?.enabled) {
      throw new VaultError("This authenticator doesn't support the PRF extension, so it can't hold vault keys. Recent iCloud Keychain, Google Password Manager, Windows Hello and YubiKey 5 do.");
    }
    const saved = { cred: toB64url(new Uint8Array(cred.rawId)), created: new Date().toISOString(), rp: location.hostname };
    passkey.saved = saved;
    return saved;
  },
  async prf(cred: string, salt: Uint8Array): Promise<Uint8Array> {
    const a = (await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: fromB64url(cred) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = a && (a.getClientExtensionResults() as PrfResults).prf?.results?.first;
    if (!out) throw new VaultError('The passkey did not return a PRF secret.');
    return new Uint8Array(out);
  },
};

// ================= Tabs =================
const TABS = ['seal', 'open', 'vault', 'verify', 'legacy', 'settings'] as const;
type Tab = (typeof TABS)[number];
const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];

function show(tab: Tab) {
  for (const t of TABS) {
    $(`view-${t}`).hidden = t !== tab;
    const b = $(`tab-${t}`);
    b.setAttribute('aria-selected', String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  if (tab === 'vault') void renderVault();
  if (tab === 'open') void refreshPick();
  if (tab === 'settings') void refreshSettings();
  if (tab === 'legacy') void renderLegacy();
  if (tab === 'seal') { void refreshDest(); refreshPasskeyMethod(); }
  window.scrollTo({ top: 0 });
}
tabBtns.forEach((b, i) => {
  b.addEventListener('click', () => show(b.dataset.tab as Tab));
  b.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = tabBtns[(i + d + tabBtns.length) % tabBtns.length];
    next.focus();
    show(next.dataset.tab as Tab);
  });
});
window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1) as Tab;
  if (TABS.includes(t)) show(t);
});

// ================= Network status =================
function updateNet() {
  const state = airGap.active ? 'airgap' : navigator.onLine ? 'online' : 'offline';
  $('net-chip').dataset.state = state;
  $('net-label').textContent = { airgap: 'Air-gapped', online: 'Online', offline: 'Offline' }[state];
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
$('net-chip').addEventListener('click', () => show('settings'));

// ================= SEAL =================
const secretText = $<HTMLTextAreaElement>('secret-text');
const labelEl = $<HTMLInputElement>('label');
const nEl = $<HTMLInputElement>('n');
const kEl = $<HTMLInputElement>('k');
const passEl = $<HTMLInputElement>('pass');
const pass2El = $<HTMLInputElement>('pass2');
const mShards = $<HTMLInputElement>('m-shards');
const mPass = $<HTMLInputElement>('m-pass');
const mPasskey = $<HTMLInputElement>('m-passkey');
const requireBoth = $<HTMLInputElement>('require-both');
let staged: { name: string; type: string; data: Uint8Array } | null = null;
type Where = 'local' | 'cloud' | 'gdrive';
type Rekey = { label: string; id: string; where?: Where } | null;
let rekey: Rekey = null;

const kind = seg('payload-kind', (v) => {
  $('payload-text').hidden = v !== 'text';
  $('payload-file').hidden = v !== 'file';
  summary();
});

const labelHint = $('label-hint');
const LABEL_DEFAULT = labelHint.textContent ?? '';
labelEl.addEventListener('input', () => {
  const risky = /\b(seed|mnemonic|passphrase|password|private key|recovery phrase|pin|binance|coinbase|ledger|trezor|metamask|wallet)\b/i.test(labelEl.value);
  labelHint.textContent = risky ? 'This label is readable by anyone who holds the file. Describe the vault ("Family kit"), not what it protects.' : LABEL_DEFAULT;
  labelHint.className = risky ? 'hint warn-text' : 'hint';
});

function updateTextCount() {
  $('text-count').textContent = `${secretText.value.length.toLocaleString()} characters`;
  summary();
}
secretText.addEventListener('input', updateTextCount);

function stage(file: { name: string; type: string; data: Uint8Array }) {
  staged = file;
  $('file-name').textContent = file.name;
  $('file-meta').textContent = `${fmtBytes(file.data.length)} · ${file.type}`;
  $('file-chip').hidden = false;
  $('file-drop').hidden = true;
  summary();
}
function clearStaged() {
  staged?.data.fill(0);
  staged = null;
  $('file-chip').hidden = true;
  $('file-drop').hidden = false;
  summary();
}
dropzone($('file-drop'), async ([f]) => {
  if (!f) return;
  if (f.size > MAX_BYTES) return fail(new VaultError(`${f.name} is ${fmtBytes(f.size)}. The limit is 100 MB.`));
  if (f.size > 25 * 1024 * 1024 && matchMedia('(pointer: coarse)').matches) toast('Large file on a phone: sealing needs several times its size in memory. If it fails, try on a computer.', 'error');
  stage({ name: f.name, type: f.type || 'application/octet-stream', data: new Uint8Array(await f.arrayBuffer()) });
  log(`Staged ${f.name} in memory`);
});
$('file-clear').addEventListener('click', clearStaged);

/** Slot types the current form would produce. */
function chosenSlots(): SlotType[] {
  const t: SlotType[] = [];
  if (mShards.checked && mPass.checked && requireBoth.checked) t.push('shards+pass');
  else {
    if (mShards.checked) t.push('shards');
    if (mPass.checked) t.push('pass');
  }
  if (mPasskey.checked) t.push('passkey');
  return t;
}
function ruleText(): string {
  const slots = chosenSlots();
  if (!slots.length) return 'Pick at least one way to unlock.';
  return `Opens with: ${describeSlots({ shamir: { k: +kEl.value, n: +nEl.value, fp: '' }, slots: slots.map((type) => ({ type, iv: '', key: '' })) })}`;
}

function syncMethods() {
  $('shard-config').hidden = !mShards.checked;
  $('pass-config').hidden = !mPass.checked;
  const both = mShards.checked && mPass.checked;
  $('both-row').hidden = !both;
  if (!both) requireBoth.checked = false;
  $('rule').textContent = ruleText();
  summary();
}
[mShards, mPass, mPasskey, requireBoth].forEach((el) => el.addEventListener('change', syncMethods));

// Quick choices cover what most people want; "Custom" reveals every key slot.
const PRESETS: Record<string, { shards: boolean; pass: boolean }> = {
  me: { shards: false, pass: true },
  people: { shards: true, pass: false },
  either: { shards: true, pass: true },
};
function applyPreset(v: string) {
  $('custom-methods').hidden = v !== 'custom';
  const p = PRESETS[v];
  if (p) {
    mShards.checked = p.shards;
    mPass.checked = p.pass;
    mPasskey.checked = false;
    requireBoth.checked = false;
  }
  syncMethods();
}
document.querySelectorAll<HTMLInputElement>('input[name=preset]').forEach((r) => r.addEventListener('change', () => applyPreset(r.value)));

function refreshPasskeyMethod() {
  const sub = $('m-passkey-sub');
  const ok = passkey.supported && Boolean(passkey.saved);
  mPasskey.disabled = !ok;
  if (!ok) mPasskey.checked = false;
  sub.textContent = !passkey.supported ? 'Needs the HTTPS site (not the offline file)'
    : !passkey.saved ? 'Register one under Settings first' : 'Touch ID, Windows Hello, security key';
  syncMethods();
}

function syncSliders() {
  const n = +nEl.value;
  kEl.max = String(n);
  if (+kEl.value > n) kEl.value = String(n);
  const k = +kEl.value;
  $('n-out').textContent = String(n);
  $('k-out').textContent = String(k);
  for (const el of [nEl, kEl]) el.style.setProperty('--p', `${((+el.value - +el.min) / (+el.max - +el.min || 1)) * 100}%`);
  $('pips').replaceChildren(...Array.from({ length: n }, (_, i) => h('span', { class: `pip${i < k ? ' need' : ''}` }, String(i + 1))));
  const spare = n - k;
  $('policy-hint').textContent = `Any ${k} of ${n} shards rebuild the key. `
    + (spare ? `Up to ${spare} can be lost safely. ` : 'Every shard is required. Losing one locks the vault forever. ')
    + `${k - 1 === 1 ? 'A single shard reveals' : `Any ${k - 1} together reveal`} nothing. Extra shards let the app catch forged ones.`;
  $('rule').textContent = ruleText();
  summary();
}
nEl.addEventListener('input', syncSliders);
kEl.addEventListener('input', syncSliders);

// Rough strength estimate: charset size × length, discounted for repeats. Labelled as an estimate in the UI.
function strengthBits(p: string): number {
  if (!p) return 0;
  const pool = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0) + (/\d/.test(p) ? 10 : 0) + (/[^a-zA-Z\d]/.test(p) ? 33 : 0);
  const unique = new Set(p).size;
  return Math.round(Math.log2(pool) * (unique + (p.length - unique) * 0.4));
}
function meter() {
  const bits = strengthBits(passEl.value);
  const [label, color, pct] = bits === 0 ? ['Use 4+ random words or a generated passphrase.', 'var(--danger)', 0]
    : bits < 45 ? [`≈${bits} bits · weak`, 'var(--danger)', 20]
    : bits < 65 ? [`≈${bits} bits · fair`, 'var(--warn)', 50]
    : bits < 90 ? [`≈${bits} bits · strong`, 'var(--accent)', 78]
    : [`≈${bits} bits · excellent`, 'var(--accent)', 100];
  const bar = $('meter');
  bar.style.setProperty('--w', `${pct}%`);
  bar.style.setProperty('--c', color as string);
  $('meter-label').textContent = label as string;
  summary();
}
passEl.addEventListener('input', meter);
pass2El.addEventListener('input', summary);

function setPassVisible(on: boolean) {
  passEl.type = pass2El.type = on ? 'text' : 'password';
  const b = $('pass-show');
  b.setAttribute('aria-pressed', String(on));
  setIcon(b.querySelector('i') ?? b, on ? 'eye-off' : 'eye');
}
$('pass-show').addEventListener('click', () => setPassVisible(passEl.type === 'password'));
$('pass-gen').addEventListener('click', () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: byte & 31 is unbiased
  const chars = Array.from(rand(26), (b) => A[b & 31]).join('');
  passEl.value = pass2El.value = chars.match(/.{1,5}/g)!.join('-');
  setPassVisible(true);
  meter();
  toast('Generated a 130-bit passphrase. Write it down now.');
});

type Dest = 'local' | 'cloud' | 'gdrive' | 'download';
const destValue = () => document.querySelector<HTMLInputElement>('input[name=dest]:checked')!.value as Dest;
document.querySelectorAll('input[name=dest]').forEach((r) => r.addEventListener('change', summary));

async function refreshDest() {
  const radio = document.querySelector<HTMLInputElement>('input[name=dest][value=cloud]')!;
  const sub = $('dest-cloud-sub');
  if (!cloudConfigured) { radio.disabled = true; sub.textContent = 'Not configured in this build'; }
  else if (airGap.active) { radio.disabled = true; sub.textContent = 'Unavailable in air-gap mode'; }
  else {
    radio.disabled = false;
    const s = await cloud.session().catch(() => null);
    sub.textContent = s ? `Signed in as ${s.user.email}` : 'Sign in to sync across devices';
  }
  const gd = $('dest-gdrive');
  gd.hidden = !drive.configured || airGap.active;
  $('dest-gdrive-sub').textContent = drive.connected ? 'Connected' : 'Your own Drive, connect once';
  const gdRadio = gd.querySelector('input')!;
  if ((radio.disabled && radio.checked) || (gd.hidden && gdRadio.checked)) document.querySelector<HTMLInputElement>('input[name=dest][value=local]')!.checked = true;
  summary();
}

function summary() {
  const what = kind.get() === 'text'
    ? (secretText.value ? `Text · ${secretText.value.length.toLocaleString()} chars` : 'Nothing yet')
    : (staged ? `${staged.name} · ${fmtBytes(staged.data.length)}` : 'No file chosen');
  const slots = chosenSlots();
  const where = { local: 'This device', cloud: 'Cloud', gdrive: 'Google Drive', download: 'Downloaded file' }[destValue()];
  const opens = slots.length ? ruleText().replace(/^Opens with: /, '') : 'Choose who can open it';
  const rows: [string, string][] = [['Locking', what], ['Opens with', opens[0].toUpperCase() + opens.slice(1)], ['Kept on', where]];
  $('summary').replaceChildren(...rows.flatMap(([a, b]) => [h('dt', {}, a), h('dd', {}, b)]));
}

function resetSeal() {
  secretText.value = '';
  labelEl.value = '';
  passEl.value = pass2El.value = '';
  setPassVisible(false);
  clearStaged();
  meter();
  updateTextCount();
}

/** Synchronous validation, so nothing (e.g. a passkey prompt) starts for an invalid form. */
function buildSeal(): { plain: Plain; pol: Policy } {
  let plain: Plain;
  if (kind.get() === 'text') {
    if (!secretText.value) throw new VaultError('Write something to seal first.');
    plain = { meta: { kind: 'text', name: 'secret.txt', type: 'text/plain', size: 0 }, data: enc.encode(secretText.value) };
  } else {
    if (!staged) throw new VaultError('Choose a file to seal.');
    plain = { meta: { kind: 'file', name: staged.name, type: staged.type, size: 0 }, data: staged.data };
  }
  const slots = chosenSlots();
  if (!slots.length) throw new VaultError('Pick at least one way to unlock.');
  if (slots.length === 1 && slots[0] === 'passkey') {
    throw new VaultError('Add shards or a passphrase too. A passkey only works on this domain, so a passkey-only vault would be lost if the site ever went away.');
  }
  const pol: Policy = { label: labelEl.value, requireBoth: requireBoth.checked };
  if (mShards.checked) pol.shards = { k: +kEl.value, n: +nEl.value };
  if (mPass.checked) {
    if (passEl.value.length < 8) throw new VaultError('Passphrase must be at least 8 characters.');
    if (passEl.value !== pass2El.value) throw new VaultError("Passphrases don't match.");
    pol.passphrase = passEl.value;
  }
  return { plain, pol };
}

$('seal-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  let built: ReturnType<typeof buildSeal>;
  try { built = buildSeal(); } catch (err) { return fail(err); }
  // Start WebAuthn synchronously inside the click so Safari keeps the user gesture.
  const pk = mPasskey.checked ? passkey.saved : null;
  const salt = pk ? rand(32) : null;
  const prfP = pk ? passkey.prf(pk.cred, salt!) : null;
  prfP?.catch(() => {});
  // Google's consent popup must also open inside the click.
  const driveP = destValue() === 'gdrive' && !drive.connected ? drive.connect() : null;
  driveP?.catch(() => {});
  void busy(btn, pk ? 'Touch your passkey…' : 'Sealing…', async () => {
    const { plain, pol } = built;
    if (pk) pol.passkey = { cred: pk.cred, rp: pk.rp, salt: toB64(salt!), prf: await prfP! };
    const dest = destValue();
    if (dest === 'cloud' && !(await cloud.session())) { openAuth(); throw new VaultError('Sign in to save to the cloud, then press Seal again.'); }
    if (driveP) await driveP;

    const { file, shards } = await engine('seal', plain, pol);
    let saveError: string | undefined;
    try {
      if (dest === 'local') await local.put(file);
      else if (dest === 'cloud') await cloud.put(file);
      else if (dest === 'gdrive') await drive.put(file);
      else downloadVault(file);
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err); // shards are still shown; user can download the .vault
    }
    log(`Sealed ${file.h.id} → ${dest} [${file.h.slots.map((s) => s.type).join(', ')}]${saveError ? ' (save failed)' : ''}`);
    const replaced = rekey;
    setRekey(null);
    resetSeal();
    showSealed(file, shards, dest, saveError, replaced);
  });
});

function setRekey(r: Rekey) {
  rekey = r;
  $('rekey-banner').hidden = !r;
  if (r) $('rekey-name').textContent = r.label;
}
$('rekey-cancel').addEventListener('click', () => { setRekey(null); resetSeal(); });

// ---- Sealed dialog ----
let sealed: { file: VaultFile; shards: string[]; saved: boolean; replaced: Rekey } | null = null;
const sealedDialog = $<HTMLDialogElement>('sealed-dialog');

function shardFile(f: VaultFile, i: number) { return `vault-${f.h.id}-shard-${i + 1}-of-${f.h.shamir!.n}.key`; }

function showSealed(file: VaultFile, shards: string[], dest: string, saveError?: string, replaced: Rekey = null) {
  sealed = { file, shards, saved: false, replaced };
  const where = { local: 'Saved on this device', cloud: 'Uploaded to your cloud vault', gdrive: 'Saved to your Google Drive', download: 'Downloaded as a .vault file' }[dest];
  $('sealed-title').textContent = saveError ? 'Sealed, but not saved' : 'Vault sealed';
  $('sealed-sub').textContent = saveError
    ? `Saving failed: ${saveError}. Download the .vault file now or the data is lost.`
    : `${where} · id ${file.h.id}${file.h.label ? ` · ${file.h.label}` : ''}`;
  const both = needsPassToo(file.h);
  const warn = $('sealed-warn').querySelector('div')!;
  warn.replaceChildren(...(shards.length
    ? [h('strong', {}, 'Save your shards now. '), `They are shown once and nobody, including us, can recover them. Give each to a different person or place. Opens with ${describeSlots(file.h)}.`
      + (both ? ' The shards are useless without the passphrase, so store it separately.' : '')]
    : [h('strong', {}, 'Your keys are the only way in. '), `Opens with ${describeSlots(file.h)}. Nothing can be reset.`]));
  $('shard-grid').replaceChildren(...shards.map((s, i) => {
    const card = h('article', { class: 'shard-card' },
      h('header', {}, h('strong', {}, `SHARD ${i + 1}/${shards.length}`), h('span', {}, `${file.h.id.slice(0, 8)}…`)),
      qr(s),
      h('div', { class: 'shard-text', title: s }, s),
      h('div', { class: 'row' },
        button('Copy', 'copy', () => { sealed!.saved = true; void copy(s, `Shard ${i + 1} copied.`); }),
        button('.key', 'download', () => { sealed!.saved = true; download(shardFile(file, i), `${s}\n`, 'text/plain'); })));
    card.style.animationDelay = `${i * 60}ms`;
    return card;
  }));
  $('dl-shards').hidden = $('print-kit').hidden = !shards.length;
  // The moment Legacy matters most: they just made something someone else must be able to find.
  $('sealed-upsell').hidden = !(cloudConfigured && !airGap.active && !plan.pro);
  if (!shards.length) sealed.saved = true;
  sealedDialog.showModal();
}

$('dl-vault').addEventListener('click', () => sealed && downloadVault(sealed.file));
$('dl-shards').addEventListener('click', async () => {
  const cur = sealed;
  if (!cur) return;
  cur.saved = true;
  for (const [i, s] of cur.shards.entries()) {
    download(shardFile(cur.file, i), `${s}\n`, 'text/plain');
    await new Promise((r) => setTimeout(r, 200)); // browsers drop rapid-fire downloads
  }
});
$('print-kit').addEventListener('click', () => { if (sealed) { sealed.saved = true; printKit(sealed.file, sealed.shards); } });

async function closeSealed() {
  if (sealed && !sealed.saved && !(await confirmDialog('Close without saving shards?', "You haven't copied, downloaded or printed any shard. Once closed they're gone, and so is access to this vault.", 'Discard shards', true))) return;
  const replaced = sealed?.replaced;
  sealed = null;
  $('shard-grid').replaceChildren();
  sealedDialog.close();
  if (replaced) await retireOld(replaced);
  void renderVault();
}
async function retireOld(old: NonNullable<Rekey>) {
  if (!old.where) return toast(`Re-keyed. Destroy the old .vault file for “${old.label}” so its old shards stop mattering.`);
  if (!(await confirmDialog('Delete the old vault?', `“${old.label}” (${old.id}) still opens with its old keys. Delete it so those shards become useless?`, 'Delete old vault', true))) return;
  try {
    if (old.where === 'gdrive') {
      const hit = (await drive.list()).find((x) => x.id === old.id);
      if (hit) await drive.remove(hit.fileId);
    } else await (old.where === 'local' ? local.remove(old.id) : cloud.remove(old.id));
    toast('Old vault deleted. Its shards no longer open anything.');
  } catch (e) { fail(e); }
}
$('sealed-done').addEventListener('click', closeSealed);
$('sealed-upsell-btn').addEventListener('click', async () => { await closeSealed(); if (!sealedDialog.open) show('legacy'); });
sealedDialog.addEventListener('cancel', (e) => { e.preventDefault(); void closeSealed(); });
window.addEventListener('beforeunload', (e) => { if (sealed && !sealed.saved) e.preventDefault(); });

function printKit(file: VaultFile, shards: string[]) {
  const { id, label, created, shamir } = file.h;
  const both = needsPassToo(file.h);
  const others = file.h.slots.filter((s) => s.type === 'pass' || s.type === 'passkey').map((s) => (s.type === 'pass' ? 'passphrase' : 'passkey'));
  const pages = shards.map((s, i) => h('section', { class: 'kit-page' },
    h('h1', {}, `Recovery shard ${i + 1} of ${shamir!.n}`),
    h('p', { class: 'kit-sub' }, `${label || 'Zero-Trust Vault'}: ${describeSlots(file.h)}.`),
    qr(s),
    h('div', { class: 'kit-shard' }, s),
    h('dl', { class: 'kit-meta' },
      h('dt', {}, 'Vault id'), h('dd', {}, id),
      h('dt', {}, 'Created'), h('dd', {}, fmtDate(created)),
      h('dt', {}, 'Needed'), h('dd', {}, `${shamir!.k} different shards${both ? ' + the passphrase' : ''}`),
      h('dt', {}, 'Alternatives'), h('dd', {}, others.length ? `Also opens with the ${others.join(' or ')}` : 'None')),
    h('strong', {}, 'How to recover'),
    h('ol', {},
      h('li', {}, 'Get the vault file (.vault), or access to the device or account where it was saved.'),
      h('li', {}, `Collect ${shamir!.k} different shards from their holders${both ? ', plus the passphrase' : ''}.`),
      h('li', {}, 'Open Zero-Trust Vault (the website, or the offline file zero-trust-vault.html if the website is gone) and go to Open.'),
      h('li', {}, 'Load the vault, then scan each QR code with "Scan QR" (or paste the text), and press Open vault. Typos and forged shards are detected automatically.')),
    h('p', {}, `Keep this page private. On its own it reveals nothing, but together with ${shamir!.k - 1} other shard${shamir!.k > 2 ? 's' : ''}${both ? ' and the passphrase' : ''} it unlocks the vault.`)));
  $('print-root').replaceChildren(...pages);
  window.addEventListener('afterprint', () => $('print-root').replaceChildren(), { once: true });
  window.print();
}

// ================= OPEN =================
let target: VaultFile | null = null;
let targetWhere: Where | undefined;
let validShards: Shard[] = []; // genuine shards: count toward quorum
let presentedShards: Shard[] = []; // everything the user supplied for this vault, passed to open() so forgeries get reported
let opened: (Plain & { via: SlotType; bad: number[] }) | null = null;
const shardPaste = $<HTMLTextAreaElement>('shard-paste');
const openPass = $<HTMLInputElement>('open-pass');
const pick = $<HTMLSelectElement>('vault-pick');
const slotTypes = () => target?.h.slots.map((s) => s.type) ?? [];

function setTarget(f: VaultFile | null, source = '', where?: Where) {
  target = f;
  targetWhere = where;
  const info = $('vault-info');
  info.hidden = !f;
  if (f) {
    info.replaceChildren(
      h('div', { class: 'title' }, h('strong', {}, f.h.label || 'Untitled vault'), h('span', { class: 'hint mono' }, f.h.id)),
      h('div', { class: 'tags' }, ...tagsFor(f)),
      h('span', { class: 'hint' }, `Created ${fmtDate(f.h.created)}${source ? ` · ${source}` : ''}`));
    log(`Loaded vault ${f.h.id}${source ? ` from ${source}` : ''}`);
  }
  const types = slotTypes();
  const shards = !f || types.some((t) => t.includes('shards'));
  const pass = !f || types.includes('pass') || types.includes('shards+pass');
  const pk = types.includes('passkey');
  $('unlock-shards').hidden = !shards;
  $('unlock-pass').hidden = !pass;
  $('open-btn').hidden = !shards && !pass;
  $('unlock-or').hidden = !(shards && pass);
  $('unlock-or-text').textContent = types.includes('shards+pass') ? 'and' : 'or';
  $('unlock-passkey').hidden = !pk;
  if (pk) {
    const slot = f!.h.slots.find((s) => s.type === 'passkey')!;
    const usable = passkey.supported && slot.rp === location.hostname;
    $<HTMLButtonElement>('open-passkey').disabled = !usable;
    $('passkey-open-hint').textContent = !passkey.supported ? 'Passkeys need the HTTPS site and are not available in the offline file. Use another key slot.'
      : slot.rp !== location.hostname ? `This passkey belongs to ${slot.rp}. Open the vault there, or use another key slot.`
      : 'Works with this passkey on any device it syncs to.';
  }
  $('keys-sub').textContent = f ? `Opens with ${describeSlots(f.h)}.` : 'Shards, a passphrase, a passkey: whatever this vault accepts.';
  void renderOpenShards();
}

dropzone($('vault-drop'), async ([f]) => {
  if (!f) return;
  try { pick.value = ''; setTarget(parseVaultFile(await f.text()), f.name); } catch (e) { fail(e); }
});

async function refreshPick() {
  const keep = pick.value;
  const opts: HTMLElement[] = [h('option', { value: '' }, 'Choose a record…')];
  const localFiles = await local.list().catch(() => []);
  if (localFiles.length) {
    const g = h('optgroup', { label: 'This device' });
    for (const f of localFiles.sort((a, b) => b.h.created.localeCompare(a.h.created))) g.append(h('option', { value: `local:${f.h.id}` }, `${f.h.label || 'Untitled'} · ${f.h.id.slice(0, 8)}`));
    opts.push(g);
  }
  if (drive.connected) {
    const items = await drive.list().catch(() => []);
    if (items.length) {
      const g = h('optgroup', { label: 'Google Drive' });
      for (const it of items) g.append(h('option', { value: `gdrive:${it.fileId}` }, `${it.label || 'Untitled'} · ${it.id.slice(0, 8)}`));
      opts.push(g);
    }
  }
  if (await cloud.session().catch(() => null)) {
    const items = await cloud.list().catch(() => []);
    if (items.length) {
      const g = h('optgroup', { label: 'Cloud' });
      for (const it of items) g.append(h('option', { value: `cloud:${it.id}` }, `${it.id} · ${fmtDate(it.created)}`));
      opts.push(g);
    }
  }
  pick.replaceChildren(...opts);
  pick.value = keep;
}
/** `ref` is the vault id, except for Google Drive where it's Drive's file id. */
async function loadRecord(where: Where, ref: string, how?: string) {
  const f = where === 'local' ? await local.get(ref) : where === 'cloud' ? await cloud.get(ref) : await drive.get(ref);
  if (!f) throw new VaultError('Record not found.');
  pick.value = `${where}:${ref}`;
  setTarget(f, how ?? { local: 'this device', cloud: 'cloud', gdrive: 'Google Drive' }[where], where);
}
pick.addEventListener('change', async () => {
  const [where, id] = pick.value.split(':');
  if (!id) return setTarget(null);
  try { await loadRecord(where as Where, id); } catch (e) { fail(e); }
});

function appendText(area: HTMLTextAreaElement, files: File[], after: () => void) {
  void Promise.all(files.map((f) => f.text())).then((texts) => {
    area.value = [area.value.trim(), ...texts.map((t) => t.trim())].filter(Boolean).join('\n');
    after();
  });
}

/** Parse shard tokens from text; returns per-token status. Shared by Open, Verify and the scanner. */
async function parseTokens(text: string) {
  const seen = new Set<string>();
  const out: { token: string; shard?: Shard; error?: string }[] = [];
  for (const token of shardTokens(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    try { out.push({ token, shard: await parseShard(token) }); } catch (e) { out.push({ token, error: (e as Error).message }); }
  }
  return out;
}

let openGen = 0;
async function renderOpenShards() {
  const gen = ++openGen;
  const parsed = await parseTokens(shardPaste.value);
  if (gen !== openGen) return;
  // Every shard belongs to one other vault that's on this device: switch to it.
  const ids = [...new Set(parsed.flatMap((p) => (p.shard ? [p.shard.id] : [])))];
  if (target && ids.length === 1 && ids[0] !== target.h.id) {
    const f = await local.get(ids[0]).catch(() => undefined);
    if (f && gen === openGen) { pick.value = `local:${ids[0]}`; setTarget(f, 'this device, matched by shard', 'local'); return; }
  }
  const forId = target?.h.id ?? parsed.find((p) => p.shard)?.shard!.id;
  const chips: HTMLElement[] = [];
  const good = new Map<number, Shard>();
  for (const p of parsed) {
    if (!p.shard) { chips.push(h('li', { class: 'chip bad', title: p.error }, icon('alert'), 'damaged shard')); continue; }
    if (p.shard.id !== forId) { chips.push(h('li', { class: 'chip dim', title: `Belongs to vault ${p.shard.id}` }, `#${p.shard.i} · other vault`)); continue; }
    good.set(p.shard.i, p.shard);
    chips.push(h('li', { class: 'chip', 'data-i': String(p.shard.i) }, icon('check'), `#${p.shard.i}/${p.shard.n}`));
  }
  validShards = [...good.values()];
  presentedShards = validShards;
  // v3 vaults carry a commitment per shard: name a forged one immediately, and don't count it toward quorum.
  if (target?.h.shamir?.commits && validShards.length) {
    const forged = await forgedShards(target.h, validShards);
    if (gen !== openGen) return;
    for (const i of forged) {
      const at = chips.findIndex((c) => c.dataset.i === String(i));
      if (at >= 0) chips[at] = h('li', { class: 'chip bad', 'data-i': String(i), title: "This shard doesn't match the vault: forged or damaged" }, icon('alert'), `#${i} · forged`);
    }
    validShards = validShards.filter((x) => !forged.includes(x.i));
  }
  $('shard-chips').replaceChildren(...chips);

  const k = target?.h.shamir?.k ?? validShards[0]?.k ?? 0;
  const have = validShards.length;
  const ring = $('ring');
  ring.style.setProperty('--q', String(k ? Math.min(100, (have / k) * 100) : 0));
  ring.classList.toggle('done', k > 0 && have >= k);
  $('ring-text').textContent = k ? `${have}/${k}` : String(have);
  $('quorum-title').textContent = !have ? 'No shards yet' : have >= k ? (have > k ? `Quorum + ${have - k} spare` : 'Quorum reached') : `${k - have} more shard${k - have > 1 ? 's' : ''} needed`;
  $('quorum-sub').textContent = !have ? 'Drop .key files, scan QR codes, or paste shards below.' : `Vault ${forId}${have > k ? ' · spares let forged shards be identified' : ''}`;

  // Shards first, no vault yet: find the matching record on this device automatically.
  if (!target && forId && validShards.length) {
    const f = await local.get(forId).catch(() => undefined);
    if (f && !target && gen === openGen) { pick.value = `local:${forId}`; setTarget(f, 'this device, matched by shard', 'local'); return; }
    if (!f) $('quorum-sub').textContent = `For vault ${forId}. Load its .vault file to open it.`;
  }
  updateOpenBtn();
}
shardPaste.addEventListener('input', () => void renderOpenShards());
dropzone($('shard-drop'), (files) => appendText(shardPaste, files, () => void renderOpenShards()));
openPass.addEventListener('input', updateOpenBtn);

function quorum() { return Boolean(target?.h.shamir && validShards.length >= target.h.shamir.k); }
function updateOpenBtn() {
  const t = slotTypes();
  const pass = Boolean(openPass.value);
  const ok = (quorum() && t.includes('shards')) || (pass && t.includes('pass')) || (quorum() && pass && t.includes('shards+pass'));
  $<HTMLButtonElement>('open-btn').disabled = !target || !ok;
}

async function doOpen(unlock: Unlock) {
  if (!target) return;
  clearResult();
  opened = await engine('open', target, unlock);
  openPass.value = '';
  showResult(opened, target);
}
$('open-btn').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Opening…', async () => {
  const t = slotTypes();
  const unlock: Unlock = {};
  if (quorum()) unlock.shards = presentedShards;
  if (openPass.value && (t.includes('pass') || t.includes('shards+pass'))) unlock.passphrase = openPass.value;
  await doOpen(unlock);
}).then(updateOpenBtn));

$('open-passkey').addEventListener('click', (e) => {
  const slot = target?.h.slots.find((s) => s.type === 'passkey');
  if (!slot) return;
  const prfP = passkey.prf(slot.cred!, fromB64(slot.salt!)); // started inside the gesture (Safari)
  prfP.catch(() => {});
  void busy(e.currentTarget as HTMLButtonElement, 'Touch your passkey…', async () => doOpen({ prf: await prfP }));
});

// ---- Result + auto-clear ----
const AUTO_CLEAR_S = 300;
let clearAt = 0;
let hiddenAt = 0;
const VIA: Record<SlotType, string> = { shards: 'shards', pass: 'passphrase', 'shards+pass': 'shards + passphrase', passkey: 'passkey' };

function showResult(p: NonNullable<typeof opened>, f: VaultFile) {
  $('open-result').hidden = false;
  $('result-sub').textContent = `${f.h.label || 'Untitled vault'} · ${f.h.id} · unlocked with ${VIA[p.via]}`;
  const isText = p.meta.kind === 'text';
  $('result-text').hidden = !isText;
  $('result-file').hidden = isText;
  if (isText) {
    $('result-title').textContent = 'Vault opened';
    const pre = $('result-pre');
    pre.textContent = dec.decode(p.data);
    pre.classList.add('blurred');
  } else {
    $('result-title').textContent = 'File recovered';
    $('result-file-name').textContent = p.meta.name;
    $('result-file-meta').textContent = `${fmtBytes(p.meta.size)} · ${p.meta.type}`;
  }
  $('result-bad').hidden = !p.bad.length;
  if (p.bad.length) {
    const many = p.bad.length > 1;
    $('result-bad-text').replaceChildren(h('strong', {}, `Forged or corrupted shard${many ? 's' : ''} ${listIdx(p.bad)}. `),
      `${many ? 'They were' : 'It was'} set aside and the vault opened from the others. Whoever holds ${many ? 'them' : 'it'} has a bad copy, or tampered with it. Consider re-keying.`);
    for (const i of p.bad) {
      const chip = document.querySelector(`#shard-chips [data-i="${i}"]`);
      chip?.classList.add('bad');
      chip?.replaceChildren(icon('alert'), `#${i} · forged`);
    }
    log(`Forged/corrupted shards detected: ${listIdx(p.bad)}`);
  }
  clearAt = Date.now() + AUTO_CLEAR_S * 1000;
  tickTimer();
  toast('Vault opened.');
  $('open-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearResult() {
  opened?.data.fill(0);
  opened = null;
  $('result-pre').textContent = '';
  $('open-result').hidden = true;
}
function clearAll(msg: string) {
  clearResult();
  shardPaste.value = '';
  openPass.value = '';
  void renderOpenShards();
  toast(msg);
}
function tickTimer() {
  if (!opened) return;
  const left = Math.max(0, Math.round((clearAt - Date.now()) / 1000));
  if (left === 0) return clearAll('Decrypted data auto-cleared after 5 minutes.');
  $('result-timer').querySelector('span')!.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
setInterval(tickTimer, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (opened && hiddenAt && Date.now() - hiddenAt > 60_000) clearAll('Cleared decrypted data: the tab was in the background for over a minute.');
});

$('result-reveal').addEventListener('click', () => $('result-pre').classList.toggle('blurred'));
$('result-copy').addEventListener('click', () => opened && void copy(dec.decode(opened.data), 'Secret copied.', 45));
$('result-download').addEventListener('click', () => opened && download(opened.meta.name, opened.data as Uint8Array<ArrayBuffer>, opened.meta.type));
$('result-clear').addEventListener('click', () => clearAll('Cleared from memory.'));
$('result-rekey').addEventListener('click', () => {
  if (!opened || !target) return;
  setRekey({ label: target.h.label || target.h.id, id: target.h.id, where: targetWhere });
  if (opened.meta.kind === 'text') {
    kind.set('text');
    secretText.value = dec.decode(opened.data);
    updateTextCount();
  } else {
    kind.set('file');
    stage({ name: opened.meta.name, type: opened.meta.type, data: opened.data.slice() });
  }
  labelEl.value = target.h.label;
  clearResult();
  show('seal');
  toast('Choose new keys, then seal.');
});

// ================= QR scanner =================
type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
let scanStop: (() => void) | null = null;

async function startScan(area: HTMLTextAreaElement, after: () => void) {
  if (!navigator.mediaDevices?.getUserMedia) throw new VaultError('Camera access is not available in this browser.');
  const dialog = $<HTMLDialogElement>('scan-dialog');
  const video = $<HTMLVideoElement>('scan-video');
  const chips = $('scan-chips');
  const status = $('scan-status');
  chips.replaceChildren();
  status.textContent = 'Starting camera…';
  dialog.showModal();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    dialog.close();
    throw new VaultError((e as DOMException).name === 'NotAllowedError' ? 'Camera permission was denied.' : 'No usable camera was found.');
  }
  video.srcObject = stream;
  await video.play().catch(() => {});

  let detector: Detector | null = null;
  const BD = (window as { BarcodeDetector?: { new (o: object): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (BD) try { if ((await BD.getSupportedFormats()).includes('qr_code')) detector = new BD({ formats: ['qr_code'] }); } catch { /* use jsQR */ }
  status.textContent = `Point the camera at a shard's QR code. Scanning with ${detector ? 'the native detector' : 'jsQR'}.`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const seen = new Set(shardTokens(area.value));
  let running = true;
  const loop = async () => {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let texts: string[] = [];
      try {
        if (detector) texts = (await detector.detect(video)).map((c) => c.rawValue);
        else {
          const w = Math.min(640, video.videoWidth);
          const hh = Math.round((video.videoHeight * w) / video.videoWidth);
          canvas.width = w; canvas.height = hh;
          ctx.drawImage(video, 0, 0, w, hh);
          const r = jsQR(ctx.getImageData(0, 0, w, hh).data, w, hh, { inversionAttempts: 'dontInvert' });
          if (r) texts = [r.data];
        }
      } catch { /* frame not ready */ }
      for (const tok of texts.flatMap(shardTokens)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        try {
          const s = await parseShard(tok);
          area.value = [area.value.trim(), tok].filter(Boolean).join('\n');
          chips.append(h('li', { class: 'chip' }, icon('check'), `#${s.i}/${s.n} · ${s.id.slice(0, 6)}`));
          status.textContent = `Got shard #${s.i}. Show the next one, or press Done.`;
          navigator.vibrate?.(60);
          const view = video.parentElement!;
          view.classList.add('hit');
          setTimeout(() => view.classList.remove('hit'), 500);
          after();
        } catch {
          chips.append(h('li', { class: 'chip bad' }, icon('alert'), 'damaged QR'));
        }
      }
    }
    setTimeout(loop, detector ? 120 : 220);
  };
  void loop();
  scanStop = () => {
    running = false;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    scanStop = null;
  };
}
$('scan-done').addEventListener('click', () => $<HTMLDialogElement>('scan-dialog').close());
$('scan-dialog').addEventListener('close', () => scanStop?.());
document.querySelectorAll<HTMLButtonElement>('[data-scan]').forEach((b) => {
  b.hidden = !navigator.mediaDevices?.getUserMedia;
  b.addEventListener('click', () => {
    const id = b.dataset.scan!;
    startScan($<HTMLTextAreaElement>(id), id === 'verify-paste' ? () => void runVerify() : () => void renderOpenShards()).catch(fail);
  });
});

// ================= VAULT =================
const vaultSrc = seg('vault-src', () => void renderVault());
const search = $<HTMLInputElement>('vault-search');
search.addEventListener('input', () => void renderVault());

interface Row { id: string; ref?: string; label: string; created: string; tags: HTMLElement[]; get: () => Promise<VaultFile | undefined>; remove: () => Promise<unknown> }

function emptyState(title: string, sub: string, action?: [string, () => void]) {
  $('records').replaceChildren();
  $('records-empty').hidden = false;
  $('empty-title').textContent = title;
  $('empty-sub').textContent = sub;
  const b = $('empty-action');
  b.hidden = !action;
  if (action) { b.textContent = action[0]; b.onclick = action[1]; }
}

let vaultGen = 0;
async function renderVault() {
  const gen = ++vaultGen;
  const where = vaultSrc.get() as Where;
  let rows: Row[] = [];
  try {
    if (where === 'local') {
      rows = (await local.list()).map((f) => ({
        id: f.h.id, label: f.h.label, created: f.h.created, tags: tagsFor(f),
        get: async () => local.get(f.h.id), remove: () => local.remove(f.h.id),
      }));
    } else if (where === 'gdrive') {
      if (airGap.active) return emptyState('Air-gap is on', 'Google Drive is blocked in this tab. Turn air-gap off in Settings and reload.', ['Open settings', () => show('settings')]);
      if (!drive.connected) return emptyState('Connect your Google Drive', 'Vaults you keep in Drive appear here. Google only stores the locked files, and this app sees only the files it created.', ['Connect Google Drive', () => connectDrive(() => void renderVault())]);
      rows = (await drive.list()).map((d) => ({
        id: d.id, ref: d.fileId, label: d.label, created: d.created, tags: [h('span', { class: 'tag' }, icon('drive'), 'Google Drive'), h('span', { class: 'tag' }, fmtBytes(d.size))],
        get: () => drive.get(d.fileId), remove: () => drive.remove(d.fileId),
      }));
    } else {
      if (!cloudConfigured) return emptyState('Cloud is not configured', 'This build has no cloud backend. Everything still works locally.');
      if (airGap.active) return emptyState('Air-gap is on', 'Cloud access is blocked in this tab. Turn air-gap off in Settings and reload to reconnect.', ['Open settings', () => show('settings')]);
      if (!(await cloud.session())) return emptyState('Sign in to see your cloud vaults', 'Sign in with Google, Apple or email to keep encrypted vaults in sync across your devices.', ['Sign in', () => openAuth()]);
      rows = (await cloud.list()).map((c) => ({
        id: c.id, label: '', created: c.created, tags: [h('span', { class: 'tag' }, icon('cloud'), 'Cloud'), h('span', { class: 'tag' }, fmtBytes(c.size))],
        get: () => cloud.get(c.id), remove: () => cloud.remove(c.id),
      }));
    }
  } catch (e) { fail(e); }
  if (gen !== vaultGen) return;

  const q = search.value.trim().toLowerCase();
  rows = rows.filter((r) => !q || r.label.toLowerCase().includes(q) || r.id.includes(q)).sort((a, b) => b.created.localeCompare(a.created));
  if (!rows.length) {
    return q ? emptyState('No matches', `Nothing matches “${search.value}”.`)
      : emptyState('Nothing here yet', where === 'local' ? 'Vaults you seal to this device, or import, show up here.' : 'Vaults you seal to the cloud show up here.', ['Seal your first vault', () => show('seal')]);
  }
  $('records-empty').hidden = true;
  $('records').replaceChildren(...rows.map((r, i) => {
    const card = h('article', { class: 'card record' },
      h('div', { class: 'record-top' },
        h('div', { class: 'icon-wrap' }, icon('lock')),
        h('div', {}, h('strong', {}, r.label || 'Untitled vault'), h('small', {}, `${r.id} · ${fmtDate(r.created)}`))),
      h('div', { class: 'tags' }, ...r.tags),
      h('div', { class: 'record-actions' },
        button('Open', 'unlock', async () => {
          try { show('open'); await loadRecord(where, r.ref ?? r.id); } catch (e) { fail(e); }
        }),
        button('Export', 'download', async () => { try { const f = await r.get(); if (f) downloadVault(f); } catch (e) { fail(e); } }),
        button('Delete', 'trash', async () => {
          if (!(await confirmDialog('Delete this vault?', `“${r.label || r.id}” will be permanently deleted from ${{ local: 'this device', cloud: 'the cloud', gdrive: 'your Google Drive' }[where]}. Shards can't bring it back. Export a copy first if you might need it.`, 'Delete forever', true))) return;
          try { await r.remove(); toast('Vault deleted.'); void renderVault(); } catch (e) { fail(e); }
        })));
    card.style.animationDelay = `${Math.min(i, 10) * 40}ms`;
    return card;
  }));
}

dropzone($('import-input').parentElement!, async (files) => {
  let ok = 0;
  for (const f of files) {
    try { await local.put(parseVaultFile(await f.text())); ok++; } catch (e) {
      fail((e as DOMException).name === 'ConstraintError' ? new VaultError(`${f.name} is already on this device.`) : e);
    }
  }
  if (ok) { toast(`Imported ${plural(ok, 'vault')}.`); vaultSrc.set('local'); }
});

// ================= VERIFY =================
const verifyPaste = $<HTMLTextAreaElement>('verify-paste');
let verifyGen = 0;
async function runVerify() {
  const gen = ++verifyGen;
  const parsed = await parseTokens(verifyPaste.value);
  if (gen !== verifyGen) return;
  const verdict = $('verdict');
  const set = (state: string, ic: string, title: string, sub: string) => {
    verdict.dataset.state = state;
    setIcon(verdict.querySelector('.verdict-icon')!, ic);
    $('verdict-title').textContent = title;
    $('verdict-sub').textContent = sub;
  };
  const renderChips = (bad: number[] = []) => $('verify-chips').replaceChildren(...parsed.map((p) => !p.shard
    ? h('li', { class: 'chip bad', title: p.error }, icon('alert'), 'checksum failed')
    : bad.includes(p.shard.i)
      ? h('li', { class: 'chip bad', title: 'Valid checksum, but its share does not fit the others' }, icon('alert'), `#${p.shard.i}/${p.shard.n} · forged`)
      : h('li', { class: 'chip' }, icon('check'), `#${p.shard.i}/${p.shard.n} · ${p.shard.id.slice(0, 6)}`)));
  renderChips();
  if (!parsed.length) return set('idle', 'shield', 'Waiting for shards', 'Results appear here as you add shards.');

  const good = parsed.flatMap((p) => (p.shard ? [p.shard] : []));
  const damaged = parsed.length - good.length;
  const ids = new Set(good.map((s) => s.id));
  if (!good.length) return set('bad', 'alert', 'No valid shards', 'Every shard failed its checksum. Look for typos or damaged copies.');
  if (ids.size > 1) return set('bad', 'alert', 'Mixed shard sets', `These shards come from ${ids.size} different vaults. Verify one set at a time.`);
  const { k, n, id } = good[0];
  const have = new Set(good.map((s) => s.i)).size;
  const damagedNote = damaged ? ` ${plural(damaged, 'damaged shard')} ignored.` : '';
  if (have < k) return set('partial', 'shard', `${have} of ${k} shards`, `Each one passes its checksum. Add ${k - have} more from this set to confirm recovery works.${damagedNote}`);
  try {
    const { bad } = await engine('verifyShards', good);
    if (gen !== verifyGen) return;
    renderChips(bad);
    if (bad.length) {
      set('partial', 'alert', 'Recovery works, but a shard is forged', `The key rebuilds for vault ${id}, but shard${bad.length > 1 ? 's' : ''} ${listIdx(bad)} ${bad.length > 1 ? "don't" : "doesn't"} fit. ${bad.length > 1 ? 'They have' : 'It has'} a valid checksum, so ${bad.length > 1 ? 'they were' : 'it was'} probably altered on purpose. Re-key this vault.${damagedNote}`);
      log(`Verify: forged shards ${listIdx(bad)} in set ${id}`);
    } else {
      set('ok', 'check', 'Recovery confirmed', `These shards rebuild the key for vault ${id}. Any ${k} of the ${n} will open it.${damagedNote}`);
      log(`Verified shard set for ${id}`);
    }
  } catch (e) {
    set('bad', 'alert', 'Recovery failed', (e as Error).message);
  }
}
verifyPaste.addEventListener('input', () => void runVerify());
dropzone($('verify-drop'), (files) => appendText(verifyPaste, files, () => void runVerify()));
$('verify-clear').addEventListener('click', () => { verifyPaste.value = ''; void runVerify(); });

// ================= SETTINGS =================
const themeSeg = seg('theme-seg', (v) => {
  try { if (v === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch { /* storage blocked */ }
  applyTheme(v as Theme);
});
themeSeg.set(storedTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themeSeg.get() as Theme));

const airToggle = $<HTMLInputElement>('airgap-toggle');

async function refreshAirgapStatus() {
  const st = $('airgap-status');
  airToggle.checked = airGap.active ? airGap.preferred : false;
  if (airGap.active && !airGap.preferred) {
    st.className = 'status on';
    st.textContent = 'Still blocked in this tab. Reload to reconnect.';
  } else if (airGap.active) {
    st.className = 'status on';
    st.textContent = 'Checking…';
    const ok = await airGap.verify();
    st.textContent = ok ? '● Network blocked by the browser. Verified: a test request was refused.' : '⚠ Lock set, but a test request got through. Your browser may not enforce runtime CSP.';
  } else {
    st.className = 'status';
    st.textContent = '○ Off. This tab can reach the network (only for cloud sync, if you use it).';
  }
}
airToggle.addEventListener('change', async () => {
  if (airToggle.checked) {
    if (!(await confirmDialog('Turn on air-gap?', 'This tab will be cut off from the network. That stays true even if you change your mind, until you turn this off and reload. Cloud sync stops. Passkeys still work, since they never use the network. It stays on for future visits.', 'Cut the network'))) {
      airToggle.checked = false;
      return;
    }
    airGap.preferred = true;
    airGap.lock();
    toast('Air-gap on. The network is blocked in this tab.');
  } else {
    airGap.preferred = false;
    toast('Air-gap will be off after you reload.');
  }
  updateNet();
  void refreshAirgapStatus();
  void refreshAccount();
  void refreshDest();
});

const PROVIDERS: Record<string, { label: string; icon: () => SVGSVGElement }> = {
  google: { label: 'Google', icon: () => brand('0 0 24 24', [
    ['#4285F4', 'M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z'],
    ['#34A853', 'M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z'],
    ['#FBBC05', 'M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z'],
    ['#EA4335', 'M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z'],
  ]) },
  apple: { label: 'Apple', icon: () => brand('0 0 24 24', [['currentColor', 'M16.37 12.6c-.02-2.3 1.88-3.4 1.97-3.46-1.07-1.57-2.74-1.78-3.33-1.8-1.42-.14-2.77.83-3.49.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.78 2.29-1.61 2.8-.41 6.94 1.16 9.21.77 1.11 1.68 2.36 2.88 2.31 1.16-.05 1.59-.75 2.99-.75 1.4 0 1.79.75 3.01.72 1.24-.02 2.03-1.13 2.79-2.25.88-1.29 1.24-2.53 1.26-2.6-.03-.01-2.42-.93-2.45-3.71zM14.08 5.84c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.11 1.77-.97 2.82 1.02.08 2.07-.52 2.71-1.28z']]) },
  github: { label: 'GitHub', icon: () => brand('0 0 16 16', [['currentColor', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z']]) },
  azure: { label: 'Microsoft', icon: () => brand('0 0 24 24', [['#F25022', 'M1 1h10v10H1z'], ['#7FBA00', 'M13 1h10v10H13z'], ['#00A4EF', 'M1 13h10v10H1z'], ['#FFB900', 'M13 13h10v10H13z']]) },
};
function brand(viewBox: string, paths: [string, string][]): SVGSVGElement {
  const s = svgEl('svg', { viewBox, 'aria-hidden': 'true' }) as SVGSVGElement;
  for (const [fill, d] of paths) s.append(svgEl('path', { fill, d }));
  return s;
}

const authDialog = $<HTMLDialogElement>('auth-dialog');
const authForm = $<HTMLFormElement>('auth-form');
const email = $<HTMLInputElement>('auth-email');
const codeForm = $<HTMLFormElement>('auth-code-form');
const codeInput = $<HTMLInputElement>('auth-code');
const RESEND_SECONDS = 60; // Supabase refuses a second email to the same address inside ~60 s
let resendTimer = 0;

function showCodeStep(to: string) {
  $('auth-sent-to').textContent = to;
  codeForm.hidden = !cloud.emailCode;
  $('auth-sent-how').textContent = cloud.emailCode ? 'Enter the 6-digit code, or open the link in the email on this device.' : 'Open the link in it on this device to finish signing in.';
  authForm.hidden = true;
  $('auth-sent').hidden = false;
  codeInput.value = '';
  if (cloud.emailCode) codeInput.focus();
  const btn = $<HTMLButtonElement>('auth-resend');
  let left = RESEND_SECONDS;
  clearInterval(resendTimer);
  const tick = () => { btn.disabled = left > 0; btn.textContent = left > 0 ? `Send a new email (${left}s)` : 'Send a new email'; if (left-- <= 0) clearInterval(resendTimer); };
  tick();
  resendTimer = window.setInterval(tick, 1000);
}

/** The one sign-in screen, reachable from the header, Settings, Legacy, plans and cloud saves. */
function openAuth() {
  if (!cloudConfigured) return toast("Accounts aren't set up for this build yet.", 'error');
  if (airGap.active) return toast('Air-gap is on. Turn it off in Settings and reload to sign in.', 'error');
  authForm.hidden = false;
  $('auth-sent').hidden = true;
  clearInterval(resendTimer);
  $('auth-providers').replaceChildren(...cloud.providers.map((p) => {
    const meta = PROVIDERS[p] ?? { label: p[0].toUpperCase() + p.slice(1), icon: () => icon('user') };
    return h('button', {
      class: 'provider', type: 'button',
      onclick: (e: Event) => {
        document.querySelectorAll<HTMLButtonElement>('.provider').forEach((b) => (b.disabled = true));
        (e.currentTarget as HTMLElement).lastChild!.textContent = 'Redirecting…';
        cloud.signInWith(p).catch((err) => { fail(err); openAuth(); }); // success navigates away
      },
    }, meta.icon(), h('span', {}, `Continue with ${meta.label}`));
  }));
  $('auth-or').hidden = !cloud.providers.length;
  if (!authDialog.open) authDialog.showModal();
}
$('auth-close').addEventListener('click', () => authDialog.close());
$('auth-back').addEventListener('click', () => { clearInterval(resendTimer); $('auth-sent').hidden = true; authForm.hidden = false; email.focus(); });
authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isEmail(email.value)) { toast('Enter a valid email address.', 'error'); return email.focus(); }
  void busy($<HTMLButtonElement>('auth-submit'), 'Sending…', async () => {
    await cloud.sendCode(email.value.trim());
    showCodeStep(email.value.trim());
  });
});
$('auth-resend').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Sending…', async () => {
  const to = $('auth-sent-to').textContent ?? '';
  await cloud.sendCode(to);
  showCodeStep(to);
  toast('New email sent.');
}));
codeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = cleanCode(codeInput.value);
  if (!code) { toast('Enter the 6-digit code from the email.', 'error'); return codeInput.focus(); }
  void busy($<HTMLButtonElement>('auth-verify'), 'Verifying…', async () => {
    await cloud.verifyCode($('auth-sent-to').textContent ?? '', code);
    // onChange(SIGNED_IN) closes the dialog and refreshes the account
    toast('Signed in.');
  });
});

async function refreshAccount() {
  const reason = !cloudConfigured ? (location.protocol === 'file:' ? 'Accounts need the website. This offline copy never connects to anything.' : "Accounts aren't set up for this build. Everything else works without one.")
    : airGap.active ? 'Unavailable while air-gap is on.' : '';
  $('account-off').hidden = !reason;
  $('account-off-text').textContent = reason;
  const btn = $('account-btn');
  btn.hidden = Boolean(reason);
  if (reason) { $('account-in').hidden = $('account-on').hidden = true; return; }
  const s = await cloud.session().catch(() => null);
  $('account-in').hidden = Boolean(s);
  $('account-on').hidden = !s;
  const who = s?.user.email ?? s?.user.id ?? '';
  if (s) {
    $('account-email').textContent = who;
    const prov = (s.user.app_metadata?.provider as string | undefined) ?? 'email';
    $('account-provider').textContent = PROVIDERS[prov]?.label ?? prov;
  }
  $('account-btn-label').textContent = s ? who.split('@')[0].slice(0, 18) : 'Sign in';
  btn.toggleAttribute('data-signed-in', Boolean(s));
}
$('account-btn').addEventListener('click', async () => ((await cloud.session().catch(() => null)) ? show('settings') : openAuth()));
$('account-signin').addEventListener('click', () => openAuth());
$('account-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement; // currentTarget is null after the first await
  if (!(await confirmDialog('Delete your account?', 'This permanently deletes your account, every vault stored in the Zero-Trust Cloud, and your Legacy plan. Vaults on your devices or in Google Drive are not touched. If you have a Pro subscription, cancel it first (link in Dodo\'s receipt email). This cannot be undone.', 'Delete account', true))) return;
  await busy(btn, 'Deleting…', async () => {
    await cloud.deleteAccount();
    toast('Your account has been deleted.');
    await refreshAccount(); void refreshDest(); void refreshPlan();
  });
});
$('auth-signout').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Signing out…', async () => {
  await cloud.signOut();
  toast('Signed out.');
  await refreshAccount();
}));

// ---- Google Drive ----
/** Must be called from a click handler: Google's consent opens in a popup. */
function connectDrive(after?: () => void) {
  drive.connect().then(() => { toast('Google Drive connected.'); refreshDrive(); void refreshDest(); after?.(); }).catch(fail);
}
function refreshDrive() {
  $('drive-card').hidden = !drive.configured;
  $('src-gdrive').hidden = !drive.configured;
  const st = $('drive-status');
  st.className = drive.connected ? 'status on-ok' : 'status';
  st.textContent = airGap.active ? '○ Blocked while air-gap is on.' : drive.connected ? '● Connected for this session.' : '○ Not connected.';
  $<HTMLButtonElement>('drive-connect').hidden = drive.connected;
  $<HTMLButtonElement>('drive-connect').disabled = airGap.active;
  $('drive-disconnect').hidden = !drive.connected;
}
$('drive-connect').addEventListener('click', () => connectDrive());
$('drive-disconnect').addEventListener('click', () => { drive.disconnect(); toast('Google Drive disconnected on this device.'); refreshDrive(); void refreshDest(); });
cloud.onChange((event) => {
  if (event === 'SIGNED_IN') {
    if (authDialog.open) authDialog.close();
    // Back from Google/Apple/email link: supabase-js has consumed ?code=; tidy the address bar.
    if (returningFromSignIn && /[?&]code=/.test(location.search)) { history.replaceState(null, '', location.pathname + location.hash); toast('Signed in.'); }
  }
  void refreshAccount(); void refreshDest(); void refreshPlan(); void silentCheckin();
});

function refreshPasskeyCard() {
  const st = $('passkey-status');
  const saved = passkey.saved;
  const reg = $<HTMLButtonElement>('passkey-register');
  reg.disabled = !passkey.supported;
  $('passkey-forget').hidden = !saved;
  st.className = saved ? 'status on-ok' : 'status';
  st.textContent = !passkey.supported ? '○ Not available here. Passkeys need the HTTPS site (not the offline file).'
    : saved ? `● Registered ${fmtDate(saved.created)} for ${saved.rp}. Available as a key slot when sealing.`
    : '○ No passkey registered on this browser.';
  reg.lastChild!.textContent = saved ? 'Register another' : 'Register passkey';
}
$('passkey-register').addEventListener('click', (e) => {
  const p = passkey.register(); // started inside the gesture (Safari)
  p.catch(() => {});
  void busy(e.currentTarget as HTMLButtonElement, 'Waiting for authenticator…', async () => {
    await p;
    toast('Passkey registered. Pick it as a key slot when sealing.');
    refreshPasskeyCard();
    refreshPasskeyMethod();
  });
});
$('passkey-forget').addEventListener('click', async () => {
  if (!(await confirmDialog('Forget this passkey here?', 'This browser will stop offering it for new vaults. Existing vaults still list its id and keep working with it. To delete the passkey itself, use your OS or password manager.', 'Forget'))) return;
  passkey.saved = null;
  refreshPasskeyCard();
  refreshPasskeyMethod();
});

function trustedTypesEnforced(): boolean {
  const csp = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
  return 'trustedTypes' in window && csp.includes('require-trusted-types-for');
}
function renderEngine() {
  const BD = 'BarcodeDetector' in window;
  const rows: [string, string, boolean][] = [
    ['Crypto isolation', worker ? 'Dedicated Web Worker' : 'Main thread (fallback)', Boolean(worker)],
    ['Secure context', isSecureContext ? 'Yes' : 'No', isSecureContext],
    ['Trusted Types', trustedTypesEnforced() ? 'Enforced' : 'Not enforced by this browser', trustedTypesEnforced()],
    ['Network', airGap.active ? 'Blocked (air-gap CSP)' : cloudConfigured ? 'Cloud backend only' : "connect-src 'none'", true],
    ['Passkey PRF', passkey.supported ? 'Available' : 'Unavailable here', passkey.supported],
    ['QR decoding', BD ? 'Native BarcodeDetector' : 'jsQR (bundled)', true],
    ['Format', 'v3 · AES-256-GCM · key-committed · HKDF-SHA256 · Argon2id · Shamir GF(2⁸) + share commitments', true],
    ['Build', `v${__APP_VERSION__}`, true],
  ];
  $('engine-info').replaceChildren(...rows.flatMap(([k, v, ok]) => [h('dt', {}, k), h('dd', { class: ok ? 'ok' : 'no' }, v)]));
}

async function refreshStorage() {
  const files = await local.list().catch(() => []);
  const persisted = await local.persisted().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  $('storage-status').textContent = `${plural(files.length, 'record')} on this device`
    + (est?.usage ? ` · ${fmtBytes(est.usage)} used` : '')
    + (persisted ? ' · protected from automatic cleanup.' : ' · the browser may clear this storage under pressure, so export important vaults.');
}
$('wipe-local').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete all local records?', 'Every vault saved on this device will be erased. Cloud records and exported .vault files are not affected.', 'Delete everything', true))) return;
  try { await local.clear(); toast('Local records deleted.'); void refreshStorage(); } catch (e) { fail(e); }
});

async function refreshSettings() {
  refreshPasskeyCard();
  refreshDrive();
  renderEngine();
  await Promise.all([refreshAirgapStatus(), refreshAccount(), refreshStorage(), refreshPlan()]);
}

// ================= PLAN =================
let plan: Plan = { pro: false, status: 'free', periodEnd: null };

async function refreshPlan(): Promise<Plan> {
  if (cloudConfigured && !airGap.active) plan = await billing.plan().catch(() => plan);
  $('pro-badge').hidden = !plan.pro;
  await renderPlanCard();
  return plan;
}

function checkoutButton(label: string, plan: 'yearly' | 'lifetime', cls: string) {
  return button(label, 'star', async () => { try { location.href = await billing.checkoutUrl(plan); } catch (e) { fail(e); } }, cls);
}

async function renderPlanCard() {
  const card = $('plan-card');
  card.hidden = !cloudConfigured || airGap.active;
  if (card.hidden) return;
  const session = await cloud.session().catch(() => null);
  const lifetime = plan.status === 'lifetime';
  const tag = $('plan-tag');
  tag.textContent = plan.pro ? (lifetime ? 'Pro · Lifetime' : 'Pro') : 'Free';
  tag.className = `tag${plan.pro ? ' accent' : ''}`;
  $('plan-desc').textContent = !billing.configured ? 'Payments are not configured in this build.'
    : !session ? 'Sign in to upgrade, so the purchase is attached to your account.'
    : plan.pro ? (lifetime ? 'Lifetime Pro. Thank you for supporting the project.'
      : plan.periodEnd ? `Pro is active until ${fmtDate(plan.periodEnd)} and renews automatically unless cancelled.` : 'Pro is active.')
    : 'Free plan: every security feature, unlimited vaults on your devices, and 2 in the cloud.';
  const actions: HTMLElement[] = [];
  if (billing.configured && !session) actions.push(button('Sign in', 'user', () => openAuth(), 'btn primary'));
  else if (billing.configured && !plan.pro) {
    actions.push(checkoutButton('Upgrade to Pro', 'yearly', 'btn primary'), checkoutButton('Get Lifetime', 'lifetime', 'btn ghost'));
  } else if (plan.pro && !lifetime && billing.portal) {
    actions.push(h('a', { class: 'btn ghost', href: billing.portal, target: '_blank', rel: 'noopener noreferrer' }, icon('star'), 'Manage billing'));
  }
  $('plan-actions').replaceChildren(...actions);
}

/** Back from checkout: the webhook may land a few seconds after the redirect. */
async function awaitUpgrade() {
  toast('Payment received. Activating Pro…');
  for (let i = 0; i < 15; i++) {
    if ((await refreshPlan()).pro) return toast('Pro is active. Thank you!');
    await new Promise((r) => setTimeout(r, 2000));
  }
  toast("Pro hasn't activated yet. It can take a minute; reload this page shortly.", 'error');
}

// ================= LEGACY =================
const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_TRUSTEES = 10;
const trusteeList = $('trustee-list');
const lgInterval = $<HTMLSelectElement>('legacy-interval');
const lgGrace = $<HTMLSelectElement>('legacy-grace');
const lgMessage = $<HTMLTextAreaElement>('legacy-message');
const lgEscrow = $<HTMLTextAreaElement>('legacy-escrow');
const lgEnabled = $<HTMLInputElement>('legacy-enabled');
const ESCROW_HINT = $('legacy-escrow-hint').textContent ?? '';
let legacyPlan: LegacyPlan | null = null;
const isoAt = (ms: number) => new Date(ms).toISOString();

function trusteeRow(t: { name: string; email: string } = { name: '', email: '' }) {
  const row = h('div', { class: 'trustee-row' },
    h('input', { type: 'text', placeholder: 'Name', value: t.name, maxlength: '80', autocomplete: 'off', 'aria-label': 'Trustee name' }),
    h('input', { type: 'email', placeholder: 'email@example.com', value: t.email, maxlength: '254', autocomplete: 'off', 'aria-label': 'Trustee email' }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove trustee', onclick: () => { if (trusteeList.children.length > 1) row.remove(); syncTrusteeAdd(); } }, icon('x')));
  return row;
}
function syncTrusteeAdd() { $<HTMLButtonElement>('trustee-add').disabled = trusteeList.children.length >= MAX_TRUSTEES; }
$('trustee-add').addEventListener('click', () => {
  trusteeList.append(trusteeRow());
  syncTrusteeAdd();
  trusteeList.lastElementChild?.querySelector('input')?.focus();
});

function syncTimeline() {
  $('tl-due').textContent = `After ${lgInterval.selectedOptions[0].text} without a check-in, you get weekly reminders.`;
  $('tl-grace').textContent = `${lgGrace.selectedOptions[0].text} more to respond, then release.`;
}
lgInterval.addEventListener('change', syncTimeline);
lgGrace.addEventListener('change', syncTimeline);
lgMessage.addEventListener('input', () => { $('legacy-count').textContent = String(lgMessage.value.length); });

const selectedVaults = () => [...document.querySelectorAll<HTMLInputElement>('#legacy-vaults input:checked')].map((i) => i.value);

async function checkEscrow(): Promise<boolean> {
  const hint = $('legacy-escrow-hint');
  const v = lgEscrow.value.trim();
  hint.className = 'hint';
  if (!v) { hint.textContent = ESCROW_HINT; return true; }
  const toks = shardTokens(v);
  if (toks.length !== 1) { hint.textContent = 'Paste exactly one shard.'; hint.className = 'hint bad-text'; return false; }
  try {
    const s = await parseShard(toks[0]);
    const shared = selectedVaults().includes(s.id);
    hint.textContent = `Shard #${s.i} of a ${s.k}-of-${s.n} set for vault ${s.id}. Trustees will need ${s.k - 1} more.`
      + (s.k === 2 ? ' This set needs only 2 shards, so the service plus any one trustee could open it. Use a 3-of-N set for escrow.' : '')
      + (shared ? '' : " That vault isn't in the shared list above.");
    hint.className = s.k === 2 || !shared ? 'hint warn-text' : 'hint ok-text';
    return true;
  } catch (e) {
    hint.textContent = (e as Error).message;
    hint.className = 'hint bad-text';
    return false;
  }
}
lgEscrow.addEventListener('input', () => void checkEscrow());
$('legacy-vaults').addEventListener('change', () => void checkEscrow());

function legacyGate(title: string, sub: string, action?: [string, () => void]) {
  $('legacy-main').hidden = true;
  $('legacy-gate').hidden = false;
  $('legacy-gate-title').textContent = title;
  $('legacy-gate-sub').textContent = sub;
  const b = $('legacy-gate-action');
  b.hidden = !action;
  if (action) { b.textContent = action[0]; b.onclick = action[1]; }
}

function renderLegacyStatus() {
  const p = legacyPlan;
  const kv: [string, string][] = [];
  let state = 'none', title = 'Not set up', sub = 'Fill in the plan and save it to arm it.';
  if (p) {
    const due = Date.parse(p.last_checkin) + p.interval_days * DAY;
    const release = due + p.grace_days * DAY;
    if (p.released_at) { state = 'released'; title = 'Released'; sub = `Trustees were contacted on ${fmtDate(p.released_at)}.`; }
    else if (!p.enabled) { state = 'paused'; title = 'Paused'; sub = 'No reminders and no release while paused.'; }
    else if (Date.now() >= due) { state = 'reminding'; title = 'Waiting for your check-in'; sub = `Release on ${fmtDate(isoAt(release))} unless you check in.`; }
    else { state = 'armed'; title = 'Armed'; sub = `Next check-in due in ${plural(Math.ceil((due - Date.now()) / DAY), 'day')}.`; }
    kv.push(['Last check-in', fmtDate(p.last_checkin)], ['Check-in due', fmtDate(isoAt(due))], ['Release if silent', fmtDate(isoAt(release))],
      ['Trustees', String(p.trustees.length)], ['Vaults shared', String(p.vault_ids.length)], ['Escrow shard', p.escrow_shard ? 'Yes' : 'No']);
  }
  $('legacy-state').dataset.state = state;
  $('legacy-state-title').textContent = title;
  $('legacy-state-sub').textContent = sub;
  $('legacy-kv').replaceChildren(...kv.flatMap(([a, b]) => [h('dt', {}, a), h('dd', {}, b)]));
}

let legacyGen = 0;
async function renderLegacy() {
  const gen = ++legacyGen;
  if (!cloudConfigured) return legacyGate('Legacy needs the hosted service', 'This build has no cloud backend. Everything else works offline.');
  if (airGap.active) return legacyGate('Air-gap is on', 'Legacy needs the network. Turn air-gap off in Settings and reload.', ['Open settings', () => show('settings')]);
  if (!(await cloud.session().catch(() => null))) {
    return legacyGate('Sign in to set up Legacy', 'Your plan is tied to your account, so we know when you check in.', ['Sign in', () => openAuth()]);
  }
  try { legacyPlan = await legacy.get(); } catch (e) { return fail(e); }
  await refreshPlan();
  if (gen !== legacyGen) return;
  if (!legacyPlan && !plan.pro) {
    return legacyGate('Legacy is part of Pro', 'Choose trustees and a check-in interval. If you ever go silent, they get your instructions and your encrypted vaults. Every security feature stays free.',
      billing.configured ? ['See Pro', () => { show('settings'); $('plan-card').scrollIntoView({ behavior: 'smooth' }); }] : undefined);
  }
  $('legacy-gate').hidden = true;
  $('legacy-main').hidden = false;
  const p = legacyPlan;
  const readonly = Boolean(p && (!plan.pro || p.released_at));
  $('legacy-readonly').hidden = !(p && !plan.pro && !p.released_at);
  trusteeList.replaceChildren(...(p?.trustees.length ? p.trustees : [{ name: '', email: '' }]).map(trusteeRow));
  syncTrusteeAdd();
  lgInterval.value = String(p?.interval_days ?? 90);
  lgGrace.value = String(p?.grace_days ?? 14);
  lgMessage.value = p?.message ?? '';
  $('legacy-count').textContent = String(lgMessage.value.length);
  lgEscrow.value = p?.escrow_shard ?? '';
  lgEnabled.checked = p?.enabled ?? true;
  const cloudItems = await cloud.list().catch(() => []);
  const ids = [...new Set([...cloudItems.map((c) => c.id), ...(p?.vault_ids ?? [])])];
  $('legacy-vaults').replaceChildren(...(ids.length ? ids.map((id) => {
    const c = cloudItems.find((x) => x.id === id);
    return h('label', {}, h('input', { type: 'checkbox', value: id, checked: Boolean(p?.vault_ids.includes(id)) }), id, h('span', { class: 'hint' }, c ? fmtDate(c.created) : 'no longer in the cloud'));
  }) : [h('p', { class: 'hint' }, 'No cloud vaults yet. Seal one with "Cloud" as its destination to share it here.')]));
  $('legacy-main').querySelectorAll<HTMLInputElement>('.steps input, .steps textarea, .steps select, .steps button, #legacy-enabled, #legacy-save')
    .forEach((el) => { el.disabled = readonly; });
  $('legacy-delete').hidden = !p;
  $('legacy-checkin').hidden = !p || Boolean(p.released_at);
  $('legacy-save').lastElementChild!.textContent = p ? 'Save changes' : 'Arm Legacy';
  renderLegacyStatus();
  syncTimeline();
  void checkEscrow();
}

$('legacy-save').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Saving…', async () => {
  const trustees = [...trusteeList.children].map((r) => {
    const [n, m] = r.querySelectorAll('input');
    return { name: n.value.trim(), email: m.value.trim().toLowerCase() };
  }).filter((t) => t.name || t.email);
  if (!trustees.length) throw new VaultError('Add at least one trustee.');
  const badT = trustees.find((t) => !t.name || !EMAIL_RE.test(t.email));
  if (badT) throw new VaultError(`Check trustee “${badT.name || badT.email}”: a name and a valid email are required.`);
  if (!(await checkEscrow())) throw new VaultError('The escrow shard is not valid.');
  const input: LegacyInput = {
    enabled: lgEnabled.checked, interval_days: +lgInterval.value, grace_days: +lgGrace.value, trustees,
    message: lgMessage.value, vault_ids: selectedVaults(), escrow_shard: shardTokens(lgEscrow.value)[0] ?? null,
  };
  const existed = Boolean(legacyPlan);
  await legacy.save(input, existed);
  await legacy.checkin().catch(() => null); // saving proves you're here
  toast(existed ? 'Legacy plan updated.' : 'Legacy is armed.');
  await renderLegacy();
}));
$('legacy-checkin').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Checking in…', async () => {
  await legacy.checkin();
  toast("Checked in. You're all set.");
  await renderLegacy();
}));
$('legacy-delete').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete your Legacy plan?', 'Your trustees will not be contacted, and the escrow shard (if any) is deleted from our servers. Your vaults are not affected.', 'Delete plan', true))) return;
  try { await legacy.remove(); legacyPlan = null; toast('Legacy plan deleted.'); await renderLegacy(); } catch (e) { fail(e); }
});

/** Opening the app while signed in counts as a check-in, so active owners never trigger a release. */
async function silentCheckin() {
  if (!cloudConfigured || airGap.active || !(await cloud.session().catch(() => null))) return;
  try { if (await legacy.checkin()) log('Legacy check-in recorded'); } catch { /* backend not migrated yet */ }
}

if (location.protocol === 'file:') {
  $('offline-dl').hidden = true;
  $('offline-note').textContent = "You're running the offline copy. Nothing here needs a network.";
}

// ================= Boot =================
$('app-version').textContent = __APP_VERSION__;
document.querySelectorAll<HTMLElement>('i[data-icon]').forEach((i) => setIcon(i, i.dataset.icon!));
syncSliders();
meter();
updateNet();
refreshPasskeyMethod();
setTarget(null);
const paidReturn = /[?&]upgraded=1/.test(location.search);
if (paidReturn) history.replaceState(null, '', location.pathname);
const initial = paidReturn ? 'upgraded' : location.hash.slice(1);
if (initial === 'checkin=ok') { show('legacy'); toast("You're checked in. Thanks!"); }
else if (initial === 'checkin=expired') { show('legacy'); toast('That check-in link has expired. Press "I\'m still here" below instead.', 'error'); }
else if (initial === 'upgraded') { show('settings'); void awaitUpgrade(); }
else if (initial === 'signin') { show('seal'); openAuth(); }
else show(TABS.includes(initial as Tab) ? (initial as Tab) : 'seal');
void refreshPlan();
void silentCheckin();
void refreshAccount();
refreshDrive();
if (oauthPopup) toast('Google Drive connected. You can close this window.');
const authError = new URLSearchParams(location.search || location.hash.slice(1)).get('error_description');
if (authError) { toast(`Sign-in failed: ${authError}`, 'error'); history.replaceState(null, '', location.pathname); }
log(`Zero-Trust Vault ${__APP_VERSION__} ready · ${worker ? 'isolated crypto worker' : 'main-thread crypto'}${airGap.active ? ' · air-gapped' : ''}`);

// Offline support when served over HTTPS (URL vetted by the Trusted Types default policy).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !airGap.active) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is best-effort */ });
}
