import qrcode from 'qrcode-generator';
import {
  MAX_BYTES, open, parseShard, parseVaultFile, rand, seal, shardTokens, verifyShards, VaultError,
  type Plain, type Policy, type Shard, type VaultFile,
} from './crypto';
import { airGap, cloud, cloudConfigured, local } from './storage';

declare const __APP_VERSION__: string;

// Air-gap must engage before anything can reach the network.
if (airGap.preferred) airGap.lock();

// ================= DOM helpers =================
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';
const enc = new TextEncoder();

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
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
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

function log(msg: string) {
  const list = $('log');
  list.prepend(h('li', {}, h('time', {}, new Date().toTimeString().slice(0, 8)), msg));
  while (list.children.length > 200) list.lastChild!.remove();
}

function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'ok' ? 'check' : 'alert'), h('span', {}, msg));
  $('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove()); }, kind === 'error' ? 6500 : 3500);
  log(kind === 'error' ? `ERROR ${msg}` : msg);
}
const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error');
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  const kids = [...btn.childNodes];
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.replaceChildren(icon('spinner'), h('span', {}, label));
  await nextFrame(); // paint before Argon2 blocks the thread
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

async function copy(text: string, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Clipboard is blocked — select and copy manually.', 'error'); }
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

function tagsFor(f: VaultFile): HTMLElement[] {
  const t: HTMLElement[] = [];
  if (f.h.shamir) t.push(h('span', { class: 'tag accent' }, icon('shard'), `${f.h.shamir.k} of ${f.h.shamir.n} shards`));
  if (f.h.pass) t.push(h('span', { class: 'tag accent' }, icon('key'), 'Passphrase'));
  t.push(h('span', { class: 'tag' }, `${fmtBytes(Math.floor((f.ct.length * 3) / 4))}`));
  return t;
}

// ================= Tabs =================
const TABS = ['seal', 'open', 'vault', 'verify', 'settings'] as const;
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
  if (tab === 'seal') void refreshDest();
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
let staged: { name: string; type: string; data: Uint8Array } | null = null;

const kind = seg('payload-kind', (v) => {
  $('payload-text').hidden = v !== 'text';
  $('payload-file').hidden = v !== 'file';
  summary();
});
const policy = seg('policy', (v) => {
  $('shard-config').hidden = v === 'pass';
  $('pass-config').hidden = v === 'shards';
  summary();
});

secretText.addEventListener('input', () => {
  $('text-count').textContent = `${secretText.value.length.toLocaleString()} characters`;
  summary();
});

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
  staged = { name: f.name, type: f.type || 'application/octet-stream', data: new Uint8Array(await f.arrayBuffer()) };
  $('file-name').textContent = f.name;
  $('file-meta').textContent = `${fmtBytes(f.size)} · ${staged.type}`;
  $('file-chip').hidden = false;
  $('file-drop').hidden = true;
  log(`Staged ${f.name} in memory`);
  summary();
});
$('file-clear').addEventListener('click', clearStaged);

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
  $('policy-hint').textContent = `Any ${k} of ${n} shards open this vault. `
    + (spare ? `Up to ${spare} can be lost safely. ` : 'Every shard is required. Losing one locks the vault forever. ')
    + `${k - 1 === 1 ? 'A single shard reveals' : `Any ${k - 1} together reveal`} nothing.`;
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

const destValue = () => document.querySelector<HTMLInputElement>('input[name=dest]:checked')!.value as 'local' | 'cloud' | 'download';
document.querySelectorAll('input[name=dest]').forEach((r) => r.addEventListener('change', summary));

async function refreshDest() {
  const radio = document.querySelector<HTMLInputElement>('input[name=dest][value=cloud]')!;
  const sub = $('dest-cloud-sub');
  if (!cloudConfigured) { radio.disabled = true; sub.textContent = 'Not configured in this build'; }
  else if (airGap.active) { radio.disabled = true; sub.textContent = 'Unavailable in air-gap mode'; }
  else {
    radio.disabled = false;
    const s = await cloud.session().catch(() => null);
    sub.textContent = s ? `Signed in as ${s.user.email}` : 'Sign in under Settings first';
  }
  if (radio.disabled && radio.checked) document.querySelector<HTMLInputElement>('input[name=dest][value=local]')!.checked = true;
  summary();
}

function summary() {
  const p = policy.get();
  const k = kEl.value, n = nEl.value;
  const what = kind.get() === 'text'
    ? (secretText.value ? `Text · ${secretText.value.length.toLocaleString()} chars` : 'Nothing yet')
    : (staged ? `${staged.name} · ${fmtBytes(staged.data.length)}` : 'No file chosen');
  const who = p === 'shards' ? `Any ${k} of ${n} shards` : p === 'pass' ? 'Passphrase' : `${k} of ${n} shards, or passphrase`;
  const where = { local: 'This device', cloud: 'Cloud', download: 'Download only' }[destValue()];
  const rows: [string, string][] = [['Payload', what], ['Unlock', who], ['Store', where], ['Cipher', 'AES-256-GCM']];
  if (p !== 'shards') rows.push(['KDF', 'Argon2id · 64 MiB']);
  $('summary').replaceChildren(...rows.flatMap(([a, b]) => [h('dt', {}, a), h('dd', {}, b)]));
}

function resetSeal() {
  secretText.value = '';
  labelEl.value = '';
  passEl.value = pass2El.value = '';
  setPassVisible(false);
  clearStaged();
  meter();
  $('text-count').textContent = '0 characters';
}

$('seal-btn').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Sealing…', async () => {
  let plain: Plain;
  if (kind.get() === 'text') {
    if (!secretText.value) throw new VaultError('Write something to seal first.');
    plain = { meta: { kind: 'text', name: 'secret.txt', type: 'text/plain', size: 0 }, data: enc.encode(secretText.value) };
  } else {
    if (!staged) throw new VaultError('Choose a file to seal.');
    plain = { meta: { kind: 'file', name: staged.name, type: staged.type, size: 0 }, data: staged.data };
  }
  const p = policy.get();
  const pol: Policy = { label: labelEl.value };
  if (p !== 'pass') pol.shards = { k: +kEl.value, n: +nEl.value };
  if (p !== 'shards') {
    if (passEl.value.length < 8) throw new VaultError('Passphrase must be at least 8 characters.');
    if (passEl.value !== pass2El.value) throw new VaultError("Passphrases don't match.");
    pol.passphrase = passEl.value;
  }
  const dest = destValue();
  if (dest === 'cloud' && !(await cloud.session())) throw new VaultError('Sign in under Settings to save to the cloud.');

  const { file, shards } = await seal(plain, pol);
  let saveError: string | undefined;
  try {
    if (dest === 'local') await local.put(file);
    else if (dest === 'cloud') await cloud.put(file);
    else downloadVault(file);
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err); // shards are still shown; user can download the .vault
  }
  log(`Sealed ${file.h.id} → ${dest}${saveError ? ' (save failed)' : ''}`);
  resetSeal();
  showSealed(file, shards, dest, saveError);
}));

// ---- Sealed dialog ----
let sealed: { file: VaultFile; shards: string[]; saved: boolean } | null = null;
const sealedDialog = $<HTMLDialogElement>('sealed-dialog');

function shardFile(f: VaultFile, i: number) { return `vault-${f.h.id}-shard-${i + 1}-of-${f.h.shamir!.n}.key`; }

function showSealed(file: VaultFile, shards: string[], dest: string, saveError?: string) {
  sealed = { file, shards, saved: false };
  const where = { local: 'Saved on this device', cloud: 'Uploaded to your cloud vault', download: 'Downloaded as a .vault file' }[dest];
  $('sealed-title').textContent = saveError ? 'Sealed, but not saved' : 'Vault sealed';
  $('sealed-sub').textContent = saveError
    ? `Saving failed: ${saveError}. Download the .vault file now or the data is lost.`
    : `${where} · id ${file.h.id}${file.h.label ? ` · ${file.h.label}` : ''}`;
  const warn = $('sealed-warn').querySelector('div')!;
  warn.replaceChildren(...(shards.length
    ? [h('strong', {}, 'Save your shards now. '), `They are shown once. Nobody, including us, can recover them. Give each to a different person or place. Any ${file.h.shamir!.k} open the vault.`]
    : [h('strong', {}, 'Your passphrase is the only key. '), 'It cannot be reset. Store it somewhere safe and separate from the vault file.']));
  $('shard-grid').replaceChildren(...shards.map((s, i) => {
    const card = h('article', { class: 'shard-card' },
      h('header', {}, h('strong', {}, `SHARD ${i + 1}/${shards.length}`), h('span', {}, `${file.h.id.slice(0, 8)}…`)),
      qr(s),
      h('div', { class: 'shard-text', title: s }, s),
      h('div', { class: 'row' },
        button('Copy', 'copy', () => { sealed!.saved = true; void copy(s, `Shard ${i + 1} copied`); }),
        button('.key', 'download', () => { sealed!.saved = true; download(shardFile(file, i), `${s}\n`, 'text/plain'); })));
    card.style.animationDelay = `${i * 60}ms`;
    return card;
  }));
  $('dl-shards').hidden = $('print-kit').hidden = !shards.length;
  if (!shards.length) sealed.saved = true;
  sealedDialog.showModal();
}

$('dl-vault').addEventListener('click', () => sealed && downloadVault(sealed.file));
$('dl-shards').addEventListener('click', async () => {
  if (!sealed) return;
  sealed.saved = true;
  for (const [i, s] of sealed.shards.entries()) {
    download(shardFile(sealed.file, i), `${s}\n`, 'text/plain');
    await new Promise((r) => setTimeout(r, 200)); // browsers drop rapid-fire downloads
  }
});
$('print-kit').addEventListener('click', () => { if (sealed) { sealed.saved = true; printKit(sealed.file, sealed.shards); } });

async function closeSealed() {
  if (sealed && !sealed.saved && !(await confirmDialog('Close without saving shards?', "You haven't copied, downloaded or printed any shard. Once closed they're gone, and so is access to this vault.", 'Discard shards', true))) return;
  sealed = null;
  $('shard-grid').replaceChildren();
  sealedDialog.close();
  void renderVault();
}
$('sealed-done').addEventListener('click', closeSealed);
sealedDialog.addEventListener('cancel', (e) => { e.preventDefault(); void closeSealed(); });
window.addEventListener('beforeunload', (e) => { if (sealed && !sealed.saved) e.preventDefault(); });

function printKit(file: VaultFile, shards: string[]) {
  const { id, label, created, shamir, pass } = file.h;
  const pages = shards.map((s, i) => h('section', { class: 'kit-page' },
    h('h1', {}, `Recovery shard ${i + 1} of ${shamir!.n}`),
    h('p', { class: 'kit-sub' }, `${label || 'Zero-Trust Vault'}: any ${shamir!.k} of ${shamir!.n} shards open this vault.`),
    qr(s),
    h('div', { class: 'kit-shard' }, s),
    h('dl', { class: 'kit-meta' },
      h('dt', {}, 'Vault id'), h('dd', {}, id),
      h('dt', {}, 'Created'), h('dd', {}, fmtDate(created)),
      h('dt', {}, 'Needed'), h('dd', {}, `${shamir!.k} different shards`),
      h('dt', {}, 'Passphrase'), h('dd', {}, pass ? 'Also opens with the passphrase' : 'None')),
    h('strong', {}, 'How to recover'),
    h('ol', {},
      h('li', {}, 'Get the vault file (.vault), or access to the device or account where it was saved.'),
      h('li', {}, `Collect ${shamir!.k} different shards from their holders. Scan each QR code with any phone camera to get its text, or type it in.`),
      h('li', {}, 'Open Zero-Trust Vault (the website or the offline HTML file) and go to Open.'),
      h('li', {}, 'Load the vault, paste the shards, and press Open vault. Typos are detected automatically.')),
    h('p', {}, `Keep this page private. On its own it reveals nothing, but together with ${shamir!.k - 1} other shard${shamir!.k > 2 ? 's' : ''} it unlocks the vault.`)));
  $('print-root').replaceChildren(...pages);
  window.addEventListener('afterprint', () => $('print-root').replaceChildren(), { once: true });
  window.print();
}

// ================= OPEN =================
let target: VaultFile | null = null;
let validShards: Shard[] = [];
let opened: Plain | null = null;
const shardPaste = $<HTMLTextAreaElement>('shard-paste');
const openPass = $<HTMLInputElement>('open-pass');
const pick = $<HTMLSelectElement>('vault-pick');

function setTarget(f: VaultFile | null, source = '') {
  target = f;
  const info = $('vault-info');
  info.hidden = !f;
  if (f) {
    info.replaceChildren(
      h('div', { class: 'title' }, h('strong', {}, f.h.label || 'Untitled vault'), h('span', { class: 'hint mono' }, f.h.id)),
      h('div', { class: 'tags' }, ...tagsFor(f)),
      h('span', { class: 'hint' }, `Created ${fmtDate(f.h.created)}${source ? ` · ${source}` : ''}`));
    log(`Loaded vault ${f.h.id}${source ? ` from ${source}` : ''}`);
  }
  const shards = !f || Boolean(f.h.shamir);
  const pass = !f || Boolean(f.h.pass);
  $('unlock-shards').hidden = !shards;
  $('unlock-pass').hidden = !pass;
  $('unlock-or').hidden = !(shards && pass);
  $('keys-sub').textContent = !f ? 'Shards, a passphrase, or whichever this vault accepts.'
    : shards && pass ? `${f.h.shamir!.k} shards or the passphrase.` : shards ? `${f.h.shamir!.k} of ${f.h.shamir!.n} shards.` : 'The passphrase.';
  void renderOpenShards();
}

dropzone($('vault-drop'), async ([f]) => {
  if (!f) return;
  try { pick.value = ''; setTarget(parseVaultFile(await f.text()), f.name); } catch (e) { fail(e); }
});

async function refreshPick() {
  const keep = pick.value;
  const opts: HTMLOptionElement[] = [h('option', { value: '' }, 'Choose a record…')];
  const localFiles = await local.list().catch(() => []);
  if (localFiles.length) {
    const g = h('optgroup', { label: 'This device' });
    for (const f of localFiles.sort((a, b) => b.h.created.localeCompare(a.h.created))) g.append(h('option', { value: `local:${f.h.id}` }, `${f.h.label || 'Untitled'} · ${f.h.id.slice(0, 8)}`));
    opts.push(g as unknown as HTMLOptionElement);
  }
  if (await cloud.session().catch(() => null)) {
    const items = await cloud.list().catch(() => []);
    if (items.length) {
      const g = h('optgroup', { label: 'Cloud' });
      for (const it of items) g.append(h('option', { value: `cloud:${it.id}` }, `${it.id} · ${fmtDate(it.created)}`));
      opts.push(g as unknown as HTMLOptionElement);
    }
  }
  pick.replaceChildren(...opts);
  pick.value = keep;
}
pick.addEventListener('change', async () => {
  const [where, id] = pick.value.split(':');
  if (!id) return setTarget(null);
  try {
    const f = where === 'local' ? await local.get(id) : await cloud.get(id);
    if (!f) throw new VaultError('Record not found.');
    setTarget(f, where === 'local' ? 'this device' : 'cloud');
  } catch (e) { fail(e); }
});

function appendText(area: HTMLTextAreaElement, files: File[], after: () => void) {
  void Promise.all(files.map((f) => f.text())).then((texts) => {
    area.value = [area.value.trim(), ...texts.map((t) => t.trim())].filter(Boolean).join('\n');
    after();
  });
}

/** Parse shard tokens from text; returns per-token status. Shared by Open and Verify. */
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
  const forId = target?.h.id ?? parsed.find((p) => p.shard)?.shard!.id;
  const chips: HTMLElement[] = [];
  const good = new Map<number, Shard>();
  for (const p of parsed) {
    if (!p.shard) { chips.push(h('li', { class: 'chip bad', title: p.error }, icon('alert'), 'damaged shard')); continue; }
    if (p.shard.id !== forId) { chips.push(h('li', { class: 'chip dim', title: `Belongs to vault ${p.shard.id}` }, `#${p.shard.i} · other vault`)); continue; }
    good.set(p.shard.i, p.shard);
    chips.push(h('li', { class: 'chip' }, icon('check'), `#${p.shard.i}/${p.shard.n}`));
  }
  validShards = [...good.values()];
  $('shard-chips').replaceChildren(...chips);

  const k = target?.h.shamir?.k ?? validShards[0]?.k ?? 0;
  const have = validShards.length;
  const ring = $('ring');
  ring.style.setProperty('--q', String(k ? Math.min(100, (have / k) * 100) : 0));
  ring.classList.toggle('done', k > 0 && have >= k);
  $('ring-text').textContent = k ? `${have}/${k}` : String(have);
  $('quorum-title').textContent = !have ? 'No shards yet' : have >= k ? 'Quorum reached' : `${k - have} more shard${k - have > 1 ? 's' : ''} needed`;
  $('quorum-sub').textContent = !have ? 'Drop .key files or paste shards below.' : `Vault ${forId}`;

  // Shards first, no vault yet: find the matching record on this device automatically.
  if (!target && forId && validShards.length) {
    const f = await local.get(forId).catch(() => undefined);
    if (f && !target && gen === openGen) { pick.value = `local:${forId}`; setTarget(f, 'this device, matched by shard'); return; }
    if (!f) $('quorum-sub').textContent = `For vault ${forId}. Load its .vault file to open it.`;
  }
  updateOpenBtn();
}
shardPaste.addEventListener('input', () => void renderOpenShards());
dropzone($('shard-drop'), (files) => appendText(shardPaste, files, () => void renderOpenShards()));
openPass.addEventListener('input', updateOpenBtn);

function canUseShards() { return Boolean(target?.h.shamir && validShards.length >= target.h.shamir.k); }
function updateOpenBtn() {
  $<HTMLButtonElement>('open-btn').disabled = !target || !(canUseShards() || (target.h.pass && openPass.value));
}

$('open-btn').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Opening…', async () => {
  if (!target) return;
  clearResult();
  opened = await open(target, canUseShards() ? { shards: validShards } : { passphrase: openPass.value });
  openPass.value = '';
  showResult(opened, target);
}).then(updateOpenBtn));

function showResult(p: Plain, f: VaultFile) {
  $('open-result').hidden = false;
  $('result-sub').textContent = `${f.h.label || 'Untitled vault'} · ${f.h.id} · sealed ${fmtDate(f.h.created)}`;
  const isText = p.meta.kind === 'text';
  $('result-text').hidden = !isText;
  $('result-file').hidden = isText;
  if (isText) {
    $('result-title').textContent = 'Vault opened';
    const pre = $('result-pre');
    pre.textContent = new TextDecoder().decode(p.data);
    pre.classList.add('blurred');
  } else {
    $('result-title').textContent = 'File recovered';
    $('result-file-name').textContent = p.meta.name;
    $('result-file-meta').textContent = `${fmtBytes(p.meta.size)} · ${p.meta.type}`;
  }
  toast('Vault opened.');
  $('open-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearResult() {
  opened?.data.fill(0);
  opened = null;
  $('result-pre').textContent = '';
  $('open-result').hidden = true;
}
$('result-reveal').addEventListener('click', () => $('result-pre').classList.toggle('blurred'));
$('result-copy').addEventListener('click', () => opened && void copy(new TextDecoder().decode(opened.data), 'Secret copied. Clear your clipboard when done.'));
$('result-download').addEventListener('click', () => opened && download(opened.meta.name, opened.data as Uint8Array<ArrayBuffer>, opened.meta.type));
$('result-clear').addEventListener('click', () => {
  clearResult();
  shardPaste.value = '';
  openPass.value = '';
  void renderOpenShards();
  toast('Cleared from memory.');
});

// ================= VAULT =================
const vaultSrc = seg('vault-src', () => void renderVault());
const search = $<HTMLInputElement>('vault-search');
search.addEventListener('input', () => void renderVault());

interface Row { id: string; label: string; created: string; tags: HTMLElement[]; get: () => Promise<VaultFile | undefined>; remove: () => Promise<unknown> }

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
  const where = vaultSrc.get();
  let rows: Row[] = [];
  try {
    if (where === 'local') {
      rows = (await local.list()).map((f) => ({
        id: f.h.id, label: f.h.label, created: f.h.created, tags: tagsFor(f),
        get: async () => local.get(f.h.id), remove: () => local.remove(f.h.id),
      }));
    } else {
      if (!cloudConfigured) return emptyState('Cloud is not configured', 'This build has no cloud backend. Everything still works locally.');
      if (airGap.active) return emptyState('Air-gap is on', 'Cloud access is blocked in this tab. Turn air-gap off in Settings and reload to reconnect.', ['Open settings', () => show('settings')]);
      if (!(await cloud.session())) return emptyState('Sign in to see your cloud vault', 'Cloud records are stored per account and protected by row-level security.', ['Sign in', () => show('settings')]);
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
          try {
            const f = await r.get();
            if (!f) throw new VaultError('Record not found.');
            show('open');
            pick.value = `${where}:${r.id}`;
            setTarget(f, where === 'local' ? 'this device' : 'cloud');
          } catch (e) { fail(e); }
        }),
        button('Export', 'download', async () => { try { const f = await r.get(); if (f) downloadVault(f); } catch (e) { fail(e); } }),
        button('Delete', 'trash', async () => {
          if (!(await confirmDialog('Delete this vault?', `“${r.label || r.id}” will be permanently deleted from ${where === 'local' ? 'this device' : 'the cloud'}. Shards can't bring it back. Export a copy first if you might need it.`, 'Delete forever', true))) return;
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
  if (ok) { toast(`Imported ${ok} vault${ok > 1 ? 's' : ''}.`); vaultSrc.set('local'); }
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
  $('verify-chips').replaceChildren(...parsed.map((p) => p.shard
    ? h('li', { class: 'chip' }, icon('check'), `#${p.shard.i}/${p.shard.n} · ${p.shard.id.slice(0, 6)}`)
    : h('li', { class: 'chip bad', title: p.error }, icon('alert'), 'checksum failed')));
  if (!parsed.length) return set('idle', 'shield', 'Waiting for shards', 'Results appear here as you add shards.');

  const good = parsed.flatMap((p) => (p.shard ? [p.shard] : []));
  const bad = parsed.length - good.length;
  const ids = new Set(good.map((s) => s.id));
  if (!good.length) return set('bad', 'alert', 'No valid shards', 'Every shard failed its checksum. Look for typos or damaged copies.');
  if (ids.size > 1) return set('bad', 'alert', 'Mixed shard sets', `These shards come from ${ids.size} different vaults. Verify one set at a time.`);
  const { k, n, id } = good[0];
  const have = new Set(good.map((s) => s.i)).size;
  const badNote = bad ? ` ${bad} damaged shard${bad > 1 ? 's' : ''} ignored.` : '';
  if (have < k) return set('partial', 'shard', `${have} of ${k} shards`, `Each one passes its checksum. Add ${k - have} more from this set to confirm recovery works.${badNote}`);
  try {
    await verifyShards(good);
    if (gen !== verifyGen) return;
    set('ok', 'check', 'Recovery confirmed', `These shards rebuild the key for vault ${id}. Any ${k} of the ${n} will open it.${badNote}`);
    log(`Verified shard set for ${id}`);
  } catch (e) {
    set('bad', 'alert', 'Recovery failed', (e as Error).message);
  }
}
verifyPaste.addEventListener('input', () => void runVerify());
dropzone($('verify-drop'), (files) => appendText(verifyPaste, files, () => void runVerify()));
$('verify-clear').addEventListener('click', () => { verifyPaste.value = ''; void runVerify(); });

// ================= SETTINGS =================
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
    if (!(await confirmDialog('Turn on air-gap?', 'This tab will be cut off from the network. That stays true even if you change your mind, until you turn this off and reload. Cloud sync stops. It stays on for future visits.', 'Cut the network'))) {
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

async function refreshAccount() {
  const off = $('account-off'), form = $('auth-form'), on = $('account-on');
  const reason = !cloudConfigured ? "Cloud sync isn't configured for this build. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable it. Everything else works without it."
    : airGap.active ? 'Unavailable while air-gap is on.' : '';
  off.hidden = !reason;
  $('account-off-text').textContent = reason;
  if (reason) { form.hidden = on.hidden = true; return; }
  const s = await cloud.session().catch(() => null);
  form.hidden = Boolean(s);
  on.hidden = !s;
  if (s) $('account-email').textContent = s.user.email ?? s.user.id;
}
const authForm = $<HTMLFormElement>('auth-form');
const email = $<HTMLInputElement>('auth-email');
const password = $<HTMLInputElement>('auth-password');
authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void busy($<HTMLButtonElement>('auth-signin'), 'Signing in…', async () => {
    await cloud.signIn(email.value, password.value);
    password.value = '';
    toast('Signed in.');
    await refreshAccount();
  });
});
$('auth-signup').addEventListener('click', (e) => {
  if (!authForm.reportValidity()) return;
  void busy(e.currentTarget as HTMLButtonElement, 'Creating…', async () => {
    const signedIn = await cloud.signUp(email.value, password.value);
    password.value = '';
    toast(signedIn ? 'Account created. You are signed in.' : 'Check your email to confirm the account, then sign in.');
    await refreshAccount();
  });
});
$('auth-signout').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, 'Signing out…', async () => {
  await cloud.signOut();
  toast('Signed out.');
  await refreshAccount();
}));
cloud.onChange(() => { void refreshAccount(); void refreshDest(); });

async function refreshStorage() {
  const files = await local.list().catch(() => []);
  const persisted = await local.persisted().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  $('storage-status').textContent = `${files.length} record${files.length === 1 ? '' : 's'} on this device`
    + (est?.usage ? ` · ${fmtBytes(est.usage)} used` : '')
    + (persisted ? ' · protected from automatic cleanup.' : ' · the browser may clear this storage under pressure, so export important vaults.');
}
$('wipe-local').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete all local records?', 'Every vault saved on this device will be erased. Cloud records and exported .vault files are not affected.', 'Delete everything', true))) return;
  try { await local.clear(); toast('Local records deleted.'); void refreshStorage(); } catch (e) { fail(e); }
});

async function refreshSettings() {
  await Promise.all([refreshAirgapStatus(), refreshAccount(), refreshStorage()]);
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
setTarget(null);
const initial = location.hash.slice(1) as Tab;
show(TABS.includes(initial) ? initial : 'seal');
log(`Zero-Trust Vault ${__APP_VERSION__} ready${airGap.active ? ' · air-gapped' : ''}`);

// Offline support when served over HTTPS. Trusted Types requires a policy for the worker URL.
if ('serviceWorker' in navigator && location.protocol === 'https:' && !airGap.active) {
  const tt = (window as { trustedTypes?: { createPolicy: (n: string, p: object) => { createScriptURL: (u: string) => string } } }).trustedTypes;
  const url = tt ? tt.createPolicy('sw', { createScriptURL: (u: string) => { if (u !== './sw.js') throw new TypeError('blocked'); return u; } }).createScriptURL('./sw.js') : './sw.js';
  navigator.serviceWorker.register(url).catch(() => { /* offline support is best-effort */ });
}
