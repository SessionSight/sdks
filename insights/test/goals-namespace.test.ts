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

// A schema-valid token shape. The SDK only checks length + regex, not the
// signature, before treating it as a stored token; signature verification
// happens server-side. Tests that need to hit the eager-bootstrap path
// can override this default.
const PREBOOTSTRAPPED_TOKEN = 'v1.' + 'a'.repeat(40) + '.' + 'b'.repeat(20);

beforeEach(() => {
  listeners.clear();
  beaconCalls.length = 0;

  // Seed the visitor-token cookie up front. The SDK now requires a valid
  // token to send full-tier goal beacons (server gates on it via the
  // new requireValidVisitorToken middleware). Without this, every goal
  // call would be queued behind the eager-bootstrap promise and never
  // hit sendBeacon in these tests.
  let docCookie = `ss_vtoken=${PREBOOTSTRAPPED_TOKEN}`;
  (globalThis as any).document = {
    get visibilityState() { return 'visible'; },
    addEventListener,
    removeEventListener,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { appendChild: () => {}, removeChild: () => {} },
    get cookie() { return docCookie; },
    set cookie(v: string) {
      // Mirror real document.cookie write semantics: each `=` write
      // either adds/replaces the matching name or expires it via
      // max-age=0.
      const match = /^([^=]+)=([^;]*)/.exec(v);
      if (!match) return;
      const name = match[1]!;
      const value = match[2] ?? '';
      const isExpire = /max-age=0|expires=Thu, 01 Jan 1970/.test(v);
      const parts = docCookie.split('; ').filter((c) => !c.startsWith(`${name}=`));
      if (!isExpire && value.length > 0) parts.push(`${name}=${value}`);
      docCookie = parts.filter(Boolean).join('; ');
    },
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
        // Blob body. We can't read sync in jsdom-style but we got the url
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
    onVisitorIdSwap(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    sendBeacon() {}
    flushAndDestroy() {}
    destroy() {}
  },
}));

// Stub the anonymous-tier transport so setConsent(false) doesn't try to
// spin up a real worker. The goals tests only exercise the full-tier
// sendBeacon path; the anonymous path is covered in consent-and-cmv2.test.ts.
mock.module('../src/anonymous-worker-bridge.js', () => ({
  AnonymousWorkerBridge: class {
    constructor(_opts: any) {}
    onKilled(_cb: Function) {}
    postEvent() {}
    flush() {}
    flushAndDestroy() {}
    destroy() {}
  },
}));

mock.module('../src/anonymous-capture.js', () => ({
  AnonymousCapture: class {
    constructor(_opts: any) {}
    start() {}
    stop() {}
    applyPrivacyConfig() {}
    emitGoalCount() {}
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

  test('beacon payload auto-attaches sessionId, apiKey, propertyId, visitorId, visitorToken', async () => {
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
    // visitorId + visitorToken now ride every full-tier goal payload —
    // they're the verification pair the server gates on.
    expect(typeof body.visitorId).toBe('string');
    expect(body.visitorId.length).toBeGreaterThan(0);
    expect(body.visitorToken).toBe(PREBOOTSTRAPPED_TOKEN);
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

  test('setConsent(false) flips to anonymous tier; goals route to the anon transport, not sendBeacon', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
    SessionSight.setConsent(false);

    // Anonymous tier counts goal fires through the anonymous transport
    // (no per-visitor attribution; counters only). sendBeacon is the
    // full-tier path and must NOT fire here.
    const result = SessionSight.goals.increment('purchase');
    expect(result.success).toBe(true);
    expect(beaconCalls).toHaveLength(0);
  });
});
