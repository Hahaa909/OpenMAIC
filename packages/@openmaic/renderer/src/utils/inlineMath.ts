'use client';

import { useLayoutEffect, type RefObject } from 'react';
import katex, { type KatexOptions } from 'katex';

/**
 * Inline formulas in slide prose. Stored prose carries each formula as LaTeX
 * source (`<span data-inline-math="LATEX">LATEX</span>`); older or unsaved
 * content may still carry a rendered KaTeX tree with the same attribute. The
 * renderer typesets every such span in the browser from its source.
 */
export const INLINE_MATH_ATTRIBUTE = 'data-inline-math';

/** Longest source typeset; longer sources are shown as plain LaTeX text. */
export const MAX_INLINE_MATH_SOURCE = 2_000;

/** Commands that define macros: mapped to nothing so user input cannot define any. */
const MACRO_DEFINITIONS = [
  '\\def',
  '\\gdef',
  '\\edef',
  '\\xdef',
  '\\let',
  '\\futurelet',
  '\\global',
  '\\newcommand',
  '\\renewcommand',
  '\\providecommand',
] as const;

/**
 * KaTeX options for authored inline formulas, in one place: untrusted input,
 * no macro definitions, bounded expansion. A fresh `macros` object per render,
 * since KaTeX writes global definitions into it.
 */
function inlineMathKatexOptions(): KatexOptions {
  return {
    displayMode: false,
    output: 'html',
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    maxExpand: 1000,
    macros: Object.fromEntries(MACRO_DEFINITIONS.map((name) => [name, ''])),
  };
}

/** Formula elements this module already handled, so a repeated pass skips them. */
const handled = new WeakSet<Element>();

/**
 * Typeset formulas by source, cloned on use: React may rewrite the injected
 * markup on any re-render, and re-typesetting the same source must stay
 * cheap. Bounded by the size of the cached markup; large renders are not kept.
 */
const TYPESET_CACHE_MAX_MARKUP = 2_000_000;
const TYPESET_CACHE_MAX_ENTRY = 64_000;
const typesetCache = new Map<string, { readonly formula: Element | null; readonly size: number }>();
let typesetCacheSize = 0;

/** Typeset one formula, or `null` to keep its source as text. */
function typesetUncached(doc: Document, latex: string): Element | null {
  if (!latex.trim() || latex.length > MAX_INLINE_MATH_SOURCE) return null;
  const host = doc.createElement('span');
  try {
    katex.render(latex, host, inlineMathKatexOptions());
  } catch {
    return null;
  }
  const formula = host.firstElementChild;
  formula?.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
  return formula;
}

function typeset(doc: Document, latex: string): Element | null {
  let entry = typesetCache.get(latex);
  if (entry) {
    // Refresh recency.
    typesetCache.delete(latex);
    typesetCache.set(latex, entry);
  } else {
    const formula = typesetUncached(doc, latex);
    entry = { formula, size: latex.length + (formula?.outerHTML.length ?? 0) };
    if (entry.size <= TYPESET_CACHE_MAX_ENTRY) {
      typesetCache.set(latex, entry);
      typesetCacheSize += entry.size;
      for (const [key, value] of typesetCache) {
        if (typesetCacheSize <= TYPESET_CACHE_MAX_MARKUP) break;
        typesetCache.delete(key);
        typesetCacheSize -= value.size;
      }
    }
  }
  if (!entry.formula) return null;
  return entry.formula.ownerDocument === doc
    ? (entry.formula.cloneNode(true) as Element)
    : (doc.importNode(entry.formula, true) as Element);
}

/**
 * Typeset every inline formula under `root`. Each `span[data-inline-math]` is
 * replaced by a KaTeX render of its source carrying the same attribute (the
 * editor's storage shape); a source that cannot be typeset is shown as text.
 */
export function renderInlineMath(root: ParentNode): void {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  for (const element of root.querySelectorAll(`span[${INLINE_MATH_ATTRIBUTE}]`)) {
    // Already handled, or inside a formula replaced earlier in this pass.
    if (handled.has(element) || !(root as Node).contains(element)) continue;
    const latex = element.getAttribute(INLINE_MATH_ATTRIBUTE) ?? '';
    const formula = typeset(doc, latex);
    if (!formula) {
      element.textContent = latex;
      handled.add(element);
      continue;
    }
    handled.add(formula);
    element.replaceWith(formula);
  }
}

/**
 * Typeset the inline formulas of prose injected into `ref` as `html`. Runs
 * after every commit, before paint: React may rewrite the injected markup on
 * any re-render (not only when `html` changes), which would put the stored
 * source spans back. Formulas already typeset are skipped, so a commit that
 * left the markup alone costs one query. Never updates React state.
 */
export function useInlineMath(ref: RefObject<Element | null>, html: string): void {
  useLayoutEffect(() => {
    if (ref.current && html.includes(INLINE_MATH_ATTRIBUTE)) renderInlineMath(ref.current);
  });
}
