/**
 * Recognize an audio container from its leading bytes. Stored narration can
 * carry a wrong format label (a provider that answered WAV without a usable
 * Content-Type is recorded as mp3), and players that trust the label decode
 * the bytes with the wrong demuxer, e.g. WebKit reporting a WAV clip whose
 * streaming header carries a placeholder data length as hours long when it is
 * labelled audio/mpeg.
 *
 * Returns an extension `canonicalArchiveMedia('audio', …)` accepts, or `null`
 * when the bytes are not recognized (callers then keep the stored label).
 */
export type SniffedAudioExtension = 'wav' | 'mp3' | 'ogg' | 'flac' | 'm4a' | 'webm';

/** How many leading bytes {@link sniffAudioContainer} reads. */
export const AUDIO_SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function sniffAudioContainer(bytes: Uint8Array): SniffedAudioExtension | null {
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'm4a';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  // MPEG audio frame sync: 11 set bits, a valid layer (not 00).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes[1] & 0x06) {
    return 'mp3';
  }
  return null;
}

/** {@link sniffAudioContainer} over a Blob's leading bytes; `null` on any read failure. */
export async function sniffAudioBlob(blob: Blob): Promise<SniffedAudioExtension | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
    return sniffAudioContainer(head);
  } catch {
    return null;
  }
}
