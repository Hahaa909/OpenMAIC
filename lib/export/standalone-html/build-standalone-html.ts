/**
 * Standalone HTML export: one `.html` file that plays the whole classroom
 * offline (slides, interactive scenes, quizzes, PBL briefings).
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
import { assembleStandaloneHtml } from './assemble';
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

/** Encode bytes as base64; works in the browser and in Node. */
export async function blobToBase64(blob: Blob): Promise<string> {
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
  return parts.join('');
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

export interface StandaloneMediaDeps {
  /** Fetch bytes for a concrete (URL) reference no archive payload backs. */
  fetchImage?: (url: string) => Promise<Blob | null>;
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
): Promise<StandaloneMediaResolution> {
  const fetchImage = deps.fetchImage ?? fetchImageBytes;
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
  const references = collectStandaloneMediaReferences(snapshot.manifest);
  await mapWithConcurrency(references, 4, async ({ ref, role }) => {
    if (role === 'video') {
      const poster = snapshot.videoPosters.get(ref);
      if (poster) videoPosters.set(ref, await blobToDataUri(poster, 'image/jpeg'));
      // Video bytes are present only when the snapshot collected them.
      const path = pathByRef.get(ref);
      if (path && isPlayableArchivePath(snapshot, path, 'video/')) videos.set(ref, path);
      return;
    }
    const dataUri = await resolveRef(ref);
    if (dataUri) dataUris.set(ref, dataUri);
  });

  const audio = new Set<string>();
  for (const [path, entry] of Object.entries(snapshot.manifest.mediaIndex)) {
    if (entry.type === 'audio' && !entry.missing && isPlayableArchivePath(snapshot, path)) {
      audio.add(path);
    }
  }
  return { dataUris, videoPosters, playback: { audio, videos } };
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
): StandalonePlaybackPayload[] {
  const payloads: StandalonePlaybackPayload[] = [];
  for (const key of paths) {
    const blob = snapshot.files.get(key);
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

/** UTF-8 length of a string without materializing its encoding. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
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
}

export interface StandaloneHtmlExport {
  html: string;
  fileName: string;
  inlineFailures: InlineReport['failed'];
  /** Media references that could not be embedded and were dropped. */
  unresolvedMedia: string[];
  /** Narration referenced by the classroom whose bytes resolved nowhere. */
  missingAudioCount: number;
  /** Size of the encoded file in bytes (UTF-8). */
  byteSize: number;
}

export async function buildStandaloneHtmlExport(
  stage: Stage,
  scenes: Scene[],
  options: StandaloneHtmlExportOptions,
): Promise<StandaloneHtmlExport> {
  const fetchAsset = options.fetchAsset ?? fetchPlayerAsset;
  const includeNarration = options.includeNarration === true;
  // Without narration, skip collecting audio and video bytes altogether
  // (posters captured for generated videos are still collected).
  const snapshot = await buildClassroomExportSnapshot(stage, scenes, options.documentDeps, {
    audio: includeNarration,
    videoBytes: includeNarration,
  });
  const media = await resolveStandaloneMedia(snapshot, options);
  const { manifest, unresolved, playbackMedia } = prepareStandaloneManifest(
    snapshot.manifest,
    media,
  );
  const embeddedMedia = await Promise.all(
    collectStandalonePlaybackPayloads(snapshot, playbackMedia).map(
      async ({ key, mimeType, blob }) => ({ key, mimeType, base64: await blobToBase64(blob) }),
    ),
  );

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
  const html = assembleStandaloneHtml({
    manifest,
    config,
    playerScript,
    playerStyle,
    extraStyles: mathFonts ? [mathFonts] : [],
    extraScripts: chartsScript ? [chartsScript] : [],
    embeddedMedia,
    lang: options.lang,
  });

  return {
    html,
    fileName: `${classroomExportBaseName(snapshot.stageName)}${STANDALONE_HTML_EXTENSION}`,
    inlineFailures: snapshot.inlineFailures,
    unresolvedMedia: unresolved,
    missingAudioCount: snapshot.missingAudioCount,
    byteSize: utf8ByteLength(html),
  };
}
