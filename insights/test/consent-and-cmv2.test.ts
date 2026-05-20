import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Covers the two-tier consent state machine + CMv2 opt-in.
 *
 * Two-tier model (see ANONYMOUS_TRACKING_PLAN.md): the SDK is always in
 * either `anonymous` or `full` tier; there is no "off" state. Boolean
 * `consent` values map to tiers: `true` → `full`, `false` → `anonymous`.
 *
 * Anonymous-tier capture is stubbed so the full SDK state machine runs
 * without trying to spin up real Web Workers.
 */

// ── Browser global stubs ─────────────────────────────────────────────

const listeners = new Map<string, Set<Function>>();

function addEventListener(event: string, fn: Function, _opts?: any) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}
function removeEventListener(event: string, fn: Function, _opts?: any) {
  listeners.get(event)?.delete(fn);
}

const origDocument = globalThis.document;
const origWindow = globalThis.window;
const origNavigator = globalThis.navigator;
const origLocation = (globalThis as any).location;

let cookieStore = '';

function mockCookieJar() {
  return {
    get cookie() { return cookieStore; },
    set cookie(v: string) {
      const parts = v.split(';').map(s => s.trim());
      const first = parts[0] || '';
      const eq = first.indexOf('=');
      if (eq < 0) return;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      const maxAge = parts.find(p => p.startsWith('max-age='));
      if (maxAge && maxAge.split('=')[1] === '0') {
        cookieStore = cookieStore
          .split('; ')
          .filter(c => !c.startsWith(name + '='))
          .join('; ');
        return;
      }
      const existing = cookieStore
        .split('; ')
        .filter(c => c && !c.startsWith(name + '='));
      existing.push(`${name}=${value}`);
      cookieStore = existing.join('; ');
    },
  };
}

const recorderInstances: Array<{ started: boolean; stopped: boolean; paused: boolean; resumed: boolean; visitorId: string }> = [];
const bridgeInstances: Array<{ sessionId: string; visitorId: string; destroyed: boolean; onRotateCb: Function | null; onPrivacyCb: Function | null; onQuotaCb: Function | null }> = [];
const anonBridgeInstances: Array<{ destroyed: boolean; ephemeralVisitorId: string; ephemeralSessionId: string }> = [];
const anonCaptureInstances: Array<{ started: boolean; stopped: boolean }> = [];

beforeEach(() => {
  listeners.clear();
  cookieStore = '';
  recorderInstances.length = 0;
  bridgeInstances.length = 0;
  anonBridgeInstances.length = 0;
  anonCaptureInstances.length = 0;

  const cookieJar = mockCookieJar();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return 'visible'; },
      addEventListener,
      removeEventListener,
      get cookie() { return cookieJar.cookie; },
      set cookie(v: string) { cookieJar.cookie = v; },
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    },
  });

  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/', pathname: '/', search: '', hash: '' };

  const storage = new Map<string, string>();
  (globalThis as any).window = {
    location: (globalThis as any).location,
    addEventListener,
    removeEventListener,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    dataLayer: [] as any[],
  };
  (globalThis as any).localStorage = (globalThis as any).window.localStorage;

  (globalThis as any).navigator = {
    language: 'en-US',
    sendBeacon: () => true,
  };
});

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: origDocument });
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).location = origLocation;
});

// ── Stubs for the full-tier and anonymous-tier transports ────────────

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    sessionId: string;
    visitorId: string;
    destroyed = false;
    onRotateCb: Function | null = null;
    onPrivacyCb: Function | null = null;
    onQuotaCb: Function | null = null;
    constructor(_apiUrl: string, _apiKey: string, _propertyId: string, sessionId: string, visitorId: string) {
      this.sessionId = sessionId;
      this.visitorId = visitorId;
      bridgeInstances.push(this);
    }
    onPrivacy(cb: Function) { this.onPrivacyCb = cb; }
    onQuotaExceeded(cb: Function) { this.onQuotaCb = cb; }
    onRotate(cb: Function) { this.onRotateCb = cb; }
    onKilled(_cb: Function) {}
    onVisitorIdSwap(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    flushAndDestroy() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
  },
}));

mock.module('../src/recorder.js', () => ({
  Recorder: class {
    started = false;
    stopped = false;
    paused = false;
    resumed = false;
    visitorId: string;
    endedByVisibility = false;
    endedByIdle = false;
    constructor(_b: any, _p: any, visitorId: any) {
      this.visitorId = visitorId;
      recorderInstances.push(this);
    }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    pause() { this.paused = true; }
    resume() { this.resumed = true; }
    beginRecording() {}
    identify() {}
    getVisitorId() { return this.visitorId; }
    getBridge() { return {}; }
    getPropertyId() { return 'prop-1'; }
    applyPrivacyConfig() {}
  },
}));

mock.module('../src/anonymous-worker-bridge.js', () => ({
  AnonymousWorkerBridge: class {
    destroyed = false;
    ephemeralVisitorId: string;
    ephemeralSessionId: string;
    constructor(opts: { ephemeralVisitorId: string; ephemeralSessionId: string }) {
      this.ephemeralVisitorId = opts.ephemeralVisitorId;
      this.ephemeralSessionId = opts.ephemeralSessionId;
      anonBridgeInstances.push(this);
    }
    onKilled(_cb: Function) {}
    postEvent() {}
    flush() {}
    flushAndDestroy() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
  },
}));

mock.module('../src/anonymous-capture.js', () => ({
  AnonymousCapture: class {
    started = false;
    stopped = false;
    constructor(_opts: any) {
      anonCaptureInstances.push(this);
    }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    applyPrivacyConfig() {}
    emitGoalCount() {}
  },
}));

async function freshSessionSight() {
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

const BASE_CONFIG = { publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' };

// ════════════════════════════════════════════════════════════════════
// Tier-transition tests
// ════════════════════════════════════════════════════════════════════

describe('tier transitions (setConsent)', () => {
  test('default init opens a full-tier session', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
    expect(anonCaptureInstances).toHaveLength(0);
    expect(cookieStore).toContain('ss_sid=');
    expect(cookieStore).toContain('ss_vid=');
    expect(SessionSight.getVisitorId()).toBeTruthy();
  });

  test('init with consent:"anonymous" runs the anonymous tier; no recorder, no session cookie', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });

    expect(recorderInstances).toHaveLength(0);
    expect(anonCaptureInstances).toHaveLength(1);
    expect(anonCaptureInstances[0]!.started).toBe(true);
    expect(anonBridgeInstances).toHaveLength(1);
    // Anonymous tier touches no persistent storage.
    expect(cookieStore).not.toContain('ss_sid=');
    expect(cookieStore).not.toContain('ss_vid=');
    // No full-tier visitor id surfaced.
    expect(SessionSight.getVisitorId()).toBeNull();
  });

  test('init with legacy consent:false maps to anonymous tier', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: false });

    expect(recorderInstances).toHaveLength(0);
    expect(anonCaptureInstances).toHaveLength(1);
    expect(SessionSight.getVisitorId()).toBeNull();
  });

  test('full → anonymous wipes ss_vid + ss_vtoken; anonymous capture starts', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    expect(cookieStore).toContain('ss_vid=');

    SessionSight.setConsent(false);

    expect(recorderInstances[0]!.stopped).toBe(true);
    expect(bridgeInstances[0]!.destroyed).toBe(true);
    // Anonymous tier's zero-persistent-storage rule: ss_vid is wiped on
    // the full → anonymous transition (deliberate behaviour change vs
    // older "preserve ss_vid across withdrawal" behaviour).
    expect(cookieStore).not.toContain('ss_sid=');
    expect(cookieStore).not.toContain('ss_vid=');
    expect(SessionSight.getVisitorId()).toBeNull();
    // Anonymous tier spun up after teardown.
    expect(anonCaptureInstances).toHaveLength(1);
    expect(anonCaptureInstances[0]!.started).toBe(true);
  });

  test('waffle (full → anonymous → full) mints a fresh visitorId', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    const firstVid = bridgeInstances[0]!.visitorId;

    SessionSight.setConsent(false);
    SessionSight.setConsent(true);

    expect(bridgeInstances).toHaveLength(2);
    expect(bridgeInstances[1]!.visitorId).not.toBe(firstVid);
    expect(bridgeInstances[1]!.sessionId).not.toBe(bridgeInstances[0]!.sessionId);
  });

  test('setConsent(true) is idempotent when already in full tier', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    const beforeCount = bridgeInstances.length;
    SessionSight.setConsent(true);
    expect(bridgeInstances.length).toBe(beforeCount);
  });

  test('setConsent(false) is idempotent when already anonymous', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });
    const beforeCaptureCount = anonCaptureInstances.length;
    const beforeBridgeCount = anonBridgeInstances.length;
    SessionSight.setConsent(false);
    expect(anonCaptureInstances.length).toBe(beforeCaptureCount);
    expect(anonBridgeInstances.length).toBe(beforeBridgeCount);
  });

  test('goals.increment in anonymous tier routes to the anonymous transport (no decrement)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });

    // Spy: anonCapture's emitGoalCount is the anon-tier goal sink.
    let goalSinkCallCount = 0;
    anonCaptureInstances[0]!.emitGoalCount = () => { goalSinkCallCount++; };

    const inc = SessionSight.goals.increment('purchase');
    expect(inc.success).toBe(true);
    expect(goalSinkCallCount).toBe(1);

    // decrement is not supported in anonymous tier (counters don't move
    // negative, no per-visitor attribution).
    const dec = SessionSight.goals.decrement('purchase');
    expect(dec.success).toBe(false);
    expect(dec.error).toContain('decrement not supported');
  });

  test('identify is a no-op in anonymous tier', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });
    expect(() => SessionSight.identify({ id: 'user-123' })).not.toThrow();
    // No recorder exists to receive identify in anonymous tier.
    expect(recorderInstances).toHaveLength(0);
  });

  test('getVisitorId returns null in anonymous tier (never leaks the ephemeral id)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });
    expect(SessionSight.getVisitorId()).toBeNull();
  });

  test('rapid toggling transitions cleanly', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    SessionSight.setConsent(false);
    SessionSight.setConsent(true);
    SessionSight.setConsent(false);
    SessionSight.setConsent(true);

    // Three full-tier bridges total (init + two re-grants); two anon
    // capture sessions in between.
    expect(bridgeInstances).toHaveLength(3);
    expect(anonCaptureInstances).toHaveLength(2);
    expect(bridgeInstances[0]!.destroyed).toBe(true);
    expect(bridgeInstances[1]!.destroyed).toBe(true);
    expect(bridgeInstances[2]!.destroyed).toBe(false);
  });

  test('stopRecording / resumeRecording / startRecording are no-ops in anonymous tier', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: 'anonymous' });
    expect(() => SessionSight.stopRecording()).not.toThrow();
    expect(() => SessionSight.resumeRecording()).not.toThrow();
    expect(() => SessionSight.startRecording()).not.toThrow();
  });

  test('stopRecording/resumeRecording in full tier pauses and resumes the recorder', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    SessionSight.stopRecording();
    expect(recorderInstances[0]!.paused).toBe(true);
    SessionSight.resumeRecording();
    expect(recorderInstances[0]!.resumed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// CMv2 opt-in tests
// ════════════════════════════════════════════════════════════════════

describe('honorConsentMode opt-in (CMv2)', () => {
  test('honorConsentMode:false installs no gtag patch', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    expect((globalThis as any).window.gtag).toBeUndefined();
  });

  test('honorConsentMode:true, initial analytics_storage:granted opens a full-tier session', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('honorConsentMode:true, initial analytics_storage:denied runs the anonymous tier', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(0);
    expect(anonCaptureInstances).toHaveLength(1);
  });

  test('honorConsentMode:true with no CMv2 signal falls back to the consent init param (default: full)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('gtag("consent", "update", {analytics_storage: granted}) upgrades from anonymous to full', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances).toHaveLength(0);
    expect(anonCaptureInstances).toHaveLength(1);

    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'granted' });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('gtag("consent", "update", {analytics_storage: denied}) downgrades full to anonymous', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances[0]!.started).toBe(true);

    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'denied' });

    expect(recorderInstances[0]!.stopped).toBe(true);
    expect(cookieStore).not.toContain('ss_sid=');
    // Anonymous tier wipes ss_vid on transition.
    expect(cookieStore).not.toContain('ss_vid=');
    expect(anonCaptureInstances).toHaveLength(1);
  });

  test('explicit setConsent() locks CMv2 out until followConsentMode() re-arms', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances).toHaveLength(0);

    SessionSight.setConsent(false);
    expect(recorderInstances).toHaveLength(0);

    // CMv2 update to granted is ignored after explicit override.
    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'granted' });
    expect(recorderInstances).toHaveLength(0);

    // followConsentMode() re-arms: adopt the current CMv2 state from dataLayer.
    (globalThis as any).window.dataLayer.push(['consent', 'update', { analytics_storage: 'granted' }]);
    SessionSight.followConsentMode();

    expect(recorderInstances).toHaveLength(1);
  });

  test('CMv2 updates that do not touch analytics_storage are ignored', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    const bridgesAfterInit = bridgeInstances.length;

    (globalThis as any).window.gtag('consent', 'update', { ad_storage: 'denied' });
    (globalThis as any).window.gtag('consent', 'update', { functionality_storage: 'granted' });

    expect(bridgeInstances.length).toBe(bridgesAfterInit);
    expect(recorderInstances[0]!.stopped).toBe(false);
  });

  test('followConsentMode() no-ops when honorConsentMode was not enabled', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    expect(() => SessionSight.followConsentMode()).not.toThrow();
    expect(bridgeInstances).toHaveLength(1);
  });
});
