/**
 * Playback media of the exported document: the media table maps each key the
 * manifest names (speech `audioRef`, video `mediaRef`) to its bytes.
 *
 * Embedded bytes are base64 data blocks, decoded into a Blob URL the first
 * time a key is resolved (a narration clip when it plays, a slide video when
 * its slide renders) and cached for the session. Blob URLs (allowed by the
 * file's CSP as `media-src blob:`) are what both Chromium and WebKit play and
 * seek most reliably; long `data:` URIs are not. A `src` entry (an export that
 * ships its media next to the page) is used as is: the element loads the file
 * itself, the only way a page opened from disk may load a sibling file.
 *
 * Linked files go missing when the page is opened without them (straight from
 * inside a ZIP, or copied out alone). The library notices it, from a probe of
 * one file as the player opens and from any linked clip that fails to load,
 * so the player can say so; playback itself carries on without the media.
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
  /** A media element failed to load `key`. Only linked files count as missing. */
  reportError(key: string | undefined): void;
  /** Whether a linked media file (shipped next to the page) failed to load. */
  linkedMediaMissing(): boolean;
  /** Notified once when linked media is first found missing. */
  subscribe(listener: () => void): () => void;
  /** Load the metadata of one linked file, so a missing folder shows before playback. */
  probeLinkedMedia(): void;
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
  const listeners = new Set<() => void>();
  let missing = false;
  let probe: HTMLMediaElement | null = null;
  const entryFor = (key: string) => {
    table ??= readTable(doc);
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };
  const markMissing = () => {
    if (missing) return;
    missing = true;
    for (const listener of listeners) listener();
  };
  const endProbe = () => {
    if (!probe) return;
    probe.onloadedmetadata = probe.onerror = null;
    probe.removeAttribute('src');
    probe = null;
  };

  return {
    reportError(key) {
      if (key && entryFor(key)?.src) markMissing();
    },
    linkedMediaMissing: () => missing,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    probeLinkedMedia() {
      if (probe || missing) return;
      table ??= readTable(doc);
      const entry = Object.values(table).find((candidate) => candidate?.src);
      if (!entry?.src) return;
      const element = doc.createElement(entry.mimeType?.startsWith('video/') ? 'video' : 'audio');
      probe = element;
      element.preload = 'metadata';
      element.muted = true;
      element.onloadedmetadata = endProbe;
      element.onerror = () => {
        endProbe();
        markMissing();
      };
      element.src = entry.src;
    },
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
      endProbe();
      listeners.clear();
    },
  };
}
