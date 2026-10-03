/**
 * GET /api/materials/library — the request owner's material library, with
 * the limits and usage uploads are held to (RFC #1716 §5, §8).
 *
 * Query: `folderId` (a folder id, or the literal `unfiled` for Unfiled; omit
 * it for every folder), `query` (literal text in names and file types),
 * `before` and `limit` (keyset paging, newest first, at most 200). The answer
 * is `{ materials, limits, nextBefore? }`; a failed extraction carries its
 * reason, a quota refusal included. The composer's picker and `@`, and later
 * the library page, read it.
 *
 * Gated like the rest of `/api/materials`: without the configured agent
 * runtime it answers a plain 404.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { listOwnerLibrary } from '@/lib/persistence/session-material-links';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { libraryPersistence, libraryRefusal } from '@/lib/server/materials/library-routes';
import { libraryLimits, libraryMaterialView } from '@/lib/server/materials/library-view';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  const rawFolder = url.searchParams.get('folderId');
  const query = url.searchParams.get('query')?.trim() || undefined;
  const before = url.searchParams.get('before')?.trim() || undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null || rawLimit === '' ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return libraryRefusal(
      400,
      'invalid_limit',
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
      new Headers(),
    );
  }
  const folderId =
    rawFolder === null || rawFolder === '' ? undefined : rawFolder === 'unfiled' ? null : rawFolder;

  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const { pool } = await libraryPersistence();
    const [entries, limits] = await Promise.all([
      listOwnerLibrary(pool, ownerId, {
        ...(folderId !== undefined ? { folderId } : {}),
        ...(query ? { query } : {}),
        ...(before ? { before } : {}),
        limit,
      }),
      libraryLimits(pool, ownerId),
    ]);
    const nextBefore = entries.length === limit ? entries.at(-1)!.id : undefined;
    return ownerJson(
      {
        materials: entries.map(libraryMaterialView),
        limits,
        ...(nextBefore ? { nextBefore } : {}),
      },
      200,
      headers,
    );
  });
}
