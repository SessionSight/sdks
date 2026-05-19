import { Recorder } from './recorder.js';
import { WorkerBridge } from './worker-bridge.js';
import type { SessionSightConfig, RecordOptions, PrivacyConfig } from './types.js';
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

/**
 * Parsed and validated identify() payload. The SDK extracts `id` and
 * `email` into dedicated wire fields and routes everything else through
 * `customProperties` (after PII filtering and reserved-key checks).
 *
 * Per-call shape:
 * - `id` / `email` are optional. An identify() call with neither slot is
 *   valid (binds data to the current anonymous visitor).
 * - PII in custom property values is silently dropped (drop-and-continue).
 *   Everything else throws synchronously on violation so caller bugs
 *   surface at the call site rather than producing silent ingest 400s.
 */
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

  // Walk the flat payload once; route each entry to the right slot.
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
      // PII check: the SDK's containsProhibitedPII calls redactString with
      // skipEmail:true, so emails are NOT caught here. The email-shape
      // rejection below is what keeps emails out of the `id` slot. If
      // skipEmail is ever dropped, this rejection becomes redundant.
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

    // Custom property branch.
    if (RESERVED_CUSTOM_PROPERTY_KEYS.includes(rawKey as 'id' | 'email')) {
      // Unreachable in practice: the SDK already extracted `id`/`email`
      // above. Defensive in case the list grows without updating the
      // routing above.
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
    // Per-key PII silently drops by design. Structural errors (missing key,
    // length cap) surface to the caller; PII detection does not.
    if (containsProhibitedPII(rawKey)) continue;

    if (typeof rawValue === 'string') {
      if (rawValue.length > MAX_CUSTOM_VALUE_LEN) {
        throw new Error(
          `SessionSight.identify: custom property value for \`${rawKey}\` exceeds ${MAX_CUSTOM_VALUE_LEN} characters.`,
        );
      }
      // Per-value PII silently drops.
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

  // Empty-object no-op: neither slot present, no surviving properties.
  if (!id && !email && propCount === 0) return null;

  const parsed: ParsedIdentify = {};
  if (id) parsed.id = id;
  if (email) parsed.email = email;
  if (propCount > 0) parsed.customProperties = customProperties;
  return parsed;
}

const PRIVACY_CACHE_KEY = 'sessionsight_privacy_config';

let recorder: Recorder | null = null;
let pendingConfig: { bridge: WorkerBridge; propertyId: string; autoRecord: boolean } | null = null;
let consentGetter: (() => boolean) | null = null;
let consentPollTimer: ReturnType<typeof setInterval> | null = null;
let lastConsentValue: boolean | null = null;
let visibilityResurrectionListener: (() => void) | null = null;
let idleResurrectionListener: (() => void) | null = null;
let focusCookieListener: (() => void) | null = null;
/** Set true by rotateSession(); cleared when activity re-attaches the recorder. */
let awaitingRotateResurrection = false;
/** The last privacy config received from the server, used for session resurrection. */
let lastPrivacyConfig: PrivacyConfig = { privacyMode: 'default', excludePages: [] };

/** Stored config for recreating the recorder after visibility-based or idle session end. */
let lastInitConfig: { bridge: WorkerBridge; propertyId: string; autoRecord: boolean } | null = null;
/** Base connection config (apiUrl, apiKey, propertyId, autoRecord). Retained across withdrawal so setConsent(true) can open a fresh bridge without reinit. */
let connectionConfig: { apiUrl: string; apiKey: string; propertyId: string; autoRecord: boolean } | null = null;
let storedVisitorId: string = '';
let storedSessionId: string = '';
/** Config used by goals.increment/decrement. Set during init(), cleared on setConsent(false). */
let goalsConfig: { apiUrl: string; apiKey: string; propertyId: string } | null = null;
let quotaExceeded = false;

// ── CMv2 opt-in state ────────────────────────────────────────────────

/** Whether honorConsentMode was enabled at init. */
let cmv2Enabled = false;
/** True after an explicit setConsent() call; CMv2 updates are ignored until followConsentMode() re-arms. */
let cmv2ExplicitOverride = false;
/** Installed gtag patch reference so we can restore on teardown. */
let originalGtag: any = null;
let cmv2PatchInstalled = false;

// ── Goal fires ───────────────────────────────────────────────────────

function fireGoal(action: 'increment' | 'decrement', goalId: string, options?: GoalOptions): GoalResult {
  if (!goalsConfig) return { success: false, error: 'SessionSight not initialized' };

  const idErr = validateGoalId(goalId);
  if (idErr) return { success: false, error: idErr };

  const amount = options?.amount ?? 1;
  const amtErr = validateGoalAmount(amount);
  if (amtErr) return { success: false, error: amtErr };

  // In the no-session state (consent withdrawn), silently no-op. Goals
  // are session-scoped conversions; without a session the ingest API
  // would refuse the write anyway.
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

// ── Consent polling (getter form) ────────────────────────────────────

function pollConsent(): void {
  if (!consentGetter) return;
  const current = consentGetter();
  if (current === lastConsentValue) return;
  lastConsentValue = current;

  if (current) applyConsentGranted();
  else applyConsentWithdrawn();
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

// ── Visibility / idle resurrection ───────────────────────────────────

function handleVisibilityResurrection(): void {
  if (document.visibilityState !== 'visible') return;
  if (!lastInitConfig) return;

  if (consentGetter && !consentGetter()) return;

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

  if (consentGetter && !consentGetter()) return;

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

/**
 * Server-driven session rotation. Invoked when the backend signals that the
 * current sessionId has been sealed (analytics computed, archival pending).
 */
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
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  writeSessionCookie(storedSessionId);
}

// ── Consent grant / withdrawal ───────────────────────────────────────

/**
 * Module-level cleanup when the bridge reports `killed` (invalid API key,
 * subscription required). Recorder's own onKilled handler tears down its
 * rrweb capture; this clears the SDK-level state so the SDK reads as
 * "uninitialized" again and stops polling for consent. Bridge already
 * marked itself killed; no need to call destroy().
 */
function handleBridgeKilled(): void {
  if (recorder) {
    try { recorder.stop(); } catch {}
    recorder = null;
  }
  pendingConfig = null;
  lastInitConfig = null;
  connectionConfig = null;
  goalsConfig = null;
  storedSessionId = '';
  storedVisitorId = '';
  awaitingRotateResurrection = false;
  stopPolling();
  consentGetter = null;
  lastConsentValue = null;
}

/**
 * Wire up a new session: mint visitorId (read-or-mint from storage),
 * mint sessionId, open a new bridge, start the recorder. Call when
 * consent is granted from any no-session state.
 */
function applyConsentGranted(): void {
  if (recorder) return; // already consented
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
 * Session-scoped teardown on consent withdrawal. Stops the recorder,
 * destroys the bridge, clears session-scoped state. Preserves the
 * persistent visitor cookie / localStorage so returning users retain
 * their cross-session history.
 */
function applyConsentWithdrawn(): void {
  if (recorder) {
    recorder.stop();
    recorder = null;
  }
  // Destroy the underlying bridge if one is outstanding. Covered:
  // - active-recorder path: recorder.stop() flushes events but doesn't
  //   destroy the WorkerBridge; we need to kill its WebSocket.
  // - pending-config path: no recorder attached, bridge held in pendingConfig.
  if (lastInitConfig?.bridge) {
    try { lastInitConfig.bridge.destroy(); } catch {}
  }
  if (pendingConfig?.bridge && pendingConfig.bridge !== lastInitConfig?.bridge) {
    try { pendingConfig.bridge.destroy(); } catch {}
  }
  pendingConfig = null;

  // Session-scoped storage teardown. Visitor cookie + LS preserved.
  clearSessionCookie();
  clearVisitorToken();
  storedSessionId = '';
  storedVisitorId = ''; // in-memory clear; persistent LS re-read on re-grant

  lastInitConfig = null;
  awaitingRotateResurrection = false;
}

// ── CMv2 opt-in wiring ───────────────────────────────────────────────

function readCurrentCMv2State(): 'granted' | 'denied' | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;

  // Preferred: gtag('get', 'consent_state'). Not all implementations expose it.
  try {
    if (typeof w.gtag === 'function') {
      let state: any = null;
      w.gtag('get', 'consent_state', (s: any) => { state = s; });
      if (state && typeof state.analytics_storage === 'string') {
        return state.analytics_storage === 'granted' ? 'granted' : 'denied';
      }
    }
  } catch {}

  // Fallback: walk window.dataLayer backwards for the most recent consent command.
  try {
    const dl: any[] = Array.isArray(w.dataLayer) ? w.dataLayer : [];
    for (let i = dl.length - 1; i >= 0; i--) {
      const row = dl[i];
      if (!row) continue;
      // dataLayer can contain [consent, update, {...}] or {event:'consent', ...}
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
            if (granted) applyConsentGranted();
            else applyConsentWithdrawn();
          }
        }
      }
    } catch (err) {
      console.warn('SessionSight: CMv2 observer error', err);
    }
    if (originalGtag) return originalGtag.apply(this, args);
    // Stub fallback: push onto dataLayer so GA/GTM still see the event.
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
  if (current === 'granted') applyConsentGranted();
  else applyConsentWithdrawn();
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

      if (recorder || pendingConfig || connectionConfig) {
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

      // SDK-level visibility/idle/focus listeners live across the SDK's
      // lifetime. They are registered once here and not reset on consent
      // transitions so resurrection after setConsent(true) still works.
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

      // CMv2 opt-in wiring. Install the gtag observer and read the
      // current state if honorConsentMode is on. Explicit setConsent()
      // calls after this point take precedence over CMv2 updates.
      const consentOption = config.consent;
      if (config.honorConsentMode) {
        cmv2Enabled = true;
        installCMv2Observer();

        const cmv2State = readCurrentCMv2State();
        if (cmv2State !== null) {
          if (cmv2State === 'granted') applyConsentGranted();
          // 'denied' is the no-session state; nothing to do.
          return;
        }
        // No CMv2 signal present; fall through to the `consent` init param.
      }

      if (typeof consentOption === 'function') {
        consentGetter = consentOption;
        const initialValue = consentGetter();
        lastConsentValue = initialValue;
        if (initialValue) applyConsentGranted();
        startPolling();
      } else {
        const consent = consentOption !== false;
        if (consent) applyConsentGranted();
      }
    } catch (e) {
      console.warn('SessionSight: failed to initialize', e);
    }
  },

  /**
   * Grant or withdraw consent. Explicit calls win over CMv2 signals
   * until followConsentMode() re-arms. `setConsent(false)` performs
   * session-scoped teardown (preserves ss_vid for returning users);
   * `setConsent(true)` reads-or-mints the visitor and opens a new session.
   */
  setConsent(granted: boolean): void {
    cmv2ExplicitOverride = true;
    if (granted) {
      if (recorder) return; // already consented
      applyConsentGranted();
      lastConsentValue = true;
    } else {
      if (!recorder && !pendingConfig && !storedSessionId) return; // already withdrawn
      applyConsentWithdrawn();
      lastConsentValue = false;
    }
  },

  /**
   * Re-arm CMv2 listening: clear the explicit-override lock and adopt
   * the current CMv2 state. No-op when honorConsentMode was not enabled
   * at init.
   */
  followConsentMode(): void {
    if (!cmv2Enabled) return;
    armCMv2FromCurrentState();
  },

  /**
   * Begin the user-triggered recording stream. Only effective when
   * consent has been granted (i.e., a session exists). No-op otherwise.
   */
  startRecording(options?: RecordOptions): void {
    if (recorder) recorder.beginRecording(options);
  },

  /**
   * Pause rrweb capture without touching the session, identity, or
   * consent. Goals, feedback, and split-test exposures continue to fire
   * while paused. No-op in the no-session state.
   */
  stopRecording(): void {
    if (recorder) recorder.pause();
  },

  /** Resume rrweb capture paused by stopRecording(). No-op in the no-session state. */
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

  /**
   * Bind identity and/or custom data to the current visitor.
   *
   * Accepts a flat object:
   *
   *   SessionSight.identify({
   *     id?: string,       // opaque stable identifier (your internal user id)
   *     email?: string,    // canonical email slot (normalized to lowercase + trim)
   *     ...customProperties,
   *   });
   *
   * Both `id` and `email` are optional. An empty `{}` is a no-op. A call
   * with only custom properties (no `id`, no `email`) binds data to the
   * current anonymous visitor without claiming an identity.
   *
   * Throws synchronously on validation failure:
   *  - email-shaped value passed as `id`
   *  - PII (SSN/cc/credentials/phone) in `id`
   *  - invalid email shape, or oversized id/email
   *  - reserved-key collision in custom properties
   *  - oversized custom property key/value, or more than the allowed cap
   *  - wrong type (custom properties must be string/number/boolean)
   *
   * Silently drops, per the existing per-value PII rule:
   *  - custom property keys matching the PII regex
   *  - string-typed custom property values matching the PII regex
   *
   * No-op in the no-session state (consent withdrawn): identity is
   * meaningless without a session to attach it to. Callers must re-call
   * identify() after a consent re-grant (which opens a new session).
   */
  identify(payload: { id?: string; email?: string } & Record<string, string | number | boolean | undefined>): void {
    const parsed = parseIdentifyPayload(payload);
    if (!parsed) return; // empty / all-dropped → no network call
    if (recorder) recorder.identify(parsed);
  },

  /** Returns the current session's visitorId, or null in the no-session state. */
  getVisitorId(): string | null {
    // Prefer the recorder's id (it tracks bootstrap-recovery swaps via the
    // bridge's onVisitorIdSwap callback), but fall through to storedVisitorId
    // when no recorder is attached (rotateSession() pending-config phase) or
    // the recorder doesn't have a value yet.
    return (recorder?.getVisitorId() || storedVisitorId) || null;
  },
};

export default SessionSight;
