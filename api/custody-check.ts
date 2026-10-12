// Vercel Function: POST /api/custody-check. A shard holder confirms they still have it (proof only, never the shard).
import { makeCustodyHandler } from '../server/custody.js';
import { admin } from '../server/env.js';

export async function POST(request: Request): Promise<Response> {
  const db = admin();
  return makeCustodyHandler({
    confirm: async (vaultId, idx, verifier) => {
      const { data, error } = await db.from('custody').update({ confirmed_at: new Date().toISOString() } as never)
        .eq('vault_id', vaultId).eq('idx', idx).eq('verifier', verifier).select('idx');
      return !error && Boolean(data?.length);
    },
  })(request);
}
