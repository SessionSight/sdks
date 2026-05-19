/**
 * SessionSight Insights Web Worker
 *
 * Owns the event buffer, flush lifecycle, and WebSocket/HTTP transport.
 * Receives pre-masked events from the main thread via postMessage.
 * This file is bundled into a string and inlined as a blob URL at build time.
 */

// ── Types (inlined to avoid cross-bundle imports) ────────────────

interface IngestPayload {
  sessionId: string;
  propertyId: string;
  visitorId: string;
  events: any[];
  metadata?: SessionMetadata;
  // Customer-supplied identity slots. The SDK's `identify({id?, email?})`
  // routes here. Backend maps `id` -> DB column `userId`.
  id?: string | null;
  email?: string | null;
  customProperties?: Record<string, string | number | boolean>;
  seqStart?: number;
  seqEnd?: number;
  final?: boolean;
}

interface SessionMetadata {
  url: string;
  referrer: string;
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  language: string;
}

interface PrivacyConfig {
  privacyMode: 'default' | 'relaxed';
  excludePages: string[];
}

// ── Configuration ────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 6_000;

/**
 * Crypto-backed [0, max) float for reconnect jitter. Math.random is banned
 * across this package so a grep for it stays empty (see C1 fallback removal).
 */
function secureJitter(max: number): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0]! / 0x1_0000_0000) * max;
  }
  return 0;
}
const FLUSH_EVENT_THRESHOLD = 50;
const MAX_KEEPALIVE_BYTES = 60_000;

// ── Worker state ─────────────────────────────────────────────────

let apiUrl = '';
let publicApiKey = '';
let propertyId = '';
let sessionId = '';
let visitorId = '';
let visitorToken: string | null = null;
let identifyId: string | null = null;
let identifyEmail: string | null = null;
let identityDirty = false;
let customProperties: Record<string, string | number | boolean> | null = null;
let customPropertiesDirty = false;
let metadata: SessionMetadata | null = null;
let metadataSent = false;
let killed = false;

// Buffer of { event, seq } entries
const buffer: Array<{ event: any; seq: number }> = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

// Entries recently sent over WS but not yet ack'd to the main thread.
// WS delivery is fire-and-forget: the server doesn't ack per-message, and
// can close the socket with 4004 shortly after accepting our `send()` if
// the handler rejects the per-message token check. We hold the entries
// here until a short grace window expires (at which point they're
// considered delivered and ack'd) or a 4004 close arrives (at which point
// we requeue them for resend once the main thread delivers a fresh
// token). Keyed by seqEnd so late acks don't ack more than once.
interface WsInFlight {
  entries: Array<{ event: any; seq: number }>;
  seqEnd: number;
  ackTimer: ReturnType<typeof setTimeout>;
}
const WS_ACK_GRACE_MS = 1_500;
const wsInFlight: WsInFlight[] = [];

function flushWsInFlightOnReject(): void {
  // 4004: everything we haven't ack'd yet needs to be re-sent after the
  // main thread recovers the token. Cancel their grace timers so we don't
  // double-ack after the reconnect.
  const toRequeue: Array<{ event: any; seq: number }> = [];
  while (wsInFlight.length > 0) {
    const f = wsInFlight.shift()!;
    clearTimeout(f.ackTimer);
    for (const e of f.entries) toRequeue.push(e);
  }
  if (toRequeue.length > 0) requeueEntries(toRequeue);
}

// ── WebSocket transport ──────────────────────────────────────────

let ws: WebSocket | null = null;
let wsReady = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
const MAX_RECONNECT_DELAY = 30_000;
let closed = false;

function connectWs(): void {
  if (killed || closed) return;

  try {
    const wsUrl = apiUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    const tokenParam = visitorToken ? `&visitorToken=${encodeURIComponent(visitorToken)}` : '';
    ws = new WebSocket(`${wsUrl}/ws/ingest?key=${encodeURIComponent(publicApiKey)}&propertyId=${encodeURIComponent(propertyId)}${tokenParam}`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.type === 'ready') {
          wsReady = true;
          reconnectDelay = 1_000;
          self.postMessage({ type: 'ready' });
          if (msg.privacy) {
            self.postMessage({ type: 'privacy', config: msg.privacy });
          }
          // Drain any events buffered while WS was reconnecting (e.g. after
          // set_visitor_token). The previous behavior eagerly flushed on
          // set_visitor_token and always hit HTTP because wsReady was false.
          if (buffer.length > 0) flush();
        }
        if (msg.type === 'quota_exceeded') {
          self.postMessage({ type: 'quota_exceeded' });
        }
        if (msg.type === 'rotate_session') {
          self.postMessage({ type: 'rotate_session', reason: msg.reason });
        }
        if (msg.type === 'rotate_visitor_token' && typeof msg.visitorToken === 'string') {
          visitorToken = msg.visitorToken;
          self.postMessage({ type: 'rotate_visitor_token', visitorToken: msg.visitorToken });
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = (event) => {
      wsReady = false;
      ws = null;
      // Notify the bridge that the WS dropped so unload-path delivery can
      // pick the right transport (sendBeacon when WS is closed, flush-final
      // when WS is open). Only emit for non-terminal closes; the 4001/4002
      // killed cases tear down anyway, and 4004 is handled below as a
      // distinct visitor_token_rejected signal.
      if (event.code !== 4001 && event.code !== 4002 && event.code !== 4004) {
        self.postMessage({ type: 'ws_closed' });
      }

      if (event.code === 4001) {
        killed = true;
        self.postMessage({ type: 'killed', reason: 'invalid_api_key' });
        return;
      }
      if (event.code === 4002) {
        killed = true;
        self.postMessage({ type: 'killed', reason: 'subscription_required' });
        return;
      }
      if (event.code === 4004) {
        // Visitor token rejected (handshake or per-message). Clear it,
        // requeue any events still in the WS ack grace window so they
        // get resent once the main thread delivers a fresh token, and
        // ask main thread to re-bootstrap. Don't kill; reconnect once
        // a fresh token arrives.
        visitorToken = null;
        flushWsInFlightOnReject();
        const reason = typeof event.reason === 'string' ? event.reason : 'visitor_token_required';
        self.postMessage({ type: 'visitor_token_rejected', code: reason });
        // Bridge needs to know the WS isn't going to deliver flush-final
        // until the new token arrives.
        self.postMessage({ type: 'ws_closed' });
        scheduleReconnect();
        return;
      }

      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires after onerror, reconnect handled there
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (killed || closed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2 + secureJitter(500), MAX_RECONNECT_DELAY);
}

// ── Flush logic ──────────────────────────────────────────────────

function flush(isFinal: boolean = false): void {
  if (killed || buffer.length === 0) return;

  const entries = buffer.splice(0);
  const events = entries.map(e => e.event);
  const seqStart = entries[0]!.seq;
  const seqEnd = entries[entries.length - 1]!.seq;

  const payload: IngestPayload = {
    sessionId,
    propertyId,
    visitorId,
    events,
    seqStart,
    seqEnd,
  };

  // Identity flag-gated: ship `id` / `email` only when they changed
  // since the last successful flush. The backend's alias short-circuit
  // (findOne by exact triple) keeps steady-state cost flat even if the
  // SDK ever ends up over-shipping, but skipping the wire entirely
  // matches the customPropertiesDirty pattern and shaves payload bytes.
  if (identityDirty) {
    if (identifyId) payload.id = identifyId;
    if (identifyEmail) payload.email = identifyEmail;
    identityDirty = false;
  }

  if (customPropertiesDirty && customProperties) {
    payload.customProperties = { ...customProperties };
    customPropertiesDirty = false;
  }

  if (!metadataSent && metadata) {
    payload.metadata = metadata;
    metadataSent = true;
  }

  if (isFinal) {
    payload.final = true;
  }

  sendPayload(payload, seqEnd, entries);
}

// Restore entries to the front of the buffer after a recoverable failure
// (e.g. visitor token rejection). Keeps original seq order so acks pair up
// once the main thread's mirror advances. Metadata / customProperties /
// identify state set on the failed payload stay committed; they're
// lightweight and idempotent; re-sending them on the next flush is fine.
function requeueEntries(entries: Array<{ event: any; seq: number }>): void {
  if (entries.length === 0) return;
  buffer.unshift(...entries);
}

function sendPayload(payload: IngestPayload, seqEnd: number, entries: Array<{ event: any; seq: number }>): void {
  // Try WebSocket first
  if (wsReady && ws?.readyState === WebSocket.OPEN) {
    try {
      const withToken: any = visitorToken ? { ...payload, visitorToken } : payload;
      ws.send(JSON.stringify(withToken));
      // Defer the ack by a grace window so a 4004 close from the server
      // (per-message token rejection) can still requeue these events
      // before the main thread's mirror prunes them.
      const flight: WsInFlight = {
        entries,
        seqEnd,
        ackTimer: setTimeout(() => {
          const idx = wsInFlight.indexOf(flight);
          if (idx >= 0) wsInFlight.splice(idx, 1);
          self.postMessage({ type: 'ack', seq: seqEnd });
        }, WS_ACK_GRACE_MS),
      };
      wsInFlight.push(flight);
      return;
    } catch {
      // WS send failed, fall through to HTTP
    }
  }

  // HTTP fallback: ack only after successful send
  sendHttpAsync(payload, seqEnd, entries);
}

async function sendHttpAsync(
  payload: IngestPayload,
  seqEnd: number,
  entries: Array<{ event: any; seq: number }>,
): Promise<void> {
  const chunks = chunkEvents(payload);
  const isFinal = payload.final === true;
  let anyFailed = false;
  // Entries from token-rejected chunks: requeue at the end so they get
  // re-sent after the main thread delivers a fresh token via
  // `set_visitor_token`. Entries from non-token failures (network errors)
  // aren't requeued. The mirror buffer on the main thread already holds
  // them for sendBeacon on page unload, and requeueing could double-send
  // if the network error hid a successful server write.
  const rejectedEntries: Array<{ event: any; seq: number }> = [];
  let entryIndex = 0;
  for (const chunk of chunks) {
    const chunkEntries = entries.slice(entryIndex, entryIndex + chunk.events.length);
    entryIndex += chunk.events.length;
    try {
      const withToken: any = visitorToken ? { ...chunk, visitorToken } : chunk;
      const body = JSON.stringify(withToken);
      // keepalive is capped at ~64KB by Chrome/Firefox. If a single event
      // exceeds that (oversized FullSnapshot is the typical culprit) we'd
      // fail the keepalive precondition; on a normal page lifecycle the
      // request still completes. On unload (final=true), keepalive is the
      // only delivery guarantee, but a >64KB body would be rejected with
      // keepalive set, so we drop the flag and accept best-effort delivery
      // rather than a guaranteed cancellation. This trades certainty for
      // a chance: better than always losing the FullSnapshot for early
      // bouncers on heavy pages.
      const useKeepalive = body.length < MAX_KEEPALIVE_BYTES;
      const res = await fetch(`${apiUrl}/v1/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': publicApiKey,
        },
        body,
        keepalive: useKeepalive,
      });
      if (res.status === 429) {
        self.postMessage({ type: 'quota_exceeded' });
        return;
      }
      if (res.status === 401 || res.status === 403) {
        // Could be a visitor-token rejection OR a bad API key. Peek at the
        // body code to tell them apart: token rejections are recoverable
        // (main thread re-bootstraps and pushes a new token), invalid API
        // keys are terminal.
        let code: string | undefined;
        try {
          const parsed = await res.clone().json();
          code = parsed?.code;
        } catch {
          // no body; treat as invalid API key
        }
        if (
          code === 'VISITOR_TOKEN_REQUIRED' ||
          code === 'VISITOR_TOKEN_EXPIRED' ||
          code === 'VISITOR_TOKEN_INVALID'
        ) {
          visitorToken = null;
          self.postMessage({ type: 'visitor_token_rejected', code });
          for (const e of chunkEntries) rejectedEntries.push(e);
          anyFailed = true;
          continue;
        }
        killed = true;
        self.postMessage({ type: 'killed', reason: 'invalid_api_key' });
        return;
      }
      // Read response body once: may carry `rotate` (session sealed) and/or
      // `rotateVisitorToken` (inline-minted token on first sighting).
      try {
        const parsed = await res.clone().json();
        if (parsed && parsed.rotate === true) {
          self.postMessage({ type: 'rotate_session', reason: 'http_sealed' });
        }
        if (parsed && typeof parsed.rotateVisitorToken === 'string') {
          visitorToken = parsed.rotateVisitorToken;
          self.postMessage({ type: 'rotate_visitor_token', visitorToken: parsed.rotateVisitorToken });
        }
      } catch {
        // body may not be JSON or may already be consumed; ignore
      }
    } catch {
      anyFailed = true;
    }
  }
  if (rejectedEntries.length > 0) {
    requeueEntries(rejectedEntries);
  }
  // Only ack if all chunks sent successfully, so the mirror buffer retains
  // unacked events for the sendBeacon fallback on page unload.
  if (!anyFailed) {
    self.postMessage({ type: 'ack', seq: seqEnd });
  }
}

function chunkEvents(payload: IngestPayload): IngestPayload[] {
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

// ── Message handler ──────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  try {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        // `init` is a full reset. In production the bridge creates a
        // fresh worker per session so there's nothing to reset; the
        // explicit reset matters for tests and for defense-in-depth if
        // a bridge ever re-inits an existing worker (today: never).
        apiUrl = msg.apiUrl;
        publicApiKey = msg.publicApiKey;
        propertyId = msg.propertyId;
        sessionId = msg.sessionId;
        visitorId = msg.visitorId;
        visitorToken = typeof msg.visitorToken === 'string' ? msg.visitorToken : null;
        identifyId = null;
        identifyEmail = null;
        identityDirty = false;
        customProperties = null;
        customPropertiesDirty = false;
        metadata = null;
        metadataSent = false;
        killed = false;
        closed = false;
        buffer.length = 0;
        for (const f of wsInFlight) clearTimeout(f.ackTimer);
        wsInFlight.length = 0;
        if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { try { ws.close(1000); } catch {} ws = null; wsReady = false; }
        connectWs();
        flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);
        break;

      case 'set_visitor_token':
        // Main thread has a fresh token (from bootstrap or inline-mint in
        // the HTTP fallback path). Reconnect WS so the handshake carries
        // the new token. The previous behavior fired flush() synchronously
        // here, but connectWs() is async; the synchronous flush always fell
        // through to HTTP because wsReady was still false. Now we either
        // drain through the WS `ready` handler (preferred) or schedule a
        // short-deadline HTTP fallback for the case where WS never comes
        // up (network failure, blocked handshake) so events don't sit in
        // the buffer until the next 6s flushTimer tick.
        if (typeof msg.visitorToken === 'string') {
          visitorToken = msg.visitorToken;
          if (ws) { try { ws.close(1000); } catch {} ws = null; wsReady = false; }
          connectWs();
          if (buffer.length > 0) {
            setTimeout(() => {
              if (!killed && !wsReady && buffer.length > 0) flush();
            }, 100);
          }
        }
        break;

      case 'set_visitor_id':
        // Bootstrap issued a fresh visitorId because the client's cached
        // one was already claimed. Switch to it for all subsequent events.
        if (typeof msg.visitorId === 'string') {
          visitorId = msg.visitorId;
        }
        break;

      case 'event':
        if (killed) break;
        buffer.push({ event: msg.event, seq: msg.seq });
        if (buffer.length >= FLUSH_EVENT_THRESHOLD) {
          flush();
        }
        break;

      case 'metadata':
        metadata = msg.metadata;
        break;

      case 'identify':
        if (msg.identityChanged) {
          identifyId = msg.id ?? null;
          identifyEmail = msg.email ?? null;
          identityDirty = true;
        }
        if (msg.customProperties && Object.keys(msg.customProperties).length > 0) {
          customProperties = { ...(customProperties || {}), ...msg.customProperties };
          customPropertiesDirty = true;
        }
        break;

      case 'flush':
        flush();
        break;

      case 'flush-final':
        if (flushTimer) {
          clearInterval(flushTimer);
          flushTimer = null;
        }
        flush(true);
        closed = true;
        if (ws) {
          try { ws.close(1000); } catch {}
          ws = null;
        }
        wsReady = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        break;
    }
  } catch (err) {
    console.warn('SessionSight worker: error handling message', err);
  }
};
