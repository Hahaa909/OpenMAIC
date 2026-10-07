/**
 * The persistence boundary runs on the server, where there is no DOM: inline
 * formulas must survive sanitization there too.
 */
import katex from 'katex';
import { describe, expect, it } from 'vitest';
import {
  INLINE_MATH_COUNT_BUDGET,
  INLINE_MATH_SOURCE_BUDGET,
  MAX_INLINE_MATH_SOURCE,
  inlineMathCacheSize,
} from '@/lib/sanitize/inline-math';
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

describe('sanitizeSceneContent — inline formula rendering limits', () => {
  const textElement = (content: string) => ({ type: 'text', id: 't', content });

  function sourceSpans(html: string): string[] {
    return [...html.matchAll(/data-inline-math="([^"]*)"/g)].map((match) => match[1]);
  }

  it('keeps an oversized formula as source text instead of rendering it', () => {
    const latex = 'x+'.repeat(50_000);
    const html = `<p>a <span data-inline-math="${latex}"></span> b</p>`;
    const started = performance.now();
    const once = sanitizeProseHtml(html);
    const twice = sanitizeProseHtml(once);
    expect(performance.now() - started).toBeLessThan(200);
    expect(once).toBe(`<p>a <span data-inline-math="${latex}">${latex}</span> b</p>`);
    expect(twice).toBe(once);
  });

  it('renders formulas up to the per-formula limit', () => {
    const latex = 'x+'.repeat(MAX_INLINE_MATH_SOURCE / 2 - 1) + 'x';
    expect(latex.length).toBeLessThanOrEqual(MAX_INLINE_MATH_SOURCE);
    const out = sanitizeProseHtml(`<p><span data-inline-math="${latex}"></span></p>`);
    expect(out).toContain('class="katex"');
  });

  it('stops rendering once the formula count budget is spent, keeping every source', () => {
    const count = INLINE_MATH_COUNT_BUDGET + 3;
    const html = Array.from(
      { length: count },
      (_, index) => `<span data-inline-math="x_{${index}}"></span>`,
    ).join('');
    const once = sanitizeSceneContent({ elements: [textElement(`<p>${html}</p>`)] });
    const out = once.elements[0].content;
    expect(sourceSpans(out)).toHaveLength(count);
    expect(out.match(/class="katex"/g)).toHaveLength(INLINE_MATH_COUNT_BUDGET);
    expect(out).toContain(`<span data-inline-math="x_{${count - 1}}">x_{${count - 1}}</span>`);
    expect(sanitizeSceneContent(once)).toEqual(once);
  });

  it('shares the source budget across the prose strings of one payload', () => {
    const size = 1_000;
    const fits = Math.floor(INLINE_MATH_SOURCE_BUDGET / size);
    const elements = Array.from({ length: fits + 2 }, (_, index) =>
      textElement(
        `<p><span data-inline-math="${'a'.repeat(size - 6)}{${String(index).padStart(3, '0')}}"></span></p>`,
      ),
    );
    const once = sanitizeSceneContent({ elements });
    const rendered = once.elements.filter((element) => element.content.includes('class="katex"'));
    expect(rendered).toHaveLength(fits);
    for (const element of once.elements) expect(sourceSpans(element.content)).toHaveLength(1);
    expect(sanitizeSceneContent(once)).toEqual(once);
  });

  it('bounds the render cache by markup size', () => {
    for (let index = 0; index < 600; index += 1) {
      sanitizeProseHtml(`<span data-inline-math="\\frac{${index}}{x^2}+\\sqrt{${index}}"></span>`);
    }
    expect(inlineMathCacheSize()).toBeLessThanOrEqual(1_000_000);
    const before = inlineMathCacheSize();
    sanitizeProseHtml(`<span data-inline-math="${'x+'.repeat(900)}x"></span>`);
    expect(inlineMathCacheSize()).toBeLessThanOrEqual(before);
  });
});

describe('sanitizeSceneContent — inline formula detection', () => {
  it('recovers a KaTeX root whose class is written as a character reference', () => {
    const html =
      '<p><span class="&#107;atex"><math><semantics><mi>x</mi>' +
      '<annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></p>';
    const out = sanitizeProseHtml(html);
    expect(out).toContain('data-inline-math="x^2"');
    expect(out).toContain('class="katex"');
  });

  it('leaves prose that only mentions the words unchanged', () => {
    expect(sanitizeProseHtml('<p>KaTeX annotation <b>notes</b></p>')).toBe(
      '<p>KaTeX annotation <b>notes</b></p>',
    );
  });
});
