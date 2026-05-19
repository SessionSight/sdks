import type { IngestPayload, PrivacyConfig } from './types.js';
import {
  getStoredVisitorToken,
  writeVisitorToken,
  clearVisitorToken,
  bootstrapVisitorToken,
  writeVisitorId,
} from '@sessionsight/sdk-shared';

const MAX_KEEPALIVE_BYTES = 60_000;

/**
 * Crypto-backed [0, max) float for reconnect jitter. Math.random is banned
 * across this package so a grep for it stays empty. Falls back to 0 jitter
 * if no secure RNG is available; the doubling term alone still prevents
 * tight reconnect loops.
 */
function secureJitter(max: number): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0]! / 0x1_0000_0000) * max;
  }
  return 0;
}

/**
 * WebSocket-first transport with HTTP fallback.
 *
 * On init, opens a persistent WebSocket to /ws/ingest. While the socket is
 * open, payloads are sent as WS messages (zero network tab noise). If the
 * socket isn't ready yet, drops, or fails to connect, falls back to HTTP
 * fetch. Page-unload delivery is handled by WorkerBridge.sendBeacon, not
 * here, so this transport never needs a beacon path of its own.
 */
export class Transport {
  private apiUrl: string;
  private publicApiKey: string;
  private propertyId: string;
  private killed = false;

  // WebSocket state
  private ws: WebSocket | null = null;
  private wsReady = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private closed = false;

  // Privacy config callback
  private onPrivacyConfig: ((config: PrivacyConfig) => void) | null = null;
  private onQuotaExceededCallback: (() => void) | null = null;
  private onRotateCallback: ((reason?: string) => void) | null = null;

  // Visitor id is required for bootstrap-on-rejection: the server can only
  // keep reusing the cached id if we pass it as clientVisitorId, and if it
  // refuses we need to propagate the fresh server-issued id back up to the
  // owner so subsequent payloads use the matching id.
  private onVisitorIdSwap: ((visitorId: string) => void) | null = null;
  private getVisitorId: (() => string) | null = null;

  constructor(apiUrl: string, publicApiKey: string, propertyId: string) {
    this.apiUrl = apiUrl;
    this.publicApiKey = publicApiKey;
    this.propertyId = propertyId;
    this.connectWs();
  }

  /**
   * Hook the transport up to the owner's visitor-id state so token recovery
   * can pass the current id to bootstrap and push a swap back on rejection.
   */
  setVisitorIdBindings(get: () => string, onSwap: (visitorId: string) => void): void {
    this.getVisitorId = get;
    this.onVisitorIdSwap = onSwap;
  }

  /** Register a callback for when the server sends privacy configuration. */
  onPrivacy(callback: (config: PrivacyConfig) => void): void {
    this.onPrivacyConfig = callback;
  }

  onQuotaExceeded(callback: () => void): void {
    this.onQuotaExceededCallback = callback;
  }

  onRotate(callback: (reason?: string) => void): void {
    this.onRotateCallback = callback;
  }

  isKilled(): boolean {
    return this.killed;
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────

  private connectWs(): void {
    if (this.killed || this.closed) return;

    try {
      const wsUrl = this.apiUrl
        .replace(/^http/, 'ws')
        .replace(/\/$/, '');
      const token = getStoredVisitorToken();
      const tokenParam = token ? `&visitorToken=${encodeURIComponent(token)}` : '';
      this.ws = new WebSocket(`${wsUrl}/ws/ingest?key=${encodeURIComponent(this.publicApiKey)}&propertyId=${encodeURIComponent(this.propertyId)}${tokenParam}`);

      this.ws.onopen = () => {
        // Wait for the 'ready' message before marking as ready
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (msg.type === 'ready') {
            this.wsReady = true;
            this.reconnectDelay = 1_000; // reset backoff on successful connection
            if (msg.privacy && this.onPrivacyConfig) {
              this.onPrivacyConfig(msg.privacy);
            }
          }
          if (msg.type === 'quota_exceeded') {
            if (this.onQuotaExceededCallback) this.onQuotaExceededCallback();
          }
          if (msg.type === 'rotate_session') {
            if (this.onRotateCallback) this.onRotateCallback(msg.reason);
          }
          if (msg.type === 'rotate_visitor_token' && typeof msg.visitorToken === 'string') {
            writeVisitorToken(msg.visitorToken);
          }
        } catch {
          // ignore non-JSON messages
        }
      };

      this.ws.onclose = (event) => {
        this.wsReady = false;
        this.ws = null;

        // 4001 = invalid API key, same as HTTP 401/403
        if (event.code === 4001) {
          this.killed = true;
          console.warn('SessionSight: invalid API key. Ingestion disabled.');
          return;
        }

        // 4002 = subscription required
        if (event.code === 4002) {
          this.killed = true;
          return;
        }

        // 4004 = visitor token invalid/expired on handshake. Clear the
        // stale token and re-bootstrap; the next reconnect attempt will
        // pick up the fresh token from storage.
        if (event.code === 4004) {
          clearVisitorToken();
          this.kickBootstrap();
        }

        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose fires after onerror, so reconnect is handled there
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.killed || this.closed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.reconnectDelay);

    // Exponential backoff with jitter. Math.random is banned across this
    // package so static analysis can flag any stray use.
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2 + secureJitter(500),
      Transport.MAX_RECONNECT_DELAY,
    );
  }

  // ── Public API ─────────────────────────────────────────────────────

  async send(payload: IngestPayload): Promise<void> {
    if (this.killed) return;

    // Attach the current visitor token if we have one. Read fresh on
    // every send so a mid-flight rotation (via rotate_visitor_token WS
    // message or rotateVisitorToken HTTP response) is picked up by the
    // next message without restarting the recorder.
    const token = getStoredVisitorToken();
    const withToken: any = token ? { ...payload, visitorToken: token } : payload;

    // Try WebSocket first
    if (this.wsReady && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(withToken));
        return;
      } catch {
        // WS send failed, fall through to HTTP
      }
    }

    // HTTP fallback. chunkEvents sees the payload without the visitor
    // token because sendHttpChunk reads it fresh when it serializes.
    const chunks = this.chunkEvents(payload);
    for (const chunk of chunks) {
      await this.sendHttpChunk(chunk);
      if (this.killed) return;
    }
  }

  /** Tear down the WebSocket (called when the recorder stops). */
  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.wsReady = false;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  /**
   * Split a payload into chunks that each fit under the keepalive size limit.
   * Events that are individually larger than the limit get their own chunk.
   */
  private chunkEvents(payload: IngestPayload): IngestPayload[] {
    const { events, ...rest } = payload;
    if (events.length === 0) return [payload];

    // Build the envelope once to know its overhead
    const envelopeSize = JSON.stringify({ ...rest, events: [] }).length;

    const chunks: IngestPayload[] = [];
    let currentEvents: any[] = [];
    let currentSize = envelopeSize;

    for (const event of events) {
      const eventSize = JSON.stringify(event).length + 1; // +1 for comma separator

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

  private async sendHttpChunk(payload: IngestPayload, isRetry = false): Promise<void> {
    try {
      const token = getStoredVisitorToken();
      const body = JSON.stringify({ ...payload, ...(token ? { visitorToken: token } : {}) });
      const res = await fetch(`${this.apiUrl}/v1/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.publicApiKey,
        },
        body,
        keepalive: body.length < MAX_KEEPALIVE_BYTES,
      });

      // Parse the body once; multiple branches below read from it.
      let parsed: any = null;
      try {
        parsed = await res.clone().json();
      } catch {
        // body not JSON
      }

      if (res.status === 429) {
        if (this.onQuotaExceededCallback) this.onQuotaExceededCallback();
        return;
      }

      // Visitor-token response handling.
      // - REQUIRED/EXPIRED: clear the stale token, bootstrap a fresh one,
      //   then retry this exact chunk once with the new token. One retry
      //   only (guarded by `isRetry`) so a server that keeps rejecting
      //   can't loop us forever.
      // - INVALID: clear the token and bootstrap, but do NOT retry. The
      //   server treated this payload as actively malicious; replaying it
      //   is what an attacker would do. The events in this chunk are
      //   dropped; future chunks carry the new token.
      if (res.status === 401 || res.status === 403) {
        const code = parsed?.code;
        if (code === 'VISITOR_TOKEN_INVALID') {
          clearVisitorToken();
          await this.kickBootstrap();
          return;
        }
        if ((code === 'VISITOR_TOKEN_REQUIRED' || code === 'VISITOR_TOKEN_EXPIRED') && !isRetry) {
          clearVisitorToken();
          await this.kickBootstrap();
          // If kickBootstrap swapped the id, rewrite the payload so the
          // retry's visitorId matches the freshly-minted token's binding.
          const currentId = this.getVisitorId?.();
          const retryPayload = currentId && currentId !== payload.visitorId
            ? { ...payload, visitorId: currentId }
            : payload;
          await this.sendHttpChunk(retryPayload, /* isRetry */ true);
          return;
        }
        if (code === 'VISITOR_TOKEN_REQUIRED' || code === 'VISITOR_TOKEN_EXPIRED') {
          // Already retried once; give up on this chunk without killing
          // the transport. Subsequent flushes use the freshly-bootstrapped
          // token.
          return;
        }
        // Not a token problem: bad API key or forbidden property.
        this.killed = true;
        console.warn('SessionSight: invalid API key. Ingestion disabled.');
        return;
      }

      // Sealed-session signal from HTTP response: tell the host to rotate.
      if (parsed && parsed.rotate === true && this.onRotateCallback) {
        this.onRotateCallback('http_sealed');
      }

      // Freshly-minted visitor token on a first-sighting event: persist it
      // so every subsequent request carries it.
      if (parsed && typeof parsed.rotateVisitorToken === 'string') {
        writeVisitorToken(parsed.rotateVisitorToken);
      }
    } catch {
      // Silently fail; don't break the host page
    }
  }

  /**
   * Fire a best-effort bootstrap request. Passes the current visitorId so
   * the server can reuse it when it's not already claimed; if the server
   * refuses the id (stale claim from a prior session), it mints a fresh
   * one and we propagate the swap through onVisitorIdSwap so every
   * subsequent payload + the cookie/localStorage match the token's
   * binding. No retry on failure; the ingest inline-mint path covers the
   * next event, or the next WS reconnect picks up a fresh token.
   */
  private async kickBootstrap(): Promise<void> {
    try {
      const currentId = this.getVisitorId?.();
      const result = await bootstrapVisitorToken({
        apiUrl: this.apiUrl,
        publicApiKey: this.publicApiKey,
        propertyId: this.propertyId,
        ...(currentId ? { clientVisitorId: currentId } : {}),
      });
      if (currentId && result.visitorId && result.visitorId !== currentId) {
        writeVisitorId(result.visitorId);
        this.onVisitorIdSwap?.(result.visitorId);
      }
    } catch {
      // Non-fatal.
    }
  }
}
