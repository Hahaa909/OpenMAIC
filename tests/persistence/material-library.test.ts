/**
 * Phase 2 of the material library on PGlite. The same scenarios run on
 * PostgreSQL in the `.pg` suite, which adds the races that need parallel
 * connections.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, it, vi } from 'vitest';

import {
  attachByIdScenario,
  attachRefusalScenario,
  bootLibraryHarness,
  deletedThroughLinkScenario,
  existingCopyScenario,
  libraryReachScenario,
  linkAcrossClaimScenario,
  resolverScenario,
  textAcrossClaimScenario,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_material-library-scenarios';

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

describe('material library (PGlite)', () => {
  let db: PGlite | undefined;

  async function boot(): Promise<ExtractionHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://material-library-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootLibraryHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
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
  });

  describe('resolver', () => {
    it('resolves session rows and owner materials, and reads each one’s bytes and text', async () => {
      await resolverScenario(await boot());
    });

    it('reads a source’s text across a claim, with the revision it found', async () => {
      await textAcrossClaimScenario(await boot());
    });
  });
});
