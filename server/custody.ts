// Shard check-ins (see supabase/migrations/0005_custody.sql). A holder's browser posts
// { vault_id, shards: [{ i, proof }] }; we hash each proof and stamp the matching row. No account needed:
// only someone holding the shard can produce its proof, and a proof reveals nothing about the shard.
export interface CustodyDeps {
  /** Stamps confirmed_at on the row with this verifier; true if one matched. */
  confirm: (vaultId: string, idx: number, verifier: string) => Promise<boolean>;
}

export const verifierOf = async (proof: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof))), (b) => b.toString(16).padStart(2, '0')).join('');

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function makeCustodyHandler(d: CustodyDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => null) as { vault_id?: unknown; shards?: unknown } | null;
    const shards = body?.shards;
    const ok = typeof body?.vault_id === 'string' && /^[0-9a-f]{16}$/.test(body.vault_id)
      && Array.isArray(shards) && shards.length >= 1 && shards.length <= 16
      && shards.every((s) => Number.isInteger(s?.i) && s.i >= 1 && s.i <= 16 && typeof s.proof === 'string' && /^[0-9a-f]{64}$/.test(s.proof));
    if (!ok) return json({ error: 'Not a valid check-in.' }, 400);
    const confirmed: number[] = [];
    for (const s of shards as { i: number; proof: string }[]) {
      if (await d.confirm(body!.vault_id as string, s.i, await verifierOf(s.proof))) confirmed.push(s.i);
    }
    return json({ confirmed: [...new Set(confirmed)] });
  };
}
