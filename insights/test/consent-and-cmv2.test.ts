import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Covers plan §Consent Lifecycle state table + §Testing/SDK CMv2 opt-in.
 *
 * Uses the same browser-globals stubbing pattern as goals-namespace.test.ts
 * so the full SDK state machine runs (WorkerBridge + Recorder are stubbed
 * to observables).
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
      // Simple implementation: parse `name=value; path=/; ...` and store.
      const parts = v.split(';').map(s => s.trim());
      const first = parts[0] || '';
      const eq = first.indexOf('=');
      if (eq < 0) return;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      // Handle max-age=0 (deletion)
      const maxAge = parts.find(p => p.startsWith('max-age='));
      if (maxAge && maxAge.split('=')[1] === '0') {
        cookieStore = cookieStore
          .split('; ')
          .filter(c => !c.startsWith(name + '='))
          .join('; ');
        return;
      }
      // Replace or append
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

beforeEach(() => {
  listeners.clear();
  cookieStore = '';
  recorderInstances.length = 0;
  bridgeInstances.length = 0;

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
    // dataLayer starts empty; individual tests push entries
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

// ── WorkerBridge + Recorder stubs ────────────────────────────────────

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
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
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

async function freshSessionSight() {
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

const BASE_CONFIG = { publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' };

// ════════════════════════════════════════════════════════════════════
// setConsent state-transition tests
// ════════════════════════════════════════════════════════════════════

describe('setConsent state transitions', () => {
  test('init with consent:true opens a session; setConsent(false) tears it down but preserves ss_vid', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
    expect(cookieStore).toContain('ss_sid=');
    expect(cookieStore).toContain('ss_vid=');
    const originalVid = SessionSight.getVisitorId();
    expect(originalVid).toBeTruthy();

    SessionSight.setConsent(false);

    // Session-scoped teardown
    expect(recorderInstances[0]!.stopped).toBe(true);
    expect(cookieStore).not.toContain('ss_sid=');
    // Visitor cookie preserved
    expect(cookieStore).toContain('ss_vid=');
    expect(SessionSight.getVisitorId()).toBeNull();
  });

  test('withdraw → re-grant re-uses the preserved visitorId', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    const firstVid = bridgeInstances[0]!.visitorId;

    SessionSight.setConsent(false);
    SessionSight.setConsent(true);

    expect(bridgeInstances).toHaveLength(2);
    // Same visitorId carries across the consent gap.
    expect(bridgeInstances[1]!.visitorId).toBe(firstVid);
    // Fresh sessionId.
    expect(bridgeInstances[1]!.sessionId).not.toBe(bridgeInstances[0]!.sessionId);
  });

  test('setConsent(true) is idempotent when already consented', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    const beforeCount = bridgeInstances.length;
    SessionSight.setConsent(true);
    expect(bridgeInstances.length).toBe(beforeCount); // no new bridge
  });

  test('setConsent(false) is idempotent when already withdrawn', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: false });

    // No recorder started yet.
    expect(recorderInstances).toHaveLength(0);
    SessionSight.setConsent(false);
    expect(recorderInstances).toHaveLength(0);
  });

  test('goals.increment is a silent no-op in no-session state', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    SessionSight.setConsent(false);

    const result = SessionSight.goals.increment('purchase');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no session');
  });

  test('identify is a no-op in no-session state', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    SessionSight.setConsent(false);

    // Should not throw; identify silently no-ops because there's no
    // current recorder to write the userId onto.
    expect(() => SessionSight.identify('user-123')).not.toThrow();
  });

  test('getVisitorId returns null in no-session state', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    SessionSight.setConsent(false);

    expect(SessionSight.getVisitorId()).toBeNull();
  });

  test('rapid withdraw/re-grant toggling opens and closes cleanly', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);

    // withdraw → re-grant → withdraw → re-grant
    SessionSight.setConsent(false);
    SessionSight.setConsent(true);
    SessionSight.setConsent(false);
    SessionSight.setConsent(true);

    // Three bridges total: init + two re-grants.
    expect(bridgeInstances).toHaveLength(3);
    // Withdrawn bridges destroyed.
    expect(bridgeInstances[0]!.destroyed).toBe(true);
    expect(bridgeInstances[1]!.destroyed).toBe(true);
    expect(bridgeInstances[2]!.destroyed).toBe(false);
    // Same visitor throughout.
    expect(bridgeInstances[1]!.visitorId).toBe(bridgeInstances[0]!.visitorId);
    expect(bridgeInstances[2]!.visitorId).toBe(bridgeInstances[0]!.visitorId);
  });

  test('stopRecording / resumeRecording are no-ops in no-session state', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG);
    SessionSight.setConsent(false);

    expect(() => SessionSight.stopRecording()).not.toThrow();
    expect(() => SessionSight.resumeRecording()).not.toThrow();
    expect(() => SessionSight.startRecording()).not.toThrow();
  });

  test('stopRecording/resumeRecording with active session pauses and resumes the recorder', async () => {
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
    // No honorConsentMode → window.gtag stays undefined.
    expect((globalThis as any).window.gtag).toBeUndefined();
  });

  test('honorConsentMode:true, initial analytics_storage:granted opens a session', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('honorConsentMode:true, initial analytics_storage:denied leaves SDK in no-session state', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(0);
  });

  test('honorConsentMode:true with no CMv2 signal falls back to the consent init param', async () => {
    // No dataLayer entries; consent param defaults to true.
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('gtag("consent", "update", {analytics_storage: granted}) opens a session after init-time denied', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances).toHaveLength(0);

    // Customer updates consent via gtag. The SDK has patched window.gtag.
    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'granted' });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]!.started).toBe(true);
  });

  test('gtag("consent", "update", {analytics_storage: denied}) tears down the session', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances[0]!.started).toBe(true);

    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'denied' });

    expect(recorderInstances[0]!.stopped).toBe(true);
    expect(cookieStore).not.toContain('ss_sid=');
    expect(cookieStore).toContain('ss_vid='); // preserved
  });

  test('explicit setConsent() locks CMv2 out until followConsentMode() re-arms', async () => {
    (globalThis as any).window.dataLayer = [
      ['consent', 'default', { analytics_storage: 'denied' }],
    ];

    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, honorConsentMode: true });
    expect(recorderInstances).toHaveLength(0);

    // Customer takes control.
    SessionSight.setConsent(false);
    expect(recorderInstances).toHaveLength(0);

    // CMv2 update to granted should now be IGNORED (explicit-wins lock).
    (globalThis as any).window.gtag('consent', 'update', { analytics_storage: 'granted' });
    expect(recorderInstances).toHaveLength(0);

    // followConsentMode() re-arms: adopt the current CMv2 state.
    // The most recent signal in dataLayer is still 'denied' (the initial default);
    // the 'update' went through the patched gtag which mutates the SDK but doesn't
    // push to dataLayer. So re-arming against current state stays in no-session.
    // Push a fresh signal so we can observe the re-arm taking effect.
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

    // Updates to ad_storage, functionality_storage, etc. — no analytics_storage key.
    (globalThis as any).window.gtag('consent', 'update', { ad_storage: 'denied' });
    (globalThis as any).window.gtag('consent', 'update', { functionality_storage: 'granted' });

    // SDK state is unchanged.
    expect(bridgeInstances.length).toBe(bridgesAfterInit);
    expect(recorderInstances[0]!.stopped).toBe(false);
  });

  test('followConsentMode() no-ops when honorConsentMode was not enabled', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init(BASE_CONFIG); // honorConsentMode not set

    // Should not throw or mutate state.
    expect(() => SessionSight.followConsentMode()).not.toThrow();
    expect(bridgeInstances).toHaveLength(1); // unchanged
  });
});
