import { afterEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { runDocumentImageWorker } from '@/lib/server/material-extraction/document-image-parser';

const state = vi.hoisted(() => ({
  worker: undefined as (EventEmitter & { terminate: ReturnType<typeof vi.fn> }) | undefined,
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: vi.fn(function () {
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
      worker.terminate = vi.fn(async () => 0);
      state.worker = worker;
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
