/**
 * Playback media of the exported document: the media table maps each key the
 * manifest names (speech `audioRef`, video `mediaRef`) to its bytes.
 *
 * Embedded bytes are base64 data blocks, decoded into a Blob URL the first
 * time a key is played and cached for the session. Blob URLs (allowed by the
 * file's CSP as `media-src blob:`) are what both Chromium and WebKit play and
 * seek most reliably; long `data:` URIs are not. A `src` entry (an export that
 * ships its media next to the page) is used as is.
 */
import {
  STANDALONE_MEDIA_TABLE_ELEMENT_ID,
  type StandaloneMediaTable,
} from '@/lib/export/standalone-html/contract';

export interface MediaLibrary {
  /** A playable URL for a media key, or `undefined` when the file has no bytes for it. */
  resolve(key: string | undefined): string | undefined;
  has(key: string | undefined): boolean;
  /** Release every decoded Blob URL. */
  dispose(): void;
}

function readTable(doc: Document): StandaloneMediaTable {
  const element = doc.getElementById(STANDALONE_MEDIA_TABLE_ELEMENT_ID);
  if (!element?.textContent) return {};
  try {
    const table = JSON.parse(element.textContent) as unknown;
    return table && typeof table === 'object' ? (table as StandaloneMediaTable) : {};
  } catch {
    return {};
  }
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createMediaLibrary(doc: Document): MediaLibrary {
  let table: StandaloneMediaTable | null = null;
  const urls = new Map<string, string>();
  const entryFor = (key: string) => {
    table ??= readTable(doc);
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };

  return {
    has(key) {
      if (!key) return false;
      const entry = entryFor(key);
      return !!entry && !!(entry.src || (entry.embedded && doc.getElementById(entry.embedded)));
    },
    resolve(key) {
      if (!key) return undefined;
      const cached = urls.get(key);
      if (cached) return cached;
      const entry = entryFor(key);
      if (!entry) return undefined;
      if (entry.src) return entry.src;
      const block = entry.embedded ? doc.getElementById(entry.embedded) : null;
      if (!block?.textContent) return undefined;
      try {
        const blob = new Blob([decodeBase64(block.textContent)], {
          type: entry.mimeType || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      } catch {
        return undefined;
      }
    },
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
