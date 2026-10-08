/**
 * Size limits of the standalone HTML export. App-side only (the player
 * bundle does not import this module).
 */

/**
 * Size above which the export warns about the file's size (it still saves).
 *
 * Opening is not the bottleneck: embedded media sits in data blocks the
 * browser keeps as plain text until a clip plays, and a 400 MB file opened
 * from disk reached the player in about 1.3 s in both desktop Chromium and
 * WebKit (100 MB: under 0.9 s). The limits are elsewhere: the exporting tab
 * holds the media, its base64 and the assembled document at once (roughly
 * three times the file size), a single JavaScript string cannot exceed about
 * 512 MiB in V8, mobile browsers evict tabs far earlier, and files this size
 * no longer fit mail or chat attachments. 100 MB flags the files that are
 * awkward to share while staying well clear of the hard limits.
 */
export const STANDALONE_HTML_SIZE_WARNING_BYTES = 100 * 1024 * 1024;

/**
 * Estimated size above which the single-file export is refused. The document
 * is assembled as Blob parts, so no single string limit applies; what remains
 * is the exporting tab holding the media and its base64 at once, and the
 * largest file verified to open (400 MB, see above).
 */
export const STANDALONE_HTML_MAX_BYTES = 400 * 1024 * 1024;

/**
 * The single-file export would exceed {@link STANDALONE_HTML_MAX_BYTES}. Thrown
 * before any media is encoded, so a caller can offer another format (such as
 * a page plus a media folder) instead.
 */
export class StandaloneHtmlTooLargeError extends Error {
  readonly name = 'StandaloneHtmlTooLargeError';

  constructor(readonly estimatedBytes: number) {
    super(`Standalone HTML export would be about ${Math.round(estimatedBytes / 1048576)} MB`);
  }
}
