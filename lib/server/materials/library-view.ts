/**
 * What the material library shows outside the agent: the public view of one
 * library material (RFC #1716 §8). Pool pointers, object keys and digests
 * never leave the server.
 */
import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import type { ResolvedMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { publicMaterialView } from '@/lib/server/agent-runtime/session-materials';

export interface LibraryMaterialView {
  materialId: string;
  kind: OwnerMaterialEntry['kind'];
  /** The display name, or the uploaded file name until it is renamed. */
  name: string;
  originalName?: string;
  mime?: string;
  bytes: number;
  folderId: string | null;
  derivedFrom?: string;
  pageNumber?: number;
  timeMs?: number;
  /** A source's extraction; `reason` says why it failed, quota refusals included. */
  extraction?: { status: string; reason?: string };
  createdAt: string;
}

export function libraryMaterialView(entry: OwnerMaterialEntry): LibraryMaterialView {
  const status = entry.extraction?.status ?? 'idle';
  return {
    materialId: entry.id,
    kind: entry.kind,
    name: entry.displayName ?? entry.originalName ?? entry.id,
    ...(entry.originalName ? { originalName: entry.originalName } : {}),
    ...(entry.mime ? { mime: entry.mime } : {}),
    bytes: entry.bytes,
    folderId: entry.folderId,
    ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}),
    ...(entry.lineage ?? {}),
    ...(entry.kind === 'source'
      ? {
          extraction: {
            status,
            ...(status === 'failed' && entry.extractionError
              ? { reason: entry.extractionError }
              : {}),
          },
        }
      : {}),
    createdAt: new Date(entry.createdAt).toISOString(),
  };
}

/**
 * The public view of one material a conversation reaches, for the session
 * material routes: a session row as it always was, an owner material as the
 * library shows it.
 */
export function sessionScopeMaterialView(material: ResolvedMaterial): Record<string, unknown> {
  return material.origin === 'session'
    ? publicMaterialView(material.record)
    : { ...libraryMaterialView(material.entry) };
}
