// Google Drive storage in the user's OWN account. No server or database of ours is involved: the browser
// talks to Google directly with a short-lived token. Scope drive.file = the app can only see files it created.
import { parseVaultFile, VaultError, type VaultFile } from './crypto';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com';
const FOLDER = 'Zero-Trust Vault';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NAME_RE = /^([0-9a-f]{16})\.vault$/;

export interface DriveEntry { fileId: string; id: string; created: string; size: number; label: string }
export interface DriveToken { token: string; expiresAt: number; state: string }

/** Google's OAuth 2.0 flow for browser apps (token in the redirect fragment, never sent to any server of ours). */
export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: SCOPE,
    state, include_granted_scopes: 'true', prompt: 'select_account',
  }).toString();
  return u.toString();
}

/** Parses `#access_token=…&expires_in=…&state=…` from the OAuth redirect. */
export function parseTokenHash(hash: string, now = Date.now()): DriveToken | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const token = p.get('access_token');
  const state = p.get('state');
  if (!token || !state) return null;
  const ttl = Number(p.get('expires_in') ?? 3600);
  return { token, state, expiresAt: now + Math.max(60, ttl - 60) * 1000 };
}

export function makeDrive(getToken: () => string, f: typeof fetch = (...a) => fetch(...a)) {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const r = await f(`${API}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${getToken()}` } })
      .catch(() => { throw new VaultError("Couldn't reach Google Drive. Check your connection."); });
    if (r.status === 401) throw new VaultError('Your Google Drive connection expired. Connect it again.');
    if (r.status === 403) throw new VaultError('Google Drive refused the request. Reconnect and allow access to the files this app creates.');
    if (!r.ok) throw new VaultError(`Google Drive error (${r.status}).`);
    return r;
  }
  let folderId: string | null = null;
  async function folder(): Promise<string> {
    if (folderId) return folderId;
    const q = `name='${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const found = await (await call(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`)).json() as { files?: { id: string }[] };
    if (found.files?.[0]) return (folderId = found.files[0].id);
    const made = await (await call('/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }),
    })).json() as { id: string };
    return (folderId = made.id);
  }

  return {
    async list(): Promise<DriveEntry[]> {
      const q = `'${await folder()}' in parents and trashed=false`;
      const r = await (await call(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,createdTime,size,appProperties)')}&orderBy=createdTime%20desc&pageSize=1000`)).json() as
        { files?: { id: string; name: string; createdTime: string; size?: string; appProperties?: Record<string, string> }[] };
      return (r.files ?? []).flatMap((x) => {
        const m = NAME_RE.exec(x.name);
        return m ? [{ fileId: x.id, id: m[1], created: x.createdTime, size: Number(x.size ?? 0), label: x.appProperties?.label ?? '' }] : [];
      });
    },
    // ponytail: single multipart request; switch to a resumable upload if vaults much larger than ~50 MB fail on slow links
    async put(file: VaultFile): Promise<void> {
      const b = `ztv-${crypto.randomUUID()}`;
      const meta = {
        name: `${file.h.id}.vault`, parents: [await folder()], mimeType: 'application/json',
        appProperties: { ztv: '2', label: file.h.label.slice(0, 60) }, // appProperties values are size-limited
      };
      const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(file)}\r\n--${b}--`;
      await call('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    },
    async get(fileId: string): Promise<VaultFile> {
      return parseVaultFile(await (await call(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)).text());
    },
    async remove(fileId: string): Promise<void> {
      await call(`/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    },
  };
}
