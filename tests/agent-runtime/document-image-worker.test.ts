import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import * as parser from '@/lib/server/material-extraction/document-image-parser';
import {
  imagePathIndex,
  resolveDerivativeRefsAsync,
} from '@/lib/server/material-extraction/document-images';

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

const index = imagePathIndex([{ key: 'img-1', path: 'fig.png' }]);

describe('document-image production parser', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not mistake a same-paragraph inequality for a tag in write or either read path', async () => {
    const input = 'If $a<b$ then ![same](images/fig.png) holds > 0.';
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [{ type: 'markdown', text: input }],
    });
    expect(written.text).toBe(input.replace('images/fig.png', 'openmaic-derivative:img-1'));
    expect(written.refs).toHaveLength(1);
    expect(written.text.slice(written.refs[0].start, written.refs[0].end)).toBe(
      'openmaic-derivative:img-1',
    );
    const expected = input.replace('images/fig.png', 'material:own-image');
    expect(
      await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'own-image' }],
        'same-paragraph-published',
        written.refs,
      ),
    ).toBe(expected);
    // Independently supply a legacy text: do not let a broken write hide a broken read.
    expect(
      await resolveDerivativeRefsAsync(
        input.replace('images/fig.png', 'openmaic-derivative:img-1'),
        [{ key: 'img-1', id: 'own-image' }],
        'same-paragraph-legacy',
      ),
    ).toBe(expected);
  });

  it('keeps real tags, complex unquoted attributes, scripts and comments unchanged in meaning', async () => {
    const input = [
      '<img alt=a*b* src=images/fig.png>',
      '<b>bold ![i](images/fig.png)</b>',
      'inline <script>const example = "![x](images/fig.png)";</script>',
      '<!-- ![comment](images/fig.png) <img src=images/fig.png> -->',
    ].join('\n\n');
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [{ type: 'markdown', text: input }],
    });
    expect(written.refs).toHaveLength(2);
    for (const refs of [written.refs, undefined]) {
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'own-image' }],
        'real-tags-legacy',
        refs,
      );
      expect(read).toContain('<img alt=a*b* src="material:own-image">');
      expect(read).toContain('<b>bold ![i](material:own-image)</b>');
      expect(read).toContain('inline <script>const example = "![x](images/fig.png)";</script>');
      expect(read).toContain('<!-- ![comment](images/fig.png) <img src=images/fig.png> -->');
    }
  });

  it('publishes exact positions across trimmed blocks, BOM, definitions, HTML and code', async () => {
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [
        { type: 'text', text: ' heading ' },
        {
          type: 'markdown',
          text: '\uFEFF  If $a<b$ then.\n\n![x][fig]\n\n[fig]: images/fig.png\n\n',
        },
        {
          type: 'markdown',
          text: '  text <img src=images/fig.png alt="*Figure*">\n\n`![code](images/fig.png)`\n\nLiteral openmaic-derivative:img-1.  ',
        },
      ],
    });
    expect(written.refs).toHaveLength(2);
    for (const ref of written.refs) {
      expect(written.text.slice(ref.start, ref.end)).toBe('openmaic-derivative:' + ref.key);
    }
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    for (const id of ['first', 'second']) {
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id }],
        'published',
        written.refs,
      );
      expect(read).toContain(`![x](material:${id})`);
      expect(read).toContain(`src="material:${id}"`);
      expect(read).toContain('`![code](images/fig.png)`');
      expect(read).toContain('Literal openmaic-derivative:img-1.');
    }
    expect(worker).not.toHaveBeenCalled();
    expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
  });

  it('parses legacy positions off-thread once and reapplies each reader’s ids', async () => {
    const text =
      'If $a<b$ then.\n\n![x](openmaic-derivative:img-1)\n\ntext <img src=openmaic-derivative:img-1>\n\n`openmaic-derivative:img-1`';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    for (const id of ['legacy-a', 'legacy-b']) {
      const read = await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id }], 'legacy-worker');
      expect(read).toContain(`![x](material:${id})`);
      expect(read).toContain(`src="material:${id}"`);
      expect(read).toContain('`openmaic-derivative:img-1`');
    }
    expect(worker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
  });

  it('keeps the main event loop responsive during write and legacy cold-read parsing', async () => {
    const text = '<span>x</span>'.repeat(25_000) + '\n\n![x](images/fig.png)';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const written = await parser.runDocumentImageWorker({
        kind: 'rewrite',
        index,
        blocks: [{ type: 'markdown', text }],
      });
      expect(ticks).toBeGreaterThan(0);
      expect(written.refs).toHaveLength(1);
      ticks = 0;
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'large' }],
        'large-legacy',
      );
      expect(ticks).toBeGreaterThan(0);
      expect(read).toContain('material:large');
      expect(worker).toHaveBeenCalledTimes(2);
      // A large *new* result's cold read never starts a parser.
      expect(
        await resolveDerivativeRefsAsync(
          written.text,
          [{ key: 'img-1', id: 'new' }],
          'large-new',
          written.refs,
        ),
      ).toContain('material:new');
      expect(worker).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
    } finally {
      clearInterval(timer);
    }
  }, 20_000);
});
