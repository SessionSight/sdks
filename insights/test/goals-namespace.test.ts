import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

// ── Browser global stubs (same pattern as idle-session-timeout.test.ts) ──

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
const origHistory = (globalThis as any).history;
const origHistoryCtor = (globalThis as any).History;
const origLocation = (globalThis as any).location;

const beaconCalls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  listeners.clear();
  beaconCalls.length = 0;

  (globalThis as any).document = {
    get visibilityState() { return 'visible'; },
    addEventListener,
    removeEventListener,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { appendChild: () => {}, removeChild: () => {} },
    cookie: '',
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), style: {}, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {} }),
  };

  const historyProto = { pushState: () => {}, replaceState: () => {} };
  (globalThis as any).History = { prototype: historyProto };
  (globalThis as any).history = { ...historyProto };
  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/', pathname: '/', search: '', hash: '' };

  (globalThis as any).window = {
    location: (globalThis as any).location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener,
    removeEventListener,
    history: (globalThis as any).history,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({}),
    localStorage: (() => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      };
    })(),
  };
  (globalThis as any).localStorage = (globalThis as any).window.localStorage;

  (globalThis as any).navigator = {
    language: 'en-US',
    sendBeacon: (url: string, body: any) => {
      let parsed = body;
      if (body instanceof Blob) {
        // Blob body — we can't read sync in jsdom-style but we got the url
        parsed = body;
      }
      beaconCalls.push({ url, body: parsed });
      return true;
    },
  };
});

afterEach(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).history = origHistory;
  (globalThis as any).History = origHistoryCtor;
  (globalThis as any).location = origLocation;
});

// Stub WorkerBridge so init() doesn't spin up real workers/WebSockets.
mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    onPrivacy(_cb: Function) {}
    onQuotaExceeded(_cb: Function) {}
    onRotate(_cb: Function) {}
    onKilled(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    sendBeacon() {}
    destroy() {}
  },
}));

// Stub Recorder so init() doesn't try to touch rrweb.
mock.module('../src/recorder.js', () => ({
  Recorder: class {
    constructor(_b: any, _p: any, _v: any, _c: any) {}
    start() {}
    stop() {}
    beginRecording() {}
    identify() {}
    getVisitorId() { return null; }
    getBridge() { return {}; }
    getPropertyId() { return 'prop-1'; }
    applyPrivacyConfig() {}
    endedByVisibility = false;
    endedByIdle = false;
  },
}));

async function freshSessionSight() {
  // Bust module cache so state resets between tests.
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

describe('SessionSight.goals namespace', () => {
  test('returns not-initialized error before init()', async () => {
    const SessionSight = await freshSessionSight();
    const result = SessionSight.goals.increment('purchase');
    expect(result.success).toBe(false);
    expect(result.error).toBe('SessionSight not initialized');
  });

  test('increment sends sendBeacon with correct URL after init()', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const result = SessionSight.goals.increment('purchase', { amount: 5 });

    expect(result.success).toBe(true);
    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]!.url).toBe('https://api.example.com/v1/sdk/goals/increment');
  });

  test('decrement sends sendBeacon to decrement URL', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const result = SessionSight.goals.decrement('inventory');

    expect(result.success).toBe(true);
    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]!.url).toBe('https://api.example.com/v1/sdk/goals/decrement');
  });

  test('beacon payload auto-attaches sessionId, apiKey, propertyId (no visitorId)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    SessionSight.goals.increment('purchase', { amount: 2, metadata: { plan: 'pro' } });

    const blob = beaconCalls[0]!.body as Blob;
    const text = await blob.text();
    const body = JSON.parse(text);
    expect(body.goalId).toBe('purchase');
    expect(body.propertyId).toBe('prop-1');
    expect(body.amount).toBe(2);
    expect(body.apiKey).toBe('pk_test');
    expect(body.metadata).toEqual({ plan: 'pro' });
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
    // Under the session-as-identity model, visitorId is never on the wire.
    expect(body.visitorId).toBeUndefined();
  });

  test('rejects empty goalId with validation error', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const result = SessionSight.goals.increment('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('goalId must be a non-empty string');
    expect(beaconCalls).toHaveLength(0);
  });

  test('rejects non-positive amount with validation error', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const result = SessionSight.goals.increment('purchase', { amount: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('amount must be a positive finite number');
    expect(beaconCalls).toHaveLength(0);
  });

  test('setConsent(false) puts the SDK in the no-session state; goals become silent no-ops', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
    SessionSight.setConsent(false);

    // Under the session-as-identity model, goals are session-scoped.
    // Without a session the SDK has nothing to attribute the fire to;
    // rather than sending a sessionless record the API can't interpret,
    // the call is a no-op.
    const result = SessionSight.goals.increment('purchase');
    expect(result.success).toBe(false);
    expect(beaconCalls).toHaveLength(0);
  });
});
