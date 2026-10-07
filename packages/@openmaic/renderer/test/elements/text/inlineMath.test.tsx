// @vitest-environment jsdom
import katex from 'katex';
import { render } from '@testing-library/react';
import type { PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import { BaseShapeElement } from '../../../src/elements/shape/BaseShapeElement';
import { StaticTable } from '../../../src/elements/table/StaticTable';
import { BaseTextElement } from '../../../src/elements/text/BaseTextElement';
import { MAX_INLINE_MATH_SOURCE, renderInlineMath } from '../../../src/utils/inlineMath';

const LATEX = '\\sqrt{x}+\\frac{a}{b}';

/** Stored prose: the formula as source only. */
function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
}

function host(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

function expectTypeset(root: ParentNode, latex: string): void {
  const formulas = root.querySelectorAll('[data-inline-math]');
  expect(formulas).toHaveLength(1);
  const formula = formulas[0];
  expect(formula.getAttribute('data-inline-math')).toBe(latex);
  expect(formula.classList.contains('katex')).toBe(true);
  expect(formula.querySelector('.katex')).toBeNull();
  expect(formula.querySelector('math')).toBeNull();
}

describe('renderInlineMath', () => {
  it('typesets a source-only formula from its attribute', () => {
    const root = host(`<p>Area: ${stored(LATEX)} units</p>`);
    renderInlineMath(root);
    expectTypeset(root, LATEX);
    expect(root.querySelector('svg')).not.toBeNull(); // the radical
    expect(root.innerHTML).toMatch(/style="top:/);
    expect(root.textContent).toMatch(/^Area: .* units$/);
  });

  it('re-renders older content that still carries KaTeX markup', () => {
    const editor = katex
      .renderToString(LATEX)
      .replace('<span class="katex">', `<span class="katex" data-inline-math="${LATEX}">`);
    const root = host(`<p>${editor}</p>`);
    renderInlineMath(root);
    expectTypeset(root, LATEX);
  });

  it('is stable when run again', () => {
    const root = host(`<p>${stored('x^2')} and ${stored('y_1')}</p>`);
    renderInlineMath(root);
    const once = root.innerHTML;
    renderInlineMath(root);
    expect(root.innerHTML).toBe(once);
  });

  it('shows over-long sources as text', () => {
    const latex = 'x'.repeat(MAX_INLINE_MATH_SOURCE + 1);
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('.katex')).toBeNull();
    expect(root.textContent).toBe(latex);
  });

  it('cannot define macros or run away on a macro bomb', () => {
    const bomb =
      `\\def\\a{${'x+'.repeat(500)}}` +
      `\\def\\b{${'\\a'.repeat(10)}}\\def\\c{${'\\b'.repeat(10)}}${'\\c'.repeat(9)}`;
    const root = host(`<p>${stored(bomb)}</p>`);
    const started = performance.now();
    renderInlineMath(root);
    expect(performance.now() - started).toBeLessThan(500);
    expect(root.textContent!.length).toBeLessThan(bomb.length * 2);
  });

  it('keeps the source of a formula KaTeX rejects', () => {
    const root = host(`<p>${stored('\\frac{')}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(
      '\\frac{',
    );
  });

  it('treats the source as text, never markup', () => {
    const latex = 'x</span><img src=x onerror=alert(1)>';
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(latex);
  });
});

describe('slide elements typeset inline formulas', () => {
  const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
  const html = `<p>Area: ${stored(LATEX)} units</p>`;

  it('in text elements', () => {
    const { container } = render(
      <BaseTextElement
        elementInfo={
          {
            ...box,
            id: 't',
            type: 'text',
            content: html,
            defaultFontName: '',
            defaultColor: '#000',
          } as PPTTextElement
        }
      />,
    );
    expectTypeset(container, LATEX);
  });

  it('in shape text', () => {
    const { container } = render(
      <BaseShapeElement
        elementInfo={
          {
            ...box,
            id: 's',
            type: 'shape',
            viewBox: [200, 200],
            path: 'M 0 0 L 200 0 L 200 200 Z',
            fixedRatio: false,
            fill: '#fff',
            text: { content: html, defaultFontName: '', defaultColor: '#000', align: 'middle' },
          } as PPTShapeElement
        }
      />,
    );
    expectTypeset(container, LATEX);
  });

  it('in table cells, again when a cell changes', () => {
    const table = (text: string) =>
      ({
        ...box,
        id: 'tb',
        type: 'table',
        outline: { width: 1, style: 'solid', color: '#000' },
        colWidths: [1],
        cellMinHeight: 20,
        data: [[{ id: 'c', colspan: 1, rowspan: 1, text }]],
      }) as PPTTableElement;
    const { container, rerender } = render(<StaticTable elementInfo={table(html)} />);
    expectTypeset(container, LATEX);
    rerender(<StaticTable elementInfo={table(`<p>${stored('y^2')}</p>`)} />);
    expectTypeset(container, 'y^2');
  });
});
