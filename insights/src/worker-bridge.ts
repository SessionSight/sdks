/**
 * WorkerBridge: main-thread coordinator for the Web Worker transport.
 *
 * Assigns sequence numbers to events, maintains a mirror buffer of unacked
 * events for sendBeacon fallback, and relays worker messages (privacy config,
 * kill signals) back to the recorder.
 *
 * Falls back to inline Transport when Workers are unavailable.
 */

import { Transport } from './transport.js';
import { createInlineWorker } from './worker-inline.js';
import type { PrivacyConfig, SessionMetadata, WorkerOutMessage, IngestPayload } from './types.js';
import {
  getStoredVisitorToken,
  writeVisitorToken,
  clearVisitorToken,
  bootstrapVisitorToken,
  writeVisitorId,
} from '@sessionsight/sdk-shared';

const FLUSH_INTERVAL_MS = 6_000;
const FLUSH_EVENT_THRESHOLD = 50;
const MAX_KEEPALIVE_BYTES = 60_000;

export class WorkerBridge {
  private worker: Worker | null = null;
  private seq = 0;
  private lastAckedSeq = 0;
  private mirrorBuffer: Array<{ event: any; seq: number }> = [];
  private _killed = false;
  // Tracks whether the worker has reported its WS as ready at least once and
  // hasn't reported a closed/reconnect since. Used by sendBeacon() to decide
  // whether the worker's flush-final will deliver (WS open) so we can skip
  // the redundant navigator.sendBeacon and avoid duplicate ingest.
  private workerWsReady = false;

  // Callbacks
  private onPrivacyCallback: ((config: PrivacyConfig) => void) | null = null;
  private onKilledCallbacks: Array<() => void> = [];
  private onQuotaExceededCallback: (() => void) | null = null;
  private onRotateCallback: ((reason?: string) => void) | null = null;
  private onVisitorIdSwapCallbacks: Array<(visitorId: string) => void> = [];

  // Session context (needed for sendBeacon payloads)
  private sessionId: string;
  private propertyId: string;
  private visitorId: string;
  private apiUrl: string;
  private publicApiKey: string;

  // Metadata and identify state (for sendBeacon payloads)
  private metadata: SessionMetadata | null = null;
  private metadataSent = false;
  // Cached identity slots. Dirty flag mirrors customPropertiesDirty:
  // identity is shipped on every flush where it changed, then the flag
  // clears so a steady-state identified visitor pays zero per-batch DB
  // cost (paired with the alias service-side short-circuit).
  private identifyId: string | null = null;
  private identifyEmail: string | null = null;
  private identityDirty = false;
  private customProperties: Record<string, string | number | boolean> | null = null;
  private customPropertiesDirty = false;

  // Fallback: inline transport + buffer when Workers unavailable
  private fallbackTransport: Transport | null = null;
  private fallbackBuffer: any[] = [];
  private fallbackFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    apiUrl: string,
    publicApiKey: string,
    propertyId: string,
    sessionId: string,
    visitorId: string,
  ) {
    this.apiUrl = apiUrl;
    this.publicApiKey = publicApiKey;
    this.propertyId = propertyId;
    this.sessionId = sessionId;
    this.visitorId = visitorId;

    const worker = createInlineWorker();
    if (worker) {
      this.worker = worker;
      this.worker.onmessage = this.handleWorkerMessage;
      this.worker.onerror = (e) => {
        console.warn('SessionSight: worker error, falling back to main thread', e);
        this.switchToFallback();
      };
      const storedToken = getStoredVisitorToken();
      this.worker.postMessage({
        type: 'init',
        apiUrl,
        publicApiKey,
        propertyId,
        sessionId,
        visitorId,
        ...(storedToken ? { visitorToken: storedToken } : {}),
      });
    } else {
      this.initFallback();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  postEvent(event: any): void {
    if (this._killed) return;

    const seq = ++this.seq;

    if (this.worker) {
      this.mirrorBuffer.push({ event, seq });
      try {
        this.worker.postMessage({ type: 'event', event, seq });
      } catch (e) {
        console.warn('SessionSight: postMessage failed, falling back', e);
        this.switchToFallback();
        this.fallbackBuffer.push(event);
      }
    } else {
      this.fallbackBuffer.push(event);
      if (this.fallbackBuffer.length >= FLUSH_EVENT_THRESHOLD) {
        this.fallbackFlush();
      }
    }
  }

  postMetadata(metadata: SessionMetadata): void {
    this.metadata = metadata;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'metadata', metadata }); } catch {}
    }
  }

  /**
   * Cache the parsed identify payload and forward it to the worker.
   *
   * `identityChanged` is set by the recorder when at least one of `id` /
   * `email` was newly supplied (i.e. differs from the previously-cached
   * value). It maps to the per-flush `identityDirty` flag so the worker
   * skips writing `payload.id` / `payload.email` when nothing changed.
   */
  postIdentify(payload: {
    id: string | null;
    email: string | null;
    customProperties?: Record<string, string | number | boolean>;
    identityChanged: boolean;
  }): void {
    if (payload.identityChanged) {
      this.identifyId = payload.id;
      this.identifyEmail = payload.email;
      this.identityDirty = true;
    }
    if (payload.customProperties && Object.keys(payload.customProperties).length > 0) {
      this.customProperties = { ...(this.customProperties || {}), ...payload.customProperties };
      this.customPropertiesDirty = true;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({
          type: 'identify',
          id: this.identifyId,
          email: this.identifyEmail,
          customProperties: payload.customProperties,
          identityChanged: payload.identityChanged,
        });
      } catch {}
    }
  }

  /** Trigger an immediate flush (e.g. before page exclusion pause). */
  flush(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush' }); } catch {}
    } else {
      this.fallbackFlush();
    }
  }

  /**
   * Flush and tear down with best-effort delivery, intended for the consent
   * withdrawal / SPA-stop path. Sends `flush-final` to the worker (HTTP
   * keepalive on its way out) before terminating it, so events on the wire
   * still complete even though the worker is going away. The worker handles
   * its own teardown on receipt of `flush-final`; we then terminate after
   * a microtask to give the postMessage time to enqueue.
   */
  flushAndDestroy(): void {
    if (this._killed) {
      this.destroy();
      return;
    }
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush-final' }); } catch {}
      // Yield once so the worker can pick up the message before terminate().
      // The HTTP request inside the worker uses keepalive so the browser
      // continues it after the worker exits. WS sends complete synchronously.
      const w = this.worker;
      this.worker = null;
      queueMicrotask(() => {
        try { w.terminate(); } catch {}
      });
    } else if (this.fallbackTransport) {
      this.fallbackFlush();
      this.fallbackTransport.destroy();
      this.fallbackTransport = null;
    }
    if (this.fallbackFlushTimer) {
      clearInterval(this.fallbackFlushTimer);
      this.fallbackFlushTimer = null;
    }
    this.mirrorBuffer = [];
    this.fallbackBuffer = [];
  }

  /**
   * Page unload handler. When WS is open, the worker's flush-final will
   * deliver via WS and we skip the redundant navigator.sendBeacon to avoid
   * doubled events on the server (heatmap clicks, errors are not idempotent
   * and the server has no per-event seq dedup).
   *
   * When WS is closed (or absent in fallback mode), fire sendBeacon as the
   * sole delivery path; flush-final's HTTP fallback is best-effort and may
   * be cancelled on page unload.
   */
  sendBeacon(): void {
    // Tell the worker to flush and close. If WS is open, this delivers via
    // WS synchronously enough that the sendBeacon below would duplicate.
    const wsWillDeliver = this.workerWsReady;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush-final' }); } catch {}
    }

    // Skip sendBeacon when the worker WS will carry the final flush. This is
    // the common case (WS open at unload); sending both would duplicate the
    // tail events at session end. If the worker post failed, we still fall
    // through to sendBeacon below.
    if (this.worker && wsWillDeliver) return;

    // Main-thread sendBeacon with unacked events
    const unacked = this.worker
      ? this.mirrorBuffer.filter(e => e.seq > this.lastAckedSeq)
      : this.fallbackBuffer.splice(0).map((event, i) => ({ event, seq: this.lastAckedSeq + i + 1 }));

    if (unacked.length === 0) return;

    const events = unacked.map(e => e.event);
    const payload: IngestPayload = {
      sessionId: this.sessionId,
      propertyId: this.propertyId,
      visitorId: this.visitorId,
      events,
      seqStart: unacked[0]!.seq,
      seqEnd: unacked[unacked.length - 1]!.seq,
      final: true,
    };

    // Identity ships on every send-final payload regardless of dirty
    // state. The keepalive path runs at unload time and has only one
    // shot to write whatever identity the page knows. Unacked events
    // bundled with this payload may not have reached the server yet,
    // and they must carry identity. The backend's short-circuit findOne
    // on the alias collection keeps this from being expensive.
    if (this.identifyId) payload.id = this.identifyId;
    if (this.identifyEmail) payload.email = this.identifyEmail;
    if (this.customPropertiesDirty && this.customProperties) {
      payload.customProperties = { ...this.customProperties };
    }
    if (!this.metadataSent && this.metadata) {
      payload.metadata = this.metadata;
      this.metadataSent = true;
    }

    try {
      const body = JSON.stringify({ ...payload, apiKey: this.publicApiKey });
      if (body.length <= MAX_KEEPALIVE_BYTES) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(`${this.apiUrl}/v1/ingest`, blob);
      } else {
        // Oversized: fire fetch with keepalive as best-effort
        fetch(`${this.apiUrl}/v1/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': this.publicApiKey },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // Silently fail
    }
  }

  onPrivacy(callback: (config: PrivacyConfig) => void): void {
    this.onPrivacyCallback = callback;
    // Also register on fallback transport if active
    if (this.fallbackTransport) {
      this.fallbackTransport.onPrivacy(callback);
    }
  }

  /**
   * Register a handler that fires when the worker reports the session has been
   * killed (invalid API key, subscription required). Multiple subscribers are
   * supported so both Recorder (clears recorder state) and index.ts (clears
   * module-level state) can react.
   */
  onKilled(callback: () => void): void {
    this.onKilledCallbacks.push(callback);
  }

  /**
   * Register a handler that fires when the bootstrap recovery path swaps the
   * visitorId (server refused to reuse the client's cached id). The bridge
   * already updates its internal `this.visitorId` and persists the new id;
   * subscribers update their own copies (Recorder.visitorId, the module-level
   * storedVisitorId in index.ts) so getVisitorId() returns the swapped value
   * and any subsequent rotateSession() carries the correct id forward.
   */
  onVisitorIdSwap(callback: (visitorId: string) => void): void {
    this.onVisitorIdSwapCallbacks.push(callback);
  }

  onQuotaExceeded(callback: () => void): void {
    this.onQuotaExceededCallback = callback;
    if (this.fallbackTransport) {
      this.fallbackTransport.onQuotaExceeded(callback);
    }
  }

  /**
   * Register a handler for server-initiated session rotation. Fires when the
   * backend pushes `rotate_session` (WS) or returns `{ rotate: true }` (HTTP
   * fallback). The caller is responsible for generating a new sessionId and
   * starting a fresh recording session.
   */
  onRotate(callback: (reason?: string) => void): void {
    this.onRotateCallback = callback;
    if (this.fallbackTransport) {
      this.fallbackTransport.onRotate?.(callback);
    }
  }

  isKilled(): boolean {
    return this._killed;
  }

  /**
   * Re-arm a previously-killed bridge so the next event flow doesn't drop.
   * The worker resets its own `killed` flag on `init`; bridges are normally
   * constructed fresh per session so this rarely matters, but keep the
   * symmetry available for tests and any future re-init flow.
   */
  resetKilled(): void {
    this._killed = false;
  }

  destroy(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    if (this.fallbackTransport) {
      this.fallbackTransport.destroy();
      this.fallbackTransport = null;
    }
    if (this.fallbackFlushTimer) {
      clearInterval(this.fallbackFlushTimer);
      this.fallbackFlushTimer = null;
    }
    this.mirrorBuffer = [];
    this.fallbackBuffer = [];
  }

  // ── Worker message handling ────────────────────────────────────────

  private handleWorkerMessage = (e: MessageEvent<WorkerOutMessage>): void => {
    try {
      const msg = e.data;
      switch (msg.type) {
        case 'ack':
          this.lastAckedSeq = msg.seq;
          // Prune mirror buffer: remove all entries up to acked seq
          while (this.mirrorBuffer.length > 0 && this.mirrorBuffer[0]!.seq <= msg.seq) {
            this.mirrorBuffer.shift();
          }
          break;

        case 'privacy':
          if (this.onPrivacyCallback) this.onPrivacyCallback(msg.config);
          break;

        case 'killed':
          this._killed = true;
          for (const cb of this.onKilledCallbacks) {
            try { cb(); } catch (err) { console.warn('SessionSight: onKilled callback threw', err); }
          }
          break;

        case 'ready':
          // WebSocket connected in worker
          this.workerWsReady = true;
          break;

        case 'ws_closed':
          // WebSocket dropped in worker; sendBeacon path should not assume
          // flush-final will deliver until a new `ready` arrives.
          this.workerWsReady = false;
          break;

        case 'quota_exceeded':
          if (this.onQuotaExceededCallback) this.onQuotaExceededCallback();
          break;

        case 'rotate_session':
          if (this.onRotateCallback) this.onRotateCallback(msg.reason);
          break;

        case 'rotate_visitor_token':
          // Inline-minted or WS-pushed token. Persist so other tabs and the
          // next page load see it. Worker has its own copy already.
          writeVisitorToken(msg.visitorToken);
          break;

        case 'visitor_token_rejected':
          // Worker's token was rejected. Clear storage and re-bootstrap on
          // the main thread (which has access to cookie/localStorage), then
          // push the fresh token back to the worker.
          this.handleVisitorTokenRejection();
          break;
      }
    } catch (err) {
      console.warn('SessionSight: error handling worker message', err);
    }
  };

  // ── Visitor token recovery ────────────────────────────────────────
  //
  // Called when the worker reports a 401 REQUIRED/EXPIRED/INVALID. The main
  // thread owns cookie/localStorage, so bootstrap runs here. If the server
  // refuses to reuse our visitorId (already claimed by a different browser
  // or left stale on this one), it mints a fresh UUID; we swap both the
  // in-memory id, the persistent storage, AND the worker's copy so every
  // subsequent payload carries the new id + matching token.

  private tokenRecoveryInFlight: Promise<void> | null = null;

  private handleVisitorTokenRejection(): void {
    if (this.tokenRecoveryInFlight) return;
    clearVisitorToken();
    this.tokenRecoveryInFlight = this.recoverVisitorToken().finally(() => {
      this.tokenRecoveryInFlight = null;
    });
  }

  private async recoverVisitorToken(): Promise<void> {
    try {
      const result = await bootstrapVisitorToken({
        apiUrl: this.apiUrl,
        publicApiKey: this.publicApiKey,
        propertyId: this.propertyId,
        clientVisitorId: this.visitorId,
      });
      const swapped = result.visitorId !== this.visitorId;
      if (swapped) {
        this.visitorId = result.visitorId;
        writeVisitorId(result.visitorId);
        if (this.worker) {
          try { this.worker.postMessage({ type: 'set_visitor_id', visitorId: result.visitorId }); } catch {}
        }
        // Propagate the new id up the stack: Recorder.visitorId and the
        // module-level storedVisitorId in index.ts must match so a future
        // server-driven rotateSession() carries the correct id forward.
        for (const cb of this.onVisitorIdSwapCallbacks) {
          try { cb(result.visitorId); } catch (err) { console.warn('SessionSight: onVisitorIdSwap callback threw', err); }
        }
      }
      if (this.worker) {
        try { this.worker.postMessage({ type: 'set_visitor_token', visitorToken: result.visitorToken }); } catch {}
      }
    } catch {
      // Bootstrap failed; the next event will trigger another rejection
      // and we'll try again. No point killing the recorder.
    }
  }

  // ── Fallback (inline transport) ────────────────────────────────────

  private initFallback(): void {
    this.fallbackTransport = new Transport(this.apiUrl, this.publicApiKey, this.propertyId);
    this.fallbackTransport.setVisitorIdBindings(
      () => this.visitorId,
      (id) => {
        this.visitorId = id;
        // Mirror the worker-path swap so subscribers (Recorder, index.ts)
        // see the new id regardless of which transport recovered the token.
        for (const cb of this.onVisitorIdSwapCallbacks) {
          try { cb(id); } catch (err) { console.warn('SessionSight: onVisitorIdSwap callback threw', err); }
        }
      },
    );
    if (this.onPrivacyCallback) {
      this.fallbackTransport.onPrivacy(this.onPrivacyCallback);
    }
    if (this.onQuotaExceededCallback) {
      this.fallbackTransport.onQuotaExceeded(this.onQuotaExceededCallback);
    }
    this.fallbackFlushTimer = setInterval(() => this.fallbackFlush(), FLUSH_INTERVAL_MS);
  }

  /** Switch from worker mode to fallback after a worker error. */
  private switchToFallback(): void {
    if (this.fallbackTransport) return; // already switched

    // Terminate broken worker
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }

    this.initFallback();

    // Re-send unacked events from mirror
    for (const entry of this.mirrorBuffer) {
      this.fallbackBuffer.push(entry.event);
    }
    this.mirrorBuffer = [];
  }

  private fallbackFlush(): void {
    if (!this.fallbackTransport || this.fallbackBuffer.length === 0) return;

    if (this.fallbackTransport.isKilled()) {
      this._killed = true;
      this.fallbackBuffer = [];
      if (this.fallbackFlushTimer) { clearInterval(this.fallbackFlushTimer); this.fallbackFlushTimer = null; }
      for (const cb of this.onKilledCallbacks) {
        try { cb(); } catch (err) { console.warn('SessionSight: onKilled callback threw', err); }
      }
      return;
    }

    const events = this.fallbackBuffer.splice(0);
    const payload: IngestPayload = {
      sessionId: this.sessionId,
      propertyId: this.propertyId,
      visitorId: this.visitorId,
      events,
    };

    if (this.identityDirty) {
      if (this.identifyId) payload.id = this.identifyId;
      if (this.identifyEmail) payload.email = this.identifyEmail;
      this.identityDirty = false;
    }
    if (this.customPropertiesDirty && this.customProperties) {
      payload.customProperties = { ...this.customProperties };
      this.customPropertiesDirty = false;
    }
    if (!this.metadataSent && this.metadata) {
      payload.metadata = this.metadata;
      this.metadataSent = true;
    }

    this.fallbackTransport.send(payload);
  }
}
