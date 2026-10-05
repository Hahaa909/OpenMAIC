/**
 * GET /api/materials/[id]?sessionId= — one material an owned session
 * reaches (its own row, or a library material its links reach), in the same
 * public projection the list uses.
 *
 * Materials are session-scoped; the client names the session and the session's
 * owner row is the authorization. A foreign or missing session, and a material
 * id the session does not reach, all answer the same plain 404 (no existence
 * oracle).
 *
 * Deletion is deliberately not exposed: the session-material store from the
 * materials slice has no delete operation, and this slice adds no persistence
 * — a later slice grows deletion on the store, then the route.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { resolveOwnedSession } from '@/lib/server/agent-runtime/session-materials';
import { resolveMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { sessionScopeMaterialView } from '@/lib/server/materials/library-view';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const { id } = await params;
    const material = await resolveMaterial(sessionId, id);
    if (!material) return ownerNotFound(responseHeaders);
    return ownerJson({ material: sessionScopeMaterialView(material) }, 200, responseHeaders);
  });
}
