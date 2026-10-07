// @vitest-environment jsdom
/**
 * The app's slide renderer typesets stored inline formulas
 * (`<span data-inline-math="SRC">SRC</span>`) in text, shape and table prose,
 * keeps them typeset across re-renders that leave the content alone, and
 * re-typesets when the content changes.
 */
import { createElement, type ComponentType } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PPTShapeElement, PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseShapeElement } from '@/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';
import { StaticTable } from '@/components/slide-renderer/components/element/TableElement/StaticTable';
import { BaseTextElement } from '@/components/slide-renderer/components/element/TextElement/BaseTextElement';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LATEX = '\\sqrt{x}+\\frac{a}{b}';
const box = { left: 0, top: 0, width: 400, height: 80, rotate: 0 };

function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  span.textContent = latex;
  return span.outerHTML;
}

const prose = (latex: string) => `<p>Area: ${stored(latex)} units</p>`;

const text = (content: string, left = 0) =>
  ({
    ...box,
    left,
    id: 't',
    type: 'text',
    content,
    defaultFontName: '',
    defaultColor: '#000',
  }) as PPTTextElement;
const shape = (content: string, left = 0) =>
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
const table = (content: string, width = 400) =>
  ({
    ...box,
    width,
    id: 'tb',
    type: 'table',
    outline: { width: 1, style: 'solid', color: '#000' },
    colWidths: [1],
    cellMinHeight: 20,
    data: [[{ id: 'c', colspan: 1, rowspan: 1, text: content }]],
  }) as PPTTableElement;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount<P extends object>(component: ComponentType<P>, props: P): (next: P) => void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(component, props)));
  return (next) => act(() => root!.render(createElement(component, next)));
}

function expectTypeset(latex: string): void {
  const formulas = host!.querySelectorAll('[data-inline-math]');
  expect(formulas).toHaveLength(1);
  expect(formulas[0].getAttribute('data-inline-math')).toBe(latex);
  expect(formulas[0].classList.contains('katex')).toBe(true);
}

describe('app slide renderer — inline formulas', () => {
  it('in text elements, across a move and a content change', () => {
    const update = mount(BaseTextElement, { elementInfo: text(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: text(prose(LATEX), 120) });
    expectTypeset(LATEX);
    update({ elementInfo: text(prose('y^2'), 120) });
    expectTypeset('y^2');
  });

  it('in shape text, across a move and a content change', () => {
    const update = mount(BaseShapeElement, { elementInfo: shape(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: shape(prose(LATEX), 120) });
    expectTypeset(LATEX);
    update({ elementInfo: shape(prose('y^2'), 120) });
    expectTypeset('y^2');
  });

  it('in table cells, across a resize and a content change', () => {
    const update = mount(StaticTable, { elementInfo: table(prose(LATEX)) });
    expectTypeset(LATEX);
    update({ elementInfo: table(prose(LATEX), 500) });
    expectTypeset(LATEX);
    update({ elementInfo: table(prose('y^2'), 500) });
    expectTypeset('y^2');
  });
});
