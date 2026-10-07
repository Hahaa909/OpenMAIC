// @vitest-environment jsdom
import type { ReactElement } from 'react';
import katex from 'katex';
import { render } from '@testing-library/react';
import type { PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import { BaseShapeElement } from '../../../src/elements/shape/BaseShapeElement';
import { StaticTable } from '../../../src/elements/table/StaticTable';
import { BaseTextElement } from '../../../src/elements/text/BaseTextElement';
import {
  INLINE_MATH_MAX_ROOT_FORMULAS,
  INLINE_MATH_SYNC_SOURCE_BUDGET,
  MAX_INLINE_MATH_SOURCE,
  renderInlineMath,
} from '../../../src/utils/inlineMath';

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

  it('typesets long legitimate formulas that expand many built-in macros', () => {
    // 30 × (\neq, \iff, \, and \dots): well over 100 built-in expansions.
    const latex = Array.from(
      { length: 30 },
      (_, i) => `a_{${i}} \\neq b_{${i}} \\iff c\\,d \\dots`,
    ).join(',\\ ');
    const root = host(`<p>${stored(latex)}</p>`);
    renderInlineMath(root);
    expectTypeset(root, latex);
    expect(root.querySelector('.katex-error')).toBeNull();
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

  const textElement = (content: string, left = 0) =>
    ({
      ...box,
      left,
      id: 't',
      type: 'text',
      content,
      defaultFontName: '',
      defaultColor: '#000',
    }) as PPTTextElement;
  const shapeElement = (content: string, left = 0) =>
    ({
      ...box,
      left,
      id: 's',
      type: 'shape',
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 Z',
      fixedRatio: false,
      fill: '#fff',
      text: { content, defaultFontName: '', defaultColor: '#000', align: 'middle' },
    }) as PPTShapeElement;
  const tableElement = (text: string, width = 400) =>
    ({
      ...box,
      width,
      id: 'tb',
      type: 'table',
      outline: { width: 1, style: 'solid', color: '#000' },
      colWidths: [1],
      cellMinHeight: 20,
      data: [[{ id: 'c', colspan: 1, rowspan: 1, text }]],
    }) as PPTTableElement;

  it('stay typeset when only geometry changes, and follow content changes', () => {
    const text = render(<BaseTextElement elementInfo={textElement(html)} />);
    text.rerender(<BaseTextElement elementInfo={textElement(html, 120)} />);
    expectTypeset(text.container, LATEX);
    text.rerender(<BaseTextElement elementInfo={textElement(`<p>${stored('z_1')}</p>`, 120)} />);
    expectTypeset(text.container, 'z_1');

    const shape = render(<BaseShapeElement elementInfo={shapeElement(html)} />);
    shape.rerender(<BaseShapeElement elementInfo={shapeElement(html, 120)} />);
    expectTypeset(shape.container, LATEX);
    shape.rerender(<BaseShapeElement elementInfo={shapeElement(`<p>${stored('z_2')}</p>`, 120)} />);
    expectTypeset(shape.container, 'z_2');

    const table = render(<StaticTable elementInfo={tableElement(html)} />);
    table.rerender(<StaticTable elementInfo={tableElement(html, 500)} />);
    expectTypeset(table.container, LATEX);
    table.rerender(<StaticTable elementInfo={tableElement(`<p>${stored('z_3')}</p>`, 500)} />);
    expectTypeset(table.container, 'z_3');
  });

  it('stay typeset when re-rendered with identical content, and on A→B→A→A', () => {
    const a = `<p>${stored('x^2')}</p>`;
    const b = `<p>${stored('y^2')}</p>`;
    const cases = [
      [BaseTextElement, (content: string) => textElement(content)],
      [BaseShapeElement, (content: string) => shapeElement(content)],
      [StaticTable, (content: string) => tableElement(content)],
    ] as const;
    for (const [Component, make] of cases) {
      const Element = Component as unknown as (props: { elementInfo: unknown }) => ReactElement;
      const same = make(a);
      const view = render(<Element elementInfo={same} />);
      view.rerender(<Element elementInfo={same} />);
      expectTypeset(view.container, 'x^2');
      for (const [content, latex] of [
        [b, 'y^2'],
        [a, 'x^2'],
        [a, 'x^2'],
      ] as const) {
        view.rerender(<Element elementInfo={make(content)} />);
        expectTypeset(view.container, latex);
      }
      view.unmount();
    }
  });
});

describe('inline math typesetting budget', () => {
  /** A distinct ~1900-character matrix: expensive to typeset and never cached. */
  const matrix = (index: number) =>
    `\\begin{pmatrix}${Array.from({ length: 160 }, (_, k) => `a_{${index}${k}}`).join('&')}\\end{pmatrix}`.slice(
      0,
      1_900,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it('typesets ordinary prose in one pass', () => {
    const root = host(
      Array.from({ length: 60 }, (_, index) => `<p>${stored(`x_{${index}}^2+${index}`)}</p>`).join(
        '',
      ),
    );
    expect(renderInlineMath(root)).toBe(false);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(60);
  });

  it('leaves heavy formulas past the budget for later passes', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => `${matrix(index)}+${index}`);
    expect(sources.every((source) => source.length <= MAX_INLINE_MATH_SOURCE)).toBe(true);
    const root = host(sources.map((source) => `<p>${stored(source)}</p>`).join(''));
    expect(renderInlineMath(root)).toBe(true);
    const first = root.querySelectorAll('.katex[data-inline-math]').length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(Math.ceil(INLINE_MATH_SYNC_SOURCE_BUDGET / 1_900));
    let passes = 1;
    while (renderInlineMath(root)) passes += 1;
    expect(passes).toBeGreaterThan(1);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(sources.length);
  });

  it('typesets everything at once when asked to complete', () => {
    const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 20)}+${index}`);
    const root = host(sources.map((source) => `<p>${stored(source)}</p>`).join(''));
    expect(renderInlineMath(root, { complete: true })).toBe(false);
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(sources.length);
  });

  it('shows formulas past the hard cap as text', () => {
    const count = INLINE_MATH_MAX_ROOT_FORMULAS + 2;
    const root = host(
      `<p>${Array.from({ length: count }, (_, index) => stored(`q_{${index}}`)).join(' ')}</p>`,
    );
    renderInlineMath(root, { complete: true });
    expect(root.querySelectorAll('.katex[data-inline-math]')).toHaveLength(
      INLINE_MATH_MAX_ROOT_FORMULAS,
    );
    expect(root.textContent).toContain(`q_{${count - 1}}`);
  });

  it('finishes the rest in idle time after mount, and stops on unmount', async () => {
    const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };
    const sources = Array.from({ length: 6 }, (_, index) => `${matrix(index + 40)}+${index}`);
    const content = sources.map((source) => `<p>${stored(source)}</p>`).join('');
    const element = {
      ...box,
      id: 'heavy',
      type: 'text',
      content,
      defaultFontName: '',
      defaultColor: '#000',
    } as PPTTextElement;
    const view = render(<BaseTextElement elementInfo={element} />);
    const typeset = () => view.container.querySelectorAll('.katex[data-inline-math]').length;
    expect(typeset()).toBeLessThan(sources.length);
    for (let index = 0; index < 20 && typeset() < sources.length; index += 1) await settle();
    expect(typeset()).toBe(sources.length);

    const other = { ...element, id: 'heavy-2', content: content.replace(/\+(\d)/g, '-$1') };
    const second = render(<BaseTextElement elementInfo={other} />);
    const detached = second.container;
    second.unmount();
    await settle();
    expect(detached.querySelectorAll('.katex[data-inline-math]')).toHaveLength(0);
  });
});
