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
 * Cheap pre-check: prose without either word cannot contain a formula, so the
 * parse is skipped. Case-insensitive because the HTML parser lowercases
 * attribute names.
 */
const MAY_CONTAIN_INLINE_MATH = /data-inline-math|katex/i;

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
 * kept (bounded, least recently used first out) and cloned on use.
 */
const RENDER_CACHE_LIMIT = 256;
const renderCache = new Map<string, Element | null>();

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

/** A fresh, inert KaTeX render of one inline formula, or `null` if there is none. */
function renderFormulaUncached(latex: string): Element | null {
  if (!latex.trim()) return null;
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
    // Keep the source span: the editor still recovers the formula from it.
    return null;
  }
  const root = parseFragment(markup).childNodes.find(defaultTreeAdapter.isElementNode);
  if (!root) return null;
  // The editor's storage shape: the KaTeX root carries the source.
  root.attrs = root.attrs.filter((attr) => attr.name !== INLINE_MATH_ATTRIBUTE);
  root.attrs.push({ name: INLINE_MATH_ATTRIBUTE, value: latex });
  return root;
}

function renderFormula(latex: string): Element | null {
  let render = renderCache.get(latex);
  if (render === undefined) {
    render = renderFormulaUncached(latex);
    if (renderCache.size >= RENDER_CACHE_LIMIT) {
      renderCache.delete(renderCache.keys().next().value as string);
    }
  } else {
    // Refresh recency.
    renderCache.delete(latex);
  }
  renderCache.set(latex, render);
  return render && cloneRender(render);
}

/**
 * Post-sanitize pass: replace each source span with a generated render of its
 * source. Anything else in the sanitized prose is left as parsed.
 */
export function renderInlineMath(sanitizedHtml: string): string {
  if (!sanitizedHtml.includes(INLINE_MATH_ATTRIBUTE)) return sanitizedHtml;
  const fragment = parseFragment(sanitizedHtml);
  walk(fragment, (element) => {
    if (!isHtmlSpan(element)) return null;
    const latex = attribute(element, INLINE_MATH_ATTRIBUTE);
    if (latex === null) return null;
    // A source span the render cannot fill stays as an empty source span.
    return renderFormula(latex) ?? sourceSpan(latex);
  });
  return serialize(fragment);
}
