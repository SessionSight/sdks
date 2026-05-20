/**
 * AnonymousWorkerBridge: main-thread coordinator for the anonymous-tier
 * worker. Owns a dedicated Web Worker that batches and POSTs anonymous
 * events to /v1/ingest/anonymous, falling back to a main-thread HTTP loop
 * when Workers are unavailable.
 *
 * Stripped-down companion to `WorkerBridge`: no WebSocket, no visitor token,
 * no per-event seq/mirror buffer, no identify/customProperties pipeline.
 * Just batched fire-and-forget HTTP delivery.
 */

import { createInlineAnonymousWorker } from './anonymous-worker-inline.js';
import { MAX_KEEPALIVE_BYTES } from './_transport-shared.js';
import type { AnonymousEvent } from './anonymous-capture.js';

const FLUSH_INTERVAL_MS = 6_000;
const FLUSH_EVENT_THRESHOLD = 50;
const MAX_EVENTS_PER_REQUEST = 100;

export class AnonymousWorkerBridge {
  private worker: Worker | null = null;
  private apiUrl: string;
  private publicApiKey: string;
  private propertyId: string;
  private ephemeralVisitorId: string;
  private ephemeralSessionId: string;
  private killed = false;

  // Fallback buffer + timer (used when Workers are unavailable).
  private fallbackBuffer: AnonymousEvent[] = [];
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  private onKilledCallbacks: Array<() => void> = [];

  constructor(opts: {
    apiUrl: string;
    publicApiKey: string;
    propertyId: string;
    ephemeralVisitorId: string;
    ephemeralSessionId: string;
  }) {
    this.apiUrl = opts.apiUrl;
    this.publicApiKey = opts.publicApiKey;
    this.propertyId = opts.propertyId;
    this.ephemeralVisitorId = opts.ephemeralVisitorId;
    this.ephemeralSessionId = opts.ephemeralSessionId;

    const worker = createInlineAnonymousWorker();
    if (worker) {
      this.worker = worker;
      this.worker.onmessage = this.handleWorkerMessage;
      this.worker.onerror = () => this.switchToFallback();
      try {
        this.worker.postMessage({
          type: 'init',
          apiUrl: this.apiUrl,
          publicApiKey: this.publicApiKey,
          propertyId: this.propertyId,
          ephemeralVisitorId: this.ephemeralVisitorId,
          ephemeralSessionId: this.ephemeralSessionId,
        });
      } catch {
        this.switchToFallback();
      }
    } else {
      this.initFallback();
    }
  }

  postEvent(event: AnonymousEvent): void {
    if (this.killed) return;
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'event', event });
      } catch {
        this.switchToFallback();
        this.fallbackBuffer.push(event);
        this.maybeFallbackFlush();
      }
    } else {
      this.fallbackBuffer.push(event);
      this.maybeFallbackFlush();
    }
  }

  flush(): void {
    if (this.killed) return;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush' }); } catch {}
    } else {
      void this.fallbackFlush(false);
    }
  }

  /**
   * Final flush before tear-down. Posts `flush-final` to the worker, then
   * gives it room to actually process the message and complete the keepalive
   * fetch before tearing the worker down.
   *
   * The previous behaviour terminated the worker on the next microtask,
   * which raced the worker's flush-final handler: the fetch was initiated
   * inside the worker, the worker died, and dev tools saw the request stuck
   * in "pending" forever because no worker context could read the response
   * (the bytes still flow server-side because of keepalive, but the
   * browser-side promise has nowhere to land). Stop-the-world delay of 5s
   * is generous for the single small HTTP POST the anonymous tier sends.
   */
  flushAndDestroy(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush-final' }); } catch {}
      const w = this.worker;
      this.worker = null;
      // Detach from event loop and terminate as a safety net only.
      setTimeout(() => {
        try { w.terminate(); } catch {}
      }, 5_000);
    } else {
      void this.fallbackFlush(true);
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.killed = true;
  }

  destroy(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.fallbackBuffer = [];
    this.killed = true;
  }

  onKilled(cb: () => void): void {
    this.onKilledCallbacks.push(cb);
  }

  // ── Worker message handling ──────────────────────────────────────

  private handleWorkerMessage = (e: MessageEvent): void => {
    try {
      const msg = e.data;
      if (msg?.type === 'killed') {
        this.killed = true;
        for (const cb of this.onKilledCallbacks) {
          try { cb(); } catch {}
        }
      }
    } catch {
      // ignore
    }
  };

  // ── Main-thread fallback ─────────────────────────────────────────

  private initFallback(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => { void this.fallbackFlush(false); }, FLUSH_INTERVAL_MS);
  }

  private switchToFallback(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    this.initFallback();
  }

  private maybeFallbackFlush(): void {
    if (this.fallbackBuffer.length >= FLUSH_EVENT_THRESHOLD) {
      void this.fallbackFlush(false);
    }
  }

  private async fallbackFlush(isFinal: boolean): Promise<void> {
    if (this.killed || this.fallbackBuffer.length === 0) return;
    const events = this.fallbackBuffer.splice(0, MAX_EVENTS_PER_REQUEST);
    const now = Date.now();
    const body = JSON.stringify({
      propertyId: this.propertyId,
      apiKey: this.publicApiKey,
      day: utcDayString(now),
      ephemeralVisitorId: this.ephemeralVisitorId,
      ephemeralSessionId: this.ephemeralSessionId,
      events,
    });
    const useKeepalive = body.length < MAX_KEEPALIVE_BYTES;
    try {
      const res = await fetch(`${this.apiUrl}/v1/ingest/anonymous`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.publicApiKey,
        },
        body,
        keepalive: useKeepalive || isFinal,
      });
      if (res.status === 401 || res.status === 403 || res.status === 402) {
        this.killed = true;
        if (this.fallbackTimer) {
          clearInterval(this.fallbackTimer);
          this.fallbackTimer = null;
        }
        for (const cb of this.onKilledCallbacks) {
          try { cb(); } catch {}
        }
        return;
      }
    } catch {
      // network failure; drop this batch silently (anonymous counters are
      // best-effort and a retry loop on a flapping endpoint would amplify load)
    }
    if (!isFinal && this.fallbackBuffer.length > 0) {
      // queue another drain on the next microtask
      queueMicrotask(() => { void this.fallbackFlush(false); });
    }
  }
}

function utcDayString(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
