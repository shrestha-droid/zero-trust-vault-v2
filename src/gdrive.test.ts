import { describe, expect, it } from 'vitest';
import { seal } from './crypto';
import { authUrl, makeDrive, parseTokenHash } from './gdrive';

/** Minimal in-memory Google Drive v3 that speaks just the endpoints we use. */
function fakeDrive() {
  const files = new Map<string, { name: string; mimeType: string; parents: string[]; body: string; createdTime: string; appProperties?: Record<string, string> }>();
  let n = 0;
  const calls: string[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if ((init.headers as Record<string, string>).Authorization !== 'Bearer tok') return new Response('', { status: 401 });
    const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const inParent = /'([^']+)' in parents/.exec(q)?.[1];
      const byName = /name='([^']+)'/.exec(q)?.[1];
      const list = [...files.entries()].filter(([, v]) => (inParent ? v.parents.includes(inParent) : true) && (byName ? v.name === byName : true))
        .map(([id, v]) => ({ id, name: v.name, createdTime: v.createdTime, size: String(v.body.length), appProperties: v.appProperties }));
      return json({ files: list });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body as string);
      const id = `f${++n}`;
      files.set(id, { ...meta, parents: meta.parents ?? [], body: '', createdTime: new Date(Date.UTC(2027, 0, n)).toISOString() });
      return json({ id });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = /boundary=(.+)$/.exec((init.headers as Record<string, string>)['Content-Type'])![1];
      const parts = (init.body as string).split(`--${boundary}`).slice(1, 3).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const meta = JSON.parse(parts[0]);
      const id = `f${++n}`;
      files.set(id, { ...meta, body: parts[1], createdTime: new Date(Date.UTC(2027, 0, n)).toISOString() });
      return json({ id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const file = files.get(m[1]);
      return file ? new Response(file.body) : new Response('', { status: 404 });
    }
    if (m && method === 'DELETE') { files.delete(m[1]); return new Response(null, { status: 204 }); }
    return new Response('', { status: 400 });
  }) as unknown as typeof fetch;
  return { f, files, calls };
}

const text = (s: string) => ({ meta: { kind: 'text' as const, name: 'x.txt', type: 'text/plain', size: 0 }, data: new TextEncoder().encode(s) });

describe('google drive', () => {
  it('creates one folder, uploads, lists, downloads byte-exact, deletes', async () => {
    const { f, files, calls } = fakeDrive();
    const drive = makeDrive(() => 'tok', f);
    const a = await seal(text('alpha'), { shards: { k: 2, n: 2 }, label: 'Family kit' });
    const b = await seal(text('beta'), { shards: { k: 2, n: 2 } });
    await drive.put(a.file);
    await drive.put(b.file);
    expect([...files.values()].filter((x) => x.mimeType === 'application/vnd.google-apps.folder')).toHaveLength(1);
    const list = await drive.list();
    expect(list.map((x) => x.id).sort()).toEqual([a.file.h.id, b.file.h.id].sort());
    expect(list.find((x) => x.id === a.file.h.id)!.label).toBe('Family kit');
    const back = await drive.get(list.find((x) => x.id === a.file.h.id)!.fileId);
    expect(back).toEqual(JSON.parse(JSON.stringify(a.file)));
    await drive.remove(list[0].fileId);
    expect(await drive.list()).toHaveLength(1);
    expect(calls.filter((c) => c === 'POST /drive/v3/files')).toHaveLength(1); // folder created once, then cached
  });

  it('reuses an existing folder from a previous session', async () => {
    const { f, files } = fakeDrive();
    const first = makeDrive(() => 'tok', f);
    await first.put((await seal(text('x'), { shards: { k: 2, n: 2 } })).file);
    const second = makeDrive(() => 'tok', f);
    expect(await second.list()).toHaveLength(1);
    expect([...files.values()].filter((x) => x.mimeType === 'application/vnd.google-apps.folder')).toHaveLength(1);
  });

  it('turns auth and network failures into clear messages', async () => {
    const { f } = fakeDrive();
    await expect(makeDrive(() => 'expired', f).list()).rejects.toThrow(/expired/);
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(makeDrive(() => 'tok', offline).list()).rejects.toThrow(/reach Google Drive/);
  });

  it('builds the consent URL and parses the redirect fragment', () => {
    const u = new URL(authUrl('cid.apps.googleusercontent.com', 'https://v.example/app/', 'st8'));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid.apps.googleusercontent.com', response_type: 'token', scope: 'https://www.googleapis.com/auth/drive.file', state: 'st8', redirect_uri: 'https://v.example/app/' });
    expect(parseTokenHash('#access_token=abc&token_type=Bearer&expires_in=3599&state=st8', 0)).toEqual({ token: 'abc', state: 'st8', expiresAt: 3539_000 });
    expect(parseTokenHash('#seal')).toBeNull();
  });
});
