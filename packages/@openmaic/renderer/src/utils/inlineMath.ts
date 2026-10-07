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
    maxExpand: 50,
    macros: Object.fromEntries(MACRO_DEFINITIONS.map((name) => [name, ''])),
  };
}

/** Formula elements this module rendered, so a repeated pass skips them. */
const rendered = new WeakSet<Element>();

/** Typeset one formula, or `null` to keep its source as text. */
function typeset(doc: Document, latex: string): Element | null {
  if (!latex.trim() || latex.length > MAX_INLINE_MATH_SOURCE) return null;
  const host = doc.createElement('span');
  try {
    katex.render(latex, host, inlineMathKatexOptions());
  } catch {
    return null;
  }
  return host.firstElementChild;
}

/**
 * Typeset every inline formula under `root`. Each `span[data-inline-math]` is
 * replaced by a KaTeX render of its source carrying the same attribute (the
 * editor's storage shape); a source that cannot be typeset is shown as text.
 */
export function renderInlineMath(root: ParentNode): void {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  for (const element of root.querySelectorAll(`span[${INLINE_MATH_ATTRIBUTE}]`)) {
    // Already typeset, or inside a formula replaced earlier in this pass.
    if (rendered.has(element) || !(root as Node).contains(element)) continue;
    const latex = element.getAttribute(INLINE_MATH_ATTRIBUTE) ?? '';
    const formula = typeset(doc, latex);
    if (!formula) {
      element.textContent = latex;
      continue;
    }
    formula.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
    rendered.add(formula);
    element.replaceWith(formula);
  }
}

/**
 * Typeset the inline formulas of prose injected into `ref` as `html`. Runs
 * after React writes the markup and before paint; React only rewrites the
 * markup when `html` changes, which re-runs this.
 */
export function useInlineMath(ref: RefObject<Element | null>, html: string): void {
  useLayoutEffect(() => {
    if (ref.current && html.includes(INLINE_MATH_ATTRIBUTE)) renderInlineMath(ref.current);
  }, [ref, html]);
}
