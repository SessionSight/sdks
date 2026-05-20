import type { IngestPayload } from './types.js';

// Shared between transport.ts (main browser thread) and worker.ts (web
// worker). These helpers have no DOM/global dependency and are pure
// functions, so they live here and both consumers import them. Hoisted
// from independent copies that had already drifted in subtle ways
// (one capitalized a comment, the other lost an explanatory line).

/**
 * Maximum bytes per keepalive fetch chunk. The fetch API requires the body
 * fit within this limit when `keepalive: true` is set; `chunkEvents`
 * splits larger payloads at this boundary.
 */
export const MAX_KEEPALIVE_BYTES = 60_000;

/**
 * Hard cap on the reconnect backoff delay. The base delay doubles on each
 * failed connect and is jittered; this is the ceiling.
 */
export const MAX_RECONNECT_DELAY = 30_000;

/**
 * Crypto-backed [0, max) float for reconnect jitter. Math.random is banned
 * across this package so a grep for it stays empty. Falls back to 0 jitter
 * if no secure RNG is available; the doubling term alone still prevents
 * tight reconnect loops.
 */
export function secureJitter(max: number): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0]! / 0x1_0000_0000) * max;
  }
  return 0;
}

/**
 * Split a payload's events array into chunks that each fit under
 * `MAX_KEEPALIVE_BYTES` once serialized. Each chunk gets a copy of the
 * envelope (everything except `events`) so consumers can post each chunk
 * as a standalone payload.
 */
export function chunkEvents(payload: IngestPayload): IngestPayload[] {
  const { events, ...rest } = payload;
  if (events.length === 0) return [payload];

  const envelopeSize = JSON.stringify({ ...rest, events: [] }).length;
  const chunks: IngestPayload[] = [];
  let currentEvents: any[] = [];
  let currentSize = envelopeSize;

  for (const event of events) {
    const eventSize = JSON.stringify(event).length + 1;
    if (currentEvents.length > 0 && currentSize + eventSize > MAX_KEEPALIVE_BYTES) {
      chunks.push({ ...rest, events: currentEvents });
      currentEvents = [];
      currentSize = envelopeSize;
    }
    currentEvents.push(event);
    currentSize += eventSize;
  }

  if (currentEvents.length > 0) {
    chunks.push({ ...rest, events: currentEvents });
  }

  return chunks;
}
