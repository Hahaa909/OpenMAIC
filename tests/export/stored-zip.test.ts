import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { buildStoredZip, crc32, isSafeArchivePath } from '@/lib/export/standalone-html/stored-zip';

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe('crc32', () => {
  it('matches the standard check value and composes across chunks', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    const whole = bytesOf('The quick brown fox jumps over the lazy dog');
    expect(crc32(whole.subarray(10), crc32(whole.subarray(0, 10)))).toBe(crc32(whole));
    expect(crc32(whole)).toBe(0x414fa339);
  });
});

describe('isSafeArchivePath', () => {
  it('accepts plain relative paths only', () => {
    expect(isSafeArchivePath('classroom.html')).toBe(true);
    expect(isSafeArchivePath('media/asset-1.mp4')).toBe(true);
    expect(isSafeArchivePath('audio/中文.mp3')).toBe(true);
    for (const unsafe of [
      '',
      '/etc/passwd',
      '../x',
      'a/../../x',
      'a/./b',
      'a//b',
      'a/',
      'a\\b',
      'C:/x',
      'a\u0000b',
    ]) {
      expect(isSafeArchivePath(unsafe), unsafe).toBe(false);
    }
  });
});

describe('buildStoredZip', () => {
  it('writes stored entries any ZIP reader extracts with matching CRCs', async () => {
    const media = new Uint8Array(70_000).map((_, index) => (index * 31) & 0xff);
    const zipBlob = await buildStoredZip(
      [
        { path: 'classroom.html', data: new Blob(['<!doctype html>']) },
        { path: 'README.txt', data: '\uFEFF先解压\r\nExtract first\r\n' },
        { path: 'media/clip.mp4', data: new Blob([media], { type: 'video/mp4' }) },
        { path: 'audio/empty.mp3', data: new Blob([]) },
      ],
      { date: new Date(2026, 9, 8, 13, 45, 30) },
    );
    expect(zipBlob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer(), { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual([
      'classroom.html',
      'README.txt',
      'media/clip.mp4',
      'audio/empty.mp3',
    ]);
    expect(await zip.file('classroom.html')!.async('string')).toBe('<!doctype html>');
    expect(await zip.file('README.txt')!.async('string')).toBe('\uFEFF先解压\r\nExtract first\r\n');
    expect(await zip.file('media/clip.mp4')!.async('uint8array')).toEqual(media);
    expect((await zip.file('audio/empty.mp3')!.async('uint8array')).length).toBe(0);
    // DOS times carry no zone; JSZip reads them as UTC fields.
    const date = zip.file('media/clip.mp4')!.date;
    expect([date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()]).toEqual([2026, 9, 8]);
    expect([date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]).toEqual([13, 45, 30]);
    // Stored: the archive is the data plus headers, nothing compressed away.
    const headers = 4 * (30 + 46) + 22;
    const names = ['classroom.html', 'README.txt', 'media/clip.mp4', 'audio/empty.mp3'];
    const nameBytes = names.reduce((sum, name) => sum + 2 * bytesOf(name).length, 0);
    const dataBytes = 15 + bytesOf('\uFEFF先解压\r\nExtract first\r\n').length + media.length;
    expect(zipBlob.size).toBe(headers + nameBytes + dataBytes);
  });

  it('flags names as UTF-8 and records Unix file permissions', async () => {
    const zipBlob = await buildStoredZip([{ path: 'audio/中文.mp3', data: 'x' }]);
    const view = new DataView(await zipBlob.arrayBuffer());
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0); // stored
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['audio/中文.mp3']);
    expect(zip.files['audio/中文.mp3'].unixPermissions).toBe(0o100644);
  });

  it('reads each entry a slice at a time and copies no entry Blob', async () => {
    const data = new Blob([new Uint8Array(1024)]);
    const slice = vi.spyOn(data, 'slice');
    const whole = vi.spyOn(data, 'arrayBuffer');
    await buildStoredZip([{ path: 'media/a.bin', data }]);
    expect(slice).toHaveBeenCalledTimes(1);
    expect(whole).not.toHaveBeenCalled();
  });

  it('refuses unsafe and duplicate paths', async () => {
    await expect(buildStoredZip([{ path: '../evil', data: 'x' }])).rejects.toThrow(/unsafe/);
    await expect(
      buildStoredZip([
        { path: 'a.txt', data: 'x' },
        { path: 'a.txt', data: 'y' },
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  it('refuses an archive plain ZIP fields cannot describe (4 GiB)', async () => {
    const huge = new Blob(['x']);
    Object.defineProperty(huge, 'size', { value: 0xffffffff });
    await expect(buildStoredZip([{ path: 'media/huge.mp4', data: huge }])).rejects.toThrow(/4 GiB/);
  });
});
