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

  // Callbacks
  private onPrivacyCallback: ((config: PrivacyConfig) => void) | null = null;
  private onKilledCallback: (() => void) | null = null;
  private onQuotaExceededCallback: (() => void) | null = null;
  private onRotateCallback: ((reason?: string) => void) | null = null;

  // Session context (needed for sendBeacon payloads)
  private sessionId: string;
  private propertyId: string;
  private visitorId: string;
  private apiUrl: string;
  private publicApiKey: string;

  // Metadata and identify state (for sendBeacon payloads)
  private metadata: SessionMetadata | null = null;
  private metadataSent = false;
  private stableId: string | null = null;
  private userProperties: Record<string, string | number | boolean> | null = null;
  private userPropertiesDirty = false;

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

  postIdentify(stableId: string, userProperties?: Record<string, string | number | boolean>): void {
    this.stableId = stableId;
    if (userProperties) {
      this.userProperties = { ...(this.userProperties || {}), ...userProperties };
      this.userPropertiesDirty = true;
    }
    if (this.worker) {
      try { this.worker.postMessage({ type: 'identify', stableId, userProperties }); } catch {}
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
   * Page unload handler. Sends flush-final to worker AND fires sendBeacon
   * with unacked events from the mirror buffer as a safety net.
   */
  sendBeacon(): void {
    // Tell the worker to flush and close
    if (this.worker) {
      try { this.worker.postMessage({ type: 'flush-final' }); } catch {}
    }

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

    if (this.stableId) payload.userId = this.stableId;
    if (this.userPropertiesDirty && this.userProperties) {
      payload.userProperties = { ...this.userProperties };
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

  onKilled(callback: () => void): void {
    this.onKilledCallback = callback;
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
          if (this.onKilledCallback) this.onKilledCallback();
          break;

        case 'ready':
          // WebSocket connected in worker
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
      }
      if (this.worker) {
        try { this.worker.postMessage({ type: 'set_visitor_token', visitorToken: result.visitorToken }); } catch {}
      }
    } catch {
      // Bootstrap failed — the next event will trigger another rejection
      // and we'll try again. No point killing the recorder.
    }
  }

  // ── Fallback (inline transport) ────────────────────────────────────

  private initFallback(): void {
    this.fallbackTransport = new Transport(this.apiUrl, this.publicApiKey, this.propertyId);
    this.fallbackTransport.setVisitorIdBindings(
      () => this.visitorId,
      (id) => { this.visitorId = id; },
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
      if (this.onKilledCallback) this.onKilledCallback();
      return;
    }

    const events = this.fallbackBuffer.splice(0);
    const payload: IngestPayload = {
      sessionId: this.sessionId,
      propertyId: this.propertyId,
      visitorId: this.visitorId,
      events,
    };

    if (this.stableId) payload.userId = this.stableId;
    if (this.userPropertiesDirty && this.userProperties) {
      payload.userProperties = { ...this.userProperties };
      this.userPropertiesDirty = false;
    }
    if (!this.metadataSent && this.metadata) {
      payload.metadata = this.metadata;
      this.metadataSent = true;
    }

    this.fallbackTransport.send(payload);
  }
}
