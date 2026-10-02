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
  deletedThroughLinkScenario,
  existingCopyScenario,
  libraryListingScenario,
  listingDerivedFieldsScenario,
  libraryReachScenario,
  libraryToolFlowScenario,
  linkAcrossClaimScenario,
  resolverScenario,
  textAcrossClaimScenario,
  type ExtractionHarness,
} from './_material-library-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;

let serial = 0;

describe.skipIf(!contractUrl)('material library on PostgreSQL', () => {
  let admin: Pool | undefined;
  const pools: Pool[] = [];
  let schema: string;

  async function boot(): Promise<ExtractionHarness> {
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
  });

  describe('tools', () => {
    it('extracts, waits for, reads and searches a library source by its own id', async () => {
      await libraryToolFlowScenario(await boot());
    });
  });
});
