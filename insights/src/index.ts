import { Recorder } from './recorder.js';
import { WorkerBridge } from './worker-bridge.js';
import { AnonymousCapture } from './anonymous-capture.js';
import { AnonymousWorkerBridge } from './anonymous-worker-bridge.js';
import type { SessionSightConfig, RecordOptions, PrivacyConfig, ConsentLevel } from './types.js';
import {
  normalizeApiUrl,
  getOrCreateVisitorId,
  validateGoalId,
  validateGoalAmount,
  buildGoalPayload,
  writeSessionCookie,
  clearSessionCookie,
  generateUUID,
  getStoredVisitorToken,
  clearVisitorToken,
  containsProhibitedPII,
  isValidEmail,
  shouldSuppressPersistentId,
  hasLocalStorage,
  MAX_ID_LEN,
  MAX_EMAIL_LEN,
  MAX_CUSTOM_KEY_LEN,
  MAX_CUSTOM_VALUE_LEN,
  MAX_CUSTOM_PROPERTY_COUNT,
  RESERVED_CUSTOM_PROPERTY_KEYS,
  type GoalOptions,
  type GoalPayloadOptions,
  type GoalResult,
} from '@sessionsight/sdk-shared';

// ── Internal state ──────────────────────────────────────────────────

type ParsedIdentify = {
  id?: string;
  email?: string;
  customProperties?: Record<string, string | number | boolean>;
};

function parseIdentifyPayload(
  payload: Record<string, string | number | boolean | undefined>,
): ParsedIdentify | null {
  if (!payload || typeof payload !== 'object') {
    throw new Error('SessionSight.identify: payload must be an object.');
  }

  let id: string | undefined;
  let email: string | undefined;
  const customProperties: Record<string, string | number | boolean> = {};

  for (const [rawKey, rawValue] of Object.entries(payload)) {
    if (rawValue === undefined) continue;

    if (rawKey === 'id') {
      if (typeof rawValue !== 'string') {
        throw new Error('SessionSight.identify: `id` must be a string.');
      }
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        throw new Error('SessionSight.identify: `id` must be a non-empty string.');
      }
      if (trimmed.length > MAX_ID_LEN) {
        throw new Error(`SessionSight.identify: \`id\` exceeds ${MAX_ID_LEN} characters.`);
      }
      if (containsProhibitedPII(trimmed)) {
        throw new Error(
          'SessionSight.identify: `id` contains prohibited PII (SSN, credit card, credentials, or phone number).',
        );
      }
      if (isValidEmail(trimmed)) {
        throw new Error(
          'SessionSight.identify: `id` must not be email-shaped. Use the `email` slot for email addresses.',
        );
      }
      id = trimmed;
      continue;
    }

    if (rawKey === 'email') {
      if (typeof rawValue !== 'string') {
        throw new Error('SessionSight.identify: `email` must be a string.');
      }
      const normalized = rawValue.trim().toLowerCase();
      if (normalized.length === 0) {
        throw new Error('SessionSight.identify: `email` must be a non-empty string.');
      }
      if (normalized.length > MAX_EMAIL_LEN) {
        throw new Error(`SessionSight.identify: \`email\` exceeds ${MAX_EMAIL_LEN} characters.`);
      }
      if (!isValidEmail(normalized)) {
        throw new Error('SessionSight.identify: `email` is not a valid email shape.');
      }
      email = normalized;
      continue;
    }

    if (RESERVED_CUSTOM_PROPERTY_KEYS.includes(rawKey as 'id' | 'email')) {
      throw new Error(`SessionSight.identify: \`${rawKey}\` is reserved.`);
    }
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new Error('SessionSight.identify: custom property keys must be non-empty strings.');
    }
    if (rawKey.length > MAX_CUSTOM_KEY_LEN) {
      throw new Error(
        `SessionSight.identify: custom property key \`${rawKey}\` exceeds ${MAX_CUSTOM_KEY_LEN} characters.`,
      );
    }
    if (containsProhibitedPII(rawKey)) continue;

    if (typeof rawValue === 'string') {
      if (rawValue.length > MAX_CUSTOM_VALUE_LEN) {
        throw new Error(
          `SessionSight.identify: custom property value for \`${rawKey}\` exceeds ${MAX_CUSTOM_VALUE_LEN} characters.`,
        );
      }
      if (containsProhibitedPII(rawValue)) continue;
      customProperties[rawKey] = rawValue;
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      customProperties[rawKey] = rawValue;
    } else {
      throw new Error(
        `SessionSight.identify: custom property value for \`${rawKey}\` must be string, number, or boolean.`,
      );
    }
  }

  const propCount = Object.keys(customProperties).length;
  if (propCount > MAX_CUSTOM_PROPERTY_COUNT) {
    throw new Error(
      `SessionSight.identify: at most ${MAX_CUSTOM_PROPERTY_COUNT} custom properties allowed.`,
    );
  }

  if (!id && !email && propCount === 0) return null;

  const parsed: ParsedIdentify = {};
  if (id) parsed.id = id;
  if (email) parsed.email = email;
  if (propCount > 0) parsed.customProperties = customProperties;
  return parsed;
}

const PRIVACY_CACHE_KEY = 'sessionsight_privacy_config';

// ── Full-tier state ──────────────────────────────────────────────────

let recorder: Recorder | null = null;
let pendingConfig: { bridge: WorkerBridge; propertyId: string; autoRecord: boolean } | null = null;
let visibilityResurrectionListener: (() => void) | null = null;
let idleResurrectionListener: (() => void) | null = null;
let focusCookieListener: (() => void) | null = null;
/** Set true by rotateSession(); cleared when activity re-attaches the recorder. */
let awaitingRotateResurrection = false;
/** The last privacy config received from the server, used for session resurrection. */
let lastPrivacyConfig: PrivacyConfig = { privacyMode: 'default', excludePages: [] };
let lastInitConfig: { bridge: WorkerBridge; propertyId: string; autoRecord: boolean } | null = null;
let connectionConfig: { apiUrl: string; apiKey: string; propertyId: string; autoRecord: boolean } | null = null;
let storedVisitorId: string = '';
let storedSessionId: string = '';
let goalsConfig: { apiUrl: string; apiKey: string; propertyId: string } | null = null;
let quotaExceeded = false;
/**
 * Set once a transport reports a terminal kill (invalid API key, revoked
 * origin, subscription required). Prevents the consent poll from re-firing
 * `applyTierTransition` and spinning a fresh bridge every second: without
 * this gate, a full-tier 401 → fall-to-anonymous → anonymous 401 chain
 * leaves `lastConsentLevel='anonymous'` while the consent getter still
 * returns 'full', so the next poll tick re-applies full and the cycle
 * repeats. Reset on `init()` (page reloads start fresh) and explicit
 * `setConsent()` (user retry intent).
 */
let transportKilled = false;

// ── Tier state (consent level + anonymous bridge) ────────────────────

/** Current active tier. Determines which capture path is alive. */
let activeTier: ConsentLevel = 'anonymous';
/** Bridge for the anonymous tier. Mutually exclusive with `recorder`. */
let anonymousBridge: AnonymousWorkerBridge | null = null;
/** AnonymousCapture instance. Mutually exclusive with `recorder`. */
let anonymousCapture: AnonymousCapture | null = null;
/** Ephemeral per-tab tokens used by the anonymous tier. Memory-only. */
let ephemeralVisitorId: string = '';
let ephemeralSessionId: string = '';

// ── Consent polling ──────────────────────────────────────────────────

let consentGetter: (() => ConsentLevel) | null = null;
let consentPollTimer: ReturnType<typeof setInterval> | null = null;
let lastConsentLevel: ConsentLevel | null = null;

// ── CMv2 opt-in state ────────────────────────────────────────────────

let cmv2Enabled = false;
let cmv2ExplicitOverride = false;
let originalGtag: any = null;
let cmv2PatchInstalled = false;

/**
 * Coerce a legacy boolean or current `ConsentLevel` value into a
 * `ConsentLevel`. `true` → 'full', `false` → 'anonymous'. There is no
 * separate "off" state.
 */
function coerceLevel(v: ConsentLevel | boolean): ConsentLevel {
  if (typeof v === 'boolean') return v ? 'full' : 'anonymous';
  return v === 'full' ? 'full' : 'anonymous';
}

// ── Goal fires ───────────────────────────────────────────────────────

function fireGoal(action: 'increment' | 'decrement', goalId: string, options?: GoalOptions): GoalResult {
  if (!goalsConfig) return { success: false, error: 'SessionSight not initialized' };

  const idErr = validateGoalId(goalId);
  if (idErr) return { success: false, error: idErr };

  const amount = options?.amount ?? 1;
  const amtErr = validateGoalAmount(amount);
  if (amtErr) return { success: false, error: amtErr };

  // Anonymous tier: route to the aggregate transport. No `amount` because
  // the anonymous tier cannot attribute dollars to a person; decrement is
  // a no-op for the same reason (counters don't move negative).
  if (activeTier === 'anonymous') {
    if (action === 'decrement') return { success: false, error: 'decrement not supported in anonymous tier' };
    if (anonymousCapture) anonymousCapture.emitGoalCount(goalId);
    return { success: true };
  }

  const sessionIdForFire = options?.sessionId || storedSessionId;
  if (!sessionIdForFire) return { success: false, error: 'no session (consent required)' };

  const { apiUrl, apiKey, propertyId } = goalsConfig;

  const storedToken = getStoredVisitorToken();
  const enrichedOptions: GoalPayloadOptions = {
    ...options,
    apiKey,
    sessionId: sessionIdForFire,
    ...(storedToken ? { visitorToken: storedToken } : {}),
  };

  const { body } = buildGoalPayload(goalId, propertyId, enrichedOptions);
  const url = `${apiUrl}/v1/sdk/goals/${action}`;
  const payload = JSON.stringify(body);
  try {
    const sent = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    return { success: sent };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'sendBeacon failed' };
  }
}

// ── Privacy config cache ─────────────────────────────────────────────

function getCachedPrivacyConfig(propertyId: string): PrivacyConfig {
  try {
    const raw = sessionStorage.getItem(PRIVACY_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.propertyId === propertyId) {
        return { privacyMode: parsed.privacyMode, excludePages: parsed.excludePages };
      }
    }
  } catch {}
  return { privacyMode: 'default', excludePages: [] };
}

function cachePrivacyConfig(propertyId: string, config: PrivacyConfig): void {
  try {
    sessionStorage.setItem(PRIVACY_CACHE_KEY, JSON.stringify({
      propertyId,
      privacyMode: config.privacyMode,
      excludePages: config.excludePages,
    }));
  } catch {}
}

// ── Consent polling ──────────────────────────────────────────────────

function pollConsent(): void {
  if (transportKilled) {
    stopPolling();
    return;
  }
  if (!consentGetter) return;
  const desired = consentGetter();
  // GPC/DNT pins the level to anonymous, regardless of what the getter
  // returned. A user who set GPC and explicitly clicked Accept still gets
  // anonymous-tier capture, lines up with the spirit of GPC's "don't
  // profile" signal.
  const target: ConsentLevel = shouldSuppressPersistentId() ? 'anonymous' : desired;
  if (target === lastConsentLevel) return;
  applyTierTransition(target);
}

function startPolling(): void {
  if (consentPollTimer) return;
  consentPollTimer = setInterval(pollConsent, 1000);
}

function stopPolling(): void {
  if (consentPollTimer) {
    clearInterval(consentPollTimer);
    consentPollTimer = null;
  }
}

/**
 * Move from whatever tier is currently active to `target`. Idempotent:
 * calling with the active tier is a no-op.
 *
 *   anonymous → full:  tear down anonymous transport, run applyConsentGranted().
 *   full → anonymous:  flush + tear down the full-tier session (clearing
 *                      ss_vid + ss_vtoken + ss_sid + sessionsight_visitor_id),
 *                      then spin up the anonymous transport.
 *
 * The visitor-id clear on full → anonymous is a deliberate behaviour change
 * from older versions of the SDK: leaving ss_vid set while the anonymous
 * tier is running would violate the tier's zero-persistent-storage rule.
 * Operator-visible consequence: a visitor who waffles (Accept → Decline →
 * Accept) shows as two distinct identified visitors. The trade favours
 * strict anonymous-tier privacy.
 *
 * Only the OUTGOING tier is torn down. On initial setup (lastConsentLevel
 * is null) we skip teardown entirely — calling teardownFull() here would
 * wipe a returning visitor's ss_vid/ss_vtoken cookies even though no
 * full-tier session ever existed in this page lifetime, forcing the next
 * Accept into a needless 401 → bootstrap → re-mint cycle.
 */
function applyTierTransition(target: ConsentLevel): void {
  if (transportKilled) return;
  if (target === lastConsentLevel) return;

  if (lastConsentLevel === 'full') teardownFull();
  else if (lastConsentLevel === 'anonymous') teardownAnonymous();

  if (target === 'full') applyConsentGranted();
  else applyAnonymousActive();

  activeTier = target;
  lastConsentLevel = target;
}

// ── Visibility / idle resurrection ───────────────────────────────────

function handleVisibilityResurrection(): void {
  if (document.visibilityState !== 'visible') return;
  if (!lastInitConfig) return;
  if (activeTier !== 'full') return;

  if (awaitingRotateResurrection && pendingConfig) {
    awaitingRotateResurrection = false;
    const { bridge, propertyId, autoRecord } = pendingConfig;
    pendingConfig = null;
    recorder = new Recorder(bridge, propertyId, storedVisitorId, { privacyMode: lastPrivacyConfig.privacyMode, excludePages: lastPrivacyConfig.excludePages });
    recorder.start(autoRecord);
    return;
  }

  if (!recorder?.endedByVisibility) return;

  const { bridge, propertyId, autoRecord } = lastInitConfig;
  recorder = new Recorder(bridge, propertyId, storedVisitorId, { privacyMode: lastPrivacyConfig.privacyMode, excludePages: lastPrivacyConfig.excludePages });
  recorder.start(autoRecord);
}

function handleIdleResurrection(): void {
  if (!lastInitConfig) return;
  if (activeTier !== 'full') return;

  if (awaitingRotateResurrection && pendingConfig) {
    awaitingRotateResurrection = false;
    const { bridge, propertyId, autoRecord } = pendingConfig;
    pendingConfig = null;
    recorder = new Recorder(bridge, propertyId, storedVisitorId, { privacyMode: lastPrivacyConfig.privacyMode, excludePages: lastPrivacyConfig.excludePages });
    recorder.start(autoRecord);
    return;
  }

  if (!recorder?.endedByIdle) return;

  const { bridge, propertyId, autoRecord } = lastInitConfig;
  recorder = new Recorder(bridge, propertyId, storedVisitorId, { privacyMode: lastPrivacyConfig.privacyMode, excludePages: lastPrivacyConfig.excludePages });
  recorder.start(autoRecord);
}

function rotateSession(): void {
  if (!goalsConfig || !lastInitConfig) return;

  const { propertyId, autoRecord, bridge: oldBridge } = lastInitConfig;
  const { apiUrl, apiKey } = goalsConfig;

  const wasRecording = recorder !== null;

  if (recorder) {
    recorder.stop();
    recorder = null;
  } else {
    try {
      oldBridge.destroy();
    } catch (e) {
      console.warn('SessionSight: old bridge teardown failed during rotate', e);
    }
  }
  pendingConfig = null;

  const newSessionId = generateUUID();
  storedSessionId = newSessionId;
  writeSessionCookie(newSessionId);

  const newBridge = new WorkerBridge(apiUrl, apiKey, propertyId, newSessionId, storedVisitorId);

  newBridge.onPrivacy((serverConfig) => {
    lastPrivacyConfig = serverConfig;
    cachePrivacyConfig(propertyId, serverConfig);
    if (recorder) recorder.applyPrivacyConfig(serverConfig);
    if (anonymousCapture) anonymousCapture.applyPrivacyConfig(serverConfig);
  });

  newBridge.onQuotaExceeded(() => {
    if (quotaExceeded) return;
    quotaExceeded = true;
    console.warn('[SessionSight] Monthly session recording limit reached. Recording paused until next billing cycle.');
    if (recorder) {
      recorder.stop();
      recorder = null;
    }
    pendingConfig = null;
    lastInitConfig = null;
    awaitingRotateResurrection = false;
  });

  newBridge.onRotate(() => { rotateSession(); });

  newBridge.onVisitorIdSwap((newVisitorId) => {
    storedVisitorId = newVisitorId;
  });

  newBridge.onKilled(handleBridgeKilled);

  lastInitConfig = { bridge: newBridge, propertyId, autoRecord };
  pendingConfig = { bridge: newBridge, propertyId, autoRecord };
  awaitingRotateResurrection = wasRecording;
}

function handleFocusCookieWrite(): void {
  if (!storedSessionId) return;
  if (activeTier !== 'full') return;
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  writeSessionCookie(storedSessionId);
}

// ── Full-tier setup / teardown ───────────────────────────────────────

function handleBridgeKilled(reason?: string): void {
  if (recorder) {
    try { recorder.stop(); } catch {}
    recorder = null;
  }
  pendingConfig = null;
  lastInitConfig = null;
  // After a hard kill, fall back to the anonymous tier so we still capture
  // pre-consent aggregate traffic from any remaining time on the page.
  // Don't wipe connectionConfig, we may need it if the page is reloaded
  // and the kill cause was transient.
  storedSessionId = '';
  storedVisitorId = '';
  awaitingRotateResurrection = false;
  logKillReason('full', reason);
  // Anonymous fallback is only useful for kills that aren't auth/billing
  // failures (e.g. a transient WS misconfig). For invalid_api_key and
  // subscription_required, the anonymous tier would hit the same wall and
  // emit a duplicate warning, so skip straight to disabling.
  const fatalForBothTiers = reason === 'invalid_api_key' || reason === 'subscription_required';
  if (activeTier === 'full' && !fatalForBothTiers) {
    activeTier = 'anonymous';
    lastConsentLevel = 'anonymous';
    applyAnonymousActive();
  } else {
    transportKilled = true;
    stopPolling();
  }
}

function logKillReason(tier: 'full' | 'anonymous', reason?: string): void {
  if (reason === 'invalid_api_key') {
    console.warn(`[SessionSight] ${tier}-tier capture stopped: the API key was rejected. Check publicApiKey + propertyId match a property on this account.`);
  } else if (reason === 'subscription_required') {
    console.warn(`[SessionSight] ${tier}-tier capture stopped: this property's plan does not allow ingest. Activate billing to resume.`);
  } else if (reason) {
    console.warn(`[SessionSight] ${tier}-tier capture stopped (${reason}).`);
  } else {
    console.warn(`[SessionSight] ${tier}-tier capture stopped.`);
  }
}

function applyConsentGranted(): void {
  if (recorder) return;
  if (!connectionConfig) {
    console.warn('SessionSight: call init() before granting consent.');
    return;
  }

  const { apiUrl, apiKey, propertyId, autoRecord } = connectionConfig;

  storedVisitorId = getOrCreateVisitorId();
  const sessionId = generateUUID();
  storedSessionId = sessionId;
  writeSessionCookie(sessionId);
  goalsConfig = { apiUrl, apiKey, propertyId };

  const bridge = new WorkerBridge(apiUrl, apiKey, propertyId, sessionId, storedVisitorId);

  bridge.onPrivacy((serverConfig) => {
    lastPrivacyConfig = serverConfig;
    cachePrivacyConfig(propertyId, serverConfig);
    if (recorder) recorder.applyPrivacyConfig(serverConfig);
  });

  bridge.onQuotaExceeded(() => {
    if (quotaExceeded) return;
    quotaExceeded = true;
    console.warn('[SessionSight] Monthly session recording limit reached. Recording paused until next billing cycle.');
    if (recorder) {
      recorder.stop();
      recorder = null;
    }
    pendingConfig = null;
    lastInitConfig = null;
  });

  bridge.onRotate(() => { rotateSession(); });

  bridge.onVisitorIdSwap((newVisitorId) => {
    storedVisitorId = newVisitorId;
  });

  bridge.onKilled(handleBridgeKilled);

  lastInitConfig = { bridge, propertyId, autoRecord };

  recorder = new Recorder(bridge, propertyId, storedVisitorId, {
    privacyMode: lastPrivacyConfig.privacyMode,
    excludePages: lastPrivacyConfig.excludePages,
  });
  recorder.start(autoRecord);
}

/**
 * Tear down the full-tier session. Used by tier transitions and by an
 * explicit setConsent('anonymous') call. Flushes the buffered events via
 * keepalive so the operator sees the tail of the just-consented-and-now-
 * withdrawing session.
 *
 * Clears ss_vid + sessionsight_visitor_id + ss_vtoken + ss_sid: the
 * anonymous tier's zero-persistent-storage rule applies as soon as the
 * tier flips. A subsequent re-grant mints a fresh visitor (the older
 * "preserve ss_vid across withdrawals so returning users keep their id"
 * behaviour is incompatible with the anonymous tier's invariant).
 */
function teardownFull(): void {
  if (recorder) {
    try { recorder.stop(); } catch {}
    recorder = null;
  }
  // flushAndDestroy on the active bridge sends the tail buffer via
  // keepalive HTTP so we don't lose the last 6s of the session.
  if (lastInitConfig?.bridge) {
    try { lastInitConfig.bridge.flushAndDestroy(); } catch {}
  }
  if (pendingConfig?.bridge && pendingConfig.bridge !== lastInitConfig?.bridge) {
    try { pendingConfig.bridge.destroy(); } catch {}
  }
  pendingConfig = null;

  clearSessionCookie();
  clearVisitorToken();
  clearVisitorIdStorage();
  storedSessionId = '';
  storedVisitorId = '';
  goalsConfig = connectionConfig
    ? { apiUrl: connectionConfig.apiUrl, apiKey: connectionConfig.apiKey, propertyId: connectionConfig.propertyId }
    : null;

  lastInitConfig = null;
  awaitingRotateResurrection = false;
}

function clearVisitorIdStorage(): void {
  if (typeof document !== 'undefined') {
    try {
      const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `ss_vid=; path=/; max-age=0; SameSite=Lax${secure}`;
    } catch {}
  }
  if (typeof window !== 'undefined' && hasLocalStorage()) {
    try { localStorage.removeItem('sessionsight_visitor_id'); } catch {}
  }
}

// ── Anonymous-tier setup / teardown ──────────────────────────────────

function applyAnonymousActive(): void {
  if (anonymousCapture) return; // already running
  if (!connectionConfig) {
    console.warn('SessionSight: call init() before starting anonymous capture.');
    return;
  }
  const { apiUrl, apiKey, propertyId } = connectionConfig;

  // Ephemeral, memory-only per-tab tokens. Never written to cookie / LS / SS.
  ephemeralVisitorId = generateUUID();
  ephemeralSessionId = generateUUID();
  goalsConfig = { apiUrl, apiKey, propertyId };

  anonymousBridge = new AnonymousWorkerBridge({
    apiUrl,
    publicApiKey: apiKey,
    propertyId,
    ephemeralVisitorId,
    ephemeralSessionId,
  });
  anonymousBridge.onKilled((reason) => {
    teardownAnonymous();
    logKillReason('anonymous', reason);
    // Anonymous-tier kill is terminal for the page lifecycle: the same API
    // key would fail again on the next tick. Mark dead and stop polling so
    // the consent loop doesn't reanimate full-tier (and bounce right back
    // through here) every second.
    transportKilled = true;
    stopPolling();
  });

  anonymousCapture = new AnonymousCapture({
    sink: (e) => { if (anonymousBridge) anonymousBridge.postEvent(e); },
    privacyConfig: lastPrivacyConfig,
  });
  anonymousCapture.start();
}

function teardownAnonymous(): void {
  if (anonymousCapture) {
    try { anonymousCapture.stop(); } catch {}
    anonymousCapture = null;
  }
  if (anonymousBridge) {
    try { anonymousBridge.flushAndDestroy(); } catch {}
    anonymousBridge = null;
  }
  ephemeralVisitorId = '';
  ephemeralSessionId = '';
}

// ── CMv2 opt-in wiring (unchanged shape; granted→full, denied→anonymous) ─

function readCurrentCMv2State(): 'granted' | 'denied' | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;

  try {
    if (typeof w.gtag === 'function') {
      let state: any = null;
      w.gtag('get', 'consent_state', (s: any) => { state = s; });
      if (state && typeof state.analytics_storage === 'string') {
        return state.analytics_storage === 'granted' ? 'granted' : 'denied';
      }
    }
  } catch {}

  try {
    const dl: any[] = Array.isArray(w.dataLayer) ? w.dataLayer : [];
    for (let i = dl.length - 1; i >= 0; i--) {
      const row = dl[i];
      if (!row) continue;
      if (Array.isArray(row) && row[0] === 'consent' && (row[1] === 'update' || row[1] === 'default')) {
        const settings = row[2];
        if (settings && typeof settings.analytics_storage === 'string') {
          return settings.analytics_storage === 'granted' ? 'granted' : 'denied';
        }
      }
    }
  } catch {}

  return null;
}

function installCMv2Observer(): void {
  if (cmv2PatchInstalled || typeof window === 'undefined') return;
  const w = window as any;

  originalGtag = typeof w.gtag === 'function' ? w.gtag : null;
  const patchedGtag = function (this: any, ...args: any[]) {
    try {
      if (args[0] === 'consent' && (args[1] === 'update' || args[1] === 'default')) {
        const settings = args[2];
        if (settings && typeof settings.analytics_storage === 'string') {
          if (!cmv2ExplicitOverride) {
            const granted = settings.analytics_storage === 'granted';
            applyTierTransition(granted ? 'full' : 'anonymous');
          }
        }
      }
    } catch (err) {
      console.warn('SessionSight: CMv2 observer error', err);
    }
    if (originalGtag) return originalGtag.apply(this, args);
    try {
      const dl: any[] = Array.isArray(w.dataLayer) ? w.dataLayer : (w.dataLayer = []);
      dl.push(Array.from(args));
    } catch {}
  };
  w.gtag = patchedGtag;
  cmv2PatchInstalled = true;
}

function armCMv2FromCurrentState(): void {
  const current = readCurrentCMv2State();
  if (current === null) return;
  applyTierTransition(current === 'granted' ? 'full' : 'anonymous');
  cmv2ExplicitOverride = false;
}

// ── Public API ───────────────────────────────────────────────────────

const SessionSight = {
  init(config: SessionSightConfig): void {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        console.warn('SessionSight: browser environment required. Skipping initialization in SSR/Node.');
        return;
      }

      if (recorder || pendingConfig || connectionConfig || anonymousCapture) {
        console.warn('SessionSight is already initialized.');
        return;
      }

      if (!config.publicApiKey) {
        console.error('SessionSight: publicApiKey is required.');
        return;
      }

      const propertyId = config.propertyId || 'dev';
      const apiUrl = normalizeApiUrl(config.apiUrl || '');
      const autoRecord = config.autoRecord !== false;

      const cachedConfig = getCachedPrivacyConfig(propertyId);
      lastPrivacyConfig = cachedConfig;

      connectionConfig = { apiUrl, apiKey: config.publicApiKey, propertyId, autoRecord };
      goalsConfig = { apiUrl, apiKey: config.publicApiKey, propertyId };

      if (!visibilityResurrectionListener) {
        visibilityResurrectionListener = handleVisibilityResurrection;
        document.addEventListener('visibilitychange', visibilityResurrectionListener);
      }
      if (!idleResurrectionListener) {
        idleResurrectionListener = handleIdleResurrection;
        document.addEventListener('click', idleResurrectionListener, true);
        document.addEventListener('keydown', idleResurrectionListener, true);
        document.addEventListener('scroll', idleResurrectionListener, { capture: true, passive: true } as AddEventListenerOptions);
      }
      if (!focusCookieListener) {
        focusCookieListener = handleFocusCookieWrite;
        window.addEventListener('focus', focusCookieListener);
        document.addEventListener('visibilitychange', focusCookieListener);
      }

      const consentOption = config.consent;
      const gpcSuppressed = shouldSuppressPersistentId();

      if (config.honorConsentMode) {
        cmv2Enabled = true;
        installCMv2Observer();

        const cmv2State = readCurrentCMv2State();
        if (cmv2State !== null) {
          const target: ConsentLevel = gpcSuppressed
            ? 'anonymous'
            : cmv2State === 'granted' ? 'full' : 'anonymous';
          applyTierTransition(target);
          return;
        }
        // No CMv2 signal present; fall through to the `consent` init param.
      }

      if (typeof consentOption === 'function') {
        consentGetter = () => coerceLevel(consentOption());
        const initialDesired = consentGetter();
        const target: ConsentLevel = gpcSuppressed ? 'anonymous' : initialDesired;
        applyTierTransition(target);
        startPolling();
      } else {
        // Default: full tier (backwards-compatible with the old `true` default).
        // GPC/DNT pins to anonymous regardless.
        const desired: ConsentLevel = consentOption === undefined ? 'full' : coerceLevel(consentOption);
        const target: ConsentLevel = gpcSuppressed ? 'anonymous' : desired;
        applyTierTransition(target);
      }
    } catch (e) {
      console.warn('SessionSight: failed to initialize', e);
    }
  },

  /**
   * Programmatically set the consent tier. Accepts the modern `ConsentLevel`
   * string or the legacy boolean (`true` → 'full', `false` → 'anonymous').
   * Explicit calls win over CMv2 signals until followConsentMode() re-arms.
   *
   * GPC/DNT still pins to 'anonymous' even when you pass 'full'.
   */
  setConsent(level: ConsentLevel | boolean): void {
    cmv2ExplicitOverride = true;
    transportKilled = false;
    const desired = coerceLevel(level);
    const target: ConsentLevel = shouldSuppressPersistentId() ? 'anonymous' : desired;
    applyTierTransition(target);
  },

  followConsentMode(): void {
    if (!cmv2Enabled) return;
    armCMv2FromCurrentState();
  },

  startRecording(options?: RecordOptions): void {
    if (recorder) recorder.beginRecording(options);
  },

  stopRecording(): void {
    if (recorder) recorder.pause();
  },

  resumeRecording(): void {
    if (recorder) recorder.resume();
  },

  goals: {
    increment(goalId: string, options?: GoalOptions): GoalResult {
      return fireGoal('increment', goalId, options);
    },
    decrement(goalId: string, options?: GoalOptions): GoalResult {
      return fireGoal('decrement', goalId, options);
    },
  },

  identify(payload: { id?: string; email?: string } & Record<string, string | number | boolean | undefined>): void {
    // identify is a full-tier-only operation. Linking aggregate counters to
    // an identity would defeat the anonymous tier's invariant.
    if (activeTier !== 'full') return;
    const parsed = parseIdentifyPayload(payload);
    if (!parsed) return;
    if (recorder) recorder.identify(parsed);
  },

  /**
   * Returns the persistent visitorId for the current full-tier session,
   * or null when the SDK is running anonymously (pre-banner, declined, or
   * under GPC/DNT). Never returns the ephemeral per-tab id; exposing it to
   * other JS on the page would defeat the anonymous tier's invariant.
   */
  getVisitorId(): string | null {
    if (activeTier !== 'full') return null;
    return (recorder?.getVisitorId() || storedVisitorId) || null;
  },
};

export default SessionSight;
