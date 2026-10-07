// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import katex from 'katex';
import temml from 'temml';
import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { safeKatexOptions } from '@openmaic/dsl';
import { renderLatexToHtml } from '@/lib/quiz/math-text';
import { renderLatexElementHtml } from '@/lib/edit/slide-edit-elements';
import { latexToOmml } from '@/lib/export/latex-to-omml';
import { sanitizeSlideRichText } from '@/lib/export/standalone-html/rich-text';
import type { SlideContent } from '@/lib/types/stage';
import { createTextDocument } from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';
import { renderLatexSource } from '../../packages/@openmaic/editor/src/ui/latex/latex-editor';
import { LEGITIMATE_MATH_CORPUS } from '../fixtures/math-corpus';
import { MACRO_EXPANSION_INPUTS } from '../fixtures/math-expansion-inputs';

/** Generous for a slow CI runner; the unguarded inputs take seconds to minutes. */
const TIME_BUDGET_MS = 100;
/** Output stays proportional to the input (error spans included). */
const OUTPUT_BUDGET_CHARS = 64 * 1024;

function timed<T>(render: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = render();
  return { value, ms: performance.now() - start };
}

function attempt(render: () => string): string {
  try {
    return render();
  } catch (error) {
    return `ERROR ${(error as Error).message}`;
  }
}

function slideWithInlineMath(latex: string): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: '' },
      elements: [
        {
          type: 'text',
          id: 'text',
          left: 0,
          top: 0,
          width: 400,
          height: 80,
          rotate: 0,
          content: `<p><span data-inline-math="${latex}"></span></p>`,
          defaultFontName: '',
          defaultColor: '#000',
        },
      ] as PPTElement[],
    },
  } as SlideContent;
}

/** Every render path, as each module exposes it, reduced to "input → output text". */
const RENDER_PATHS: Record<string, (latex: string) => string> = {
  'quiz math text': (latex) => renderLatexToHtml(latex) ?? '',
  'slide latex element': (latex) => renderLatexElementHtml(latex) ?? '',
  'pptx export (temml)': (latex) => latexToOmml(latex) ?? '',
  'standalone HTML inline math': (latex) => {
    const { content } = sanitizeSlideRichText(slideWithInlineMath(latex));
    const element = content.canvas.elements[0];
    return element.type === 'text' ? element.content : '';
  },
  'editor latex dialog': (latex) => {
    const result = renderLatexSource(latex);
    return 'html' in result ? (result.html ?? '') : (result.error ?? '');
  },
  'editor inline math node': (latex) => {
    const doc = createTextDocument(`<p><span data-inline-math="${latex}"></span></p>`);
    return JSON.stringify(doc.toJSON());
  },
};

describe('math rendering with user macro definitions disabled', () => {
  for (const [path, render] of Object.entries(RENDER_PATHS)) {
    for (const [name, input] of Object.entries(MACRO_EXPANSION_INPUTS)) {
      it(`${path}: ${name} renders quickly with small output`, () => {
        const { value, ms } = timed(() => render(input));
        expect(ms).toBeLessThan(TIME_BUDGET_MS);
        expect(value.length).toBeLessThan(OUTPUT_BUDGET_CHARS);
      });
    }
  }

  it('does not carry a \\gdef from one render into the next', () => {
    expect(renderLatexToHtml('\\gdef\\leaked{LEAK}x')).not.toBeNull();
    expect(renderLatexToHtml('\\leaked')).toBeNull();

    const shared = { '\\keep': 'K' };
    const first = safeKatexOptions({ macros: shared });
    katex.renderToString('\\gdef\\leaked{LEAK}\\keep', first);
    const second = safeKatexOptions({ macros: shared });
    expect(second.macros).not.toBe(first.macros);
    expect(Object.keys(shared)).toEqual(['\\keep']);
    expect(katex.renderToString('\\keep', second)).toContain('K');
    expect(() => katex.renderToString('\\leaked', { ...second, throwOnError: true })).toThrow(
      /Undefined control sequence/,
    );
  });

  it('swallows each definition form without rendering its body', () => {
    const forms = [
      '\\def\\ma#1{BODY}',
      '\\gdef\\ma{BODY}',
      '\\edef\\ma{BODY}',
      '\\xdef\\ma{BODY}',
      '\\global\\def\\ma{BODY}',
      '\\long\\def\\ma{BODY}',
      '\\newcommand{\\ma}{BODY}',
      '\\newcommand\\ma[2][x]{BODY}',
      '\\renewcommand{\\frac}{BODY}',
      '\\providecommand{\\ma}{BODY}',
      '\\let\\ma=\\frac',
      '\\let\\ma\\frac',
    ];
    const reference = withoutSource(katex.renderToString('y', { output: 'mathml' }));
    for (const form of forms) {
      const html = katex.renderToString(
        `${form} y`,
        safeKatexOptions({ output: 'mathml', throwOnError: true }),
      );
      expect(withoutSource(html), form).toBe(reference);
    }
  });

  it('keeps built-in commands that are themselves macros working', () => {
    for (const latex of ['a \\neq b', 'p \\iff q', '1, \\dots, n', 'a \\, b', '\\frac{1}{2}']) {
      expect(renderLatexToHtml(latex), latex).not.toBeNull();
      expect(renderLatexSource(latex), latex).toHaveProperty('html');
    }
  });
});

/** MathML output minus the annotation that echoes the source. */
function withoutSource(mathml: string): string {
  return mathml.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/, '');
}

describe('legitimate formulas render exactly as before', () => {
  const variants = [
    { output: 'htmlAndMathml', displayMode: false },
    { output: 'html', displayMode: true },
    { output: 'mathml', displayMode: true },
  ] as const;

  for (const latex of LEGITIMATE_MATH_CORPUS) {
    it(`KaTeX and Temml: ${latex}`, () => {
      for (const variant of variants) {
        const before = attempt(() =>
          katex.renderToString(latex, { ...variant, throwOnError: false, strict: false }),
        );
        const after = attempt(() =>
          katex.renderToString(
            latex,
            safeKatexOptions({ ...variant, throwOnError: false, strict: false }),
          ),
        );
        expect(after).toBe(before);
      }
      expect(attempt(() => temml.renderToString(latex, safeKatexOptions()))).toBe(
        attempt(() => temml.renderToString(latex)),
      );
    });
  }
});

describe('every KaTeX and Temml render goes through safeKatexOptions', () => {
  // Coverage guard: a new call site must merge the hardened options.
  const RENDER_CALL =
    /\b(katex|temml)\.(render|renderToString|__renderToDomTree|__renderToHTMLTree)\(/g;
  const files = execFileSync(
    'git',
    ['grep', '-lE', '(katex|temml)\\.(render|renderToString|__render)', '--', '*.ts', '*.tsx'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => !/(^|\/)(tests?|__tests__)\//.test(file) && !file.includes('.test.'));

  it('finds the known render modules', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(file, () => {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RENDER_CALL)) {
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const linePrefix = source.slice(lineStart, match.index).trim();
        if (linePrefix.startsWith('*') || linePrefix.startsWith('//')) continue; // prose
        const call = source.slice(match.index, match.index + 400);
        // The options argument is the last one; it must be the hardened helper.
        expect(call, `${file}:${source.slice(0, match.index).split('\n').length}`).toMatch(
          /^[^;]*?,\s*safeKatexOptions\(/,
        );
      }
    });
  }
});
