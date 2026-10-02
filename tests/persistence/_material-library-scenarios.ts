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
import {
  attachOwnerMaterialsToSession,
  ensureSessionMaterialLinkSchema,
  getLinkedOwnerMaterial,
  getSessionOwnerMaterial,
  listLinkedOwnerMaterials,
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

export async function bootLibraryHarness(
  pool: ExtractionScenarioPool,
  databaseUrl: string,
): Promise<ExtractionHarness> {
  const h = await bootExtractionHarness(pool, databaseUrl);
  await ensureAgentSessionMaterialSchema(pool as never);
  await ensureSessionMaterialLinkSchema(pool as never);
  // Seeded sources name `objects/<id>` (see seedSource); session copies their own keys.
  const objects = new Map<string, Buffer>();
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
