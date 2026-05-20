/**
 * SessionSight Anonymous-tier Web Worker.
 *
 * HTTP-only batched transport for the anonymous (cookieless / no-consent)
 * tier. Mirrors the buffer + flush lifecycle of `worker.ts` but strips out:
 *   - WebSocket transport (no streaming; HTTP batching is enough)
 *   - visitor-token machinery (no per-visitor identity)
 *   - mirror buffer / ack grace (no per-event seq; HTTP-only one-shot delivery)
 *   - identity / customProperties / metadata fields
 *
 * Receives anonymous events from the main thread (`AnonymousCapture`), batches
 * on a 6s timer or 50-event threshold, POSTs to `/v1/ingest/anonymous` with
 * keepalive=true on final flushes. Bundled and inlined via build.ts the same
 * way the full-tier worker is.
 */

import { MAX_KEEPALIVE_BYTES } from './_transport-shared.js';

const FLUSH_INTERVAL_MS = 6_000;
const FLUSH_EVENT_THRESHOLD = 50;
const MAX_EVENTS_PER_REQUEST = 100;

// ── Worker state ─────────────────────────────────────────────────

let apiUrl = '';
let publicApiKey = '';
let propertyId = '';
let ephemeralVisitorId = '';
let ephemeralSessionId = '';
let killed = false;
let closed = false;

const buffer: any[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function utcDayString(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function flush(isFinal: boolean = false): Promise<void> {
  if (killed || buffer.length === 0) return;
  const events = buffer.splice(0, MAX_EVENTS_PER_REQUEST);
  const now = Date.now();
  const body = JSON.stringify({
    propertyId,
    apiKey: publicApiKey,
    day: utcDayString(now),
    ephemeralVisitorId,
    ephemeralSessionId,
    events,
  });
  const useKeepalive = body.length < MAX_KEEPALIVE_BYTES;
  try {
    const res = await fetch(`${apiUrl}/v1/ingest/anonymous`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': publicApiKey,
      },
      body,
      keepalive: useKeepalive || isFinal,
    });
    if (res.status === 401 || res.status === 403) {
      // Anonymous endpoint rejection is terminal for this worker: either the
      // API key was revoked or the origin no longer matches. Drop further
      // events so we don't loop on rejections.
      killed = true;
      self.postMessage({ type: 'killed', reason: 'invalid_api_key' });
      return;
    }
    if (res.status === 402) {
      killed = true;
      self.postMessage({ type: 'killed', reason: 'subscription_required' });
      return;
    }
    // 429 / 5xx: events already drained from buffer. Don't retry — anonymous
    // counters are best-effort; an over-eager retry loop on a flapping endpoint
    // would amplify load. The next 6s tick brings fresh events anyway.
  } catch {
    // network failure; drop this batch silently
  }

  // Drain any remainder if we capped at MAX_EVENTS_PER_REQUEST above.
  if (buffer.length > 0 && !isFinal) {
    // tail-call via microtask so we don't deepen the stack
    queueMicrotask(() => { void flush(false); });
  }
}

self.onmessage = (e: MessageEvent) => {
  try {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        apiUrl = msg.apiUrl;
        publicApiKey = msg.publicApiKey;
        propertyId = msg.propertyId;
        ephemeralVisitorId = msg.ephemeralVisitorId;
        ephemeralSessionId = msg.ephemeralSessionId;
        killed = false;
        closed = false;
        buffer.length = 0;
        if (flushTimer) clearInterval(flushTimer);
        flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
        break;

      case 'event':
        if (killed || closed) break;
        buffer.push(msg.event);
        if (buffer.length >= FLUSH_EVENT_THRESHOLD) void flush();
        break;

      case 'flush':
        void flush();
        break;

      case 'flush-final':
        closed = true;
        if (flushTimer) {
          clearInterval(flushTimer);
          flushTimer = null;
        }
        void flush(true);
        break;
    }
  } catch (err) {
    console.warn('SessionSight anonymous worker: error handling message', err);
  }
};
