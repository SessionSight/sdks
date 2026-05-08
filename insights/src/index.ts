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
  type GoalOptions,
  type GoalPayloadOptions,
  type GoalResult,
} from '@sessionsight/sdk-shared';

// ── Internal state ──────────────────────────────────────────────────

function sanitizeProperties(
  props: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (containsProhibitedPII(key)) continue;
    if (typeof value === 'string' && containsProhibitedPII(value)) continue;
    out[key] = value;
  }
  return out;
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
/** Base connection config (apiUrl, apiKey, propertyId, autoRecord) — retained across withdrawal so setConsent(true) can open a fresh bridge without reinit. */
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
        // No CMv2 signal present — fall through to the `consent` init param.
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
   * Write identity onto the current session. No-op in the no-session
   * state (consent withdrawn): identity is meaningless without a session
   * to attach it to. Callers must re-call identify() after a consent
   * re-grant (which opens a new session).
   */
  identify(stableId: string, properties?: Record<string, string | number | boolean>): void {
    if (containsProhibitedPII(stableId)) {
      throw new Error(
        'SessionSight.identify: stableId contains prohibited PII (SSN, credit card, credentials, or phone number). Use an email, UUID, or other non-PII identifier.',
      );
    }
    const sanitized = properties ? sanitizeProperties(properties) : undefined;
    if (recorder) recorder.identify(stableId, sanitized);
  },

  /** Returns the current session's visitorId, or null in the no-session state. */
  getVisitorId(): string | null {
    return recorder ? recorder.getVisitorId() : null;
  },
};

export default SessionSight;
