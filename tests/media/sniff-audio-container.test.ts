import { describe, expect, it } from 'vitest';
import { sniffAudioBlob, sniffAudioContainer } from '@/lib/media/sniff-audio-container';
import { streamingWavBytes } from '../fixtures/streaming-wav';

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === 'string' ? [...value].map((char) => char.charCodeAt(0)) : [value],
    ),
  );

describe('sniffAudioContainer', () => {
  it.each([
    ['wav', streamingWavBytes(4)],
    ['mp3', bytes('ID3', 4, 0, 0, 0, 0, 0, 0)],
    ['mp3', bytes(0xff, 0xfb, 0x90, 0x64)],
    ['ogg', bytes('OggS', 0, 2)],
    ['flac', bytes('fLaC', 0, 0, 0, 34)],
    ['m4a', bytes(0, 0, 0, 0x20, 'ftypM4A ')],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)],
  ] as const)('recognizes %s', (expected, input) => {
    expect(sniffAudioContainer(input)).toBe(expected);
  });

  it('returns null for unrecognized or too-short bytes', () => {
    expect(sniffAudioContainer(bytes('audio-bytes'))).toBeNull();
    expect(sniffAudioContainer(bytes(0xff))).toBeNull();
    expect(sniffAudioContainer(new Uint8Array())).toBeNull();
    // Frame sync with the reserved layer is not MPEG audio.
    expect(sniffAudioContainer(bytes(0xff, 0xe0))).toBeNull();
  });

  it('reads only the head of a Blob', async () => {
    expect(await sniffAudioBlob(new Blob([streamingWavBytes()], { type: 'audio/mpeg' }))).toBe(
      'wav',
    );
  });
});
