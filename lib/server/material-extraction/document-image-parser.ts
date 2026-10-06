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

export function runDocumentImageWorker(job: PlanJob): Promise<ImagePlan>;
export function runDocumentImageWorker(job: RewriteJob): Promise<RewriteResult>;
export function runDocumentImageWorker(
  job: PlanJob | RewriteJob,
): Promise<ImagePlan | RewriteResult> {
  return new Promise((resolve, reject) => {
    // Keep this path a literal inside `new Worker(...)`: Turbopack rewrites it
    // at build time into a worker chunk that bundles the parser's
    // dependencies. A path computed elsewhere is spawned as the raw .mjs, which
    // cannot resolve them in a standalone deployment.
    const worker = new Worker(
      join(process.cwd(), 'lib/server/material-extraction/document-image-worker.mjs'),
      { workerData: job },
    );
    let settled = false;
    const finish = (error?: Error, result?: ImagePlan | RewriteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for termination before returning, including timeout/error paths.
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(result!);
      }, reject);
    };
    const timer = setTimeout(() => finish(new Error('Document image parse exceeded 30s')), 30_000);
    worker.once('message', (message: { error?: string; result?: ImagePlan | RewriteResult }) => {
      if (message.error || !message.result)
        finish(new Error(message.error ?? 'Document image worker returned no result'));
      else finish(undefined, message.result);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) =>
      finish(new Error(`Document image worker exited before its result (${code})`)),
    );
  });
}
