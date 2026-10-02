/**
 * Which library materials a conversation has attached (RFC #1716 §4).
 *
 * Before Phase 2, sending a library material copied its bytes into the
 * session's byte prefix and minted a session row (`agent_session_materials`).
 * An attachment is now a link: one `(session_id, material_id)` row naming an
 * owner material by its own id. Nothing is copied, and every reader resolves
 * the id against the owner's row as it is now -- its extraction, its
 * derivatives, whether it was deleted.
 *
 * ## No owner on the link
 *
 * A link records no owner. A claim moves a session (`agent-sessions`) and its
 * owner's materials (`owner-materials`) in one transaction and keeps both
 * ids, so a link stays valid across a claim with no participant of its own.
 * Every read joins the session's owner now to the material's owner now and
 * answers nothing when they differ.
 *
 * ## What a link reaches
 *
 * A link names a source. Through it the session reaches that source and the
 * source's media derivatives (`derived_from`), as long as the source is
 * ready and not deleted; a derivative is never attached on its own. A
 * deleted source answers nothing even while its bytes are still in the pool
 * within the grace period.
 *
 * ## Copies made before links
 *
 * A session that already holds a copy of a material -- a row whose
 * `owner_material_id` is the material, or one the pre-upgrade binder keyed on
 * the material id itself -- keeps reading that copy: attaching the material
 * again reuses the copy instead of adding a link, so the conversation never
 * lists the same file twice under two ids. Copies are never migrated.
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

import type { OwnerExtractionResult } from './owner-material-extraction';
import {
  OWNER_MATERIAL_COLUMNS,
  ownerMaterialRowToRecord,
  type OwnerMaterialRecord,
  type RawOwnerMaterialRow,
} from './owner-materials';
import { forwardOwnerWrite } from './owner-merges';

/**
 * The link table. It references `agent_sessions` and is provisioned after the
 * session-material schema, which needs that table too. Deleting a session
 * row removes its links; soft-deleting one leaves them, and every read joins
 * a live session.
 */
export const SESSION_MATERIAL_LINK_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_session_material_links (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  created_at  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (session_id, material_id)
);
`;

export async function ensureSessionMaterialLinkSchema(queryable: Queryable): Promise<void> {
  await queryable.query(SESSION_MATERIAL_LINK_SCHEMA.trim());
}

/** An owner material with the library columns readers need beyond the record. */
export interface OwnerMaterialEntry extends OwnerMaterialRecord {
  folderId: string | null;
  displayName: string | null;
  /** Why the latest extraction failed, while the status is `failed`. */
  extractionError: string | null;
  /** The latest successful extraction of a source; `null` before the first. */
  extractionResult: OwnerExtractionResult | null;
}

interface RawOwnerMaterialEntryRow extends RawOwnerMaterialRow {
  folder_id: string | null;
  display_name: string | null;
  extraction_error: string | null;
  extraction_result: unknown;
}

/** The entry columns, every one qualified by `alias`. */
function entryColumns(alias: string): string {
  return [
    ...OWNER_MATERIAL_COLUMNS.split(',').map((column) => column.trim()),
    'folder_id',
    'display_name',
    'extraction_error',
    'extraction_result',
  ]
    .map((column) => `${alias}.${column}`)
    .join(', ');
}

export function ownerMaterialEntryOf(row: RawOwnerMaterialEntryRow): OwnerMaterialEntry {
  return {
    ...ownerMaterialRowToRecord(row),
    folderId: row.folder_id,
    displayName: row.display_name,
    extractionError: row.extraction_error,
    extractionResult: (row.extraction_result ?? null) as OwnerExtractionResult | null,
  };
}

/**
 * The live sources a session links, with their owner: the session must be
 * live and the source its owner's now, ready and not deleted.
 */
const LINKED_SOURCES = `
  SELECT source.id, source.owner_id, link.created_at AS linked_at
    FROM agent_session_material_links AS link
    JOIN agent_sessions AS session
      ON session.id = link.session_id AND session.deleted_at IS NULL
    JOIN owner_material AS source
      ON source.id = link.material_id AND source.owner_id = session.owner_id
   WHERE link.session_id = $1
     AND source.kind = 'source' AND source.status = 'ready' AND source.deleted_at IS NULL`;

/** Each linked source and its live derivatives (`linked` is {@link LINKED_SOURCES}). */
const LINKED_MATERIALS = `
  SELECT ${entryColumns('material')}, linked.linked_at
    FROM linked
    JOIN owner_material AS material
      ON material.id = linked.id
      OR (material.derived_from = linked.id AND material.owner_id = linked.owner_id
          AND material.status = 'ready' AND material.deleted_at IS NULL)`;

/**
 * Every material a session reaches through its links: each linked source,
 * then its derivatives, in the order the sources were attached.
 */
export async function listLinkedOwnerMaterials(
  queryable: Queryable,
  sessionId: string,
): Promise<OwnerMaterialEntry[]> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `WITH linked AS (${LINKED_SOURCES})
     ${LINKED_MATERIALS}
     ORDER BY linked.linked_at, linked.id, material.derived_from NULLS FIRST,
              material.created_at, material.id`,
    [sessionId],
  );
  return result.rows.map(ownerMaterialEntryOf);
}

/** One material the session reaches through a link, or `null`. */
export async function getLinkedOwnerMaterial(
  queryable: Queryable,
  sessionId: string,
  materialId: string,
): Promise<OwnerMaterialEntry | null> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `WITH linked AS (${LINKED_SOURCES})
     ${LINKED_MATERIALS}
     WHERE material.id = $2
     LIMIT 1`,
    [sessionId, materialId],
  );
  return result.rows[0] ? ownerMaterialEntryOf(result.rows[0]) : null;
}

/**
 * One live material of the session's owner, attached or not -- what library
 * scope reaches. A derivative answers only while its source is live too.
 */
export async function getSessionOwnerMaterial(
  queryable: Queryable,
  sessionId: string,
  materialId: string,
): Promise<OwnerMaterialEntry | null> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `SELECT ${entryColumns('material')}
       FROM agent_sessions AS session
       JOIN owner_material AS material ON material.owner_id = session.owner_id
       LEFT JOIN owner_material AS source ON source.id = material.derived_from
      WHERE session.id = $1 AND session.deleted_at IS NULL AND material.id = $2
        AND material.status = 'ready' AND material.deleted_at IS NULL
        AND (material.derived_from IS NULL
          OR (source.owner_id = material.owner_id AND source.status = 'ready'
              AND source.deleted_at IS NULL))
      LIMIT 1`,
    [sessionId, materialId],
  );
  return result.rows[0] ? ownerMaterialEntryOf(result.rows[0]) : null;
}

/** One attached material: the id the conversation knows it by, and its owner row. */
export interface AttachedOwnerMaterial {
  /** The owner material id for a link; the copy's own id for an existing copy. */
  materialId: string;
  /** `link`: attached by id. `copy`: the session already held a copy, which it keeps reading. */
  attachment: 'link' | 'copy';
  record: OwnerMaterialRecord;
}

export type AttachOwnerMaterialsOutcome =
  | { status: 'attached'; materials: AttachedOwnerMaterial[] }
  | { status: 'session_missing' }
  | { status: 'unavailable' };

/**
 * Attach library sources to a session by id, idempotently.
 *
 * One transaction: the owner's write fence, forwarded (an attachment rides on
 * the session's own write, which follows a claim; the route refuses a retired
 * owner before it gets here), then the session, which must be live and the
 * owner's, then the sources, each of which must be the owner's ready,
 * undeleted source -- locked `FOR SHARE` so a deletion cannot commit between
 * the check and the link. A derivative or another owner's material makes the
 * whole call `unavailable`, and nothing is attached.
 *
 * A source the session already holds a copy of keeps that copy (see the
 * module docstring); every other source gets one link, and a link that
 * exists already is left as it is. The result follows `materialIds`, without
 * repeats.
 */
export async function attachOwnerMaterialsToSession(
  persistence: { withTransaction: WithTransaction },
  input: { sessionId: string; ownerId: string; materialIds: readonly string[] },
  now: number = Date.now(),
): Promise<AttachOwnerMaterialsOutcome> {
  const ids = [...new Set(input.materialIds)];
  return persistence.withTransaction(async (tx) => {
    const ownerId = await forwardOwnerWrite(tx, input.ownerId);
    const session = await tx.query<{ owner_id: string }>(
      'SELECT owner_id FROM agent_sessions WHERE id = $1 AND deleted_at IS NULL',
      [input.sessionId],
    );
    if (session.rows[0]?.owner_id !== ownerId) return { status: 'session_missing' as const };
    if (ids.length === 0) return { status: 'attached' as const, materials: [] };

    const sources = await tx.query<RawOwnerMaterialRow>(
      `SELECT ${OWNER_MATERIAL_COLUMNS}
         FROM owner_material
        WHERE id = ANY($1::text[]) AND owner_id = $2 AND kind = 'source'
          AND status = 'ready' AND deleted_at IS NULL
        ORDER BY id
          FOR SHARE`,
      [ids, ownerId],
    );
    if (sources.rows.length !== ids.length) return { status: 'unavailable' as const };
    const byId = new Map(sources.rows.map((row) => [row.id, ownerMaterialRowToRecord(row)]));

    // The session's copies of these sources: rows that name the source, or
    // that the pre-upgrade binder keyed on the source id itself.
    const copies = await tx.query<{ id: string; owner_material_id: string | null }>(
      `SELECT id, owner_material_id
         FROM agent_session_materials
        WHERE session_id = $1
          AND (owner_material_id = ANY($2::text[]) OR id = ANY($2::text[]))`,
      [input.sessionId, ids],
    );
    const copyOf = new Map<string, string>();
    for (const row of copies.rows) {
      if (row.owner_material_id !== null) copyOf.set(row.owner_material_id, row.id);
    }
    for (const row of copies.rows) {
      if (row.owner_material_id === null && !copyOf.has(row.id)) copyOf.set(row.id, row.id);
    }

    const toLink = ids.filter((id) => !copyOf.has(id));
    if (toLink.length > 0) {
      await tx.query(
        `INSERT INTO agent_session_material_links (session_id, material_id, created_at)
         SELECT $1, material_id, $3 FROM unnest($2::text[]) AS material_id
         ON CONFLICT (session_id, material_id) DO NOTHING`,
        [input.sessionId, toLink, now],
      );
    }
    return {
      status: 'attached' as const,
      materials: ids.map((id) => {
        const copy = copyOf.get(id);
        return copy === undefined
          ? { materialId: id, attachment: 'link' as const, record: byId.get(id)! }
          : { materialId: copy, attachment: 'copy' as const, record: byId.get(id)! };
      }),
    };
  });
}
