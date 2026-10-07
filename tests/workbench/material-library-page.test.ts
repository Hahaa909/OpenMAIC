// @vitest-environment jsdom
/**
 * The knowledge base page (RFC #1716 §1, §7, §8): what it asks the library
 * for, how it shows each source's state and the upload limits, that a failed
 * read is never an empty library, and that only the latest answer paints.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}${JSON.stringify(values)}` : key,
  }),
}));

import { MaterialLibraryPage } from '@/components/workbench/workspace/MaterialLibraryPage';
import {
  MATERIAL_LIBRARY_POLL_MS,
  useMaterialLibrary,
  type MaterialLibraryData,
} from '@/lib/workbench/use-material-library';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import {
  formatMaterialBytes,
  materialLibraryErrorOf,
  type LibraryScope,
} from '@/lib/workbench/material-library-client';

const LIMITS = {
  documentMaxBytes: 50 * 1024 * 1024,
  mediaMaxBytes: 50 * 1024 * 1024,
  maxCount: 100,
  maxTotalBytes: 2 * 1024 ** 3,
  usedCount: 3,
  usedBytes: 2048,
  assetQuotaBytes: 10 * 1024 ** 3,
  assetUsedBytes: 4096,
};

const source = (id: string, extra: Record<string, unknown> = {}) => ({
  materialId: id,
  kind: 'source',
  name: `${id}.pdf`,
  mime: 'application/pdf',
  bytes: 1024,
  folderId: null,
  extraction: { status: 'done' },
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type LibraryHandler = (params: URLSearchParams) => Promise<Response> | Response;

let library: LibraryHandler;
let folders: () => Promise<Response> | Response;
const libraryCalls: URLSearchParams[] = [];
let uploadMaterial: (file: File) => Promise<Response> | Response;
const uploadCalls: { url: string; init: RequestInit }[] = [];
interface WriteCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
let writeMaterial: (call: WriteCall) => Promise<Response> | Response;
const writeCalls: WriteCall[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const method = init?.method ?? 'GET';
      const organizing =
        method === 'PATCH' ||
        url.pathname === '/api/materials/move' ||
        (url.pathname === '/api/materials/folders' && method === 'POST');
      if (organizing) {
        const call = { method, path: url.pathname, body: JSON.parse(String(init!.body)) };
        writeCalls.push(call);
        return writeMaterial(call);
      }
      if (url.pathname === '/api/materials/folders') return folders();
      if (url.pathname === '/api/materials' && init?.method === 'POST') {
        uploadCalls.push({ url: input, init });
        return uploadMaterial(init.body as File);
      }
      if (url.pathname === '/api/materials/library') {
        libraryCalls.push(url.searchParams);
        return library(url.searchParams);
      }
      throw new Error(`unexpected fetch ${input}`);
    }),
  );
}

const settle = (milliseconds = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

/** Mounted roots still alive; `afterEach` unmounts any a failed test left. */
const mounted = new Set<() => Promise<void>>();

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const dispose = async () => {
    if (!mounted.delete(dispose)) return;
    await act(async () => root.unmount());
    container.remove();
  };
  mounted.add(dispose);
  return {
    container,
    query: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    render: (element: ReturnType<typeof createElement>) => act(async () => root.render(element)),
    click: (testId: string) =>
      act(async () => {
        container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
      }),
    dispose,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  libraryCalls.length = 0;
  uploadCalls.length = 0;
  writeCalls.length = 0;
  writeMaterial = ({ path }) =>
    path === '/api/materials/folders'
      ? json({ folder: { id: 'f-new', name: 'New' }, created: true }, 201)
      : json({ status: 'renamed' });
  uploadMaterial = (file) =>
    json(
      {
        materialId: `stored-${file.name}`,
        originalName: file.name,
        bytes: file.size,
        mime: file.type,
        extraction: { status: 'idle' },
      },
      201,
    );
  library = () => json({ materials: [source('a')], limits: LIMITS });
  folders = () =>
    json({ folders: [{ id: 'f1', name: 'Unit 1', materialCount: 2, createdAt: 1, updatedAt: 1 }] });
  stubFetch();
});

afterEach(async () => {
  for (const dispose of [...mounted]) await dispose();
  vi.unstubAllGlobals();
});

describe('what the page asks the library for', () => {
  it('lists sources of All, Unfiled or one folder, and always asks for the limits', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await page.click('kb-scope-unfiled');
    await settle();
    await page.click('kb-scope-folder-f1');
    await settle();

    expect(libraryCalls.map((params) => params.get('folderId'))).toEqual([null, 'unfiled', 'f1']);
    for (const params of libraryCalls) {
      expect(params.get('sources')).toBe('1');
      expect(params.get('limit')).toBe('200');
      expect(params.has('limits')).toBe(false);
    }
    expect(page.query('kb-scope-folder-f1')?.getAttribute('aria-current')).toBe('page');
    expect(page.query('kb-scope-folder-f1')?.textContent).toContain('2');
    await page.dispose();
  });

  it('asks again with the typed query once typing settles', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const input = page.query('kb-search') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '  photosynthesis ',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(350);
    expect(libraryCalls.at(-1)?.get('query')).toBe('photosynthesis');
    await page.dispose();
  });
});

describe('what the page shows', () => {
  it('names every processing state, a failure with its reason', async () => {
    library = () =>
      json({
        materials: [
          source('idle', { extraction: { status: 'idle' } }),
          source('pending', { extraction: { status: 'pending' } }),
          source('running', { extraction: { status: 'running' } }),
          source('done'),
          source('failed', { extraction: { status: 'failed', reason: 'quota exceeded' } }),
        ],
        limits: LIMITS,
      });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();

    const status = (id: string) => page.query(`kb-status-${id}`)?.textContent;
    expect(status('idle')).toBe('workspace.knowledgeBase.status.stored');
    expect(status('pending')).toBe('workspace.knowledgeBase.status.parsing');
    expect(status('running')).toBe('workspace.knowledgeBase.status.parsing');
    expect(status('done')).toBe('workspace.knowledgeBase.status.searchable');
    expect(status('failed')).toBe(
      'workspace.knowledgeBase.status.failed' +
        'workspace.knowledgeBase.status.failedReason{"reason":"quota exceeded"}',
    );
    await page.dispose();
  });

  it('shows the limits before any upload, a disabled pool quota as no limit', async () => {
    library = () => json({ materials: [], limits: { ...LIMITS, assetQuotaBytes: null } });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();

    const limits = page.query('kb-limits')?.textContent ?? '';
    expect(limits).toContain('"document":"50 MB"');
    expect(limits).toContain('"count":3,"maxCount":100');
    expect(limits).toContain('"maxBytes":"2 GB"');
    expect(limits).toContain('workspace.knowledgeBase.limits.storageUnlimited{"used":"4 KB"}');
    await page.dispose();
  });

  it('says what the knowledge base is for when it is empty, and not for an empty folder', async () => {
    library = () => json({ materials: [], limits: LIMITS });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    expect(page.query('kb-onboarding')?.textContent).toContain(
      'workspace.knowledgeBase.empty.body',
    );

    await page.click('kb-scope-folder-f1');
    await settle();
    expect(page.query('kb-onboarding')).toBeNull();
    expect(page.query('kb-empty')?.textContent).toContain('workspace.knowledgeBase.empty.folder');
    await page.dispose();
  });

  it('switches between cards and a list of the same sources', async () => {
    library = () => json({ materials: [source('a', { folderId: 'f1', folderName: 'Unit 1' })] });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    expect(page.query('kb-cards')?.textContent).toContain('Unit 1');

    await page.click('kb-view-list');
    expect(page.query('kb-cards')).toBeNull();
    expect(page.query('kb-list')?.textContent).toContain('a.pdf');
    expect(page.query('kb-view-list')?.getAttribute('aria-pressed')).toBe('true');
    await page.dispose();
  });

  it('reports a failed read as an error, never as an empty library, and retries', async () => {
    library = () =>
      json({ success: false, errorCode: 'INTERNAL_ERROR', error: 'boom', reason: 'x' }, 500);
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();

    expect(page.query('kb-error')?.textContent).toContain('workspace.knowledgeBase.error.load');
    expect(page.query('kb-onboarding')).toBeNull();
    expect(page.query('kb-empty')).toBeNull();

    library = () => json({ materials: [source('a')], limits: LIMITS });
    await page.click('kb-retry');
    await settle();
    expect(page.query('kb-error')).toBeNull();
    expect(page.query('kb-material-a')).not.toBeNull();
    await page.dispose();
  });

  it('never lets a slow answer for an earlier query paint over a newer one', async () => {
    const slow = deferred<Response>();
    library = (params) =>
      params.get('query') === 'old'
        ? slow.promise
        : json({ materials: [source(params.get('query') ?? 'all')], limits: LIMITS });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const type = async (value: string) => {
      const input = page.query('kb-search') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle(350);
    };
    await type('old');
    await type('new');
    expect(page.query('kb-material-new')).not.toBeNull();

    await act(async () => slow.resolve(json({ materials: [source('old')], limits: LIMITS })));
    await settle();
    expect(page.query('kb-material-old')).toBeNull();
    expect(page.query('kb-material-new')).not.toBeNull();
    await page.dispose();
  });
});

describe('loading more, and refreshing what is loaded', () => {
  /** Record what the hook returned, outside the component. */
  function recorder(sink: { current: MaterialLibraryData | null }) {
    return (value: MaterialLibraryData) => {
      sink.current = value;
    };
  }

  function Probe({
    scope,
    record,
  }: {
    readonly scope: LibraryScope;
    readonly record: (value: MaterialLibraryData) => void;
  }) {
    record(useMaterialLibrary({ scope, query: '' }));
    return null;
  }

  it('appends the next page, then refreshes both from the new cursors in one swap', async () => {
    let round = 0;
    library = (params) => {
      const before = params.get('before');
      if (!before) {
        return json({
          materials: [source(`r${round}-1`), source('shared')],
          limits: LIMITS,
          nextBefore: `cursor-${round}`,
        });
      }
      return json({ materials: [source('shared'), source(`after-${before}`)], limits: LIMITS });
    };
    const sink = { current: null as MaterialLibraryData | null };
    const page = mount();
    await page.render(createElement(Probe, { scope: { kind: 'all' }, record: recorder(sink) }));
    await settle();
    expect(sink.current?.hasMore).toBe(true);

    await act(async () => sink.current!.loadMore());
    await settle();
    expect(libraryCalls.at(-1)?.get('before')).toBe('cursor-0');
    // A material on both pages is listed once.
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual([
      'r0-1',
      'shared',
      'after-cursor-0',
    ]);
    expect(sink.current?.hasMore).toBe(false);

    round = 1;
    libraryCalls.length = 0;
    await act(async () => sink.current!.reload());
    await settle();
    // Two pages again, the second from the cursor THIS refresh's first page gave.
    expect(libraryCalls.map((params) => params.get('before'))).toEqual([null, 'cursor-1']);
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual([
      'r1-1',
      'shared',
      'after-cursor-1',
    ]);
    await page.dispose();
  });

  it('keeps the shown list when a refresh fails part-way, and says so', async () => {
    let failSecond = false;
    library = (params) => {
      if (!params.get('before')) {
        return json({ materials: [source('one')], limits: LIMITS, nextBefore: 'c' });
      }
      return failSecond
        ? json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503)
        : json({ materials: [source('two')], limits: LIMITS });
    };
    const sink = { current: null as MaterialLibraryData | null };
    const page = mount();
    await page.render(createElement(Probe, { scope: { kind: 'all' }, record: recorder(sink) }));
    await settle();
    await act(async () => sink.current!.loadMore());
    await settle();

    failSecond = true;
    await act(async () => sink.current!.reload());
    await settle();
    expect(sink.current?.status).toBe('ready');
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual(['one', 'two']);
    expect(sink.current?.error).toMatchObject({ status: 503, code: 'OWNER_BUSY' });
    await page.dispose();
  });

  it('ignores load more while a refresh rereads the list, then pages from the fresh cursor', async () => {
    library = () => json({ materials: [source('initial')], limits: LIMITS, nextBefore: 'old' });
    const sink = { current: null as MaterialLibraryData | null };
    const page = mount();
    await page.render(createElement(Probe, { scope: { kind: 'all' }, record: recorder(sink) }));
    await settle();

    const refreshing = deferred<Response>();
    library = (params) =>
      params.get('before')
        ? json({ materials: [source(`after-${params.get('before')}`)], limits: LIMITS })
        : refreshing.promise;
    libraryCalls.length = 0;
    await act(async () => sink.current!.reload());
    expect(sink.current?.refreshing).toBe(true);
    await act(async () => sink.current!.loadMore());
    await settle();
    // No page was read from the old cursor while the list is being reread.
    expect(libraryCalls.map((params) => params.get('before'))).toEqual([null]);

    await act(async () =>
      refreshing.resolve(
        json({ materials: [source('refreshed')], limits: LIMITS, nextBefore: 'fresh' }),
      ),
    );
    await settle();
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual(['refreshed']);
    expect(sink.current?.refreshing).toBe(false);
    expect(sink.current?.hasMore).toBe(true);

    await act(async () => sink.current!.loadMore());
    await settle();
    expect(libraryCalls.at(-1)?.get('before')).toBe('fresh');
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual(['refreshed', 'after-fresh']);
    await page.dispose();
  });

  it('drops a page still loading when a refresh starts, whichever answers first', async () => {
    for (const order of ['page first', 'refresh first'] as const) {
      library = () => json({ materials: [source('initial')], limits: LIMITS, nextBefore: 'old' });
      const sink = { current: null as MaterialLibraryData | null };
      const page = mount();
      await page.render(createElement(Probe, { scope: { kind: 'all' }, record: recorder(sink) }));
      await settle();

      const more = deferred<Response>();
      const refreshing = deferred<Response>();
      library = (params) => (params.get('before') ? more.promise : refreshing.promise);
      await act(async () => sink.current!.loadMore());
      await act(async () => sink.current!.reload());
      const page2 = () => json({ materials: [source('stale-tail')], limits: LIMITS });
      const fresh = () =>
        json({ materials: [source('refreshed')], limits: LIMITS, nextBefore: 'fresh' });
      if (order === 'page first') {
        await act(async () => more.resolve(page2()));
        await settle();
        await act(async () => refreshing.resolve(fresh()));
      } else {
        await act(async () => refreshing.resolve(fresh()));
        await settle();
        await act(async () => more.resolve(page2()));
      }
      await settle();

      expect(
        sink.current?.materials.map((m) => m.materialId),
        order,
      ).toEqual(['refreshed']);
      expect(sink.current?.hasMore, order).toBe(true);
      expect(sink.current?.loadingMore, order).toBe(false);
      await page.dispose();
    }
  });

  it('starts a new scope from one page', async () => {
    library = (params) =>
      params.get('before')
        ? json({ materials: [source('older')], limits: LIMITS })
        : json({ materials: [source('newest')], limits: LIMITS, nextBefore: 'c' });
    const sink = { current: null as MaterialLibraryData | null };
    const page = mount();
    await page.render(createElement(Probe, { scope: { kind: 'all' }, record: recorder(sink) }));
    await settle();
    await act(async () => sink.current!.loadMore());
    await settle();

    libraryCalls.length = 0;
    await page.render(createElement(Probe, { scope: { kind: 'unfiled' }, record: recorder(sink) }));
    await settle();
    expect(libraryCalls.map((params) => params.get('before'))).toEqual([null]);
    expect(sink.current?.materials.map((m) => m.materialId)).toEqual(['newest']);
    await page.dispose();
  });
});

describe('load more on the page', () => {
  it('is disabled while retry rereads the list, and then pages from the fresh cursor', async () => {
    library = (params) =>
      params.get('before')
        ? json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503)
        : json({ materials: [source('initial')], limits: LIMITS, nextBefore: 'old' });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await page.click('kb-load-more');
    await settle();
    expect(page.query('kb-stale')).not.toBeNull();

    const refreshing = deferred<Response>();
    library = (params) =>
      params.get('before')
        ? json({ materials: [source(`after-${params.get('before')}`)], limits: LIMITS })
        : refreshing.promise;
    libraryCalls.length = 0;
    await act(async () => page.query('kb-stale')!.querySelector('button')!.click());
    const button = () => page.query('kb-load-more') as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    await page.click('kb-load-more');
    await settle();
    expect(libraryCalls.map((params) => params.get('before'))).toEqual([null]);

    await act(async () =>
      refreshing.resolve(
        json({ materials: [source('refreshed')], limits: LIMITS, nextBefore: 'fresh' }),
      ),
    );
    await settle();
    expect(button().disabled).toBe(false);
    await page.click('kb-load-more');
    await settle();
    expect(libraryCalls.at(-1)?.get('before')).toBe('fresh');
    expect(page.query('kb-material-refreshed')).not.toBeNull();
    expect(page.query('kb-material-after-fresh')).not.toBeNull();
    expect(page.query('kb-material-initial')).toBeNull();
    await page.dispose();
  });
});

describe('staying fresh outside a run (option B)', () => {
  function FreshProbe({
    scope,
    record,
  }: {
    readonly scope: LibraryScope;
    readonly record: (value: MaterialLibraryData) => void;
  }) {
    record(useMaterialLibrary({ scope, query: '' }));
    return null;
  }

  let hidden = false;
  const tick = (milliseconds: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  const setHidden = async (value: boolean) => {
    hidden = value;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error -- drop the test's own property, back to jsdom's
    delete document.visibilityState;
  });

  async function mountProbe(scope: LibraryScope = { kind: 'all' }) {
    const sink = { current: null as MaterialLibraryData | null };
    const page = mount();
    await page.render(
      createElement(FreshProbe, {
        scope,
        record: (value: MaterialLibraryData) => {
          sink.current = value;
        },
      }),
    );
    await tick(0);
    return { sink, page };
  }

  it('polls while a shown source is parsing, and stops once nothing is', async () => {
    let status = 'running';
    library = () => json({ materials: [source('a', { extraction: { status } })], limits: LIMITS });
    const { page } = await mountProbe();
    expect(libraryCalls).toHaveLength(1);

    await tick(MATERIAL_LIBRARY_POLL_MS);
    expect(libraryCalls).toHaveLength(2);
    status = 'done';
    await tick(MATERIAL_LIBRARY_POLL_MS);
    expect(libraryCalls).toHaveLength(3);
    await tick(MATERIAL_LIBRARY_POLL_MS * 4);
    expect(libraryCalls).toHaveLength(3);
    await page.dispose();
  });

  it('keeps polling after a failed read: a failure is not the parse finishing', async () => {
    let fail = false;
    library = () =>
      fail
        ? json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503)
        : json({ materials: [source('a', { extraction: { status: 'pending' } })], limits: LIMITS });
    const { sink, page } = await mountProbe();
    fail = true;
    await tick(MATERIAL_LIBRARY_POLL_MS);
    expect(sink.current?.error).toMatchObject({ status: 503 });
    fail = false;
    await tick(MATERIAL_LIBRARY_POLL_MS);
    expect(libraryCalls).toHaveLength(3);
    expect(sink.current?.error).toBeNull();
    await page.dispose();
  });

  it('does not poll a hidden tab, and reads again as soon as it is visible', async () => {
    library = () =>
      json({ materials: [source('a', { extraction: { status: 'running' } })], limits: LIMITS });
    const { page } = await mountProbe();
    await setHidden(true);
    await tick(MATERIAL_LIBRARY_POLL_MS * 3);
    expect(libraryCalls).toHaveLength(1);

    await setHidden(false);
    await tick(0);
    expect(libraryCalls).toHaveLength(2);
    await page.dispose();
  });

  it('reads again on window focus, without polling when nothing is parsing', async () => {
    const { page } = await mountProbe();
    await tick(MATERIAL_LIBRARY_POLL_MS * 3);
    expect(libraryCalls).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await tick(0);
    expect(libraryCalls).toHaveLength(2);
    await page.dispose();
  });

  it('reads once more after a read that was running when the teacher came back', async () => {
    for (const outcome of ['answers', 'fails'] as const) {
      const old = deferred<Response>();
      library = () => old.promise;
      libraryCalls.length = 0;
      const { sink, page } = await mountProbe();
      await setHidden(true);
      // Meanwhile another tab changes the library; then the teacher returns,
      // with both a visibility change and a focus.
      library = () => json({ materials: [source('fresh')], limits: LIMITS });
      await setHidden(false);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(libraryCalls, outcome).toHaveLength(1);

      await act(async () =>
        old.resolve(
          outcome === 'answers'
            ? json({ materials: [source('old')], limits: LIMITS })
            : json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503),
        ),
      );
      await tick(0);
      // Exactly one more read, however many signals arrived, and it wins.
      expect(libraryCalls, outcome).toHaveLength(2);
      expect(
        sink.current?.materials.map((m) => m.materialId),
        outcome,
      ).toEqual(['fresh']);
      await tick(MATERIAL_LIBRARY_POLL_MS * 3);
      expect(libraryCalls, outcome).toHaveLength(2);
      await page.dispose();
    }
  });

  it('reads again when the run reports a material change, in the same folder', async () => {
    const { page } = await mountProbe({ kind: 'folder', folderId: 'f1' });
    await act(async () => {
      useWorkbenchStore.setState((state) => ({
        materialLibraryRevision: state.materialLibraryRevision + 1,
      }));
    });
    await tick(0);
    expect(libraryCalls.map((params) => params.get('folderId'))).toEqual(['f1', 'f1']);
    await page.dispose();
  });

  it('leaves no timer or request behind once the page is gone', async () => {
    library = () =>
      json({ materials: [source('a', { extraction: { status: 'running' } })], limits: LIMITS });
    const { page } = await mountProbe();
    await page.dispose();
    await tick(MATERIAL_LIBRARY_POLL_MS * 3);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(libraryCalls).toHaveLength(1);
  });

  it('says a folder deleted elsewhere is gone, and leaves going back to the teacher', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await tick(0);
    await page.click('kb-scope-folder-f1');
    await tick(0);
    expect(page.query('kb-scope-folder-f1')?.getAttribute('aria-current')).toBe('page');

    // Another tab deleted it; the next read no longer lists it.
    folders = () => json({ folders: [] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await tick(0);
    expect(page.query('kb-folder-gone')).not.toBeNull();
    // The refresh did not navigate: still the same folder, no other scope read.
    expect(libraryCalls.map((params) => params.get('folderId'))).toEqual([null, 'f1', 'f1']);
    expect(page.query('kb-scope-all')?.getAttribute('aria-current')).toBeNull();

    await page.click('kb-folder-gone-back');
    await tick(0);
    expect(page.query('kb-folder-gone')).toBeNull();
    expect(page.query('kb-scope-all')?.getAttribute('aria-current')).toBe('page');
    expect(libraryCalls.at(-1)?.get('folderId')).toBeNull();
    await page.dispose();
  });
});

describe('uploading from the page', () => {
  const file = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
  async function choose(page: ReturnType<typeof mount>, files: File[]) {
    const input = page.query('kb-upload-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('shows the file uploading, then reads the list again once it is stored', async () => {
    const stored = deferred<Response>();
    uploadMaterial = () => stored.promise;
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const reads = libraryCalls.length;

    await choose(page, [file('lesson.pdf')]);
    await settle();
    expect(page.query('kb-uploads')?.textContent).toContain('lesson.pdf');
    expect(page.query('kb-uploads')?.textContent).toContain(
      'workspace.knowledgeBase.status.uploading',
    );

    await act(async () =>
      stored.resolve(json({ materialId: 'm1', originalName: 'lesson.pdf', bytes: 4 }, 201)),
    );
    await settle();
    expect(page.query('kb-uploads')).toBeNull();
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('uploads into Unfiled from a folder, and says so', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await page.click('kb-scope-folder-f1');
    await settle();

    await choose(page, [file('notes.pdf')]);
    await settle();
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.url).toBe('/api/materials');
    expect(JSON.stringify(uploadCalls[0]!.init.headers)).not.toMatch(/folder/i);
    expect(page.query('kb-upload-to-unfiled')?.textContent).toBe(
      'workspace.knowledgeBase.upload.toUnfiled',
    );
    // The teacher stays in the folder; leaving it drops the note.
    expect(page.query('kb-scope-folder-f1')?.getAttribute('aria-current')).toBe('page');
    await page.click('kb-scope-unfiled');
    expect(page.query('kb-upload-to-unfiled')).toBeNull();
    await page.dispose();
  });

  it('says why an upload was refused, with the shared messages, until dismissed', async () => {
    const pool = json(
      { success: false, errorCode: 'ASSET_QUOTA_EXCEEDED', error: 'asset storage quota exceeded' },
      507,
    );
    pool.headers.set('x-request-id', 'trace-507');
    const refusals: Record<string, Response> = {
      'big.pdf': json({ error: 'too large', maxBytes: 50 * 1024 * 1024 }, 413),
      'quota.pdf': json({ error: 'quota' }, 429),
      'odd.pdf': json({ error: 'type' }, 415),
      'full.pdf': pool,
    };
    uploadMaterial = (chosen) => refusals[chosen.name]!;
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const reads = libraryCalls.length;

    await choose(page, [file('big.pdf'), file('quota.pdf'), file('odd.pdf'), file('full.pdf')]);
    await settle();
    const text = page.query('kb-uploads')?.textContent ?? '';
    expect(text).toContain('workbench.material.fileTooLargeWithLimit{"limit":"50"}');
    expect(text).toContain('workbench.material.quotaExceeded');
    expect(text).toContain('workbench.material.unsupportedType');
    // The pool quota has its own words; the trace stays out of the row.
    expect(text).toContain('workbench.material.storageFull');
    expect(text).not.toContain('trace-507');
    expect(text).not.toContain('asset storage quota exceeded');
    // Each file, once done, has the list read again.
    expect(libraryCalls.length).toBe(reads + 4);

    await page.click('kb-upload-1-dismiss');
    expect(page.query('kb-upload-1')).toBeNull();
    expect(page.query('kb-upload-2')).not.toBeNull();
    await page.dispose();
  });

  it('shows a file the server stored even though its answer failed', async () => {
    // The publication committed, then the reply was lost: the route answers
    // 500 and the listing already has the source.
    let stored = false;
    uploadMaterial = () => {
      stored = true;
      return json({ success: false, errorCode: 'INTERNAL_ERROR', error: 'upload failed' }, 500);
    };
    library = () =>
      json({ materials: stored ? [source('kept', { name: 'kept.pdf' })] : [], limits: LIMITS });
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();

    await choose(page, [file('kept.pdf')]);
    await settle();
    expect(page.query('kb-material-kept')).not.toBeNull();
    // The failure is still reported, not turned into a success.
    expect(page.query('kb-upload-1')?.textContent).toContain('upload failed');
    await page.dispose();
  });

  it('polls while an upload is in flight, though nothing shown is parsing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stored = deferred<Response>();
      uploadMaterial = () => stored.promise;
      const tick = (milliseconds: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(milliseconds);
        });
      const page = mount();
      await page.render(createElement(MaterialLibraryPage));
      await tick(0);
      await choose(page, [file('slow.pdf')]);
      const reads = libraryCalls.length;

      await tick(MATERIAL_LIBRARY_POLL_MS);
      expect(libraryCalls.length).toBe(reads + 1);
      await act(async () =>
        stored.resolve(json({ materialId: 'm1', originalName: 'slow.pdf', bytes: 4 }, 201)),
      );
      await tick(0);
      const settled = libraryCalls.length;
      await tick(MATERIAL_LIBRARY_POLL_MS * 3);
      expect(libraryCalls.length).toBe(settled);
      await page.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('organizing from the page', () => {
  const inDocument = (testId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const openMenu = async (testId: string) => {
    const trigger = inDocument(testId)!;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
      );
      trigger.click();
    });
  };
  const choose = (testId: string) =>
    act(async () => {
      inDocument(testId)!.click();
    });
  const typeName = async (value: string) => {
    const input = inDocument('kb-name-dialog-input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submitName = async () => {
    await choose('kb-name-dialog-submit');
    await settle();
  };

  beforeEach(() => {
    library = (params) =>
      json({
        materials:
          params.get('folderId') === 'f1'
            ? [source('in-f1', { folderId: 'f1', folderName: 'Unit 1' })]
            : [source('a')],
        limits: LIMITS,
      });
  });

  it('renames a source from its menu, then reads the list again', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const reads = libraryCalls.length;

    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-rename');
    expect((inDocument('kb-name-dialog-input') as HTMLInputElement).value).toBe('a.pdf');
    await typeName('  Chapter 1  ');
    await submitName();

    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/a', body: { name: 'Chapter 1' } },
    ]);
    expect(inDocument('kb-name-dialog')).toBeNull();
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('keeps a refused rename in its dialog, in the server’s terms, and still re-reads', async () => {
    writeMaterial = () =>
      json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'taken', reason: 'name_taken' },
        409,
      );
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    const reads = libraryCalls.length;

    await openMenu('kb-folder-menu-f1');
    await choose('kb-folder-menu-f1-rename');
    await typeName('Unit 2');
    await submitName();

    expect(writeCalls).toEqual([
      { method: 'PATCH', path: '/api/materials/folders/f1', body: { name: 'Unit 2' } },
    ]);
    expect(inDocument('kb-name-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.nameTaken',
    );
    expect(inDocument('kb-name-dialog')).not.toBeNull();
    expect(libraryCalls.length).toBe(reads + 1);
    await page.dispose();
  });

  it('hints at an empty or overlong folder name before asking the server', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await openMenu('kb-folder-menu-f1');
    await choose('kb-folder-menu-f1-rename');

    await typeName('   ');
    await submitName();
    expect(inDocument('kb-name-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.folderNameEmpty',
    );
    await typeName('一'.repeat(21));
    await submitName();
    expect(inDocument('kb-name-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.folderNameTooLong',
    );
    expect(writeCalls).toEqual([]);
    await page.dispose();
  });

  it('moves a source into a folder, or back to Unfiled with null', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    // Already in Unfiled: only the folder is offered.
    expect(inDocument('kb-move-to-unfiled')).toBeNull();
    await choose('kb-move-to-f1');
    await settle();
    expect(writeCalls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/materials/move',
      body: { materialIds: ['a'], folderId: 'f1' },
    });
    expect(inDocument('kb-move-dialog')).toBeNull();

    await page.click('kb-scope-folder-f1');
    await settle();
    await openMenu('kb-material-menu-in-f1');
    await choose('kb-material-menu-in-f1-move');
    expect(inDocument('kb-move-to-f1')).toBeNull();
    await choose('kb-move-to-unfiled');
    await settle();
    expect(writeCalls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/materials/move',
      body: { materialIds: ['in-f1'], folderId: null },
    });
    await page.dispose();
  });

  it('says why a move was refused, never as a success', async () => {
    writeMaterial = () =>
      json(
        {
          success: false,
          errorCode: 'INVALID_REQUEST',
          error: 'no',
          reason: 'not_movable',
          materialIds: ['a'],
        },
        422,
      );
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await openMenu('kb-material-menu-a');
    await choose('kb-material-menu-a-move');
    await choose('kb-move-to-f1');
    await settle();
    expect(inDocument('kb-move-dialog-error')?.textContent).toBe(
      'workspace.knowledgeBase.error.notMovable',
    );
    expect(inDocument('kb-move-dialog')).not.toBeNull();
    await page.dispose();
  });

  it('creates a folder and opens it; a name already taken opens that folder', async () => {
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();

    folders = () =>
      json({
        folders: [
          { id: 'f1', name: 'Unit 1', materialCount: 2 },
          { id: 'f-new', name: 'New', materialCount: 0 },
        ],
      });
    await page.click('kb-folder-new');
    await typeName('New');
    await submitName();
    expect(writeCalls).toEqual([
      { method: 'POST', path: '/api/materials/folders', body: { name: 'New' } },
    ]);
    expect(page.query('kb-scope-folder-f-new')?.getAttribute('aria-current')).toBe('page');
    expect(libraryCalls.at(-1)?.get('folderId')).toBe('f-new');

    writeMaterial = () => json({ folder: { id: 'f1', name: 'Unit 1' }, created: false }, 200);
    await page.click('kb-folder-new');
    await typeName('unit 1');
    await submitName();
    expect(page.query('kb-scope-folder-f1')?.getAttribute('aria-current')).toBe('page');
    expect(inDocument('kb-name-dialog')).toBeNull();
    await page.dispose();
  });

  it('does not read the list for a page the teacher left before a write answered', async () => {
    for (const action of ['rename', 'move', 'create'] as const) {
      const answer = deferred<Response>();
      writeMaterial = () => answer.promise;
      writeCalls.length = 0;
      const page = mount();
      await page.render(createElement(MaterialLibraryPage));
      await settle();
      if (action === 'create') {
        await page.click('kb-folder-new');
        await typeName('Later');
        await choose('kb-name-dialog-submit');
      } else if (action === 'rename') {
        await openMenu('kb-material-menu-a');
        await choose('kb-material-menu-a-rename');
        await typeName('Later');
        await choose('kb-name-dialog-submit');
      } else {
        await openMenu('kb-material-menu-a');
        await choose('kb-material-menu-a-move');
        await choose('kb-move-to-f1');
      }
      expect(writeCalls, action).toHaveLength(1);

      await page.dispose();
      const reads = libraryCalls.length;
      const folderReads = vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input) === '/api/materials/folders').length;
      await act(async () =>
        answer.resolve(
          action === 'create'
            ? json({ folder: { id: 'f-late', name: 'Later' }, created: true }, 201)
            : json({ status: 'renamed' }),
        ),
      );
      await settle();
      expect(libraryCalls.length, action).toBe(reads);
      expect(
        vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/materials/folders')
          .length,
        action,
      ).toBe(folderReads);
    }
  });

  it('names the folder limit, a vanished item and a busy owner', async () => {
    const answers = [
      json({ success: false, errorCode: 'INVALID_REQUEST', error: 'x', reason: 'limit' }, 409),
      new Response('Not found', { status: 404 }),
      json({ error: { code: 'OWNER_BUSY', message: 'busy' } }, 503),
    ];
    writeMaterial = () => answers.shift()!;
    const page = mount();
    await page.render(createElement(MaterialLibraryPage));
    await settle();
    await page.click('kb-folder-new');
    await typeName('Another');
    const shown: (string | null | undefined)[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await submitName();
      shown.push(inDocument('kb-name-dialog-error')?.textContent);
    }
    expect(shown).toEqual([
      'workspace.knowledgeBase.error.folderLimit',
      'workspace.knowledgeBase.error.gone',
      'workspace.knowledgeBase.error.busy',
    ]);
    await page.dispose();
  });
});

describe('the library client', () => {
  it('reads all three refusal shapes', async () => {
    await expect(
      materialLibraryErrorOf(
        json({ success: false, errorCode: 'X', error: 'e', reason: 'not_empty' }, 409),
      ),
    ).resolves.toMatchObject({ status: 409, reason: 'not_empty', code: 'X' });
    await expect(
      materialLibraryErrorOf(json({ error: { code: 'OWNER_BUSY', message: 'm' } }, 503)),
    ).resolves.toMatchObject({ status: 503, code: 'OWNER_BUSY' });
    await expect(
      materialLibraryErrorOf(new Response('Not found', { status: 404 })),
    ).resolves.toMatchObject({ status: 404, reason: undefined, code: undefined });
  });

  it('formats byte counts for people', () => {
    expect(formatMaterialBytes(512, 'en-US')).toBe('512 B');
    expect(formatMaterialBytes(1536, 'en-US')).toBe('1.5 KB');
    expect(formatMaterialBytes(50 * 1024 * 1024, 'en-US')).toBe('50 MB');
  });
});
