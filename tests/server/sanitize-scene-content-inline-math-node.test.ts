/**
 * The persistence boundary runs on the server, where there is no DOM and no
 * math is rendered: inline formulas are reduced to their source in time
 * linear in the input, whatever the source contains.
 */
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import { describe, expect, it } from 'vitest';
import { sanitizeProseHtml, sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** The editor's storage shape: a full KaTeX render with the source on its root. */
function editorFormula(latex: string): string {
  const escaped = latex.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return katex
    .renderToString(latex, { throwOnError: false, trust: false })
    .replace(
      '<span class="katex">',
      () => `<span class="katex" data-inline-math="${escaped}" contenteditable="false">`,
    );
}

function elapsed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Best of a few runs, to keep timing assertions stable on a busy machine. */
function fastest(run: () => unknown, runs = 3): number {
  return Math.min(...Array.from({ length: runs }, () => elapsed(run)));
}

describe('sanitizeSceneContent — inline formulas without a DOM', () => {
  it('runs in an environment with no document', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('stores the source only, idempotently', () => {
    const once = sanitizeSceneContent({
      elements: [{ type: 'text', id: 't', content: `<p>Area: ${editorFormula(LATEX)} units</p>` }],
    });
    expect(once.elements[0].content).toBe(
      `<p>Area: <span data-inline-math="${LATEX}">${LATEX}</span> units</p>`,
    );
    expect(sanitizeSceneContent(once)).toEqual(once);
  });

  it('recovers a KaTeX root whose class is written as a character reference', () => {
    const html =
      '<p><span class="&#107;atex"><math><semantics><mi>x</mi>' +
      '<annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></p>';
    expect(sanitizeProseHtml(html)).toBe('<p><span data-inline-math="x^2">x^2</span></p>');
  });

  it('ends a formula where the parser does when its tags are not closed', () => {
    expect(sanitizeProseHtml('<p>a <span data-inline-math="z"><b>open</p><p>next</p>')).toBe(
      '<p>a <span data-inline-math="z">z</span></p><p>next</p>',
    );
    expect(sanitizeProseHtml('<p>end <span data-inline-math="w">')).toBe(
      '<p>end <span data-inline-math="w">w</span></p>',
    );
  });

  it('escapes the source in both places', () => {
    const html = '<p><span data-inline-math="a&amp;b &quot;q&quot; &lt;c&gt;"><i>x</i></span></p>';
    const out = sanitizeProseHtml(html);
    expect(out).toBe(
      '<p><span data-inline-math="a&amp;b &quot;q&quot; &lt;c&gt;">a&amp;b "q" &lt;c&gt;</span></p>',
    );
    expect(sanitizeProseHtml(out)).toBe(out);
  });

  it('leaves prose that only mentions the words unchanged', () => {
    expect(sanitizeProseHtml('<p>KaTeX annotation <b>notes</b></p>')).toBe(
      '<p>KaTeX annotation <b>notes</b></p>',
    );
  });
});

describe('sanitizeSceneContent — hostile inline formulas stay cheap', () => {
  it('stores a macro bomb as source without expanding it', () => {
    const bomb =
      `\\def\\a{${'x+'.repeat(500)}}` +
      `\\def\\b{${'\\a'.repeat(10)}}\\def\\c{${'\\b'.repeat(10)}}${'\\c'.repeat(9)}`;
    const html = `<p><span data-inline-math="${bomb}"></span></p>`;
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(50);
    expect(sanitizeProseHtml(html)).toBe(`<p><span data-inline-math="${bomb}">${bomb}</span></p>`);
  });

  it('keeps a 100 KB flat formula as plain text, quickly', () => {
    const latex = 'x+'.repeat(50_000);
    const html = `<p><span data-inline-math="${latex}"></span></p>`;
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(50);
    expect(sanitizeProseHtml(html)).toBe(`<p>${latex}</p>`);
  });

  it('stays linear on deep nesting that mentions a formula marker', () => {
    const depth = 30_000;
    const html = `${'<div>'.repeat(depth)}annotation${'</div>'.repeat(depth)}`;
    const policy = () => sanitizeHtml(html, { allowedTags: ['div'] });
    // The formula pre-pass is one extra streaming parse: same order as the policy itself.
    expect(fastest(() => sanitizeProseHtml(html))).toBeLessThan(fastest(policy) * 4 + 50);
  });

  it('stores a whole payload the same as scene by scene', () => {
    const scene = (index: number) => ({
      type: 'text',
      id: `t${index}`,
      content: `<p>${Array.from({ length: 50 }, (_, k) => editorFormula(`x_{${index}}^{${k}}`)).join(' ')}</p>`,
    });
    const scenes = Array.from({ length: 20 }, (_, index) => scene(index));
    expect(sanitizeSceneContent(scenes)).toEqual(scenes.map((item) => sanitizeSceneContent(item)));
  });
});
