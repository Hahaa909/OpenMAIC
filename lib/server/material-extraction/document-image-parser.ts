/** Isolate Markdown/HTML parsing from the shared server event loop. */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isTransientExtractionError, MaterialExtractionError } from './errors';
import type { ImagePlan, ImageReference } from './document-image-apply.mjs';
import type { ImagePathIndex } from './document-images';

type PlanJob = { kind: 'plan'; text: string };
type RewriteJob = {
  kind: 'rewrite';
  blocks: Array<{ type: string; text?: string }>;
  index: ImagePathIndex;
};
type RewriteResult = { text: string; refs: ImageReference[] };
type Result = ImagePlan | RewriteResult;

/** A parser failure must end this extraction rather than try another provider. */
export class DocumentImageParseError extends MaterialExtractionError {
  constructor(cause: unknown) {
    super(
      `Document image parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      isTransientExtractionError(cause),
      { cause },
    );
    this.name = 'DocumentImageParseError';
  }
}

const MAX_PARSER_WORKERS = 2;
// Measured against the A/B/C fixtures in the hardening evidence, including
// parser/module loading; A and B retain at least twice the observed heap headroom.
const MAX_PARSER_OLD_GENERATION_MB = 512;
let running = 0;
const pending: Array<() => void> = [];
interface ParseTask {
  promise: Promise<Result>;
  cancel: () => void;
  subscribers: number;
  abandoned: boolean;
}
const inFlightPlans = new Map<string, ParseTask>();

function drain() {
  while (running < MAX_PARSER_WORKERS && pending.length) pending.shift()!();
}

function enqueue(job: PlanJob | RewriteJob): ParseTask {
  const task: ParseTask = {
    promise: undefined!,
    cancel: () => {},
    subscribers: 0,
    abandoned: false,
  };
  task.promise = new Promise((resolve, reject) => {
    const start = () => {
      running++;
      let worker: Worker;
      try {
        // Keep this literal inside new Worker: Turbopack replaces it with the
        // bundled worker chunk used by standalone deployments.
        worker = new Worker(
          join(process.cwd(), 'lib/server/material-extraction/document-image-worker.mjs'),
          {
            workerData: job,
            resourceLimits: { maxOldGenerationSizeMb: MAX_PARSER_OLD_GENERATION_MB },
          },
        );
      } catch (error) {
        running--;
        reject(new DocumentImageParseError(error));
        drain();
        return;
      }
      let settled = false;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Release the slot only after the old worker really stops.
        void worker.terminate().then(
          () => {
            running--;
            if (error) reject(new DocumentImageParseError(error));
            else resolve(result!);
            drain();
          },
          (terminationError) => {
            running--;
            reject(new DocumentImageParseError(terminationError));
            drain();
          },
        );
      };
      // Time in the queue is excluded from the worker's 30-second budget.
      task.cancel = () => finish(new Error('aborted'));
      const timer = setTimeout(
        () => finish(new Error('Document image parse exceeded 30s')),
        30_000,
      );
      worker.once('message', (message: { error?: string; result?: Result }) => {
        if (message.error || !message.result)
          finish(new Error(message.error ?? 'Document image worker returned no result'));
        else finish(undefined, message.result);
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) =>
        finish(new Error(`Document image worker exited before its result (${code})`)),
      );
    };
    task.cancel = () => {
      const at = pending.indexOf(start);
      if (at !== -1) pending.splice(at, 1);
      reject(new Error('aborted'));
    };
    pending.push(start);
    drain();
  });
  return task;
}

function subscribe(task: ParseTask, signal?: AbortSignal): Promise<Result> {
  task.subscribers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      task.subscribers--;
    };
    const abort = () => {
      if (settled) return;
      release();
      reject(new Error('aborted'));
      if (task.subscribers === 0) {
        task.abandoned = true;
        task.cancel();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    void task.promise.then(
      (result) => {
        if (settled) return;
        release();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        release();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

export function runDocumentImageWorker(
  job: PlanJob,
  cacheKey?: string,
  signal?: AbortSignal,
): Promise<ImagePlan>;
export function runDocumentImageWorker(job: RewriteJob): Promise<RewriteResult>;
export function runDocumentImageWorker(
  job: PlanJob | RewriteJob,
  cacheKey?: string,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  if (job.kind !== 'plan' || cacheKey === undefined) return subscribe(enqueue(job), signal);
  const shared = inFlightPlans.get(cacheKey);
  if (shared && !shared.abandoned) return subscribe(shared, signal);
  const work = enqueue(job);
  inFlightPlans.set(cacheKey, work);
  const remove = () => {
    if (inFlightPlans.get(cacheKey) === work) inFlightPlans.delete(cacheKey);
  };
  // Both success and failure end the in-flight entry; this is not a result cache.
  void work.promise.then(remove, remove);
  return subscribe(work, signal);
}
