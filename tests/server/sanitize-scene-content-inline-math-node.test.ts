/**
 * The persistence boundary runs on the server, where there is no DOM: inline
 * formulas must survive sanitization there too.
 */
import katex from 'katex';
import { describe, expect, it } from 'vitest';
import { sanitizeProseHtml, sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** The editor's storage shape: a full KaTeX render with the source on its root. */
function storedFormula(latex: string): string {
  const escaped = latex.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return katex
    .renderToString(latex, { throwOnError: false, trust: false })
    .replace(
      '<span class="katex">',
      () => `<span class="katex" data-inline-math="${escaped}" contenteditable="false">`,
    );
}

describe('sanitizeSceneContent — inline formulas without a DOM', () => {
  it('runs in an environment with no document', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('keeps the source and a fresh render, idempotently', () => {
    const element = {
      type: 'text',
      id: 't',
      content: `<p>Area: ${storedFormula(LATEX)} units</p>`,
    };
    const once = sanitizeSceneContent({ elements: [element] });
    const html = once.elements[0].content;
    expect(html).toContain(`data-inline-math="${LATEX}"`);
    expect(html).toContain('<svg');
    expect(html).toMatch(/style="top:/);
    expect(html).not.toContain('<math');
    expect(html).not.toContain('contenteditable');
    expect(sanitizeSceneContent(once)).toEqual(once);
  });

  it('falls back to the plain prose policy instead of failing on pathological nesting', () => {
    const depth = 20_000;
    const html = `${'<span>'.repeat(depth)}${storedFormula('x')}<img src=x onerror=alert(1)>${'</span>'.repeat(depth)}`;
    const out = sanitizeProseHtml(html);
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('data-inline-math');
    expect(out.startsWith('<span><span>')).toBe(true);
  });
});
