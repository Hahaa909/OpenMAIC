/**
 * Inline formulas in prose HTML, kept across sanitization.
 *
 * The slide text editor stores an inline formula as a rendered KaTeX tree
 * (`<span class="katex" data-inline-math="LATEX">`, with hidden MathML, layout
 * SVG and positioned spans) inside the prose HTML. The prose policy cannot
 * allow that markup without allowing far more than prose needs, so formulas
 * are carried through sanitization as source only:
 *
 *   1. `liftInlineMath` replaces each formula element with an empty
 *      `<span data-inline-math>` holding just its LaTeX source;
 *   2. the caller sanitizes the result with `data-inline-math` allowed on
 *      `span`;
 *   3. `renderInlineMath` replaces every surviving source span with a fresh
 *      KaTeX render of the source it reads back from the sanitized tree.
 *
 * KaTeX's generated markup is the only markup added after sanitizing; nothing
 * authored is re-inserted. The source is read and written as an attribute of
 * a parsed tree and never spliced into strings, so it stays inert text. Step 1
 * is capture, not a security boundary: whatever it emits still goes through
 * the sanitizer.
 *
 * Rendering is bounded: KaTeX output is ~100-150x the size of its source, and
 * this runs synchronously on every persistence read and write. A formula over
 * the per-formula limit, or past the per-call budget, is kept as a source span
 * showing its LaTeX as text instead of a render, so nothing is lost and the
 * editor still recovers it. Limits count source characters in document order,
 * never time, so the same input always renders the same formulas and repeated
 * read/write passes stay stable.
 *
 * Uses `parse5` (a spec-compliant parser with no DOM dependency) so the same
 * code runs at the server persistence boundary and in the browser export.
 */
import katex from 'katex';
import { safeKatexOptions } from '@openmaic/dsl';
import {
  defaultTreeAdapter,
  html as parse5Html,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from 'parse5';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

export const INLINE_MATH_ATTRIBUTE = 'data-inline-math';

const HTML_NAMESPACE = parse5Html.NS.HTML;

/**
 * Cheap pre-check: a formula is either a `data-inline-math` attribute or a
 * KaTeX root with an `<annotation>` element. Names cannot be written as
 * character references (unlike the `katex` class value), so prose without
 * either word cannot contain a formula and the parse is skipped.
 * Case-insensitive because the HTML parser lowercases names.
 */
const MAY_CONTAIN_INLINE_MATH = /data-inline-math|annotation/i;

/**
 * Longest source rendered, in characters. Inline formulas are short (the
 * longest in the repo's fixtures is under 30 characters); 2000 leaves room for
 * matrices and aligned expressions while keeping one worst-case render (flat
 * `x+x+…`, ~290 KB of markup) to tens of milliseconds.
 */
export const MAX_INLINE_MATH_SOURCE = 2_000;

/**
 * Rendering budget per sanitize call (one stage, scene or scene list). Cost
 * tracks source size (markup is ~100-150x the source for typical and
 * worst-case input alike), so the budget is in source characters, plus a
 * formula count for the fixed per-formula cost. 16 000 characters / 1 000
 * formulas holds a 40-slide course with 600 typical formulas (~12 000
 * characters) and caps a hostile payload at well under a second per pass.
 */
export const INLINE_MATH_SOURCE_BUDGET = 16_000;

/** Formulas rendered per sanitize call. */
export const INLINE_MATH_COUNT_BUDGET = 1_000;

/** What is left to render in one sanitize call. */
export interface InlineMathBudget {
  sourceChars: number;
  formulas: number;
}

export function createInlineMathBudget(): InlineMathBudget {
  return { sourceChars: INLINE_MATH_SOURCE_BUDGET, formulas: INLINE_MATH_COUNT_BUDGET };
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value ?? null;
}

function hasClass(element: Element, name: string): boolean {
  return (attribute(element, 'class') ?? '').split(/[\t\n\f\r ]+/).includes(name);
}

function isHtmlSpan(node: ChildNode): node is Element {
  return (
    defaultTreeAdapter.isElementNode(node) &&
    node.tagName === 'span' &&
    node.namespaceURI === HTML_NAMESPACE
  );
}

/** Text content of a subtree (template contents excluded, as in the DOM). */
function textContent(node: ParentNode): string {
  let text = '';
  for (const child of node.childNodes) {
    if (defaultTreeAdapter.isTextNode(child)) text += child.value;
    else if (defaultTreeAdapter.isElementNode(child)) text += textContent(child);
  }
  return text;
}

/** The first `annotation[encoding="application/x-tex"]` in a subtree, depth-first. */
function texAnnotation(node: ParentNode): string | null {
  for (const child of node.childNodes) {
    if (!defaultTreeAdapter.isElementNode(child)) continue;
    if (child.tagName === 'annotation' && attribute(child, 'encoding') === 'application/x-tex') {
      return textContent(child);
    }
    const found = texAnnotation(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The LaTeX source of an inline-formula element, or `null` for anything else.
 * Mirrors the editor's parse rules: `span[data-inline-math]`, else a
 * `span.katex` with a non-empty TeX annotation.
 */
function inlineMathSource(element: Element): string | null {
  const source = attribute(element, INLINE_MATH_ATTRIBUTE);
  if (source !== null) return source;
  if (!hasClass(element, 'katex')) return null;
  return texAnnotation(element) || null;
}

/** Replace `node` in its parent with `replacement`. */
function replaceNode(node: ChildNode, replacement: ChildNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  defaultTreeAdapter.insertBefore(parent, replacement, node);
  defaultTreeAdapter.detachNode(node);
}

/** An empty `<span data-inline-math>` carrying only the source. */
function sourceSpan(latex: string): Element {
  return defaultTreeAdapter.createElement('span', HTML_NAMESPACE, [
    { name: INLINE_MATH_ATTRIBUTE, value: latex },
  ]);
}

/** A source span that also shows its LaTeX as text, for a formula left unrendered. */
function unrenderedSpan(latex: string): Element {
  const span = sourceSpan(latex);
  if (latex) defaultTreeAdapter.insertText(span, latex);
  return span;
}

/**
 * Visit every element in document order, template contents included (the
 * sanitizer drops the template tag but keeps its permitted children). The
 * visitor returns a replacement to stop descending into that element.
 */
function walk(parent: ParentNode, visit: (element: Element) => ChildNode | null): void {
  for (const child of [...parent.childNodes]) {
    if (!defaultTreeAdapter.isElementNode(child)) continue;
    const replacement = visit(child);
    if (replacement) {
      replaceNode(child, replacement);
      continue;
    }
    walk(child, visit);
    if ('content' in child) walk(child.content, visit);
  }
}

/**
 * Pre-sanitize pass: replace every inline-formula element with an empty
 * source-only span. Returns `null` when the prose holds no formula, so the
 * caller can sanitize the original string unchanged.
 */
export function liftInlineMath(html: string): string | null {
  if (!MAY_CONTAIN_INLINE_MATH.test(html)) return null;
  const fragment = parseFragment(html);
  let lifted = false;
  walk(fragment, (element) => {
    if (!isHtmlSpan(element)) return null;
    const latex = inlineMathSource(element);
    if (latex === null) return null;
    lifted = true;
    return sourceSpan(latex);
  });
  return lifted ? serialize(fragment) : null;
}

/**
 * Rendered formulas by source. Every persistence read and write re-renders
 * stored formulas, and the same source recurs across reads, so renders are
 * kept (least recently used first out) and cloned on use. Bounded by the size
 * of their markup; large renders are never kept.
 */
const RENDER_CACHE_MAX_MARKUP = 1_000_000;
const RENDER_CACHE_MAX_ENTRY = 32_000;

interface CachedRender {
  readonly root: Element | null;
  readonly size: number;
}

const renderCache = new Map<string, CachedRender>();
let renderCacheSize = 0;

/** Markup characters currently held by the render cache (for tests). */
export function inlineMathCacheSize(): number {
  return renderCacheSize;
}

/** A deep copy of a generated KaTeX subtree (elements and text only). */
function cloneRender(element: Element): Element {
  const copy = defaultTreeAdapter.createElement(
    element.tagName,
    element.namespaceURI,
    element.attrs.map((attr) => ({ ...attr })),
  );
  for (const child of element.childNodes) {
    if (defaultTreeAdapter.isElementNode(child)) {
      defaultTreeAdapter.appendChild(copy, cloneRender(child));
    } else if (defaultTreeAdapter.isTextNode(child)) {
      defaultTreeAdapter.insertText(copy, child.value);
    }
  }
  return copy;
}

/** A fresh, inert KaTeX render of one inline formula, or `null` if KaTeX fails. */
function renderFormulaUncached(latex: string): CachedRender {
  let markup: string;
  try {
    markup = katex.renderToString(
      latex,
      safeKatexOptions({
        displayMode: false,
        output: 'html',
        throwOnError: false,
        strict: 'ignore',
      }),
    );
  } catch {
    return { root: null, size: 0 };
  }
  const root = parseFragment(markup).childNodes.find(defaultTreeAdapter.isElementNode) ?? null;
  if (root) {
    // The editor's storage shape: the KaTeX root carries the source.
    root.attrs = root.attrs.filter((attr) => attr.name !== INLINE_MATH_ATTRIBUTE);
    root.attrs.push({ name: INLINE_MATH_ATTRIBUTE, value: latex });
  }
  return { root, size: markup.length + latex.length };
}

function renderFormula(latex: string): Element | null {
  let render = renderCache.get(latex);
  if (render) {
    // Refresh recency.
    renderCache.delete(latex);
    renderCache.set(latex, render);
  } else {
    render = renderFormulaUncached(latex);
    if (render.size <= RENDER_CACHE_MAX_ENTRY) {
      renderCache.set(latex, render);
      renderCacheSize += render.size;
      for (const [key, entry] of renderCache) {
        if (renderCacheSize <= RENDER_CACHE_MAX_MARKUP) break;
        renderCache.delete(key);
        renderCacheSize -= entry.size;
      }
    }
  }
  return render.root && cloneRender(render.root);
}

/**
 * Post-sanitize pass: replace each source span with a generated render of its
 * source, within `budget` (shared by every prose string of one sanitize
 * call). Anything else in the sanitized prose is left as parsed.
 */
export function renderInlineMath(
  sanitizedHtml: string,
  budget: InlineMathBudget = createInlineMathBudget(),
): string {
  if (!sanitizedHtml.includes(INLINE_MATH_ATTRIBUTE)) return sanitizedHtml;
  const fragment = parseFragment(sanitizedHtml);
  walk(fragment, (element) => {
    if (!isHtmlSpan(element)) return null;
    const latex = attribute(element, INLINE_MATH_ATTRIBUTE);
    if (latex === null) return null;
    if (!latex.trim()) return sourceSpan(latex);
    if (
      latex.length > MAX_INLINE_MATH_SOURCE ||
      latex.length > budget.sourceChars ||
      budget.formulas < 1
    ) {
      return unrenderedSpan(latex);
    }
    budget.sourceChars -= latex.length;
    budget.formulas -= 1;
    // KaTeX failing outright: keep the source, as the editor does.
    return renderFormula(latex) ?? unrenderedSpan(latex);
  });
  return serialize(fragment);
}
