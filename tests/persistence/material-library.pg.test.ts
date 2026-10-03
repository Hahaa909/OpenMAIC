/**
 * Phase 2 of the material library on a real PostgreSQL, where transactions
 * run on separate connections: the shared scenarios, and the races only
 * parallel connections can show.
 *
 * Each test works in a schema of its own (see
 * `document-asset-references.pg.test.ts` for why), dropped afterwards.
 */
import { Pool } from 'pg';
import { afterEach, describe, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';

import {
  attachByIdScenario,
  attachRefusalScenario,
  bootLibraryHarness,
  copyOnUseScenario,
  deletedThroughLinkScenario,
  documentImagesQuotaScenario,
  documentImagesScenario,
  existingCopyScenario,
  libraryListingScenario,
  listingDerivedFieldsScenario,
  libraryReachScenario,
  libraryToolFlowScenario,
  linkAcrossClaimScenario,
  mediaLibraryScopeScenario,
  ownerRunnerScenario,
  rawConsumersScenario,
  releaseEdgesScenario,
  releaseRefusedOutputsScenario,
  resolverScenario,
  textAcrossClaimScenario,
  type LibraryHarness,
} from './_material-library-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;

let serial = 0;

describe.skipIf(!contractUrl)('material library on PostgreSQL', () => {
  let admin: Pool | undefined;
  const pools: Pool[] = [];
  let schema: string;

  async function boot(env: Record<string, string> = {}): Promise<LibraryHarness> {
    serial += 1;
    schema = `openmaic_material_library_test_${serial}`;
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      application_name: `material-library-${serial}`,
      max: 8,
    });
    pools.push(pool);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=material-library-${serial}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    return bootLibraryHarness(pool as never, databaseUrl);
  }

  afterEach(async () => {
    resetClaimParticipantsForTests();
    vi.unstubAllEnvs();
    for (const pool of pools.splice(0)) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      admin = undefined;
    }
  });

  describe('links', () => {
    it('attaches by id without a copy and reaches the source and its derivatives', async () => {
      await attachByIdScenario(await boot());
    });

    it('keeps reading a copy the session already holds', async () => {
      await existingCopyScenario(await boot());
    });

    it('attaches only the owner’s ready, undeleted sources, all or nothing', async () => {
      await attachRefusalScenario(await boot());
    });

    it('answers nothing through the link of a deleted source', async () => {
      await deletedThroughLinkScenario(await boot());
    });

    it('reaches unattached materials in library scope, never another owner’s', async () => {
      await libraryReachScenario(await boot());
    });

    it('keeps a link valid across a claim', async () => {
      await linkAcrossClaimScenario(await boot());
    });

    it('lists the library by folder, Unfiled and literal query, in pages', async () => {
      await libraryListingScenario(await boot());
    });

    it('derives lineage, attachment and searchable sources beyond the rows listed', async () => {
      await listingDerivedFieldsScenario(await boot());
    });
  });

  describe('resolver', () => {
    it('resolves session rows and owner materials, and reads each one’s bytes and text', async () => {
      await resolverScenario(await boot());
    });

    it('reads a source’s text across a claim, with the revision it found', async () => {
      await textAcrossClaimScenario(await boot());
    });

    it('reads original bytes for every consumer, whatever kind of row, and says when they are unavailable', async () => {
      await rawConsumersScenario(await boot());
    });
  });

  describe('extraction', () => {
    it('keeps a document’s images as derivatives and names them in its text', async () => {
      await documentImagesScenario(await boot());
    });

    it('publishes nothing when a document’s images do not fit the quota', async () => {
      await documentImagesQuotaScenario(await boot({ ASSET_QUOTA_BYTES: '2000' }));
    });

    it('removes the outputs of a run refused for certain, and keeps them when unsure', async () => {
      await releaseRefusedOutputsScenario(await boot());
    });

    it('keeps a committed publication, releases after a root refusal, and only warns when a release fails', async () => {
      await releaseEdgesScenario(await boot());
    });

    it('runs queued extractions and waits for a run under way when stopped', async () => {
      await ownerRunnerScenario(await boot());
    });
  });

  describe('courses', () => {
    it('copies a material into a course as an entry of its own', async () => {
      await copyOnUseScenario(await boot());
    });

    it('uses an unattached material in library scope without attaching it', async () => {
      await mediaLibraryScopeScenario(await boot());
    });
  });

  describe('tools', () => {
    it('extracts, waits for, reads and searches a library source by its own id', async () => {
      await libraryToolFlowScenario(await boot());
    });
  });
});
