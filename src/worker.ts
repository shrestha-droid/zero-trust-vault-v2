// All key handling runs here, off the UI thread: data keys and Shamir secrets never exist in the
// page's JS heap, and Argon2id's 64 MiB pass doesn't freeze the interface.
import { open, seal, VaultError, verifyShards } from './crypto';

export const api = { seal, open, verifyShards };
export type Api = typeof api;

self.onmessage = async (e: MessageEvent<{ id: number; fn: keyof Api; args: unknown[] }>) => {
  const { id, fn, args } = e.data;
  try {
    const result = await (api[fn] as (...a: unknown[]) => Promise<unknown>)(...args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err), vault: err instanceof VaultError });
  }
};
