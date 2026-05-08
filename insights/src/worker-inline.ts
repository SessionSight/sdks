/**
 * Creates a Web Worker from an inlined blob URL.
 *
 * The WORKER_SOURCE string is imported from _worker-bundle.ts, which is generated
 * by running `bun run build:worker` (or the full `bun run build`).
 * Run `bun run build:worker` once before starting the dev server.
 */

import { WORKER_SOURCE } from './_worker-bundle.js';

export function createInlineWorker(): Worker | null {
  try {
    if (typeof Worker === 'undefined' || !WORKER_SOURCE) return null;
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return worker;
  } catch (e) {
    console.warn('SessionSight: failed to create worker, using main-thread fallback', e);
    return null;
  }
}
