// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaLibrary } from '@/lib/standalone-player/playback/media-library';

const BYTES = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);

function documentWith(table: unknown, blocks: Record<string, string>): Document {
  const doc = document.implementation.createHTMLDocument('x');
  const tableElement = doc.createElement('script');
  tableElement.type = 'application/json';
  tableElement.id = 'openmaic-media';
  tableElement.textContent = typeof table === 'string' ? table : JSON.stringify(table);
  doc.body.append(tableElement);
  for (const [id, base64] of Object.entries(blocks)) {
    const block = doc.createElement('script');
    block.type = 'application/octet-stream';
    block.id = id;
    block.textContent = base64;
    doc.body.append(block);
  }
  return doc;
}

const created: Blob[] = [];
beforeEach(() => {
  created.length = 0;
  let next = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:test/${++next}`;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMediaLibrary', () => {
  it('decodes an embedded block into a typed Blob URL once and caches it', async () => {
    const doc = documentWith(
      { 'audio/audio-1.mp3': { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' } },
      { 'openmaic-media-1': Buffer.from(BYTES).toString('base64') },
    );
    const library = createMediaLibrary(doc);
    expect(library.has('audio/audio-1.mp3')).toBe(true);
    const url = library.resolve('audio/audio-1.mp3');
    expect(url).toBe('blob:test/1');
    expect(library.resolve('audio/audio-1.mp3')).toBe(url);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe('audio/mpeg');
    expect(new Uint8Array(await created[0].arrayBuffer())).toEqual(BYTES);
    library.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('uses a src entry as is (media shipped next to the page)', () => {
    const library = createMediaLibrary(
      documentWith({ 'media/asset-1.mp4': { src: 'media/asset-1.mp4' } }, {}),
    );
    expect(library.resolve('media/asset-1.mp4')).toBe('media/asset-1.mp4');
  });

  it('returns undefined for unknown keys, missing blocks, corrupt base64 and a corrupt table', () => {
    const library = createMediaLibrary(
      documentWith(
        {
          missing: { mimeType: 'audio/mpeg', embedded: 'nowhere' },
          corrupt: { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' },
        },
        { 'openmaic-media-1': '@@not base64@@' },
      ),
    );
    expect(library.resolve(undefined)).toBeUndefined();
    expect(library.resolve('unknown')).toBeUndefined();
    expect(library.has('missing')).toBe(false);
    expect(library.resolve('missing')).toBeUndefined();
    expect(library.resolve('corrupt')).toBeUndefined();
    expect(library.resolve('__proto__')).toBeUndefined();
    expect(createMediaLibrary(documentWith('{not json', {})).resolve('x')).toBeUndefined();
  });
});
