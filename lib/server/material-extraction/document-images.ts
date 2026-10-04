/**
 * Images embedded in a document, for owner-level extraction (RFC #1716 §2).
 *
 * A document provider returns the document's text and, separately, the
 * images it found. Owner extraction keeps both: each image becomes an image
 * derivative of the source (its own pool entry, rooted under its own id), and
 * every reference in the text that names one of them is rewritten to name the
 * derivative instead of a file only the provider knew.
 *
 * ## What the providers give
 *
 * - MinerU (self-hosted and cloud) writes markdown that names images by file,
 *   `![](images/<file>)`; the parser records that file on each image
 *   (`metadata.path`), so a reference can be matched to its image. The
 *   markdown is parsed, not pattern-matched ({@link rewriteImageReferences}).
 * - The built-in PDF parser and AliDocMind return images beside text that
 *   names none of them: the images are kept, there is nothing to rewrite.
 * - Plain text and markdown uploads return no images and keep their own text.
 *
 * ## References that do not depend on the source
 *
 * A source that reuses another source's result shares its text entry (see
 * `owner-extraction.ts`), but gets derivatives of its own, with ids of its
 * own. So the stored text cannot name derivative ids. It names each kept
 * image by a key instead (`openmaic-derivative:<key>`), and each source's
 * result maps keys to its own derivatives; a reader resolves the keys of the
 * result it read ({@link resolveDerivativeRefs}).
 *
 * ## Bounds
 *
 * The same as media keyframes (`lib/document/extractors/images.ts`): at most
 * `MAX_DERIVED_IMAGES` images, in provider order, each downsampled to a WebP
 * within `MAX_DERIVED_IMAGE_BYTES`. A reference to an image that was not kept
 * -- past the limit, unreadable, or unknown to the provider -- becomes its
 * alt text, so the stored text never names a file nothing holds.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseFragment, Tokenizer, type DefaultTreeAdapterMap, type TokenHandler } from 'parse5';

import { MAX_DERIVED_IMAGES, prepareDerivedImage } from '@/lib/document/extractors/images';
import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';

import {
  decodeMediaAssetData,
  documentOutcome,
  type ExtractedSourceImage,
  type SourceExtractionOutcome,
} from './extract';

/** The link target a stored text uses for a kept image. */
export const DERIVATIVE_REF_PREFIX = 'openmaic-derivative:';
/** The link target a reader sees for one: the derivative's own material id. */
export const MATERIAL_REF_PREFIX = 'material:';

/** A target the provider resolved against its own files: no scheme, not absolute. */
function isProviderPath(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/');
}

function normalizePath(target: string): string {
  let path = target.replace(/^\.\//, '');
  try {
    path = decodeURI(path);
  } catch {
    // Keep it as written.
  }
  return path;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** One kept image: the derivative to store and the key the text names it by. */
interface KeptImage {
  key: string;
  image: ExtractedSourceImage;
}

/**
 * The document's images to keep, in provider order and within the bounds,
 * each prepared as WebP, keyed `img-<n>`. An image that cannot be decoded or
 * prepared is skipped.
 */
async function keptImages(
  artifact: DocumentArtifact,
): Promise<{ kept: Array<KeptImage & { path?: string }>; skipped: number }> {
  const candidates = artifact.assets.filter((asset) => asset.type === 'image' && asset.data);
  const kept: Array<KeptImage & { path?: string }> = [];
  let skipped = 0;
  for (const asset of candidates) {
    if (kept.length >= MAX_DERIVED_IMAGES) {
      skipped += 1;
      continue;
    }
    let prepared;
    try {
      prepared = await prepareDerivedImage(decodeMediaAssetData(asset.data!));
    } catch {
      prepared = null;
    }
    if (!prepared) {
      skipped += 1;
      continue;
    }
    const key = `img-${kept.length + 1}`;
    const path = typeof asset.metadata?.path === 'string' ? asset.metadata.path : undefined;
    kept.push({
      key,
      ...(path ? { path } : {}),
      image: {
        data: prepared.buffer.toString('base64'),
        mimeType: prepared.mime,
        title: asset.description ?? key,
        key,
        ...(asset.pageNumber ? { pageNumber: asset.pageNumber } : {}),
      },
    });
  }
  return { kept, skipped };
}

/**
 * Where each kept image's references may point: the provider's own path for
 * it first, then -- only when exactly one kept image has that file name -- its
 * bare file name, so one image's alias can never take another's path.
 */
export interface ImagePathIndex {
  exact: ReadonlyMap<string, string>;
  byBasename: ReadonlyMap<string, string>;
}

export function imagePathIndex(
  images: ReadonlyArray<{ key: string; path?: string }>,
): ImagePathIndex {
  const exact = new Map<string, string>();
  const basenames = new Map<string, Set<string>>();
  for (const { key, path } of images) {
    if (!path) continue;
    const normalized = normalizePath(path);
    if (!exact.has(normalized)) exact.set(normalized, key);
    const name = basename(normalized);
    basenames.set(name, (basenames.get(name) ?? new Set()).add(key));
  }
  // MinerU's markdown names an image `images/<file>` where its dictionary
  // says `<file>`. Add aliases only after every real path has its place.
  for (const { key, path } of images) {
    if (!path) continue;
    const normalized = normalizePath(path);
    const alias = `images/${normalized}`;
    if (!normalized.includes('/') && !exact.has(alias)) exact.set(alias, key);
  }
  const byBasename = new Map<string, string>();
  for (const [name, keys] of basenames) {
    if (keys.size === 1) byBasename.set(name, [...keys][0]!);
  }
  return { exact, byBasename };
}

function keyOf(index: ImagePathIndex, target: string): string | undefined {
  const path = normalizePath(target);
  return index.exact.get(path) ?? index.byBasename.get(basename(path));
}

/** `[`, `]` and `\\` escaped, so alt text stays alt text inside `![...]`. */
function escapeAlt(alt: string): string {
  return alt.replace(/[[\]\\]/g, (character) => `\\${character}`);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface MarkdownNode {
  type: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  value?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function span(node: MarkdownNode): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/**
 * Rewrite the image references of one markdown text. The text is parsed as
 * CommonMark, so only real image references change: an image (`![alt](x)`,
 * destinations with balanced parentheses or `<...>` included), an image
 * reference (`![alt][label]`, `![alt][]`, `![alt]`) through its definition,
 * and an `<img>` inside raw HTML. Code blocks, inline code and escaped text
 * are not image references and are left exactly as written.
 *
 * A reference to a kept image names its key; one to any other file of the
 * provider becomes its alt text. A reference image is written inline, and a
 * definition of a provider file that only images use is removed, so no
 * provider path is left behind. Remote, inline (`data:`) and absolute
 * references are kept.
 */
export function rewriteImageReferences(markdown: string, index: ImagePathIndex): string {
  return rewriteImageDestinations(markdown, (target) => {
    if (!isProviderPath(target)) return undefined;
    const key = keyOf(index, target);
    return key ? `${DERIVATIVE_REF_PREFIX}${key}` : null;
  });
}

/** Undefined leaves a destination alone; null replaces an unavailable image with its alt text. */
type RewriteImageTarget = (target: string) => string | null | undefined;
type Range = { start: number; end: number };
interface MarkdownImage extends Range {
  target: string;
  alt: string;
  title?: string | null;
  definition?: Range;
}
interface HtmlImage extends Range {
  target: string;
  alt: string;
  src: Range;
  attributePrefix: string;
  quote: string;
}
interface ImagePlan {
  markdown: MarkdownImage[];
  html: HtmlImage[];
}

function mergedRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** First merged range ending after an offset; ranges are sorted and disjoint. */
function rangeAfter(ranges: readonly Range[], offset: number): Range | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ranges[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  return ranges[low];
}

/** Keep offsets stable while excluding Markdown code and non-HTML destinations. */
function maskRanges(input: string, ranges: Range[]): string {
  let end = 0;
  const parts: string[] = [];
  for (const at of mergedRanges(ranges)) {
    parts.push(input.slice(end, at.start), ' '.repeat(at.end - at.start));
    end = at.end;
  }
  parts.push(input.slice(end));
  return parts.join('');
}

/** Parse complete HTML tags before interpreting Markdown images inside their ranges. */
function imagePlan(input: string): ImagePlan {
  const tree = fromMarkdown(input) as unknown as MarkdownNode;
  const htmlRanges: Range[] = [];
  const textRanges: Range[] = [];
  const markdownBlocks: Range[] = [];
  const rawTextTags = new Set([
    'script',
    'style',
    'textarea',
    'title',
    'xmp',
    'iframe',
    'noembed',
    'noscript',
    'plaintext',
  ]);
  const closedRawText: Range[] = [];
  const excluded: Range[] = [];
  walk(tree, (node) => {
    const at = span(node);
    if (!at) return;
    if (['paragraph', 'heading', 'html'].includes(node.type)) markdownBlocks.push(at);
    if (node.type === 'html') htmlRanges.push(at);
    else if (node.type === 'text') textRanges.push(at);
    else if (['code', 'inlineCode', 'image', 'imageReference', 'definition'].includes(node.type)) {
      excluded.push(at);
    } else if (node.type === 'link') {
      // A link label may contain real HTML; its destination and title may not.
      let end = at.start;
      for (const child of node.children ?? []) {
        const childAt = span(child);
        if (!childAt) continue;
        excluded.push({ start: end, end: childAt.start });
        end = childAt.end;
      }
      excluded.push({ start: end, end: at.end });
    }
  });

  if (input.includes('<')) {
    // CommonMark may split an unquoted HTML attribute at Markdown emphasis.
    // The HTML tokenizer locates the whole tag, including its quoted values;
    // only a tag starting in real HTML or unescaped text is admitted.
    const textSpans = mergedRanges(textRanges);
    const admittedSpans = mergedRanges([...textSpans, ...htmlRanges]);
    const rawStarts = new Map<string, Range[]>();
    const rawEnds = new Map<string, Range[]>();
    const tag =
      (closing: boolean): TokenHandler['onStartTag'] =>
      (token) => {
        const location = token.location;
        if (!location) return;
        const start = location.startOffset;
        const admitted = rangeAfter(admittedSpans, start);
        if (!admitted || admitted.start > start) return;
        let backslashes = 0;
        for (let i = start - 1; input[i] === '\\'; i -= 1) backslashes += 1;
        if (backslashes % 2 !== 0) return;
        const at = { start, end: location.endOffset };
        const textSpan = rangeAfter(textSpans, start);
        if (textSpan && textSpan.start <= start) htmlRanges.push(at);
        if (rawTextTags.has(token.tagName)) {
          const spans = closing ? rawEnds : rawStarts;
          const entries = spans.get(token.tagName) ?? [];
          entries.push(at);
          spans.set(token.tagName, entries);
        }
      };
    const noop = () => {};
    new Tokenizer(
      { sourceCodeLocationInfo: true },
      {
        onStartTag: tag(false),
        onEndTag: tag(true),
        onComment: noop,
        onDoctype: noop,
        onEof: noop,
        onCharacter: noop,
        onWhitespaceCharacter: noop,
        onNullCharacter: noop,
      },
    ).write(maskRanges(input, excluded), true);
    // Closed inline raw-text elements can span Markdown paragraphs. Keep
    // those together; only unclosed starts are bounded by their Markdown block.
    for (const [name, starts] of rawStarts) {
      const ends = rawEnds.get(name) ?? [];
      for (const at of starts) {
        const closing = rangeAfter(ends, at.end);
        if (closing) closedRawText.push({ start: at.start, end: closing.end });
      }
    }
  }

  const htmlSpans = mergedRanges(htmlRanges);
  const protectedHtml = [...htmlSpans];
  const plan: ImagePlan = { markdown: [], html: [] };
  // Raw HTML blocks already contain their full CommonMark extent, including
  // unclosed script blocks. Inline tags belong to their paragraph or heading;
  // an unclosed one must not change how the next Markdown block is read.
  const blocks = mergedRanges([...markdownBlocks, ...htmlSpans, ...closedRawText]);
  let nextHtml = 0;
  for (const block of blocks) {
    if (!htmlSpans[nextHtml] || htmlSpans[nextHtml]!.start >= block.end) continue;
    let end = block.start;
    const parts: string[] = [];
    while (htmlSpans[nextHtml] && htmlSpans[nextHtml]!.start < block.end) {
      const at = htmlSpans[nextHtml++]!;
      parts.push(' '.repeat(at.start - end), input.slice(at.start, at.end));
      end = at.end;
    }
    parts.push(' '.repeat(block.end - end));
    const visit = (node: DefaultTreeAdapterMap['node']) => {
      if ('tagName' in node && node.sourceCodeLocation) {
        const location = node.sourceCodeLocation;
        if (rawTextTags.has(node.tagName)) {
          protectedHtml.push({
            start: block.start + location.startOffset,
            end: location.endTag ? block.start + location.endOffset : block.end,
          });
        }
        if (node.tagName === 'img') {
          const src = node.attrs.find((attribute) => attribute.name === 'src');
          const at = location.attrs?.src;
          if (src && at) {
            const srcRange = {
              start: block.start + at.startOffset,
              end: block.start + at.endOffset,
            };
            const original = input.slice(srcRange.start, srcRange.end);
            const valueStart = original.indexOf('=') + 1;
            const spaces = original.slice(valueStart).match(/^\s*/)?.[0] ?? '';
            const attributePrefix = original.slice(0, valueStart + spaces.length);
            plan.html.push({
              start: block.start + location.startOffset,
              end: block.start + location.endOffset,
              target: src.value,
              alt: node.attrs.find((attribute) => attribute.name === 'alt')?.value ?? '',
              src: srcRange,
              attributePrefix,
              quote: original[attributePrefix.length] === "'" ? "'" : '"',
            });
          }
        }
      }
      if ('childNodes' in node) for (const child of node.childNodes) visit(child);
      if ('content' in node) visit(node.content);
    };
    visit(parseFragment(parts.join(''), { sourceCodeLocationInfo: true }));
  }
  const protectedSpans = mergedRanges(protectedHtml);
  const inHtml = (at: Range) => {
    const html = rangeAfter(protectedSpans, at.start);
    return html !== undefined && html.start < at.end;
  };
  const definitions = new Map<string, MarkdownNode>();
  const linkLabels = new Set<string>();
  walk(tree, (node) => {
    const at = span(node);
    if (!at || inHtml(at)) return;
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if (node.type === 'linkReference' && node.identifier) linkLabels.add(node.identifier);
  });
  walk(tree, (node) => {
    const at = span(node);
    if (!at || inHtml(at)) return;
    if (node.type === 'image' && node.url !== undefined) {
      plan.markdown.push({ ...at, target: node.url, alt: node.alt ?? '', title: node.title });
    } else if (node.type === 'imageReference' && node.identifier) {
      const definition = definitions.get(node.identifier);
      if (!definition?.url) return;
      plan.markdown.push({
        ...at,
        target: definition.url,
        alt: node.alt ?? '',
        title: definition.title,
        ...(!linkLabels.has(node.identifier) ? { definition: span(definition)! } : {}),
      });
    }
  });
  return plan;
}

function applyImagePlan(input: string, plan: ImagePlan, rewriteTarget: RewriteImageTarget): string {
  const edits: Edit[] = [];
  const definitions = new Map<number, Range>();
  const missingImage = (alt: string) => `\\[image${alt ? `: ${escapeAlt(alt)}` : ''}\\]`;
  for (const image of plan.markdown) {
    const target = rewriteTarget(image.target);
    if (target === undefined) continue;
    const title =
      image.title == null
        ? ''
        : ` "${image.title.replace(/["\\]/g, (character) => `\\${character}`)}"`;
    edits.push({
      start: image.start,
      end: image.end,
      text:
        target === null ? missingImage(image.alt) : `![${escapeAlt(image.alt)}](${target}${title})`,
    });
    if (image.definition) definitions.set(image.definition.start, image.definition);
  }
  for (const image of plan.html) {
    const target = rewriteTarget(image.target);
    if (target === undefined) continue;
    if (target === null)
      edits.push({ start: image.start, end: image.end, text: missingImage(image.alt) });
    else {
      const escaped = target.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character]!,
      );
      edits.push({
        ...image.src,
        text: `${image.attributePrefix}${image.quote}${escaped}${image.quote}`,
      });
    }
  }
  for (const at of definitions.values()) edits.push({ ...at, text: '' });
  // Join once; repeatedly slicing the partially rewritten document amplifies
  // the work by its image count even when a parsed plan has been reused.
  let end = 0;
  const parts: string[] = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    parts.push(input.slice(end, edit.start), edit.text);
    end = edit.end;
  }
  parts.push(input.slice(end));
  return parts.join('');
}

function rewriteImageDestinations(markdown: string, rewriteTarget: RewriteImageTarget): string {
  const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? markdown.slice(1) : markdown;
  return prefix + applyImagePlan(input, imagePlan(input), rewriteTarget);
}

// A cache of derived reference positions, not owner text or derivative ids.
// Callers supply an immutable text-entry/revision identity after resolving its
// bytes. Every reader still applies its own result's mapping, including reuse.
const MAX_IMAGE_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PLAN_ENTRIES = 16;
const imagePlans = new Map<string, { plan: ImagePlan; bytes: number }>();
let imagePlanBytes = 0;
function derivativeImagePlan(input: string, cacheKey?: string): ImagePlan {
  const cached = cacheKey === undefined ? undefined : imagePlans.get(cacheKey);
  if (cached) {
    imagePlans.delete(cacheKey!);
    imagePlans.set(cacheKey!, cached);
    return cached.plan;
  }
  const parsed = imagePlan(input);
  const plan = {
    markdown: parsed.markdown.filter((image) => image.target.startsWith(DERIVATIVE_REF_PREFIX)),
    html: parsed.html.filter((image) => image.target.startsWith(DERIVATIVE_REF_PREFIX)),
  };
  const size = [...plan.markdown, ...plan.html].reduce(
    (bytes, image) =>
      bytes +
      256 +
      2 *
        (image.target.length +
          image.alt.length +
          ('title' in image ? (image.title?.length ?? 0) : 0) +
          ('attributePrefix' in image ? image.attributePrefix.length : 0)),
    0,
  );
  if (cacheKey !== undefined && size <= MAX_IMAGE_PLAN_BYTES) {
    while (
      imagePlans.size >= MAX_IMAGE_PLAN_ENTRIES ||
      imagePlanBytes + size > MAX_IMAGE_PLAN_BYTES
    ) {
      const oldest = imagePlans.keys().next().value!;
      imagePlanBytes -= imagePlans.get(oldest)!.bytes;
      imagePlans.delete(oldest);
    }
    // Copy the small plan so cached substrings cannot retain a large input's
    // backing storage after its parsed tree has been discarded.
    imagePlans.set(cacheKey, { plan: structuredClone(plan), bytes: size });
    imagePlanBytes += size;
  }
  return plan;
}

/**
 * A document provider's artifact as owner extraction keeps it: the text with
 * its references rewritten, and the kept images as derivatives. The session
 * chain keeps using {@link documentOutcome}, which keeps text only.
 */
export async function ownerDocumentOutcome(
  artifact: DocumentArtifact,
  provider: DocumentExtractorProvider,
): Promise<SourceExtractionOutcome> {
  const { kept, skipped } = await keptImages(artifact);
  const index = imagePathIndex(kept);
  // Uploads decoded by plain-text have no provider-owned image paths. MinerU
  // output still needs rewriting when all of its images are missing.
  const rewritten: DocumentArtifact = {
    ...artifact,
    blocks: artifact.blocks.map((block) =>
      provider.id !== 'plain-text' && block.type === 'markdown' && block.text
        ? { ...block, text: rewriteImageReferences(block.text, index) }
        : block,
    ),
  };
  const base = documentOutcome(rewritten, provider);
  const diagnostics = [
    ...(base.stats.diagnostics ?? []),
    ...(skipped > 0
      ? [`${skipped} document image(s) not kept (limit ${MAX_DERIVED_IMAGES}, or unreadable)`]
      : []),
  ];
  return {
    ...base,
    images: kept.map(({ image }) => image),
    stats: {
      ...base.stats,
      imageCount: kept.length,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

/**
 * Resolve a stored text's keys to the derivatives of the result being read:
 * `openmaic-derivative:<key>` becomes `material:<derivative id>`. A key the
 * result does not have (it cannot happen for a text and result published
 * together) is left as it is.
 */
export function resolveDerivativeRefs(
  text: string,
  derivatives: ReadonlyArray<{ id: string; key?: string }>,
  cacheKey?: string,
): string {
  const idByKey = new Map(
    derivatives.flatMap((derivative) => (derivative.key ? [[derivative.key, derivative.id]] : [])),
  );
  if (idByKey.size === 0) return text;
  const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? text.slice(1) : text;
  return (
    prefix +
    applyImagePlan(input, derivativeImagePlan(input, cacheKey), (target) => {
      if (!target.startsWith(DERIVATIVE_REF_PREFIX)) return undefined;
      const id = idByKey.get(target.slice(DERIVATIVE_REF_PREFIX.length));
      return id ? `${MATERIAL_REF_PREFIX}${id}` : undefined;
    })
  );
}
