/**
 * Standalone HTML export: one `.html` file that plays the whole classroom
 * offline (slides, interactive scenes, quizzes, PBL briefings). A classroom
 * too large for one file is exported as a ZIP instead: `classroom.html` plus
 * the narration and video files it plays by relative path.
 *
 * The data is the classroom ZIP's export snapshot (one serializer for both
 * formats); this layer resolves the referenced media to `data:` URIs, fetches
 * the player assets that the app build precompiled into `public/`, and hands
 * everything to the pure assembler. No bundler runs at export time.
 */
import type { Scene, Stage } from '@/lib/types/stage';
import type { DocumentMigrationDeps } from '@/lib/document-store';
import { fetchMediaUrl } from '@/lib/media/fetch-media-url';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { mapWithConcurrency } from '@/lib/utils/concurrency';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import {
  buildClassroomExportSnapshot,
  classroomExportBaseName,
  type ClassroomExportSnapshot,
} from '../use-export-classroom';
import type { InlineReport } from '../inline-assets';
import type { ClassroomManifest } from '../classroom-zip-types';
import {
  assembleStandaloneHtmlParts,
  serializeJsonForHtmlScript,
  type StandaloneEmbeddedMedia,
  type StandaloneHtmlInput,
} from './assemble';
import { STANDALONE_HTML_MAX_BYTES, StandaloneHtmlTooLargeError } from './limits';
import { buildStoredZip, isSafeArchivePath, STORED_ZIP_MAX_BYTES } from './stored-zip';
import {
  STANDALONE_PLAYER_ASSETS,
  type StandalonePlayerConfig,
  type StandalonePlayerStrings,
} from './contract';
import {
  collectStandaloneMediaReferences,
  prepareStandaloneManifest,
  type StandaloneMediaResolution,
} from './prepare-manifest';

export const STANDALONE_HTML_EXTENSION = '.html';
export const STANDALONE_ZIP_EXTENSION = '.zip';

/** The page inside the ZIP variant; its media sits next to it under the payload keys. */
export const STANDALONE_ZIP_PAGE_NAME = 'classroom.html';
export const STANDALONE_ZIP_README_NAME = 'README.txt';

/**
 * English instructions shipped in every ZIP's README (after the UI locale's
 * own, when that is not English). Mirrors `export.htmlZipReadme` in en-US.
 */
export const STANDALONE_ZIP_README_EN =
  'Extract this whole ZIP file first, then open classroom.html in a web browser. Keep the audio and media folders next to classroom.html: the page plays its narration and video from them. Opened from inside the ZIP without extracting, the page cannot find them and plays without sound or video.';

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function imageMimeFromUrl(url: string): string | undefined {
  const path = url.split(/[?#]/)[0] ?? '';
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTENSION_MIME[extension];
}

/**
 * Encode bytes as base64 pieces that concatenate into one valid string; works
 * in the browser and in Node. Kept as pieces so a large clip never has to be
 * held as one giant string.
 */
export async function blobToBase64Parts(blob: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Encoded in chunks (a multiple of 3 bytes, so the pieces concatenate into
  // one valid string) to keep the intermediate binary strings small for
  // multi-megabyte media.
  const parts: string[] = [];
  const chunk = 0x8000 * 3;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk);
    let binary = '';
    for (let index = 0; index < slice.length; index += 0x8000) {
      binary += String.fromCharCode(...slice.subarray(index, index + 0x8000));
    }
    parts.push(btoa(binary));
  }
  return parts;
}

/** Encode bytes as base64; works in the browser and in Node. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return (await blobToBase64Parts(blob)).join('');
}

/** Encode bytes as a `data:` URI; works in the browser and in Node. */
export async function blobToDataUri(blob: Blob, fallbackMimeType?: string): Promise<string> {
  const mimeType = blob.type || fallbackMimeType || 'application/octet-stream';
  return `data:${mimeType};base64,${await blobToBase64(blob)}`;
}

/** Fetch a concrete image URL through the app's media fetch path; `null` on any failure. */
async function fetchImageBytes(url: string): Promise<Blob | null> {
  try {
    const response = await fetchMediaUrl(url, 15_000);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    if (blob.type.startsWith('image/')) return blob;
    const guessed = imageMimeFromUrl(url);
    return guessed ? new Blob([blob], { type: guessed }) : null;
  } catch {
    return null;
  }
}

const VIDEO_EXTENSION_MIME: Record<string, string> = {
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
};

function urlExtension(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

/** Fetch a concrete video URL through the app's media fetch path; `null` on any failure. */
async function fetchVideoBytes(url: string): Promise<Blob | null> {
  try {
    const response = await fetchMediaUrl(url, 15_000);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    if (blob.type.startsWith('video/')) return blob;
    const guessed = VIDEO_EXTENSION_MIME[urlExtension(url)];
    return guessed ? new Blob([blob], { type: guessed }) : null;
  } catch {
    return null;
  }
}

export interface StandaloneMediaDeps {
  /** Fetch bytes for a concrete (URL) image reference no archive payload backs. */
  fetchImage?: (url: string) => Promise<Blob | null>;
  /** Fetch bytes for a concrete (URL) video source no archive payload backs. */
  fetchVideo?: (url: string) => Promise<Blob | null>;
}

export interface StandaloneMediaOptions {
  /**
   * Resolve playback media (narration and video bytes) too. Without it the
   * resolution carries no `playback` and the file plays without media.
   */
  playbackMedia?: boolean;
}

/**
 * Resolve every displayed media reference of the snapshot to a `data:` URI:
 * archive payloads first (matched through the media index's `sourceRef`), then
 * concrete URLs fetched now. Whatever resolves nowhere is dropped by
 * {@link prepareStandaloneManifest} and reported back.
 */
export async function resolveStandaloneMedia(
  snapshot: Pick<ClassroomExportSnapshot, 'manifest' | 'files' | 'videoPosters'>,
  deps: StandaloneMediaDeps = {},
  options: StandaloneMediaOptions = {},
): Promise<StandaloneMediaResolution> {
  const fetchImage = deps.fetchImage ?? fetchImageBytes;
  const fetchVideo = deps.fetchVideo ?? fetchVideoBytes;
  const pathByRef = new Map<string, string>();
  for (const [path, entry] of Object.entries(snapshot.manifest.mediaIndex)) {
    if (entry.sourceRef && !entry.missing && entry.type !== 'audio') {
      pathByRef.set(entry.sourceRef, path);
    }
  }

  // One resolution per ref, shared by every slot that names it, so a ref used
  // as both an image and a background is fetched once.
  const pending = new Map<string, Promise<string | undefined>>();
  const resolveRef = (ref: string): Promise<string | undefined> => {
    let resolution = pending.get(ref);
    if (!resolution) {
      resolution = (async () => {
        const path = pathByRef.get(ref);
        const archived = path ? snapshot.files.get(path) : undefined;
        if (archived && archived.size > 0) {
          return blobToDataUri(
            archived,
            path ? snapshot.manifest.mediaIndex[path]?.mimeType : undefined,
          );
        }
        if (!isConcreteMediaAddress(ref)) return undefined;
        const fetched = await fetchImage(ref);
        return fetched ? blobToDataUri(fetched) : undefined;
      })();
      pending.set(ref, resolution);
    }
    return resolution;
  };

  const dataUris = new Map<string, string>();
  const videoPosters = new Map<string, string>();
  const videos = new Map<string, string>();
  const fetchedVideos = new Map<string, Blob>();
  const references = collectStandaloneMediaReferences(snapshot.manifest);
  await mapWithConcurrency(references, 4, async ({ ref, role }) => {
    if (role === 'video') {
      const poster = snapshot.videoPosters.get(ref);
      if (poster) videoPosters.set(ref, await blobToDataUri(poster, 'image/jpeg'));
      if (!options.playbackMedia) return;
      // Generated and stored videos come with the snapshot; a direct video
      // URL no stored row backs is fetched now, like images.
      const path = pathByRef.get(ref);
      if (path && isPlayableArchivePath(snapshot, path, 'video/')) {
        videos.set(ref, path);
      } else if (!path && isConcreteMediaAddress(ref)) {
        const fetched = await fetchVideo(ref);
        if (fetched) {
          const extension = VIDEO_EXTENSION_MIME[urlExtension(ref)] ? urlExtension(ref) : 'mp4';
          const key = `media/linked-${fetchedVideos.size + 1}.${extension}`;
          fetchedVideos.set(key, fetched);
          videos.set(ref, key);
        }
      }
      return;
    }
    const dataUri = await resolveRef(ref);
    if (dataUri) dataUris.set(ref, dataUri);
  });

  if (!options.playbackMedia) return { dataUris, videoPosters };
  const audio = new Set<string>();
  for (const [path, entry] of Object.entries(snapshot.manifest.mediaIndex)) {
    if (entry.type === 'audio' && !entry.missing && isPlayableArchivePath(snapshot, path)) {
      audio.add(path);
    }
  }
  return { dataUris, videoPosters, playback: { audio, videos, files: fetchedVideos } };
}

/** Whether the snapshot carries non-empty bytes at `path` (of the given MIME family). */
function isPlayableArchivePath(
  snapshot: Pick<ClassroomExportSnapshot, 'manifest' | 'files'>,
  path: string,
  mimePrefix?: string,
): boolean {
  const blob = snapshot.files.get(path);
  if (!blob || blob.size === 0) return false;
  if (!mimePrefix) return true;
  const mimeType = snapshot.manifest.mediaIndex[path]?.mimeType || blob.type;
  return mimeType.startsWith(mimePrefix);
}

/** One playback media payload: its key (archive path), MIME type and bytes. */
export interface StandalonePlaybackPayload {
  key: string;
  mimeType: string;
  blob: Blob;
}

/**
 * The bytes of the playback media a prepared manifest names, read from the
 * snapshot. Format-neutral: the single file embeds them, and an export that
 * ships a `media/` folder next to the page can write the same payloads.
 */
export function collectStandalonePlaybackPayloads(
  snapshot: Pick<ClassroomExportSnapshot, 'manifest' | 'files'>,
  paths: readonly string[],
  media?: Pick<StandaloneMediaResolution, 'playback'>,
): StandalonePlaybackPayload[] {
  const payloads: StandalonePlaybackPayload[] = [];
  for (const key of paths) {
    const blob = snapshot.files.get(key) ?? media?.playback?.files?.get(key);
    if (!blob || blob.size === 0) continue;
    const mimeType =
      snapshot.manifest.mediaIndex[key]?.mimeType || blob.type || 'application/octet-stream';
    payloads.push({ key, mimeType, blob });
  }
  return payloads;
}

/**
 * The online classroom address PBL scenes link to ("Continue this project
 * online"). A classroom is readable by anyone holding its link, so the
 * address is always offered; the file needs no lookup to build it.
 */
export function classroomUrlFor(origin: string, stageId: string): string {
  return `${origin.replace(/\/+$/, '')}/classroom/${encodeURIComponent(stageId)}`;
}

function hasQuizMath(text: string | undefined): boolean {
  return !!text && renderQuizMathText(text).some((segment) => segment.type === 'math');
}

/**
 * Whether the classroom shows math, so the KaTeX fonts must ship: a slide
 * carrying KaTeX markup, or quiz text the player renders as math (the same
 * `renderQuizMathText` decides it in both places).
 */
function needsMathFonts(manifest: ClassroomManifest): boolean {
  return manifest.scenes.some((scene) => {
    const content = scene.content;
    if (content.type === 'slide') return JSON.stringify(content.canvas).includes('katex');
    if (content.type !== 'quiz') return false;
    return (content.questions ?? []).some(
      (question) =>
        hasQuizMath(question.question) ||
        hasQuizMath(question.analysis) ||
        (question.answer ?? []).some(hasQuizMath) ||
        (question.options ?? []).some((option) => hasQuizMath(option.label)),
    );
  });
}

/** Whether any slide has a chart element, so the charts runtime must ship. */
function needsCharts(manifest: ClassroomManifest): boolean {
  return manifest.scenes.some(
    (scene) =>
      scene.content.type === 'slide' &&
      (scene.content.canvas.elements ?? []).some((element) => element.type === 'chart'),
  );
}

async function fetchPlayerAsset(path: string): Promise<string> {
  // `no-cache` revalidates, so an upgraded deployment never pairs a stale
  // player with a newer manifest.
  const response = await fetch(`/${path}`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Standalone player asset unavailable: /${path} (HTTP ${response.status})`);
  }
  return response.text();
}

export interface StandaloneHtmlExportOptions extends StandaloneMediaDeps {
  strings: StandalonePlayerStrings;
  /**
   * Embed narration audio (stored and legacy URL narration) and video clips
   * so the file plays like the classroom. Without it the file stays small:
   * speech plays on the reading timer with captions and videos show their
   * poster frame. Defaults to false.
   */
  includeNarration?: boolean;
  lang: string;
  /**
   * Address of the online classroom (see {@link classroomUrlFor}). PBL scenes
   * link to it; when absent, the link is omitted.
   */
  classroomUrl?: string;
  /** Document-store dependencies, forwarded to the snapshot. */
  documentDeps?: DocumentMigrationDeps;
  /** Loads a precompiled player asset by its public path. */
  fetchAsset?: (path: string) => Promise<string>;
  /** Size ceiling of the single file; defaults to {@link STANDALONE_HTML_MAX_BYTES}. */
  maxBytes?: number;
  /**
   * - `html` (default): one self-contained file; throws
   *   {@link StandaloneHtmlTooLargeError} above `maxBytes`.
   * - `zip`: a ZIP of `classroom.html` and the media files it plays by
   *   relative path.
   * - `auto`: the single file, or the ZIP when the single file would exceed
   *   `maxBytes`.
   */
  format?: 'html' | 'zip' | 'auto';
  /**
   * README text of the ZIP variant in the UI locale; the English text
   * ({@link STANDALONE_ZIP_README_EN}) always follows it.
   */
  zipReadme?: string;
  /** Timestamp of the ZIP entries; defaults to now. */
  zipDate?: Date;
}

export interface StandaloneHtmlExport {
  /** Which format was built (`zip` also when `auto` fell back to it). */
  format: 'html' | 'zip';
  /** The document, or the ZIP; assembled from parts (no single giant string). */
  blob: Blob;
  fileName: string;
  inlineFailures: InlineReport['failed'];
  /** Media references that could not be embedded and were dropped. */
  unresolvedMedia: string[];
  /** Narration referenced by the classroom whose bytes resolved nowhere. */
  missingAudioCount: number;
  /** Size of the file in bytes. */
  byteSize: number;
  /**
   * When `auto` built the ZIP: the size the single file would have had
   * (estimated, or exact when only the assembled document passed the ceiling).
   */
  singleFileBytes?: number;
}

/**
 * Size the single file will have, estimated before any media is encoded:
 * base64 grows the media by 4/3; the manifest (with the images already
 * inlined) counts as its escaped UTF-8 bytes, plus the player assets' typical
 * size. The assembled file is checked again, exactly, before it is returned.
 */
export function estimateStandaloneHtmlBytes(
  manifest: ClassroomManifest,
  payloads: readonly { blob: Blob }[],
): number {
  const media = payloads.reduce((sum, payload) => sum + Math.ceil(payload.blob.size / 3) * 4, 0);
  // The manifest as the document will carry it: escaped for its script
  // element and encoded as UTF-8.
  const manifestBytes = new Blob([serializeJsonForHtmlScript(manifest)]).size;
  return media + manifestBytes + PLAYER_ASSETS_ESTIMATE_BYTES;
}

/** Rough size of the inlined player script and styles. */
const PLAYER_ASSETS_ESTIMATE_BYTES = 1024 * 1024;

export async function buildStandaloneHtmlExport(
  stage: Stage,
  scenes: Scene[],
  options: StandaloneHtmlExportOptions,
): Promise<StandaloneHtmlExport> {
  const fetchAsset = options.fetchAsset ?? fetchPlayerAsset;
  const includeNarration = options.includeNarration === true;
  // Without narration, skip collecting audio and video bytes altogether
  // (posters captured for generated videos are still collected).
  // Slide audio elements are never played offline, so their bytes are not
  // collected (or counted as missing) either; without narration, interactive
  // pages do not fetch their clips.
  const snapshot = await buildClassroomExportSnapshot(stage, scenes, options.documentDeps, {
    audio: includeNarration,
    videoBytes: includeNarration,
    audioElements: false,
    interactiveMedia: includeNarration,
  });
  const media = await resolveStandaloneMedia(snapshot, options, {
    playbackMedia: includeNarration,
  });
  const { manifest, unresolved, playbackMedia } = prepareStandaloneManifest(
    snapshot.manifest,
    media,
  );
  const payloads = collectStandalonePlaybackPayloads(snapshot, playbackMedia, media);
  const maxBytes = options.maxBytes ?? STANDALONE_HTML_MAX_BYTES;
  const requested = options.format ?? 'html';
  const estimatedBytes = estimateStandaloneHtmlBytes(manifest, payloads);
  let singleFileBytes: number | undefined;
  if (requested !== 'zip' && estimatedBytes > maxBytes) {
    if (requested === 'html') throw new StandaloneHtmlTooLargeError(estimatedBytes);
    singleFileBytes = estimatedBytes;
  }

  const [playerScript, playerStyle, mathFonts, chartsScript] = await Promise.all([
    fetchAsset(STANDALONE_PLAYER_ASSETS.script),
    fetchAsset(STANDALONE_PLAYER_ASSETS.style),
    needsMathFonts(manifest) ? fetchAsset(STANDALONE_PLAYER_ASSETS.mathFonts) : undefined,
    needsCharts(manifest) ? fetchAsset(STANDALONE_PLAYER_ASSETS.charts) : undefined,
  ]);
  const config: StandalonePlayerConfig = {
    strings: options.strings,
    ...(options.classroomUrl ? { classroomUrl: options.classroomUrl } : {}),
  };
  const page: Omit<StandaloneHtmlInput, 'embeddedMedia' | 'linkedMedia'> = {
    manifest,
    config,
    playerScript,
    playerStyle,
    extraStyles: mathFonts ? [mathFonts] : [],
    extraScripts: chartsScript ? [chartsScript] : [],
    lang: options.lang,
  };
  const baseName = classroomExportBaseName(snapshot.stageName);
  const report = {
    inlineFailures: snapshot.inlineFailures,
    unresolvedMedia: unresolved,
    missingAudioCount: snapshot.missingAudioCount,
  };

  if (requested !== 'zip' && singleFileBytes === undefined) {
    // One clip at a time, so only one clip's base64 is being produced at once.
    const embeddedMedia: StandaloneEmbeddedMedia[] = [];
    for (const { key, mimeType, blob } of payloads) {
      embeddedMedia.push({ key, mimeType, base64: await blobToBase64Parts(blob) });
    }
    const blob = new Blob(assembleStandaloneHtmlParts({ ...page, embeddedMedia }), {
      type: 'text/html;charset=utf-8',
    });
    // The estimate is a guard, not a measurement: the ceiling holds exactly.
    if (blob.size <= maxBytes) {
      return {
        format: 'html',
        blob,
        fileName: `${baseName}${STANDALONE_HTML_EXTENSION}`,
        ...report,
        byteSize: blob.size,
      };
    }
    if (requested === 'html') throw new StandaloneHtmlTooLargeError(blob.size);
    singleFileBytes = blob.size;
  }

  const blob = await buildStandaloneZip(page, payloads, options);
  return {
    format: 'zip',
    blob,
    fileName: `${baseName}${STANDALONE_ZIP_EXTENSION}`,
    ...report,
    byteSize: blob.size,
    ...(singleFileBytes !== undefined ? { singleFileBytes } : {}),
  };
}

/** Relative URL of a payload key (an archive path such as `media/clip.mp4`). */
export function linkedMediaSrc(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** README of the ZIP variant: the UI locale's text, then the English one. */
export function standaloneZipReadme(localized?: string): string {
  const texts = [localized?.trim(), STANDALONE_ZIP_README_EN].filter(
    (text, index, all): text is string => !!text && all.indexOf(text) === index,
  );
  // A BOM and CRLF line ends, so every text editor (Windows Notepad included)
  // shows the text as UTF-8 with its paragraphs.
  return `\uFEFF${texts.join('\r\n\r\n')}\r\n`;
}

/**
 * The ZIP variant: `classroom.html` (the player and manifest, media
 * referenced by relative path), each payload at its key, and a README. The
 * media is stored as is, and the archive Blob references the payload Blobs,
 * so building it copies no media.
 */
export async function buildStandaloneZip(
  page: Omit<StandaloneHtmlInput, 'embeddedMedia' | 'linkedMedia'>,
  payloads: readonly StandalonePlaybackPayload[],
  options: Pick<StandaloneHtmlExportOptions, 'zipReadme' | 'zipDate'>,
): Promise<Blob> {
  const reserved = new Set([STANDALONE_ZIP_PAGE_NAME, STANDALONE_ZIP_README_NAME]);
  for (const { key } of payloads) {
    if (!isSafeArchivePath(key) || reserved.has(key)) {
      throw new Error(`Standalone ZIP: unusable media path ${JSON.stringify(key)}`);
    }
  }
  const html = new Blob(
    assembleStandaloneHtmlParts({
      ...page,
      linkedMedia: payloads.map(({ key, mimeType }) => ({
        key,
        mimeType,
        src: linkedMediaSrc(key),
      })),
    }),
    { type: 'text/html;charset=utf-8' },
  );
  const readme = standaloneZipReadme(options.zipReadme);
  // Checked before any CRC is computed. Headers add well under 1 KB per entry.
  const contentBytes =
    html.size +
    new Blob([readme]).size +
    payloads.reduce((sum, { blob }) => sum + blob.size, 0) +
    (payloads.length + 2) * 1024;
  if (contentBytes > STORED_ZIP_MAX_BYTES) throw new StandaloneHtmlTooLargeError(contentBytes);
  return buildStoredZip(
    [
      { path: STANDALONE_ZIP_PAGE_NAME, data: html },
      { path: STANDALONE_ZIP_README_NAME, data: readme },
      ...payloads.map(({ key, blob }) => ({ path: key, data: blob })),
    ],
    { date: options.zipDate },
  );
}
