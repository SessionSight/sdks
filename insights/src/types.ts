/**
 * Two-tier consent surfaced to the SDK.
 *  - 'anonymous': cookieless/storageless aggregate capture (pre-banner default).
 *  - 'full': identified session capture with replay (requires explicit Accept).
 *
 * Mirrored from `@sessionsight/shared` so the SDK doesn't pull the entire
 * shared package into the browser bundle.
 */
export type ConsentLevel = 'anonymous' | 'full';

export interface SessionSightConfig {
  publicApiKey: string;
  propertyId?: string; // defaults to 'dev' (localhost)
  apiUrl?: string;  // defaults to https://api.sessionsight.com
  autoRecord?: boolean; // default true. Set to false for manual recording control
  /**
   * Consent level. Defaults to 'full' for backwards compatibility with the
   * old boolean `true` default; integrators wiring a banner should pass a
   * getter that returns 'anonymous' pre-Accept and 'full' post-Accept.
   *
   * Boolean is still accepted for legacy callers: `true` → 'full',
   * `false` → 'anonymous'. There is no "off" — the SDK always runs at
   * least the anonymous tier. GPC/DNT pins the tier to 'anonymous'
   * regardless of what this returns.
   */
  consent?: ConsentLevel | boolean | (() => ConsentLevel | boolean);
  /**
   * Opt into Google Consent Mode v2 auto-wiring. When true, the SDK
   * reads `analytics_storage` at init and observes subsequent
   * `gtag('consent', 'update', ...)` calls. Explicit setConsent() calls
   * lock CMv2 out for the rest of the session; followConsentMode() re-arms.
   * Default false; opt-in because this couples the SDK to Google's
   * framework and most integrators wire consent explicitly.
   */
  honorConsentMode?: boolean;
}

export interface PrivacyConfig {
  privacyMode: 'default' | 'relaxed';
  excludePages: string[];
}

export interface RecordOptions {
  preRecordSecs?: number; // 0-5, default 0. Include N seconds of pre-buffer
}

export interface SessionMetadata {
  url: string;
  referrer: string;
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  language: string;
}

export interface IngestPayload {
  sessionId: string;
  propertyId: string;
  visitorId: string;
  events: any[];
  metadata?: SessionMetadata;
  // Customer-supplied identity slots from the SDK's `identify({id?, email?})`
  // call. Backend maps wire `id` -> DB column `userId` on visitor profiles.
  id?: string | null;
  email?: string | null;
  customProperties?: Record<string, string | number | boolean>;
  seqStart?: number;
  seqEnd?: number;
  final?: boolean;
}

// ── Worker message protocol ──────────────────────────────────────

/** Main thread → Worker */
export type WorkerInMessage =
  | { type: 'init'; apiUrl: string; publicApiKey: string; propertyId: string; sessionId: string; visitorId: string; visitorToken?: string }
  | { type: 'event'; event: any; seq: number }
  | { type: 'metadata'; metadata: SessionMetadata }
  | {
      type: 'identify';
      id: string | null;
      email: string | null;
      customProperties?: Record<string, string | number | boolean>;
      // True when at least one of id/email differs from the previously
      // cached value. Gates the identityDirty flag in the worker so
      // unchanged identity is not re-shipped on every batch flush.
      identityChanged: boolean;
    }
  | { type: 'flush' }
  | { type: 'flush-final' }
  | { type: 'set_visitor_token'; visitorToken: string }
  | { type: 'set_visitor_id'; visitorId: string };

/** Worker → Main thread */
export type WorkerOutMessage =
  | { type: 'ack'; seq: number }
  | { type: 'privacy'; config: PrivacyConfig }
  | { type: 'killed'; reason: string }
  | { type: 'ready' }
  | { type: 'ws_closed' }
  | { type: 'quota_exceeded' }
  | { type: 'rotate_session'; reason?: string }
  | { type: 'rotate_visitor_token'; visitorToken: string }
  | { type: 'visitor_token_rejected'; code: string };
