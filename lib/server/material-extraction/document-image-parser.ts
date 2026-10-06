/** Isolate Markdown/HTML parsing from the shared server event loop. */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
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

const MAX_PARSER_WORKERS = 2;
// Measured against the A/B/C fixtures in the hardening evidence, including
// parser/module loading; A and B retain at least twice the observed heap headroom.
const MAX_PARSER_OLD_GENERATION_MB = 512;
let running = 0;
const pending: Array<() => void> = [];
const inFlightPlans = new Map<string, Promise<Result>>();

function drain() {
  while (running < MAX_PARSER_WORKERS && pending.length) pending.shift()!();
}

function enqueue(job: PlanJob | RewriteJob): Promise<Result> {
  return new Promise((resolve, reject) => {
    pending.push(() => {
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
        reject(error);
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
            if (error) reject(error);
            else resolve(result!);
            drain();
          },
          (terminationError) => {
            running--;
            reject(terminationError);
            drain();
          },
        );
      };
      // Time in the queue is excluded from the worker's 30-second budget.
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
    });
    drain();
  });
}

export function runDocumentImageWorker(job: PlanJob, cacheKey?: string): Promise<ImagePlan>;
export function runDocumentImageWorker(job: RewriteJob): Promise<RewriteResult>;
export function runDocumentImageWorker(
  job: PlanJob | RewriteJob,
  cacheKey?: string,
): Promise<Result> {
  if (job.kind !== 'plan' || cacheKey === undefined) return enqueue(job);
  const shared = inFlightPlans.get(cacheKey);
  if (shared) return shared;
  const work = enqueue(job);
  inFlightPlans.set(cacheKey, work);
  const remove = () => {
    if (inFlightPlans.get(cacheKey) === work) inFlightPlans.delete(cacheKey);
  };
  // Both success and failure end the in-flight entry; this is not a result cache.
  void work.then(remove, remove);
  return work;
}
