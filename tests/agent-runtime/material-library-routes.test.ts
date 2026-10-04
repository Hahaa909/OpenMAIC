/**
 * The session material routes over PGlite: what a conversation reaches --
 * its own rows and the library materials its links reach -- under the
 * request owner. Only owner resolution and the runtime gate are stubbed.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  ownerId: 'user:alice',
}));

vi.mock('@/lib/config/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/feature-flags')>()),
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => mocks.ownerId),
);

import { GET as sessionMaterialRoute } from '@/app/api/materials/[id]/route';
import { GET as sessionMaterialsRoute } from '@/app/api/materials/route';
import { attachOwnerMaterialsToSession } from '@/lib/persistence/session-material-links';

import {
  ACCOUNT,
  OTHER,
  bootLibraryHarness,
  seedCopy,
  seedDerivative,
  seedSession,
  type ExtractionScenarioPool,
  type LibraryHarness,
} from '../persistence/_material-library-scenarios';
import { seedSource } from '../persistence/_owner-extraction-scenarios';

class PGlitePool implements ExtractionScenarioPool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('session material routes (PGlite)', () => {
  let db: PGlite | undefined;

  async function boot(): Promise<LibraryHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://library-routes-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootLibraryHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    mocks.runtimeConfigured = true;
    mocks.ownerId = ACCOUNT;
    await db?.close();
    db = undefined;
  });

  /** ses-1 holds a pre-link copy and links src-a (with img-a1); src-loose is not attached. */
  async function seedLinkedConversation(h: LibraryHarness): Promise<void> {
    await seedSession(h, 'ses-1');
    await seedSession(h, 'ses-other', OTHER);
    await seedSource(h, 'src-a');
    await seedSource(h, 'src-loose');
    await seedDerivative(h, 'img-a1', 'src-a');
    await seedCopy(h, 'ses-1', 'mat_copy', null);
    await attachOwnerMaterialsToSession(h.provider, {
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      materialIds: ['src-a'],
    });
  }

  it('lists a conversation’s linked materials after its own rows, on one cursor', async () => {
    await seedLinkedConversation(await boot());
    const list = async (query: string) => {
      const response = await sessionMaterialsRoute(
        request('GET', `/api/materials?sessionId=ses-1${query}`),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { materials: Array<Record<string, unknown>> }).materials;
    };

    const all = await list('');
    expect(all.map((m) => m.materialId)).toEqual(['mat_copy', 'src-a', 'img-a1']);
    expect(all[1]).toMatchObject({ kind: 'source', extraction: { status: 'idle' } });
    expect(all[2]).toMatchObject({ kind: 'image', derivedFrom: 'src-a' });
    // Pool pointers, object keys and digests stay on the server.
    for (const material of all) {
      for (const key of ['assetId', 'ossKey', 'sha256', 'ownerId', 'rawAssetId', 'textAssetId']) {
        expect(material).not.toHaveProperty(key);
      }
    }
    // One cursor pages across both kinds of row.
    const pages: unknown[] = [];
    let before = '';
    for (let page = 0; page < 4; page += 1) {
      const rows = await list(`&limit=1${before ? `&before=${before}` : ''}`);
      pages.push(rows.map((m) => m.materialId));
      if (rows.length === 0) break;
      before = String(rows[0]!.materialId);
    }
    expect(pages).toEqual([['mat_copy'], ['src-a'], ['img-a1'], []]);
    expect(await list('&limit=2&before=missing')).toEqual([]);
    expect(
      (await sessionMaterialsRoute(request('GET', '/api/materials?sessionId=ses-other'))).status,
    ).toBe(404);
  });

  it('reads one linked material of a conversation by its id', async () => {
    await seedLinkedConversation(await boot());
    const read = (id: string, sessionId = 'ses-1') =>
      sessionMaterialRoute(
        request('GET', `/api/materials/${id}?sessionId=${sessionId}`),
        params(id),
      );

    const linked = await read('src-a');
    expect(linked.status).toBe(200);
    const { material } = (await linked.json()) as { material: Record<string, unknown> };
    expect(material).toMatchObject({ materialId: 'src-a', kind: 'source' });
    for (const key of ['assetId', 'ossKey', 'sha256', 'ownerId']) {
      expect(material).not.toHaveProperty(key);
    }
    expect((await read('img-a1')).status).toBe(200);
    expect((await read('mat_copy')).status).toBe(200);
    // Unattached, or another owner's conversation: the same 404.
    expect((await read('src-loose')).status).toBe(404);
    expect((await read('src-a', 'ses-other')).status).toBe(404);
  });
});
