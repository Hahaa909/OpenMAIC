/**
 * Phase 2 of the material library (RFC #1716): the scenarios, shared by the
 * PGlite suite and the PostgreSQL one so both engines run the same
 * assertions. The PostgreSQL suite adds the races that need parallel
 * connections.
 *
 * Built on the owner-extraction harness: the real persistence provider on an
 * empty database, sources seeded the way uploads are.
 */
import { createHash } from 'node:crypto';

import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { expect } from 'vitest';

import { claimOwner } from '@/lib/persistence/owner-claims';
import {
  allocateOwnerMaterialBytes,
  publishOwnerMaterialUpload,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';
import {
  listSessionScopeMaterials,
  readResolvedMaterialRaw,
  readResolvedMaterialText,
  resolveMaterial,
  resolvedMaterialId,
} from '@/lib/server/agent-runtime/material-resolver';
import { runNextOwnerExtraction } from '@/lib/server/material-extraction/owner-extraction';
import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { buildMaterialMediaTool } from '@/lib/server/agent-runtime/material-media';
import { resolveRawMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { buildVoiceCloneTools } from '@/lib/server/agent-runtime/voice-clone-tools';
import {
  attachOwnerMaterialsToSession,
  ensureSessionMaterialLinkSchema,
  getLinkedOwnerMaterial,
  getSessionOwnerMaterial,
  listLinkedOwnerMaterials,
  listSessionOwnerLibrary,
  attachedMaterialIds,
} from '@/lib/persistence/session-material-links';

import {
  ACCOUNT,
  ANON,
  OTHER,
  bootExtractionHarness,
  ensure,
  seedSource,
  stateOf,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_owner-extraction-scenarios';

export { ACCOUNT, ANON, OTHER, type ExtractionHarness, type ExtractionScenarioPool };

export type LibraryHarness = ExtractionHarness & {
  /** Material byte-store objects written or seeded by key, besides `objects/<id>`. */
  objects: Map<string, Buffer>;
};

export async function bootLibraryHarness(
  pool: ExtractionScenarioPool,
  databaseUrl: string,
): Promise<LibraryHarness> {
  const h = Object.assign(await bootExtractionHarness(pool, databaseUrl), {
    objects: new Map<string, Buffer>(),
  });
  await ensureAgentSessionMaterialSchema(pool as never);
  await ensureSessionMaterialLinkSchema(pool as never);
  // Seeded sources name `objects/<id>` (see seedSource); session copies their own keys.
  const objects = h.objects;
  setMaterialByteStoreForTests({
    put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const id = key.startsWith('objects/') ? key.slice('objects/'.length) : undefined;
      const value = objects.get(key) ?? (id ? h.sources.get(id) : undefined);
      if (!value) throw new Error(`missing material bytes: ${key}`);
      return value;
    },
    delete: async (key) => void objects.delete(key),
  });
  return h;
}

export async function seedSession(
  h: ExtractionHarness,
  id: string,
  owner: string = ACCOUNT,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id) VALUES ($1, $2, 'p', $3)`,
    [id, owner, `stage-${id}`],
  );
}

/** A ready image derivative of `sourceId`, as a publication files one. */
export async function seedDerivative(
  h: ExtractionHarness,
  id: string,
  sourceId: string,
  owner: string = ACCOUNT,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, derived_from, mime, bytes, original_name, oss_key, sha256,
        status, extraction, created_at, asset_id)
     VALUES ($1, $2, 'image', $3, 'image/png', 3, $1, '', $4, 'ready', NULL, $5, NULL)`,
    [id, owner, sourceId, createHash('sha256').update(id).digest('hex'), h.clock.now],
  );
}

/** A session copy the binder made before links: a row naming the owner material. */
export async function seedCopy(
  h: ExtractionHarness,
  sessionId: string,
  copyId: string,
  ownerMaterialId: string | null,
): Promise<void> {
  await h.pool.query(
    `INSERT INTO agent_session_materials
       (id, session_id, kind, title, owner_material_id, raw_asset_id, text_chars,
        extraction_status)
     VALUES ($1, $2, 'source', 'copy.pdf', $3, $4, 0, 'idle')`,
    [copyId, sessionId, ownerMaterialId, `materials/${sessionId}/${copyId}/raw`],
  );
}

async function linksOf(h: ExtractionHarness, sessionId: string): Promise<string[]> {
  const result = await h.pool.query<{ material_id: string }>(
    `SELECT material_id FROM agent_session_material_links WHERE session_id = $1
      ORDER BY material_id`,
    [sessionId],
  );
  return result.rows.map((row) => row.material_id);
}

async function copyCount(h: ExtractionHarness): Promise<number> {
  const result = await h.pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM agent_session_materials',
  );
  return Number(result.rows[0]!.count);
}

const attach = (h: ExtractionHarness, sessionId: string, ids: string[], owner = ACCOUNT) =>
  attachOwnerMaterialsToSession(h.provider, { sessionId, ownerId: owner, materialIds: ids });

/**
 * Attaching links by id: no copy and no new session row, repeats collapse,
 * and the link reaches the source and its derivatives.
 */
export async function attachByIdScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-b');
  await seedDerivative(h, 'img-a1', 'src-a');

  const first = await attach(h, 'ses-1', ['src-b', 'src-a', 'src-b']);
  expect(first.status).toBe('attached');
  if (first.status !== 'attached') return;
  expect(first.materials.map((m) => [m.materialId, m.attachment])).toEqual([
    ['src-b', 'link'],
    ['src-a', 'link'],
  ]);
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a', 'src-b']);
  expect(await copyCount(h)).toBe(0);

  // Attaching again changes nothing.
  h.clock.now += 1;
  await attach(h, 'ses-1', ['src-a']);
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a', 'src-b']);

  const listed = await listLinkedOwnerMaterials(h.pool as never, 'ses-1');
  expect(listed.map((m) => m.id).sort()).toEqual(['img-a1', 'src-a', 'src-b']);
  // A derivative follows its source.
  const ids = listed.map((m) => m.id);
  expect(ids.indexOf('img-a1')).toBeGreaterThan(ids.indexOf('src-a'));

  expect((await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'img-a1'))?.derivedFrom).toBe(
    'src-a',
  );
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toMatchObject({
    id: 'src-a',
    kind: 'source',
    folderId: null,
    extractionResult: null,
  });
}

/** A session that already holds a copy keeps reading it: no link, no duplicate. */
export async function existingCopyScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-b');
  await seedSource(h, 'src-c');
  // A copy that names its source, and one the pre-upgrade binder keyed on the id.
  await seedCopy(h, 'ses-1', 'mat_copy', 'src-a');
  await seedCopy(h, 'ses-1', 'src-b', null);

  const outcome = await attach(h, 'ses-1', ['src-a', 'src-b', 'src-c']);
  expect(outcome).toMatchObject({
    status: 'attached',
    materials: [
      { materialId: 'mat_copy', attachment: 'copy' },
      { materialId: 'src-b', attachment: 'copy' },
      { materialId: 'src-c', attachment: 'link' },
    ],
  });
  expect(await linksOf(h, 'ses-1')).toEqual(['src-c']);
  expect(await copyCount(h)).toBe(2);
}

/**
 * Only the owner's ready, undeleted sources attach. One that is not makes the
 * whole call unavailable and attaches nothing.
 */
export async function attachRefusalScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSession(h, 'ses-other', OTHER);
  await seedSource(h, 'src-a');
  await seedSource(h, 'src-deleted');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-deleted']);
  await seedSource(h, 'src-uploading');
  await h.pool.query(`UPDATE owner_material SET status = 'uploading' WHERE id = $1`, [
    'src-uploading',
  ]);
  await seedSource(h, 'src-foreign', { owner: OTHER });
  await seedDerivative(h, 'img-a1', 'src-a');

  for (const bad of ['src-deleted', 'src-uploading', 'src-foreign', 'img-a1', 'missing']) {
    expect(await attach(h, 'ses-1', ['src-a', bad])).toEqual({ status: 'unavailable' });
  }
  expect(await linksOf(h, 'ses-1')).toEqual([]);
  // Another owner's session is not this owner's to attach to.
  expect(await attach(h, 'ses-other', ['src-a'])).toEqual({ status: 'session_missing' });
  expect(await attach(h, 'ses-none', ['src-a'])).toEqual({ status: 'session_missing' });
}

/**
 * A deleted source stops answering through its link -- the source and its
 * derivatives -- while the link row stays.
 */
export async function deletedThroughLinkScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await attach(h, 'ses-1', ['src-a']);

  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-a']);
  expect(await listLinkedOwnerMaterials(h.pool as never, 'ses-1')).toEqual([]);
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toBeNull();
  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'img-a1')).toBeNull();
  expect(await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'img-a1')).toBeNull();
  expect(await linksOf(h, 'ses-1')).toEqual(['src-a']);
}

/** Library scope reaches the owner's unattached materials, never another owner's. */
export async function libraryReachScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await seedDerivative(h, 'img-a1', 'src-a');
  await seedSource(h, 'src-foreign', { owner: OTHER });

  expect(await getLinkedOwnerMaterial(h.pool as never, 'ses-1', 'src-a')).toBeNull();
  expect((await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'src-a'))?.id).toBe('src-a');
  expect((await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'img-a1'))?.id).toBe('img-a1');
  expect(await getSessionOwnerMaterial(h.pool as never, 'ses-1', 'src-foreign')).toBeNull();
}

/**
 * A claim moves the session and the materials together and keeps both ids:
 * the link still reaches the material, and an attachment made with the
 * anonymous owner afterwards lands for the account.
 */
export async function linkAcrossClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-anon', ANON);
  await seedSource(h, 'src-a', { owner: ANON });
  await seedSource(h, 'src-b', { owner: ANON });
  await attach(h, 'ses-anon', ['src-a'], ANON);

  await claimOwner(ANON, ACCOUNT, { provider: h.provider });

  expect((await getLinkedOwnerMaterial(h.pool as never, 'ses-anon', 'src-a'))?.ownerId).toBe(
    ACCOUNT,
  );
  // A run that started before the claim still names the anonymous owner.
  expect(await attach(h, 'ses-anon', ['src-b'], ANON)).toMatchObject({ status: 'attached' });
  expect(await linksOf(h, 'ses-anon')).toEqual(['src-a', 'src-b']);
}

/** Extract one source of `owner` to `done` with the harness's fake providers. */
async function extractToDone(h: ExtractionHarness, id: string, owner = ACCOUNT): Promise<void> {
  await ensure(h, id, owner);
  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  expect((await stateOf(h, id)).status).toBe('done');
}

/**
 * One resolver for both kinds of id: a session row wins over an owner
 * material of the same id, the link reaches owner materials, library scope
 * reaches unattached ones, and each reads its own bytes and text.
 */
export async function resolverScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a', { bytes: Buffer.from('%PDF-a') });
  await seedSource(h, 'src-b');
  await seedSource(h, 'src-old');
  await seedCopy(h, 'ses-1', 'src-old', null);
  await attachOwnerMaterialsToSession(h.provider, {
    sessionId: 'ses-1',
    ownerId: ACCOUNT,
    materialIds: ['src-a'],
  });

  const listed = await listSessionScopeMaterials('ses-1');
  expect(listed.map((m) => [m.origin, resolvedMaterialId(m)])).toEqual([
    ['session', 'src-old'],
    ['owner', 'src-a'],
  ]);

  // The copy keyed on the owner id keeps meaning the copy.
  expect((await resolveMaterial('ses-1', 'src-old'))?.origin).toBe('session');
  // Unattached: only library scope reaches it.
  expect(await resolveMaterial('ses-1', 'src-b')).toBeNull();
  expect((await resolveMaterial('ses-1', 'src-b', 'library'))?.origin).toBe('owner');
  expect(await resolveMaterial('ses-1', 'missing', 'library')).toBeNull();

  const linked = (await resolveMaterial('ses-1', 'src-a'))!;
  expect(await readResolvedMaterialRaw('ses-1', linked)).toEqual({
    bytes: Buffer.from('%PDF-a'),
    mime: 'application/pdf',
  });
  // No extraction yet: no text.
  expect(await readResolvedMaterialText('ses-1', linked)).toBeNull();

  await extractToDone(h, 'src-a');
  const done = (await resolveMaterial('ses-1', 'src-a'))!;
  const text = await readResolvedMaterialText('ses-1', done);
  expect(text?.text).toContain('# Lesson');
  expect(text?.revision).toBe((await stateOf(h, 'src-a')).extraction_result!.revision);
}

/**
 * After a claim re-keys the text's pool entry to the account, a reader still
 * holding the anonymous owner reads it through the fenced re-read, with the
 * revision of the result it found; a source deleted since reads nothing.
 */
export async function textAcrossClaimScenario(h: ExtractionHarness): Promise<void> {
  await seedSource(h, 'src-anon', { owner: ANON });
  await seedSource(h, 'src-gone', { owner: ANON });
  await extractToDone(h, 'src-anon', ANON);
  await extractToDone(h, 'src-gone', ANON);
  const stale = {
    id: 'src-anon',
    ownerId: ANON,
    extractionResult: (await stateOf(h, 'src-anon')).extraction_result,
  };
  const staleGone = {
    id: 'src-gone',
    ownerId: ANON,
    extractionResult: (await stateOf(h, 'src-gone')).extraction_result,
  };

  await claimOwner(ANON, ACCOUNT, { provider: h.provider });
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);

  const read = await readOwnerMaterialText(stale);
  expect(read?.text).toContain('# Lesson');
  expect(read?.revision).toBe(stale.extractionResult!.revision);
  expect(await readOwnerMaterialText(staleGone)).toBeNull();
}

/** Run one material tool of a conversation with the production dependencies. */
async function runTool(sessionId: string, name: string, params: Record<string, unknown>) {
  const tool = buildMaterialTools({ sessionId, waitForDelay: async () => undefined }).find(
    (candidate) => candidate.name === name,
  )!;
  return (await tool.execute('call', params as never)) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  };
}

/**
 * The library flow through the real tools: an unattached source is invisible
 * in session scope, extracted on the owner chain in library scope, then read
 * and searched by its own id with the revision of its result. Nothing is
 * attached along the way.
 */
export async function libraryToolFlowScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');

  expect((await runTool('ses-1', 'read_material', { materialId: 'src-a' })).details).toEqual({
    status: 'not_found',
  });
  const listed = await runTool('ses-1', 'list_materials', { scope: 'library' });
  expect(listed.details.materials).toEqual([
    expect.objectContaining({
      materialId: 'src-a',
      attached: false,
      extraction: { status: 'idle' },
    }),
  ]);

  const extract = await runTool('ses-1', 'extract_material', {
    materialId: 'src-a',
    scope: 'library',
  });
  expect(extract.details).toEqual({ materialId: 'src-a', status: 'pending', started: true });
  // Again: already queued, not started a second time.
  expect(
    (await runTool('ses-1', 'extract_material', { materialId: 'src-a', scope: 'library' })).details,
  ).toMatchObject({ status: 'pending', started: false });

  expect(await runNextOwnerExtraction(h.deps())).toBe(true);
  const waited = await runTool('ses-1', 'wait_for_materials', {
    materialIds: ['src-a'],
    scope: 'library',
    timeoutSec: 1,
  });
  expect(waited.details).toMatchObject({ complete: true, materials: [{ status: 'done' }] });

  const revision = (await stateOf(h, 'src-a')).extraction_result!.revision;
  const read = await runTool('ses-1', 'read_material', { materialId: 'src-a', scope: 'library' });
  expect(read.content[0]!.text).toContain('# Lesson');
  expect(read.details).toMatchObject({ materialId: 'src-a', revision, offset: 0 });

  const search = await runTool('ses-1', 'search_material', { query: 'lesson', scope: 'library' });
  expect(search.details.hits).toEqual([expect.objectContaining({ materialId: 'src-a', revision })]);

  // Library reads attach nothing.
  expect(await linksOf(h, 'ses-1')).toEqual([]);
}

/**
 * The library listing: omitted folderId lists every folder, null lists
 * Unfiled only; query matches names and types literally; derivatives of a
 * deleted source and other owners' materials never appear.
 */
export async function libraryListingScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-unfiled');
  h.clock.now += 1;
  await seedSource(h, 'src-filed', { folderId: 'fold-1' });
  await seedDerivative(h, 'img-filed', 'src-filed');
  await h.pool.query(`UPDATE owner_material SET folder_id = 'fold-1' WHERE id = 'img-filed'`);
  await seedSource(h, 'src-gone');
  await seedDerivative(h, 'img-gone', 'src-gone');
  await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);
  await seedSource(h, 'src-100%_done');
  await seedSource(h, 'src-foreign', { owner: OTHER });

  const ids = async (options: Parameters<typeof listSessionOwnerLibrary>[2]) =>
    (await listSessionOwnerLibrary(h.pool as never, 'ses-1', options)).map((m) => m.id).sort();

  expect(await ids({})).toEqual(['img-filed', 'src-100%_done', 'src-filed', 'src-unfiled']);
  expect(await ids({ folderId: null })).toEqual(['src-100%_done', 'src-unfiled']);
  expect(await ids({ folderId: 'fold-1' })).toEqual(['img-filed', 'src-filed']);
  // Literal: % and _ match only themselves.
  expect(await ids({ query: '100%_' })).toEqual(['src-100%_done']);
  expect(await ids({ query: 'UNFILED' })).toEqual(['src-unfiled']);
  expect(await ids({ query: '%' })).toEqual(['src-100%_done']);

  // Keyset paging, newest first.
  const firstPage = await listSessionOwnerLibrary(h.pool as never, 'ses-1', { limit: 2 });
  const secondPage = await listSessionOwnerLibrary(h.pool as never, 'ses-1', {
    limit: 2,
    before: firstPage.at(-1)!.id,
  });
  expect([...firstPage, ...secondPage].map((m) => m.id).sort()).toEqual(await ids({}));
}

/**
 * What a listing derives from rows it may not include: a derivative's page
 * and time come from its source's result even when the source is filtered
 * out; a copy counts as attached; a text-only listing skips derivatives, so
 * newer images never crowd an older source out of a search.
 */
export async function listingDerivedFieldsScenario(h: ExtractionHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  await seedSource(h, 'src-a');
  await h.pool.query(
    `UPDATE owner_material
        SET extraction = '{"status":"done"}'::jsonb,
            extraction_result = $2::jsonb
      WHERE id = $1`,
    [
      'src-a',
      JSON.stringify({
        revision: 'rev-a',
        text: { assetId: 'pool-text', chars: 4 },
        extractor: { id: 'x', version: '1', options: {} },
        stats: {},
        derivatives: [
          {
            id: 'img-a1',
            kind: 'image',
            assetId: 'p',
            title: 't',
            mime: 'image/png',
            bytes: 3,
            sha256: 's',
            timeMs: 1500,
          },
        ],
        completedAt: 0,
      }),
    ],
  );
  h.clock.now += 1;
  for (let index = 0; index < 5; index += 1) {
    await seedDerivative(h, index === 0 ? 'img-a1' : `img-a${index + 1}`, 'src-a');
  }
  await seedSource(h, 'src-copied');
  await seedSource(h, 'src-old-copy');
  await seedSource(h, 'src-none');
  await seedCopy(h, 'ses-1', 'mat_copy', 'src-copied');
  await seedCopy(h, 'ses-1', 'src-old-copy', null);

  // The query matches the derivative only; its source is not in the result.
  const byName = await listSessionOwnerLibrary(h.pool as never, 'ses-1', { query: 'img-a1' });
  expect(byName.map((m) => [m.id, m.lineage])).toEqual([['img-a1', { timeMs: 1500 }]]);

  expect(
    [
      ...(await attachedMaterialIds(h.pool as never, 'ses-1', [
        'src-copied',
        'src-old-copy',
        'src-none',
      ])),
    ].sort(),
  ).toEqual(['src-copied', 'src-old-copy']);

  const withText = await listSessionOwnerLibrary(h.pool as never, 'ses-1', {
    withTextOnly: true,
    limit: 2,
  });
  expect(withText.map((m) => m.id)).toEqual(['src-a']);
}

/** A ready source whose original lives only in the pool, uploaded the way the route does. */
export async function seedPoolSource(
  h: ExtractionHarness,
  id: string,
  bytes: Buffer,
  mime: string,
) {
  await registerOwnerMaterial(
    h.pool as never,
    {
      id,
      ownerId: ACCOUNT,
      kind: 'source',
      mime,
      bytes: bytes.byteLength,
      originalName: `${id}.bin`,
      ossKey: '',
      extraction: { status: 'idle' },
    },
    { maxCount: 100, maxTotalBytes: 1_000_000 },
  );
  const assetId = await allocateOwnerMaterialBytes(h.provider, ACCOUNT, bytes, mime);
  await publishOwnerMaterialUpload(h.provider, ACCOUNT, id, {
    assetId,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/**
 * Every consumer of original bytes reads the same three kinds of material:
 * a linked source in the pool, a linked source from before the pool, and a
 * session copy. A pre-pool object that no longer matches its digest reads as
 * unavailable, and the consumers say so instead of using other bytes.
 */
export async function rawConsumersScenario(h: LibraryHarness): Promise<void> {
  await seedSession(h, 'ses-1');
  const video = Buffer.from('fake-mp4');
  await seedPoolSource(h, 'src-pool', video, 'video/mp4');
  await seedSource(h, 'src-old', { mime: 'audio/mpeg', bytes: Buffer.from('fake-mp3') });
  await seedSource(h, 'src-bad', { mime: 'audio/mpeg', bytes: Buffer.from('fake-mp3-bad') });
  await seedCopy(h, 'ses-1', 'mat_copy', null);
  h.objects.set('materials/ses-1/mat_copy/raw', Buffer.from('copied'));
  await attachOwnerMaterialsToSession(h.provider, {
    sessionId: 'ses-1',
    ownerId: ACCOUNT,
    materialIds: ['src-pool', 'src-old', 'src-bad'],
  });
  // The stored object changes after its digest was recorded.
  h.sources.set('src-bad', Buffer.from('tampered'));

  const read = async (id: string) => (await resolveRawMaterial('ses-1', id))!.read();
  expect(await read('src-pool')).toEqual({ bytes: video, mime: 'video/mp4' });
  expect(await read('src-old')).toEqual({ bytes: Buffer.from('fake-mp3'), mime: 'audio/mpeg' });
  expect((await read('mat_copy'))?.bytes).toEqual(Buffer.from('copied'));
  expect(await read('src-bad')).toBeNull();
  // Unattached: no consumer reaches it in the session.
  await seedSource(h, 'src-loose');
  expect(await resolveRawMaterial('ses-1', 'src-loose')).toBeNull();

  const clip = buildVoiceCloneTools({
    sessionId: 'ses-1',
    clipAudio: async () => Buffer.alloc(0),
  }).find((tool) => tool.name === 'clip_audio')!;
  await expect(
    clip.execute('call', { materialId: 'src-bad', startSec: 0, endSec: 10 } as never),
  ).rejects.toThrow('material bytes are unavailable');

  const media = buildMaterialMediaTool({ sessionId: 'ses-1' });
  const result = (await media.execute('call', {
    materialId: 'src-bad',
    stageId: 'stage-1',
  } as never)) as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.content[0]!.text).toBe('Media bytes are unavailable.');
  expect(result.isError).toBe(true);
}
