import { afterEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import {
  DocumentImageParseError,
  runDocumentImageWorker,
} from '@/lib/server/material-extraction/document-image-parser';

const state = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>,
  worker: undefined as (EventEmitter & { terminate: ReturnType<typeof vi.fn> }) | undefined,
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: vi.fn(function () {
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
      worker.terminate = vi.fn(async () => 0);
      state.worker = worker;
      state.workers.push(worker);
      return worker;
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('loads the parser worker from its source path', async () => {
  const job = runDocumentImageWorker({ kind: 'plan', text: 'text' });
  expect(vi.mocked(Worker).mock.calls.at(-1)?.[0]).toBe(
    `${process.cwd()}/lib/server/material-extraction/document-image-worker.mjs`,
  );
  state.worker!.emit('message', { result: { markdown: [], html: [] } });
  await expect(job).resolves.toEqual({ markdown: [], html: [] });
});

it('terminates a timed-out parser and clears its timer', async () => {
  vi.useFakeTimers();
  const job = runDocumentImageWorker({ kind: 'plan', text: 'text' });
  const rejected = expect(job).rejects.toThrow('exceeded 30s');
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(state.worker!.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['error', 'exit'])('terminates a parser after %s before its result', async (event) => {
  vi.useFakeTimers();
  const job = runDocumentImageWorker({ kind: 'plan', text: 'text' });
  const rejected = expect(job).rejects.toThrow(
    event === 'error' ? 'worker failed' : 'before its result',
  );
  state.worker!.emit(event, event === 'error' ? new Error('worker failed') : 0);
  await rejected;
  expect(state.worker!.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for termination before handing the result to its caller', async () => {
  vi.useFakeTimers();
  let terminate!: () => void;
  const job = runDocumentImageWorker({ kind: 'plan', text: 'text' });
  state.worker!.terminate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        terminate = resolve;
      }),
  );
  let done = false;
  void job.then(() => {
    done = true;
  });
  state.worker!.emit('message', { result: { markdown: [], html: [] } });
  await Promise.resolve();
  expect(done).toBe(false);
  terminate();
  await expect(job).resolves.toEqual({ markdown: [], html: [] });
  expect(vi.getTimerCount()).toBe(0);
});

it('sets a measured heap limit and caps mixed plan/rewrite jobs at two workers', async () => {
  const start = state.workers.length;
  const jobs = [
    runDocumentImageWorker({ kind: 'plan', text: 'first' }),
    runDocumentImageWorker({
      kind: 'rewrite',
      blocks: [],
      index: { exact: new Map(), byBasename: new Map() },
    }),
    runDocumentImageWorker({ kind: 'plan', text: 'third' }),
    runDocumentImageWorker({ kind: 'plan', text: 'fourth' }),
  ];
  expect(state.workers.length - start).toBe(2);
  expect(vi.mocked(Worker).mock.calls.at(-1)?.[1]?.resourceLimits).toEqual({
    maxOldGenerationSizeMb: 512,
  });
  for (let n = 0; n < 4; n++) {
    state.workers[start + n].emit('message', { result: { markdown: [], html: [] } });
    await jobs[n];
    expect(state.workers.length - start).toBe(Math.min(4, n + 3));
  }
});

it('does not count queue time against the worker timeout', async () => {
  vi.useFakeTimers();
  const start = state.workers.length;
  const first = runDocumentImageWorker({ kind: 'plan', text: 'first' });
  const second = runDocumentImageWorker({ kind: 'plan', text: 'second' });
  const queued = runDocumentImageWorker({ kind: 'plan', text: 'queued' });
  await vi.advanceTimersByTimeAsync(20_000);
  state.workers[start].emit('message', { result: { markdown: [], html: [] } });
  state.workers[start + 1].emit('message', { result: { markdown: [], html: [] } });
  await Promise.all([first, second]);
  const rejected = expect(queued).rejects.toThrow('exceeded 30s');
  await vi.advanceTimersByTimeAsync(29_999);
  expect(state.workers[start + 2].terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['result', 'error'])('shares an immutable plan key including its %s', async (outcome) => {
  const start = state.workers.length;
  const first = runDocumentImageWorker({ kind: 'plan', text: 'shared' }, `same:${outcome}`);
  const second = runDocumentImageWorker({ kind: 'plan', text: 'shared' }, `same:${outcome}`);
  expect(state.workers.length - start).toBe(1);
  const results = Promise.allSettled([first, second]);
  state.workers[start].emit(
    outcome === 'error' ? 'error' : 'message',
    outcome === 'error' ? new Error('shared failure') : { result: { markdown: [], html: [] } },
  );
  const [a, b] = await results;
  expect(a.status).toBe(outcome === 'error' ? 'rejected' : 'fulfilled');
  expect(b).toEqual(a);
  if (a.status === 'rejected' && b.status === 'rejected') expect(b.reason).toBe(a.reason);
  if (a.status === 'fulfilled' && b.status === 'fulfilled') expect(b.value).toBe(a.value);
  const retried = runDocumentImageWorker({ kind: 'plan', text: 'shared' }, `same:${outcome}`);
  expect(state.workers.length - start).toBe(2);
  state.workers[start + 1].emit('message', { result: { markdown: [], html: [] } });
  await retried;
});

it('releases a failed worker slot and starts the queued job', async () => {
  const start = state.workers.length;
  const failed = runDocumentImageWorker({ kind: 'plan', text: 'oom' });
  const caught = expect(failed).rejects.toThrow('out of memory');
  const other = runDocumentImageWorker({ kind: 'plan', text: 'other' });
  const queued = runDocumentImageWorker({ kind: 'plan', text: 'queued' });
  state.workers[start].emit(
    'error',
    Object.assign(new Error('out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
  );
  await caught;
  expect(state.workers.length - start).toBe(3);
  for (const worker of state.workers.slice(start + 1))
    worker.emit('message', { result: { markdown: [], html: [] } });
  await Promise.all([other, queued]);
});

it('aborts one shared subscriber while the other still completes', async () => {
  const start = state.workers.length;
  const controller = new AbortController();
  const canceled = runDocumentImageWorker(
    { kind: 'plan', text: 'shared' },
    'shared-abort',
    controller.signal,
  );
  const remaining = runDocumentImageWorker({ kind: 'plan', text: 'shared' }, 'shared-abort');
  const rejected = expect(canceled).rejects.toThrow('aborted');
  controller.abort();
  await rejected;
  expect(state.workers[start].terminate).not.toHaveBeenCalled();
  state.workers[start].emit('message', { result: { markdown: [], html: [] } });
  await expect(remaining).resolves.toEqual({ markdown: [], html: [] });
  expect(state.workers.length - start).toBe(1);
});

it('removes the last canceled queued subscriber without starting its worker', async () => {
  const start = state.workers.length;
  const first = runDocumentImageWorker({ kind: 'plan', text: 'first' });
  const second = runDocumentImageWorker({ kind: 'plan', text: 'second' });
  const controller = new AbortController();
  const queued = runDocumentImageWorker(
    { kind: 'plan', text: 'queued' },
    'queued-abort',
    controller.signal,
  );
  const rejected = expect(queued).rejects.toThrow('aborted');
  controller.abort();
  await rejected;
  state.workers[start].emit('message', { result: { markdown: [], html: [] } });
  state.workers[start + 1].emit('message', { result: { markdown: [], html: [] } });
  await Promise.all([first, second]);
  expect(state.workers.length - start).toBe(2);
});

it('terminates the last canceled worker and lets a new subscriber start fresh', async () => {
  const start = state.workers.length;
  const controller = new AbortController();
  const canceled = runDocumentImageWorker(
    { kind: 'plan', text: 'old' },
    'last-abort',
    controller.signal,
  );
  const rejected = expect(canceled).rejects.toThrow('aborted');
  controller.abort();
  await rejected;
  expect(state.workers[start].terminate).toHaveBeenCalledOnce();
  const fresh = runDocumentImageWorker({ kind: 'plan', text: 'fresh' }, 'last-abort');
  expect(state.workers.length - start).toBe(2);
  state.workers[start + 1].emit('message', { result: { markdown: [], html: [] } });
  await fresh;
});

it('rejects an already canceled request without starting a worker', async () => {
  const start = state.workers.length;
  const controller = new AbortController();
  controller.abort();
  await expect(
    runDocumentImageWorker({ kind: 'plan', text: 'text' }, 'already-abort', controller.signal),
  ).rejects.toThrow('aborted');
  expect(state.workers.length).toBe(start);
});

it('identifies a real worker timeout as a parse failure', async () => {
  vi.useFakeTimers();
  const job = runDocumentImageWorker({ kind: 'plan', text: 'timeout' });
  const rejected = expect(job).rejects.toBeInstanceOf(DocumentImageParseError);
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  // Preserve the pre-existing classification for this exact timeout message.
  await expect(job).rejects.toMatchObject({
    retryable: false,
    cause: { message: 'Document image parse exceeded 30s' },
  });
});
